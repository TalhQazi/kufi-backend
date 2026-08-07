/**
 * Geographic feasibility for generated itineraries.
 *
 * The generator (AI or template) can place activities that are hundreds of kilometres
 * apart on the same day. This module provides the primitives to detect and repair that,
 * with no destination-specific knowledge: everything is derived from the coordinates and
 * place labels already stored on Activity documents.
 *
 * Resolution order for an activity's position:
 *   1. `coordinates.lat/lng`      — exact, available for ~90% of the catalogue
 *   2. place label (city/location) — activities sharing a label are treated as co-located
 *
 * Entries with neither are "unanchored" and are never used to justify splitting a day.
 */

const EARTH_RADIUS_KM = 6371;

/** Two places closer than this are treated as the same base — no relocation needed. */
const SAME_AREA_RADIUS_KM = Number(process.env.ITINERARY_SAME_AREA_RADIUS_KM) || 60;

/** Average door-to-door ground speed, km/h. Deliberately conservative. */
const AVG_TRAVEL_SPEED_KMH = Number(process.env.ITINERARY_TRAVEL_SPEED_KMH) || 70;

/** Fixed overhead per intercity transfer (check-out, terminals, transfers), minutes. */
const TRANSFER_OVERHEAD_MIN = Number(process.env.ITINERARY_TRANSFER_OVERHEAD_MIN) || 60;

/** Beyond this, ground transfer is unrealistic and a flight is assumed instead. */
const FLIGHT_THRESHOLD_KM = Number(process.env.ITINERARY_FLIGHT_THRESHOLD_KM) || 400;

/** Door-to-door cost of a short-haul flight (transfers + check-in + air time), minutes. */
const FLIGHT_OVERHEAD_MIN = Number(process.env.ITINERARY_FLIGHT_OVERHEAD_MIN) || 240;

/** Default activity length when the catalogue has no parsable duration, minutes. */
const DEFAULT_ACTIVITY_MIN = Number(process.env.ITINERARY_DEFAULT_ACTIVITY_MIN) || 120;

const toRad = (deg) => (Number(deg) * Math.PI) / 180;

const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);

/** A usable {lat,lng} from any of the shapes used across the codebase, else null. */
function getCoordinates(source) {
    if (!source || typeof source !== 'object') return null;
    const c = source.coordinates || source.coords || source;
    const lat = Number(c?.lat ?? c?.latitude);
    const lng = Number(c?.lng ?? c?.lon ?? c?.longitude);
    if (!isFiniteNumber(lat) || !isFiniteNumber(lng)) return null;
    // Reject the null-island default and out-of-range values.
    if (lat === 0 && lng === 0) return null;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
    return { lat, lng };
}

