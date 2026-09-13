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

/**
 * Two places closer than this are treated as the same base — no relocation needed.
 * Day capacity still comes from Control Panel activity start/end times; this radius
 * only groups nearby stops for multi-area routing.
 */
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

/**
 * Schedule granularity, in minutes.
 *
 * Travel estimates are rounded UP to this step and start times snap to it, so the
 * itinerary reads in clean clock times. Without it an exact 37-minute leg produced
 * "14:37", and a day quickly filled with times like 17:04 and 10:19.
 */
const TIME_ROUNDING_MINUTES = Number(process.env.ITINERARY_TIME_ROUNDING_MINUTES) || 5;

/**
 * Floor for the hop between two DISTINCT places.
 *
 * Two stops a few hundred metres apart used to cost nothing, so the itinerary showed no
 * travel at all between them — the traveller appeared to leave one venue and arrive at
 * the next in the same instant. Even a short walk costs time. v148 uses a 15-minute
 * floor (`Math.max(.25, km/35)`); this uses one scheduling step, which is enough to
 * make the leg real and visible without inflating every day by a quarter hour per stop.
 *
 * Stops at the SAME coordinates still cost nothing — that is one venue, not two.
 */
const MIN_TRANSFER_MINUTES = Number(process.env.ITINERARY_MIN_TRANSFER_MINUTES) || TIME_ROUNDING_MINUTES;

/** Round up to the next scheduling step. Rounding up never under-books travel. */
function roundUpToStep(minutes, step = TIME_ROUNDING_MINUTES) {
    if (!isFiniteNumber(minutes) || minutes <= 0) return 0;
    if (step <= 1) return Math.ceil(minutes);
    return Math.ceil(minutes / step) * step;
}

/**
 * Realistic door-to-door travel time in minutes for a given distance.
 *
 * Rounded up to the scheduling step so the resulting clock times are tidy: a 37-minute
 * leg is booked as 40. Legs under a minute stay at 0 — neighbouring sites should not
 * acquire a phantom five-minute transfer.
 */
function travelMinutesForKm(km) {
    if (!isFiniteNumber(km) || km <= 0) return 0;

    let raw;
    if (km <= SAME_AREA_RADIUS_KM) {
        // Local hops: slower average speed, no fixed overhead.
        raw = (km / 40) * 60;
    } else if (km >= FLIGHT_THRESHOLD_KM) {
        raw = FLIGHT_OVERHEAD_MIN;
    } else {
        raw = TRANSFER_OVERHEAD_MIN + (km / AVG_TRAVEL_SPEED_KMH) * 60;
    }

    // Nearby is not the same as co-located: getting there still takes a few minutes.
    if (raw < MIN_TRANSFER_MINUTES) return MIN_TRANSFER_MINUTES;
    return roundUpToStep(raw);
}

/**
 * Door-to-door minutes between two coordinates or activity-like objects.
 *
 * Intercity legs use the Google Distance Matrix when one was primed for this run
 * (same as Kufi v148). Local hops and missing cells fall back to haversine.
 */
