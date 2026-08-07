/**
 * Geographic planning + repair layer for generated itineraries.
 *
 * Sits between "a generator produced some days" and "we return the itinerary":
 *
 *     Generate Itinerary
 *            ↓
 *     Validate Geography / Travel Time / Daily Capacity
 *            ↓
 *     Reorganize if necessary  ← this module
 *            ↓
 *     Final Itinerary
 *
 * Everything is derived from coordinates and place labels on the activities themselves,
 * so no destination is special-cased. If the catalogue has no coordinates at all the
 * planner degrades gracefully to place-label grouping, and if it has neither it leaves
 * the generated order untouched.
 */

const {
    SAME_AREA_RADIUS_KM,
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
} = require('./geo');
const { isBreakEntry, countableActivities } = require('./activityClassification');

/**
 * Human-readable name for a cluster, for transfer notes.
 *
 * Prefers the most specific label available. A country name is only used as a last
 * resort, because in a single-country trip every cluster carries the same one and a note
 * like "Egypt → Egypt" tells the supplier nothing.
 */
function clusterName(cluster, fallbackIndex) {
    const pick = (accessor) => {
        const named = cluster.items
            .map(accessor)
            .map((v) => String(v ?? '').trim())
            .filter(Boolean);
        if (!named.length) return '';
        const counts = new Map();
        named.forEach((n) => counts.set(n, (counts.get(n) || 0) + 1));
        return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    };

    return (
        pick((a) => a.city) ||
        pick((a) => a.area) ||
        pick((a) => a.location) ||
        pick((a) => a.country) ||
        `Area ${fallbackIndex + 1}`
    );
}

/**
 * Wording for a transfer between two bases. Falls back to a distance-only description
 * when the two labels are indistinguishable, rather than printing "X → X".
 */
function describeTransfer({ fromLabel, toLabel, distanceKm, travelMinutes, mode }) {
    const hours = Math.max(1, Math.round(travelMinutes / 60));
    const route = fromLabel && toLabel && fromLabel !== toLabel ? `${fromLabel} → ${toLabel}` : (toLabel || '');
    const where = route ? `${route} ` : '';
    return `Travel day — ${where}(~${distanceKm}km, ~${hours}h by ${mode}).`;
}

/**
 * Decide how many days each cluster gets.
 *
 * Every cluster that survives gets at least one day; the remainder is handed out in
 * proportion to how many activities the cluster holds. When there are more clusters than
 * days, the ones furthest from the route start are dropped — visiting them is not
 * feasible in the time the traveler booked.
 */
function allocateDaysToClusters(clusters, availableDays) {
    if (availableDays <= 0 || clusters.length === 0) return [];

    let kept = clusters;
    if (clusters.length > availableDays) {
        // Keep the densest clusters — that is where the trip's value is.
        kept = [...clusters].sort((a, b) => b.items.length - a.items.length).slice(0, availableDays);
        // Restore route order among the survivors.
        kept = clusters.filter((c) => kept.includes(c));
    }

    const totalItems = kept.reduce((sum, c) => sum + c.items.length, 0) || 1;
    const allocation = kept.map((cluster) => ({ cluster, days: 1 }));
    let remaining = availableDays - allocation.length;

    // Largest-remainder distribution of the spare days.
    const shares = allocation.map(({ cluster }) => (cluster.items.length / totalItems) * availableDays - 1);
    while (remaining > 0) {
        let bestIdx = 0;
        let best = -Infinity;
        shares.forEach((share, idx) => {
            if (share > best) {
                best = share;
                bestIdx = idx;
            }
        });
        allocation[bestIdx].days += 1;
        shares[bestIdx] -= 1;
        remaining -= 1;
    }

    return allocation;
}

/**
 * Build day-by-day activity assignments that respect geography and daily capacity.
 *
 * @param {Array} activities     candidate activities (already budget-filtered)
 * @param {object} options
 * @param {Array<{index:number, date:string}>} options.activeDays days that may hold activities
 * @param {object} options.controlPanel
 * @param {object|null} options.origin  starting coordinates (hotel), if known
 * @param {number} options.maxPerDay
 * @returns {{ assignments: Map<number, Array>, transfers: Map<number, object> }}
 */