/** Great-circle distance in kilometres. */
function haversineKm(a, b) {
    if (!a || !b) return null;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const h =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Normalized place label used when coordinates are missing. */
function placeLabel(entry) {
    const raw = entry?.city || entry?.location || entry?.area || entry?.country || '';
    return String(raw).trim().toLowerCase();
}

/** Realistic door-to-door travel time in minutes for a given distance. */
function travelMinutesForKm(km) {
    if (!isFiniteNumber(km) || km <= 0) return 0;
    if (km <= SAME_AREA_RADIUS_KM) {
        // Local hops: slower average speed, no fixed overhead.
        return Math.round((km / 40) * 60);
    }
    if (km >= FLIGHT_THRESHOLD_KM) return FLIGHT_OVERHEAD_MIN;
    return Math.round(TRANSFER_OVERHEAD_MIN + (km / AVG_TRAVEL_SPEED_KMH) * 60);
}

/** The transport a leg of this length realistically requires. */
function transportModeForKm(km) {
    if (!isFiniteNumber(km) || km <= SAME_AREA_RADIUS_KM) return 'local';
    if (km >= FLIGHT_THRESHOLD_KM) return 'flight';
    return 'road';
}

/** Parse "3 hours", "90 mins", "2.5 h", "Full day" into minutes. */
function parseDurationMinutes(value) {
    if (isFiniteNumber(value)) return value;
    const raw = String(value ?? '').trim().toLowerCase();
    if (!raw) return DEFAULT_ACTIVITY_MIN;
    if (/full\s*day/.test(raw)) return 480;
    if (/half\s*day/.test(raw)) return 240;
    if (/multi|\bdays?\b/.test(raw)) {
        const d = parseFloat(raw);
        if (Number.isFinite(d) && d >= 1) return Math.round(d * 480);
    }
    const hours = raw.match(/(\d+(?:\.\d+)?)\s*(hours?|hrs?|h)\b/);
    const mins = raw.match(/(\d+(?:\.\d+)?)\s*(minutes?|mins?|m)\b/);
    let total = 0;
    if (hours) total += parseFloat(hours[1]) * 60;
    if (mins) total += parseFloat(mins[1]);
    if (total > 0) return Math.round(total);
    const bare = parseFloat(raw);
    if (Number.isFinite(bare) && bare > 0) return Math.round(bare <= 12 ? bare * 60 : bare);
    return DEFAULT_ACTIVITY_MIN;
}

/**
 * Group activities into geographic clusters.
 *
 * Coordinate-bearing entries are clustered by proximity (single-link, threshold
 * SAME_AREA_RADIUS_KM). Entries without coordinates fall back to their place label, and
 * join a coordinate cluster when that cluster already contains the same label.
 *
 * @returns {Array<{ key, centroid, label, items }>} ordered largest-first
 */
function clusterByGeography(activities, { radiusKm = SAME_AREA_RADIUS_KM } = {}) {
    const list = Array.isArray(activities) ? activities : [];
    const clusters = [];

    const anchored = [];
    const unanchored = [];
    list.forEach((act) => {
        const coords = getCoordinates(act);
        (coords ? anchored : unanchored).push({ act, coords, label: placeLabel(act) });
    });

    anchored.forEach(({ act, coords, label }) => {
        let target = null;
        let bestDistance = Infinity;
        for (const cluster of clusters) {
            const d = haversineKm(cluster.centroid, coords);
            if (d !== null && d <= radiusKm && d < bestDistance) {
                bestDistance = d;
                target = cluster;
            }
        }
        if (!target) {
            clusters.push({
                key: `geo-${clusters.length}`,
                centroid: { ...coords },
                labels: new Set(label ? [label] : []),
                items: [act],
                _sumLat: coords.lat,
                _sumLng: coords.lng,
            });
            return;
        }
        target.items.push(act);
        if (label) target.labels.add(label);
        // Keep the centroid as the running mean of its members.
        target._sumLat += coords.lat;
        target._sumLng += coords.lng;
        target.centroid = {
            lat: target._sumLat / target.items.length,
            lng: target._sumLng / target.items.length,
        };
    });

    // Place label-only entries next to a matching coordinate cluster where possible.
    const labelClusters = new Map();
    unanchored.forEach(({ act, label }) => {
        const match = clusters.find((c) => label && c.labels.has(label));
        if (match) {
            match.items.push(act);
            return;
        }
        const key = label || '__unknown__';
        if (!labelClusters.has(key)) {
            const cluster = { key: `label-${key}`, centroid: null, labels: new Set([key]), items: [] };
            labelClusters.set(key, cluster);
            clusters.push(cluster);
        }
        labelClusters.get(key).items.push(act);
    });

    return clusters
        .map((c) => ({
            key: c.key,
            centroid: c.centroid,
            label: [...c.labels][0] || '',
            items: c.items,
        }))
        .sort((a, b) => b.items.length - a.items.length);
}

/**
 * Order clusters into a sensible travel route: start from `origin` (the hotel, or the
 * largest cluster) and repeatedly hop to the nearest unvisited cluster. Keeps a
 * multi-city trip moving in one direction instead of bouncing back and forth.
 */
function orderClustersByRoute(clusters, origin = null) {
    const remaining = [...clusters];
    if (remaining.length <= 1) return remaining;

    const ordered = [];
    let current = origin;

    if (!current) {
        // Start from the biggest cluster — most of the trip happens there.
        const first = remaining.shift();
        ordered.push(first);
        current = first.centroid;
    }

    while (remaining.length > 0) {
        let bestIdx = 0;
        let bestDistance = Infinity;
        remaining.forEach((cluster, idx) => {
            const d = current && cluster.centroid ? haversineKm(current, cluster.centroid) : null;
            // Unlocatable clusters sort last but still get placed.
            const score = d === null ? Number.MAX_SAFE_INTEGER - (remaining.length - idx) : d;
            if (score < bestDistance) {
                bestDistance = score;
                bestIdx = idx;
            }
        });
        const [next] = remaining.splice(bestIdx, 1);
        ordered.push(next);
        if (next.centroid) current = next.centroid;
    }

    return ordered;
}

/** Maximum bookable minutes in a day, honouring the control panel window and lunch. */
function dayCapacityMinutes(controlPanel = {}, override = {}) {
    const toMin = (t, fallback) => {
        const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || '').trim());
        if (!m) return fallback;
        return Number(m[1]) * 60 + Number(m[2]);
    };
    const start = toMin(override.startTime || controlPanel.activityStartTime, 9 * 60);
    const end = toMin(override.endTime || controlPanel.activityEndTime, 19 * 60);
    const lunchStart = toMin(override.lunchStart || controlPanel.lunchStart, 13 * 60);
    const lunchEnd = toMin(override.lunchEnd || controlPanel.lunchEnd, 14 * 60);

    const window = Math.max(0, end - start);
    const lunch = lunchEnd > lunchStart && lunchStart >= start && lunchEnd <= end
        ? lunchEnd - lunchStart
        : 0;
    return Math.max(0, window - lunch);
}