function travelMinutesBetween(from, to, routeMatrix) {
    const a = getCoordinates(from);
    const b = getCoordinates(to);
    if (!a || !b) return 0;
    if (routeMatrix) {
        try {
            const { matrixTravelMinutes } = require('./routeMatrix');
            const live = matrixTravelMinutes(a, b, routeMatrix);
            if (live != null) return live;
        } catch {
            // The matrix module is optional at boot; haversine still works.
        }
    }
    return travelMinutesForKm(haversineKm(a, b));
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
            // Complete-link: join only when EVERY existing member is within radius.
            // Centroid-only matching chained Beirut→Laqlouq→Baalbek into one "area".
            let farthest = 0;
            let ok = true;
            for (const member of cluster.items) {
                const mc = getCoordinates(member);
                const d = mc ? haversineKm(mc, coords) : null;
                if (d === null || d > radiusKm) {
                    ok = false;
                    break;
                }
                farthest = Math.max(farthest, d);
            }
            if (ok && farthest < bestDistance) {
                bestDistance = farthest;
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

const DEFAULT_LUNCH_MINUTES = Number(process.env.ITINERARY_LUNCH_MINUTES) || 60;

const parseTimeToMinutes = (value, fallback = null) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
    if (!m) return fallback;
    return Number(m[1]) * 60 + Number(m[2]);
};

const minutesToTime = (mins) => {
    const clamped = ((Math.round(mins) % 1440) + 1440) % 1440;
    return `${String(Math.floor(clamped / 60)).padStart(2, '0')}:${String(clamped % 60).padStart(2, '0')}`;
};

/**
 * Where lunch falls on a given day.
 *
 * The supplier now configures a *duration* only — a start time was one more thing to keep
 * consistent with the activity window, and getting it wrong silently produced days where
 * lunch sat outside working hours. The break is instead centred in the day's activity
 * window and applies to every day, so it always lands somewhere sensible:
 *
 *   09:00–19:00, 60 min  ->  13:30–14:30
 *   08:00–18:00, 60 min  ->  12:30–13:30
 *   09:00–19:00, 90 min  ->  13:15–14:45
 *
 * Legacy records that still carry explicit lunchStart/lunchEnd keep working: their stored
 * span is used as the duration when no explicit duration is set.
 *
 * @returns {{ startMinutes, endMinutes, durationMinutes, lunchStart, lunchEnd }}
 */
function resolveLunchWindow(controlPanel = {}, override = {}) {
    const dayStart = parseTimeToMinutes(override.startTime || controlPanel.activityStartTime, 9 * 60);
    const dayEnd = parseTimeToMinutes(override.endTime || controlPanel.activityEndTime, 19 * 60);

    // Duration: explicit setting first, then the span of any legacy start/end pair.
    let duration = Number(
        override.lunchDurationMinutes ?? controlPanel.lunchDurationMinutes
    );
    if (!Number.isFinite(duration) || duration < 0) {
        const legacyStart = parseTimeToMinutes(override.lunchStart || controlPanel.lunchStart, null);
        const legacyEnd = parseTimeToMinutes(override.lunchEnd || controlPanel.lunchEnd, null);
        duration = legacyStart !== null && legacyEnd !== null && legacyEnd > legacyStart
            ? legacyEnd - legacyStart
            : DEFAULT_LUNCH_MINUTES;
    }

    const window = Math.max(0, dayEnd - dayStart);
    // A break can never be longer than the working day.
    duration = Math.max(0, Math.min(duration, window));

    // Centre it, rounded down to a quarter hour so the times read cleanly.
    const midpoint = dayStart + Math.floor(window / 2);
    let startMinutes = Math.floor((midpoint - Math.floor(duration / 2)) / 15) * 15;
    startMinutes = Math.max(dayStart, Math.min(startMinutes, dayEnd - duration));

    return {
        startMinutes,
        endMinutes: startMinutes + duration,
        durationMinutes: duration,
        lunchStart: minutesToTime(startMinutes),
        lunchEnd: minutesToTime(startMinutes + duration),
    };
}

/** Maximum bookable minutes in a day, honouring the control panel window and lunch. */
function dayCapacityMinutes(controlPanel = {}, override = {}, dayFlags = {}) {
    let start = parseTimeToMinutes(override.startTime || controlPanel.activityStartTime, 9 * 60);
    let end = parseTimeToMinutes(override.endTime || controlPanel.activityEndTime, 19 * 60);

    // Optional clock times from the v148-style control panel shrink the first/last day.
    if (dayFlags.isArrival && controlPanel.arrivalTime) {
        const arrival = parseTimeToMinutes(controlPanel.arrivalTime, null);
        if (arrival != null) start = Math.max(start, arrival);
    }
    if (dayFlags.isDeparture && controlPanel.departureTime) {
        const departure = parseTimeToMinutes(controlPanel.departureTime, null);
        if (departure != null) end = Math.min(end, departure);
    }

    const { durationMinutes } = resolveLunchWindow(controlPanel, override);

    const window = Math.max(0, end - start);
    return Math.max(0, window - durationMinutes);
}

/**
 * Inspect a generated plan and report every day that is not geographically feasible.
 *
 * @returns {{ ok: boolean, issues: Array, dayReports: Array }}
 */
function validateItineraryGeography(days, { controlPanel = {}, isBreakEntry = () => false, routeMatrix = null } = {}) {
    const issues = [];
    const dayReports = [];
    const list = Array.isArray(days) ? days : [];

    list.forEach((day, idx) => {
        const entries = (Array.isArray(day?.activities) ? day.activities : []).filter(
            (a) => !isBreakEntry(a)
        );
        const override = (controlPanel.perDayOverrides || []).find((o) => o.date === day?.date) || {};
        const capacity = dayCapacityMinutes(controlPanel, override, {
            isArrival: idx === 0,
            isDeparture: idx === list.length - 1,
        });

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
            if (previous && here) requiredMinutes += travelMinutesBetween(previous, here, routeMatrix);
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
    MIN_TRANSFER_MINUTES,
    SAME_AREA_RADIUS_KM,
    FLIGHT_THRESHOLD_KM,
    DEFAULT_ACTIVITY_MIN,
    getCoordinates,
    haversineKm,
    placeLabel,
    travelMinutesForKm,
    travelMinutesBetween,
    transportModeForKm,
    parseDurationMinutes,
    clusterByGeography,
    orderClustersByRoute,
    dayCapacityMinutes,
    resolveLunchWindow,
    roundUpToStep,
    TIME_ROUNDING_MINUTES,
    parseTimeToMinutes,
    minutesToTime,
    DEFAULT_LUNCH_MINUTES,
    validateItineraryGeography,
};