function planActivitiesAcrossDays(activities, {
    activeDays = [],
    controlPanel = {},
    origin = null,
    maxPerDay = 3,
} = {}) {
    const assignments = new Map();
    const transfers = new Map();
    activeDays.forEach(({ index }) => assignments.set(index, []));

    const list = (Array.isArray(activities) ? activities : []).filter(Boolean);
    if (list.length === 0 || activeDays.length === 0) return { assignments, transfers };

    const clusters = clusterByGeography(list);
    const routed = orderClustersByRoute(clusters, origin);
    const allocation = allocateDaysToClusters(routed, activeDays.length);

    let dayCursor = 0;
    let previousCentroid = origin;

    allocation.forEach(({ cluster, days }, clusterIdx) => {
        const clusterDays = activeDays.slice(dayCursor, dayCursor + days);
        if (clusterDays.length === 0) return;

        // Record the transfer onto the first day of a new base.
        const first = clusterDays[0];
        if (previousCentroid && cluster.centroid) {
            const distanceKm = haversineKm(previousCentroid, cluster.centroid);
            if (distanceKm !== null && distanceKm > SAME_AREA_RADIUS_KM) {
                transfers.set(first.index, {
                    fromLabel: clusterIdx > 0 ? clusterName(allocation[clusterIdx - 1].cluster, clusterIdx - 1) : '',
                    toLabel: clusterName(cluster, clusterIdx),
                    distanceKm: Math.round(distanceKm),
                    travelMinutes: travelMinutesForKm(distanceKm),
                    mode: transportModeForKm(distanceKm),
                });
            }
        }

        // Order the cluster's activities so consecutive stops are near each other.
        const ordered = [];
        const pool = [...cluster.items];
        let cursor = cluster.centroid || origin;
        while (pool.length > 0) {
            let bestIdx = 0;
            let bestScore = Infinity;
            pool.forEach((act, idx) => {
                const coords = getCoordinates(act);
                const d = cursor && coords ? haversineKm(cursor, coords) : null;
                const score = d === null ? Number.MAX_SAFE_INTEGER - idx : d;
                if (score < bestScore) {
                    bestScore = score;
                    bestIdx = idx;
                }
            });
            const [next] = pool.splice(bestIdx, 1);
            ordered.push(next);
            const c = getCoordinates(next);
            if (c) cursor = c;
        }

        // Fill this cluster's days, respecting both the per-day cap and the real
        // time budget (activity durations + travel between stops).
        let di = 0;
        ordered.forEach((act) => {
            for (let attempts = 0; attempts < clusterDays.length; attempts++) {
                const target = clusterDays[(di + attempts) % clusterDays.length];
                const bucket = assignments.get(target.index);
                if (bucket.length >= maxPerDay) continue;

                const override = (controlPanel.perDayOverrides || []).find((o) => o.date === target.date) || {};
                let capacity = dayCapacityMinutes(controlPanel, override);
                const transfer = transfers.get(target.index);
                if (transfer) capacity -= transfer.travelMinutes;

                let used = 0;
                let prev = null;
                bucket.forEach((existing) => {
                    used += parseDurationMinutes(existing.durationMinutes ?? existing.duration);
                    const c = getCoordinates(existing);
                    if (prev && c) used += travelMinutesForKm(haversineKm(prev, c));
                    if (c) prev = c;
                });
                const here = getCoordinates(act);
                let cost = parseDurationMinutes(act.durationMinutes ?? act.duration);
                if (prev && here) cost += travelMinutesForKm(haversineKm(prev, here));

                if (capacity <= 0 || used + cost <= capacity) {
                    bucket.push(act);
                    di = (di + attempts) % clusterDays.length;
                    return;
                }
            }
            // Every day in this cluster is full — the activity does not make the cut.
        });

        dayCursor += days;
        if (cluster.centroid) previousCentroid = cluster.centroid;
    });

    return { assignments, transfers };
}

/**
 * Post-generation repair. Validates the produced days and, when they are not
 * geographically feasible, redistributes the same activities into a plan that is.
 *
 * Breaks are re-attached to whichever day they were on, so lunch placeholders survive
 * the reshuffle without ever being treated as activities.
 *
 * @returns {{ days, validation, repaired: boolean, repairedValidation: object|null }}
 */
function repairItineraryGeography(days, { controlPanel = {}, origin = null, maxPerDay = 3 } = {}) {
    const list = Array.isArray(days) ? days.map((d) => (d?.toObject ? d.toObject() : d)) : [];
    const validation = validateItineraryGeography(list, { controlPanel, isBreakEntry });

    if (validation.ok || list.length === 0) {
        return { days: list, validation, repaired: false, repairedValidation: null };
    }

    // Only rearrange days that are allowed to hold activities. A deliberately empty
    // arrival/departure day must stay empty.
    const activeDays = [];
    list.forEach((day, index) => {
        const hasActivities = countableActivities(day).length > 0;
        if (hasActivities) activeDays.push({ index, date: day?.date || '' });
    });
    if (activeDays.length === 0) {
        return { days: list, validation, repaired: false, repairedValidation: null };
    }

    // Pull every real activity out; keep breaks pinned to their original day.
    const pooled = [];
    const breaksByDay = new Map();
    list.forEach((day, index) => {
        const entries = Array.isArray(day?.activities) ? day.activities : [];
        const breaks = entries.filter(isBreakEntry);
        if (breaks.length) breaksByDay.set(index, breaks);
        entries.filter((e) => !isBreakEntry(e)).forEach((e) => pooled.push(e));
    });

    // Nothing to work with geographically — leave the plan alone rather than shuffle blindly.
    const anchored = pooled.filter((a) => getCoordinates(a) || placeLabel(a));
    if (anchored.length < 2) {
        return { days: list, validation, repaired: false, repairedValidation: null };
    }

    const { assignments, transfers } = planActivitiesAcrossDays(pooled, {
        activeDays,
        controlPanel,
        origin,
        maxPerDay: Math.max(maxPerDay, Math.ceil(pooled.length / activeDays.length)),
    });

    const rebuilt = list.map((day, index) => {
        if (!assignments.has(index)) return day;
        const activities = [...(assignments.get(index) || [])];
        const breaks = breaksByDay.get(index) || [];
        const transfer = transfers.get(index);
        return {
            ...day,
            activities: [...activities, ...breaks],
            ...(transfer ? { transferNote: describeTransfer(transfer), transfer } : {}),
        };
    });

    const repairedValidation = validateItineraryGeography(rebuilt, { controlPanel, isBreakEntry });

    // Only accept the repair if it genuinely improved things.
    if (repairedValidation.issues.length >= validation.issues.length) {
        return { days: list, validation, repaired: false, repairedValidation };
    }

    return { days: rebuilt, validation, repaired: true, repairedValidation };
}

module.exports = {
    clusterName,
    describeTransfer,
    allocateDaysToClusters,
    planActivitiesAcrossDays,
    repairItineraryGeography,
};