/**
 * Inspect a generated plan and report every day that is not geographically feasible.
 *
 * @returns {{ ok: boolean, issues: Array, dayReports: Array }}
 */
function validateItineraryGeography(days, { controlPanel = {}, isBreakEntry = () => false } = {}) {
    const issues = [];
    const dayReports = [];
    const list = Array.isArray(days) ? days : [];

    list.forEach((day, idx) => {
        const entries = (Array.isArray(day?.activities) ? day.activities : []).filter(
            (a) => !isBreakEntry(a)
        );
        const override = (controlPanel.perDayOverrides || []).find((o) => o.date === day?.date) || {};
        const capacity = dayCapacityMinutes(controlPanel, override);

        // Widest separation between any two activities scheduled on this day.
        let maxSpreadKm = 0;
        let worstPair = null;
        for (let i = 0; i < entries.length; i++) {
            const a = getCoordinates(entries[i]);
            if (!a) continue;
            for (let j = i + 1; j < entries.length; j++) {
                const b = getCoordinates(entries[j]);
                if (!b) continue;
                const d = haversineKm(a, b);
                if (d !== null && d > maxSpreadKm) {
                    maxSpreadKm = d;
                    worstPair = [entries[i], entries[j]];
                }
            }
        }

        // Time actually needed: activity durations + travel between consecutive stops.
        let requiredMinutes = 0;
        let previous = null;
        entries.forEach((entry) => {
            requiredMinutes += parseDurationMinutes(entry.durationMinutes ?? entry.duration);
            const here = getCoordinates(entry);
            if (previous && here) requiredMinutes += travelMinutesForKm(haversineKm(previous, here));
            if (here) previous = here;
        });

        const report = {
            day: day?.day ?? idx + 1,
            date: day?.date || '',
            activityCount: entries.length,
            maxSpreadKm: Math.round(maxSpreadKm),
            requiredMinutes,
            capacityMinutes: capacity,
        };
        dayReports.push(report);

        if (maxSpreadKm > SAME_AREA_RADIUS_KM) {
            issues.push({
                type: 'geographic_spread',
                day: report.day,
                distanceKm: Math.round(maxSpreadKm),
                message: `Day ${report.day} mixes activities ${Math.round(maxSpreadKm)}km apart (${
                    worstPair ? `"${worstPair[0].title}" and "${worstPair[1].title}"` : 'multiple locations'
                }).`,
            });
        }
        if (capacity > 0 && requiredMinutes > capacity) {
            issues.push({
                type: 'over_capacity',
                day: report.day,
                requiredMinutes,
                capacityMinutes: capacity,
                message: `Day ${report.day} needs ${requiredMinutes}min of activity + travel but only has ${capacity}min available.`,
            });
        }
    });

    return { ok: issues.length === 0, issues, dayReports };
}

module.exports = {
    SAME_AREA_RADIUS_KM,
    FLIGHT_THRESHOLD_KM,
    DEFAULT_ACTIVITY_MIN,
    getCoordinates,
    haversineKm,
    placeLabel,
    travelMinutesForKm,
    transportModeForKm,
    parseDurationMinutes,
    clusterByGeography,
    orderClustersByRoute,
    dayCapacityMinutes,
    validateItineraryGeography,
};
