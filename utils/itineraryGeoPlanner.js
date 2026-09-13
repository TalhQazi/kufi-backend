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
    travelMinutesBetween,
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
    routeMatrix = null,
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
                    travelMinutes: travelMinutesBetween(previousCentroid, cluster.centroid, routeMatrix),
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
                let capacity = dayCapacityMinutes(controlPanel, override, {
                    isArrival: target.index === 0,
                });
                const transfer = transfers.get(target.index);
                if (transfer) capacity -= transfer.travelMinutes;

                let used = 0;
                let prev = null;
                bucket.forEach((existing) => {
                    used += parseDurationMinutes(existing.durationMinutes ?? existing.duration);
                    const c = getCoordinates(existing);
                    if (prev && c) used += travelMinutesBetween(prev, c, routeMatrix);
                    if (c) prev = c;
                });
                const here = getCoordinates(act);
                let cost = parseDurationMinutes(act.durationMinutes ?? act.duration);
                if (prev && here) cost += travelMinutesBetween(prev, here, routeMatrix);

                // Skip days with no remaining time (e.g. an Egypt Cairo→Luxor flight
                // ate the window). Previously `capacity <= 0` was treated as "always
                // accept", which dumped every leftover activity onto that one day.
                if (capacity > 0 && used + cost <= capacity) {
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
 * Which day indices are allowed to hold activities.
 *
 * The arrival and departure days are opt-in/opt-out via the Control Panel:
 *   startOnArrival  false -> day 1 stays free (transfer only)
 *   endOnDeparture  false -> the last day stays free
 *
 * A single-day trip is always active — blanking it would produce an empty itinerary.
 */
function allowedDayIndices(dayCount, controlPanel = {}) {
    if (dayCount <= 0) return [];
    if (dayCount === 1) return [0];

    const startOnArrival = controlPanel.startOnArrival === true;
    const endOnDeparture = controlPanel.endOnDeparture !== false; // defaults to true

    const allowed = [];
    for (let i = 0; i < dayCount; i++) {
        if (i === 0 && !startOnArrival) continue;
        if (i === dayCount - 1 && !endOnDeparture) continue;
        allowed.push(i);
    }
    // Every day was excluded (a 2-day trip with both toggles off) — fall back to all of
    // them rather than returning a plan with nothing in it.
    return allowed.length > 0 ? allowed : Array.from({ length: dayCount }, (_, i) => i);
}

/**
 * Enforce the arrival/departure rules on an already-generated plan.
 *
 * This has to run on the result, not just inside one generator: the template-clone path
 * copies days wholesale from an older itinerary and never consulted these toggles, so
 * flipping "Start activities on arrival day" changed nothing at all.
 *
 * When the current layout violates the rules, every real activity is pooled and
 * redistributed across the allowed days through the same geographic planner, so the
 * result stays grouped by area and within each day's time budget. Breaks stay on days
 * that remain active and are dropped from days that must now be empty.
 *
 * @returns {{ days: Array, changed: boolean }}
 */
function enforceDayBoundaries(days, { controlPanel = {}, origin = null, maxPerDay = 3, routeMatrix = null } = {}) {
    const list = Array.isArray(days) ? days.map((d) => (d?.toObject ? d.toObject() : d)) : [];
    if (list.length === 0) return { days: list, changed: false };

    const allowed = allowedDayIndices(list.length, controlPanel);
    const allowedSet = new Set(allowed);

    const realOn = (day) => (Array.isArray(day?.activities) ? day.activities : []).filter((a) => !isBreakEntry(a));

    // Violation 1: activities sitting on a day that must be free.
    const misplaced = list.some((day, i) => !allowedSet.has(i) && realOn(day).length > 0);

    // Violation 2: a day that is now allowed sits empty while another allowed day holds
    // more than one activity — i.e. there is work that could move into it.
    const emptyAllowed = allowed.filter((i) => realOn(list[i]).length === 0);
    const spare = allowed.some((i) => realOn(list[i]).length > 1);
    const underfilled = emptyAllowed.length > 0 && spare;

    if (!misplaced && !underfilled) return { days: list, changed: false };

    const pooled = [];
    const breaksByDay = new Map();
    list.forEach((day, index) => {
        const entries = Array.isArray(day?.activities) ? day.activities : [];
        const breaks = entries.filter(isBreakEntry);
        if (breaks.length && allowedSet.has(index)) breaksByDay.set(index, breaks);
        entries.filter((e) => !isBreakEntry(e)).forEach((e) => pooled.push(e));
    });

    if (pooled.length === 0) return { days: list, changed: false };

    const activeDays = allowed.map((index) => ({ index, date: list[index]?.date || '' }));
    const { assignments, transfers } = planActivitiesAcrossDays(pooled, {
        activeDays,
        controlPanel,
        origin,
        maxPerDay: Math.max(maxPerDay, Math.ceil(pooled.length / activeDays.length)),
        routeMatrix,
    });

    const rebuilt = list.map((day, index) => {
        if (!allowedSet.has(index)) {
            // Must be free: strip activities and breaks, and explain why.
            const isArrival = index === 0;
            const isDeparture = index === list.length - 1;
            return {
                ...day,
                activities: [],
                ...(isArrival ? { arrivalNote: day.arrivalNote || 'Arrival Day — Free day. Airport to hotel transfer provided.' } : {}),
                ...(isDeparture ? { departureNote: day.departureNote || 'Departure Day — Hotel to airport transfer provided.' } : {}),
            };
        }
        const transfer = transfers.get(index);
        return {
            ...day,
            activities: [...(assignments.get(index) || []), ...(breaksByDay.get(index) || [])],
            ...(transfer ? { transferNote: describeTransfer(transfer), transfer } : {}),
        };
    });

    return { days: rebuilt, changed: true };
}

function priceOf(activity) {
    return Number(activity?.price) || 0;
}

/** Famous / iconic title signals — used to prefer must-see experiences over filler. */
const FAMOUS_TITLE_RE = /pyramid|sphinx|museum|karnak|burj|eiffel|colosseum|valley of the kings|abu simbel|temple|citadel|bazaar|nile cruise|snorkel|great wall|petra|angkor/i;

/** Activity spend should reach at least this fraction of the computed ceiling. */
const BUDGET_UTILIZATION_TARGET = 0.95;

function isFamousActivity(act) {
    const title = String(act?.title || '').toLowerCase();
    const category = String(act?.category || '').toLowerCase();
    if (FAMOUS_TITLE_RE.test(title)) return true;
    if (/landmark|iconic|famous|must.?see|heritage|historic/i.test(category)) return true;
    return (Number(act?.rating) || 0) >= 4.7 && (Number(act?.reviews) || 0) >= 20;
}

/**
 * Higher = more desirable for itinerary generation.
 * Blends landmark status, rating, review volume, and a light price signal so premium
 * experiences beat $12 filler without optimising purely for cost.
 */
function activityQualityScore(act) {
    let score = 0;
    const title = String(act?.title || '').toLowerCase();
    if (FAMOUS_TITLE_RE.test(title)) score += 1000;
    const category = String(act?.category || '').toLowerCase();
    if (/landmark|iconic|famous|tour|heritage|culture/i.test(category)) score += 200;
    score += (Number(act?.rating) || 0) * 80;
    score += Math.min(Number(act?.reviews) || 0, 150);
    score += Math.min(priceOf(act), 250) * 0.4;
    return score;
}

function compareActivitiesByQuality(a, b) {
    const diff = activityQualityScore(b) - activityQualityScore(a);
    if (diff !== 0) return diff;
    return (Number(b.rating) || 0) - (Number(a.rating) || 0);
}

function spendOfDays(days) {
    return (Array.isArray(days) ? days : []).reduce(
        (total, day) => total + countableActivities(day).reduce((sum, act) => sum + priceOf(act), 0),
        0
    );
}

function markUsedIds(used, activity) {
    [activity?.activityId, activity?._id, activity?.title].forEach((value) => {
        const key = String(value || '').trim();
        if (key && key !== 'null' && key !== 'undefined') used.add(key);
    });
}

function catalogueEntryFrom(act) {
    return {
        activityId: String(act._id),
        title: act.title,
        description: act.description,
        location: act.location || act.city,
        coordinates: getCoordinates(act) || undefined,
        duration: act.duration,
        durationMinutes: act.durationMinutes,
        price: Number(act.price) || 0,
        category: act.category || 'general',
        image: act._id ? `/api/activities/${act._id}/image` : (act.image || ''),
        isBreak: false,
        isSupplierOnly: true,
        backfilled: true,
    };
}

/**
 * Whether a proposed activity list still fits one day's hours and stays in one area.
 */
function dayWouldFit(day, activities, controlPanel = {}, routeMatrix = null, dayFlags = {}) {
    const real = (Array.isArray(activities) ? activities : []).filter((a) => a && !isBreakEntry(a));
    const override = (controlPanel.perDayOverrides || []).find((o) => o.date === day?.date) || {};
    const capacity = dayCapacityMinutes(controlPanel, override, dayFlags);
    let used = 0;
    let prev = null;
    for (const act of real) {
        used += parseDurationMinutes(act.durationMinutes ?? act.duration);
        const coords = getCoordinates(act);
        if (prev && coords) {
            const km = haversineKm(prev, coords);
            if (km > SAME_AREA_RADIUS_KM) return false;
            used += travelMinutesBetween(prev, coords, routeMatrix);
        }
        if (coords) prev = coords;
    }
    if (capacity > 0 && used > capacity) return false;
    return true;
}

/**
 * Schedule as much of the catalogue as the trip can genuinely hold.
 *
 * Two phases:
 *   1. every allowed empty day gets at most one activity that still fits the budget, and
 *   2. days with spare capacity and remaining budget are topped up from whatever is left.
 *
 * Whichever generator ran can leave gaps: the model may skip days, and the
 * database-template path clones an older, shorter itinerary and pads the remainder with
 * blanks. Spreading the whole remaining catalogue onto those blanks is what produced a
 * "maximum itinerary" when budget tolerance was 0%. One-per-empty-day respects the
 * ceiling; leftover catalogue is only added in phase 2 if spend still has headroom.
 *
 * Candidates are drawn from the catalogue, skipping anything already used, and chosen
 * nearest-first so filling can never wreck the route — an activity more than
 * SAME_AREA_RADIUS_KM from where a day ends is never added to it.
 *
 * @returns {{ days: Array, filled: number, toppedUp: number }}
 */
function fillDaysFromCatalogue(days, catalogue, { controlPanel = {}, maxPerDay = 3, budget, routeMatrix = null } = {}) {
    const list = Array.isArray(days) ? days.map((d) => (d?.toObject ? d.toObject() : d)) : [];
    if (list.length === 0) return { days: list, filled: 0, toppedUp: 0 };

    const allowed = allowedDayIndices(list.length, controlPanel);
    const emptyIdx = allowed.filter((i) => countableActivities(list[i]).length === 0);
    // No early return when nothing is empty: phase 2 still has to use up spare capacity.

    const used = new Set();
    list.forEach((d) => (d.activities || []).forEach((a) => {
        if (a?.activityId) used.add(String(a.activityId));
    }));

    // No early return when the pool is empty: that is precisely when the loop below has
    // to rebalance instead of add.
    const pool = (Array.isArray(catalogue) ? catalogue : []).filter((a) => a?._id && !used.has(String(a._id)));

    /** Coordinates of the nearest already-populated day, searching outwards. */
    const anchorFor = (index) => {
        for (let offset = 1; offset < list.length; offset++) {
            for (const i of [index - offset, index + offset]) {
                if (i < 0 || i >= list.length) continue;
                const coords = countableActivities(list[i]).map(getCoordinates).filter(Boolean);
                if (coords.length) return coords[coords.length - 1];
            }
        }
        return null;
    };

    const rebuilt = [...list];
    let filled = 0;
    let remainingDays = emptyIdx.length;

    const toEntry = catalogueEntryFrom;

    for (const index of emptyIdx) {
        const anchor = anchorFor(index);

        const chosen = [];
        let cursor = anchor;
        // One activity per empty day. Using ceil(pool / emptyDays) dumped the whole
        // catalogue onto the trip, which ignored the supplier's budget ceiling.
        while (chosen.length < 1 && pool.length > 0) {
            let bestIdx = -1;
            let bestScore = Infinity;
            pool.forEach((act, i) => {
                if (typeof budget === 'number') {
                    const spent = spendOfDays(rebuilt) + chosen.reduce((sum, a) => sum + priceOf(a), 0);
                    if (spent + priceOf(act) > budget) return;
                }
                const coords = getCoordinates(act);
                const d = cursor && coords ? haversineKm(cursor, coords) : null;
                // Prefer top-rated / famous activities nearby, not the closest cheap filler.
                const geo = d === null ? 50_000 : d;
                const score = geo - activityQualityScore(act) * 20;
                if (score < bestScore) {
                    bestScore = score;
                    bestIdx = i;
                }
            });
            if (bestIdx === -1) break;
            const [next] = pool.splice(bestIdx, 1);
            chosen.push(next);
            const c = getCoordinates(next);
            if (c) cursor = c;
        }

        if (chosen.length === 0) {
            // The catalogue is exhausted. Borrow a surplus activity from a day that has
            // more than one — with a fixed number of activities and more days than that,
            // the only way every day gets something is to spread what already exists.
            const donorIdx = allowed
                .filter((i) => countableActivities(rebuilt[i]).length > 1)
                .sort((x, y) => countableActivities(rebuilt[y]).length - countableActivities(rebuilt[x]).length)[0];
            if (donorIdx === undefined) continue;

            const donorActs = countableActivities(rebuilt[donorIdx]);
            // Take the one nearest this day's neighbours so the route stays sensible.
            let pick = donorActs[donorActs.length - 1];
            if (anchor) {
                let best = Infinity;
                donorActs.forEach((act) => {
                    const c = getCoordinates(act);
                    const d = c ? haversineKm(anchor, c) : null;
                    const score = d === null ? Number.MAX_SAFE_INTEGER : d;
                    if (score < best) { best = score; pick = act; }
                });
            }

            rebuilt[donorIdx] = {
                ...rebuilt[donorIdx],
                activities: (rebuilt[donorIdx].activities || []).filter((a) => a !== pick),
            };
            rebuilt[index] = {
                ...rebuilt[index],
                activities: [...(rebuilt[index].activities || []), { ...pick, backfilled: true }],
            };
            filled += 1;
            remainingDays -= 1;
            continue;
        }

        rebuilt[index] = {
            ...rebuilt[index],
            activities: [
                ...(rebuilt[index].activities || []),
                ...chosen.map((act) => toEntry(act)),
            ],
        };
        filled += 1;
        remainingDays -= 1;
    }

    // ── Phase 2: top up days that still have room ───────────────────────────────
    // Filling only EMPTY days left activities stranded in the pool while most days sat
    // at 2 of 3 activities using half their hours — a Lebanon trip used 12 of 13 and
    // spent $1,960 of an available $2,885. Anything the day can genuinely fit should be
    // scheduled; the budget pass afterwards decides whether it stays.
    let toppedUp = 0;
    let progress = true;
    while (pool.length > 0 && progress) {
        progress = false;

        for (const index of allowed) {
            if (pool.length === 0) break;

            const current = countableActivities(rebuilt[index]);
            if (current.length >= maxPerDay) continue;

            const override = (controlPanel.perDayOverrides || []).find((o) => o.date === rebuilt[index]?.date) || {};
            const capacity = dayCapacityMinutes(controlPanel, override, {
                isArrival: index === 0,
                isDeparture: index === rebuilt.length - 1,
            });

            // Minutes the day already needs, travel between stops included.
            let used = 0;
            let prev = null;
            current.forEach((a) => {
                used += parseDurationMinutes(a.durationMinutes ?? a.duration);
                const c = getCoordinates(a);
                if (prev && c) used += travelMinutesBetween(prev, c, routeMatrix);
                if (c) prev = c;
            });

            // Unused activity in the same area — prefer famous / top-rated, and lean on
            // higher prices when there is still a large budget gap to close.
            const remainingBudget = typeof budget === 'number' ? budget - spendOfDays(rebuilt) : null;
            const budgetPressure = remainingBudget != null && budget > 0
                ? Math.min(1, remainingBudget / budget)
                : 0;
            let bestIdx = -1;
            let bestScore = Infinity;
            pool.forEach((act, i) => {
                const c = getCoordinates(act);
                const d = prev && c ? haversineKm(prev, c) : null;
                if (d !== null && d > SAME_AREA_RADIUS_KM) return;
                const p = priceOf(act);
                if (remainingBudget != null && p > remainingBudget) return;
                const geoScore = d === null ? 10_000 : d;
                const score = geoScore
                    - activityQualityScore(act) * (12 + budgetPressure * 8)
                    - p * budgetPressure * 25;
                if (score < bestScore) {
                    bestScore = score;
                    bestIdx = i;
                }
            });
            if (bestIdx === -1) continue;

            const candidate = pool[bestIdx];
            const c = getCoordinates(candidate);
            const cost = parseDurationMinutes(candidate.durationMinutes ?? candidate.duration)
                + (prev && c ? travelMinutesBetween(prev, c, routeMatrix) : 0);

            if (capacity > 0 && used + cost > capacity) continue; // genuinely no time

            pool.splice(bestIdx, 1);
            rebuilt[index] = {
                ...rebuilt[index],
                activities: [...(rebuilt[index].activities || []), toEntry(candidate)],
            };
            toppedUp += 1;
            progress = true;
        }
    }

    return { days: rebuilt, filled, toppedUp };
}

/**
 * Choose which activities to schedule.
 *
 * Two goals that pull against each other:
 *   - every day of the trip must get something (the budget is advisory, not a filter);
 *   - the total should still track the traveller's budget.
 *
 * Doing only the first made the budget inert — a 6-day Lebanon trip cost $1,960 whether
 * the traveller asked for $500 or $5,000. Doing only the second emptied most of a long
 * trip. The days are filled with a mix of famous / top-rated activities first, then
 * topped up with more quality picks until the budget ceiling is reached.
 *
 * @param {Array}  activities   candidates
 * @param {object} options
 * @param {Array}  options.required   traveller-selected; always included, never priced out
 * @param {number} options.budget     advisory ceiling for activity spend
 * @param {number} options.activeDays days that may hold activities
 * @param {number} options.maxPerDay
 */
/** How many days of this trip may actually hold activities. */
function countActiveDays(itinerary, tripDays) {
    const cp = itinerary?.controlPanel?.toObject ? itinerary.controlPanel.toObject() : (itinerary?.controlPanel || {});
    if (tripDays <= 1) return 1;
    let active = tripDays;
    if (!cp.startOnArrival) active -= 1;
    if (cp.endOnDeparture === false) active -= 1;
    return Math.max(1, active);
}

function selectActivitiesForTrip(activities, { required = [], budget, activeDays = 1, maxPerDay = 3 } = {}) {
    const all = (Array.isArray(activities) ? activities : []).filter(Boolean);
    const requiredIds = new Set((required || []).map((a) => String(a?._id)).filter(Boolean));

    const selected = [...(required || [])];
    let total = selected.reduce((sum, a) => sum + (Number(a.price) || 0), 0);

    const rest = all.filter((a) => !requiredIds.has(String(a._id)));
    const price = (a) => Number(a.price) || 0;
    const byQuality = [...rest].sort(compareActivitiesByQuality);

    // Stage 1 — one famous / top-rated activity per day within the budget ceiling.
    const targetCount = Math.max(selected.length, activeDays);
    for (const a of byQuality) {
        if (selected.length >= targetCount) break;
        if (typeof budget === 'number' && total + price(a) > budget) continue;
        selected.push(a);
        total += price(a);
    }

    // Stage 2 — fill remaining slots with more quality picks, never exceeding the ceiling.
    const maxWanted = Math.max(activeDays, activeDays * maxPerDay);
    const chosenIds = new Set(selected.map((a) => String(a._id)));
    const remaining = rest
        .filter((a) => !chosenIds.has(String(a._id)))
        .sort(compareActivitiesByQuality);

    for (const act of remaining) {
        if (selected.length >= maxWanted) break;
        const next = total + price(act);
        if (typeof budget === 'number' && next > budget) continue;
        selected.push(act);
        total = next;
    }

    return selected;
}

/**
 * Bring the plan's cost back toward the traveller's budget without emptying any day.
 *
 * Runs on every generation path, which is the point: selection logic inside one generator
 * is bypassed by the others. The database-template path clones an older itinerary
 * wholesale, so a 6-day Lebanon trip cost $1,960 whether the traveller asked for $500 or
 * $5,000 — the budget was completely inert.
 *
 * Surplus activities are dropped most-expensive-first. Days may go empty when that is
 * the only way to honour the supplier's ceiling (0% tolerance = the traveller's budget;
 * N% = budget × (1 + N/100)). Keeping one activity on every day was what left 0%
 * tolerance generating a maximum itinerary.
 *
 * @returns {{ days: Array, removed: number, spend: number }}
 */
function trimToBudget(days, { budget, controlPanel = {} } = {}) {
    const list = Array.isArray(days) ? days.map((d) => (d?.toObject ? d.toObject() : d)) : [];
    const priceOf = (a) => Number(a?.price) || 0;
    const spendOf = (ds) => ds.reduce((t, d) => t + countableActivities(d).reduce((s, a) => s + priceOf(a), 0), 0);

    if (typeof budget !== 'number' || budget < 0 || list.length === 0) {
        return { days: list, removed: 0, spend: spendOf(list) };
    }

    const allowed = new Set(allowedDayIndices(list.length, controlPanel));
    const rebuilt = [...list];
    let spend = spendOf(rebuilt);
    let removed = 0;

    // Bounded by the number of activities present, so it always terminates.
    for (let guard = 0; guard < 500 && spend > budget; guard++) {
        let bestDay = -1;
        let bestAct = null;
        let bestPrice = -1;

        rebuilt.forEach((day, i) => {
            if (!allowed.has(i)) return;
            const real = countableActivities(day);
            if (real.length === 0) return;
            real.forEach((act) => {
                if (priceOf(act) > bestPrice) {
                    bestPrice = priceOf(act);
                    bestAct = act;
                    bestDay = i;
                }
            });
        });

        if (bestDay === -1 || !bestAct || bestPrice <= 0) break;

        rebuilt[bestDay] = {
            ...rebuilt[bestDay],
            activities: (rebuilt[bestDay].activities || []).filter((a) => a !== bestAct),
        };
        spend -= bestPrice;
        removed += 1;
    }

    return { days: rebuilt, removed, spend };
}

/**
 * Raise a plan toward the traveller's activity budget using famous / top-rated picks.
 *
 * `trimToBudget` only cuts overspend. This pass adds unused catalogue items, then swaps
 * weak filler for better in-area options, until spend is close to the ceiling without
 * going over it. Quality (landmarks, rating, reviews) leads; price is a tie-breaker.
 *
 * @returns {{ days: Array, added: number, swapped: number, spend: number }}
 */
function spendUpToBudget(days, catalogue, { budget, controlPanel = {}, maxPerDay = 3, routeMatrix = null } = {}) {
    const list = Array.isArray(days) ? days.map((d) => (d?.toObject ? d.toObject() : d)) : [];
    let spend = spendOfDays(list);
    if (typeof budget !== 'number' || budget <= 0 || list.length === 0) {
        return { days: list, added: 0, swapped: 0, spend };
    }

    const targetSpend = budget;
    const minSpend = Math.floor(budget * BUDGET_UTILIZATION_TARGET);
    if (spend >= minSpend) {
        return { days: list, added: 0, swapped: 0, spend };
    }

    const allowed = allowedDayIndices(list.length, controlPanel);
    const used = new Set();
    list.forEach((day) => (day.activities || []).forEach((act) => markUsedIds(used, act)));

    const pool = (Array.isArray(catalogue) ? catalogue : []).filter((a) => {
        if (!a?._id) return false;
        if (used.has(String(a._id)) || used.has(String(a.title || '').trim())) return false;
        return true;
    });
    const rebuilt = [...list];
    let added = 0;
    let swapped = 0;

    const proposedList = (day, extra) => [...countableActivities(day), extra];
    const proposedSwap = (day, oldAct, newAct) => countableActivities(day).map((act) => (act === oldAct ? newAct : act));

    const pickScore = (act, price) => {
        const quality = activityQualityScore(act);
        const headroom = Math.max(0, targetSpend - spend);
        const gapAfter = headroom - price;
        const budgetFit = gapAfter >= 0 ? price : -1_000_000;
        return quality * 1000 + budgetFit * 5 + price;
    };

    // Phase 1 — add famous / top-rated unused activities that still fit the day.
    let progress = true;
    let addGuard = 0;
    const maxAddPasses = Math.max(100, pool.length * allowed.length * maxPerDay);
    while (progress && spend < minSpend && pool.length > 0 && addGuard < maxAddPasses) {
        addGuard += 1;
        progress = false;
        let best = null;
        allowed.forEach((index) => {
            const day = rebuilt[index];
            if (countableActivities(day).length >= maxPerDay) return;
            pool.forEach((act, poolIdx) => {
                const price = priceOf(act);
                if (price <= 0 || spend + price > budget) return;
                const entry = catalogueEntryFrom(act);
                if (!dayWouldFit(day, proposedList(day, entry), controlPanel, routeMatrix, {
                    isArrival: index === 0,
                    isDeparture: index === rebuilt.length - 1,
                })) return;
                const score = pickScore(act, price);
                if (!best || score > best.score) {
                    best = { index, poolIdx, price, entry, score };
                }
            });
        });
        if (!best) break;
        const [picked] = pool.splice(best.poolIdx, 1);
        markUsedIds(used, picked);
        rebuilt[best.index] = {
            ...rebuilt[best.index],
            activities: [...(rebuilt[best.index].activities || []), best.entry],
        };
        spend += best.price;
        added += 1;
        progress = true;
    }

    // Phase 2 — swap weak filler for a better in-area option that also raises spend.
    progress = true;
    let swapGuard = 0;
    const maxSwapPasses = Math.max(100, pool.length * allowed.length * maxPerDay);
    while (progress && spend < minSpend && pool.length > 0 && swapGuard < maxSwapPasses) {
        swapGuard += 1;
        progress = false;
        let bestSwap = null;
        allowed.forEach((index) => {
            const day = rebuilt[index];
            countableActivities(day).forEach((oldAct) => {
                const oldPrice = priceOf(oldAct);
                const oldQuality = activityQualityScore(oldAct);
                pool.forEach((cand, poolIdx) => {
                    const newPrice = priceOf(cand);
                    const newQuality = activityQualityScore(cand);
                    const delta = newPrice - oldPrice;
                    if (delta <= 0 || spend + delta > budget) return;
                    const entry = catalogueEntryFrom(cand);
                    if (!dayWouldFit(day, proposedSwap(day, oldAct, entry), controlPanel, routeMatrix, {
                        isArrival: index === 0,
                        isDeparture: index === rebuilt.length - 1,
                    })) return;
                    const oldCoords = getCoordinates(oldAct);
                    const newCoords = getCoordinates(cand);
                    if (oldCoords && newCoords && haversineKm(oldCoords, newCoords) > SAME_AREA_RADIUS_KM) return;
                    const swapScore = (newQuality - oldQuality) * 1000 + delta;
                    if (!bestSwap || swapScore > bestSwap.swapScore) {
                        bestSwap = { index, oldAct, poolIdx, delta, entry, cand, swapScore };
                    }
                });
            });
        });
        if (!bestSwap) break;
        const [picked] = pool.splice(bestSwap.poolIdx, 1);
        const oldId = String(bestSwap.oldAct?.activityId || bestSwap.oldAct?._id || '').trim();
        rebuilt[bestSwap.index] = {
            ...rebuilt[bestSwap.index],
            activities: (rebuilt[bestSwap.index].activities || []).map((act) => (
                act === bestSwap.oldAct ? bestSwap.entry : act
            )),
        };
        if (oldId) {
            used.delete(oldId);
            used.delete(String(bestSwap.oldAct?.title || '').trim());
            used.delete(String(bestSwap.oldAct?._id || '').trim());
            const original = (Array.isArray(catalogue) ? catalogue : []).find((a) => (
                String(a._id) === oldId || String(a.title || '').trim() === String(bestSwap.oldAct?.title || '').trim()
            ));
            if (original) pool.push(original);
        }
        markUsedIds(used, picked);
        spend += bestSwap.delta;
        swapped += 1;
        progress = true;
    }

    // Phase 3 — pack any remaining day capacity with the priciest fits to reach the ceiling.
    progress = true;
    let packGuard = 0;
    const maxPackPasses = Math.max(100, pool.length * allowed.length * maxPerDay);
    while (progress && spend < targetSpend && pool.length > 0 && packGuard < maxPackPasses) {
        packGuard += 1;
        progress = false;
        let best = null;
        allowed.forEach((index) => {
            const day = rebuilt[index];
            if (countableActivities(day).length >= maxPerDay) return;
            pool.forEach((act, poolIdx) => {
                const price = priceOf(act);
                if (price <= 0 || spend + price > budget) return;
                const entry = catalogueEntryFrom(act);
                if (!dayWouldFit(day, proposedList(day, entry), controlPanel, routeMatrix, {
                    isArrival: index === 0,
                    isDeparture: index === rebuilt.length - 1,
                })) return;
                if (!best || price > best.price) {
                    best = { index, poolIdx, price, entry };
                }
            });
        });
        if (!best) break;
        const [picked] = pool.splice(best.poolIdx, 1);
        markUsedIds(used, picked);
        rebuilt[best.index] = {
            ...rebuilt[best.index],
            activities: [...(rebuilt[best.index].activities || []), best.entry],
        };
        spend += best.price;
        added += 1;
        progress = true;
    }

    // Phase 4 — last pass: swap for the largest price increase in-area until the ceiling.
    progress = true;
    let boostGuard = 0;
    const maxBoostPasses = Math.max(100, pool.length * allowed.length * maxPerDay);
    while (progress && spend < targetSpend && pool.length > 0 && boostGuard < maxBoostPasses) {
        boostGuard += 1;
        progress = false;
        let bestSwap = null;
        allowed.forEach((index) => {
            const day = rebuilt[index];
            countableActivities(day).forEach((oldAct) => {
                const oldPrice = priceOf(oldAct);
                pool.forEach((cand, poolIdx) => {
                    const newPrice = priceOf(cand);
                    const delta = newPrice - oldPrice;
                    if (delta <= 0 || spend + delta > budget) return;
                    const entry = catalogueEntryFrom(cand);
                    if (!dayWouldFit(day, proposedSwap(day, oldAct, entry), controlPanel, routeMatrix, {
                        isArrival: index === 0,
                        isDeparture: index === rebuilt.length - 1,
                    })) return;
                    const oldCoords = getCoordinates(oldAct);
                    const newCoords = getCoordinates(cand);
                    if (oldCoords && newCoords && haversineKm(oldCoords, newCoords) > SAME_AREA_RADIUS_KM) return;
                    if (!bestSwap || delta > bestSwap.delta) {
                        bestSwap = { index, oldAct, poolIdx, delta, entry, cand };
                    }
                });
            });
        });
        if (!bestSwap) break;
        const [picked] = pool.splice(bestSwap.poolIdx, 1);
        const oldId = String(bestSwap.oldAct?.activityId || bestSwap.oldAct?._id || '').trim();
        rebuilt[bestSwap.index] = {
            ...rebuilt[bestSwap.index],
            activities: (rebuilt[bestSwap.index].activities || []).map((act) => (
                act === bestSwap.oldAct ? bestSwap.entry : act
            )),
        };
        if (oldId) {
            used.delete(oldId);
            used.delete(String(bestSwap.oldAct?.title || '').trim());
            used.delete(String(bestSwap.oldAct?._id || '').trim());
            const original = (Array.isArray(catalogue) ? catalogue : []).find((a) => (
                String(a._id) === oldId || String(a.title || '').trim() === String(bestSwap.oldAct?.title || '').trim()
            ));
            if (original) pool.push(original);
        }
        markUsedIds(used, picked);
        spend += bestSwap.delta;
        swapped += 1;
        progress = true;
    }

    return { days: rebuilt, added, swapped, spend };
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
function repairItineraryGeography(days, { controlPanel = {}, origin = null, maxPerDay = 3, routeMatrix = null } = {}) {
    const list = Array.isArray(days) ? days.map((d) => (d?.toObject ? d.toObject() : d)) : [];
    const validation = validateItineraryGeography(list, { controlPanel, isBreakEntry, routeMatrix });

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
        routeMatrix,
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

    const repairedValidation = validateItineraryGeography(rebuilt, { controlPanel, isBreakEntry, routeMatrix });

    // Never accept a repair that THREW AWAY activities. planActivitiesAcrossDays gives each
    // geographic cluster a fixed slice of days and silently drops any stop that does not fit
    // that slice — on an 11-day multi-city trip a packed 4,3,4,4,4,4,3,4,3,3 collapsed to
    // 4,4,3,2,4,1,2,3,4,1, losing 11 activities. The fill step already produced coherent,
    // time-respecting days; a "geography fix" that empties them is worse than the problem.
    // Overflow is handled losslessly later by spillOverflowToNextDays.
    const beforeCount = pooled.length;
    const afterCount = rebuilt.reduce((n, d) => n + countableActivities(d).length, 0);
    if (afterCount < beforeCount) {
        return { days: list, validation, repaired: false, repairedValidation };
    }

    // Only accept the repair if it genuinely improved things.
    if (repairedValidation.issues.length >= validation.issues.length) {
        return { days: list, validation, repaired: false, repairedValidation };
    }

    return { days: rebuilt, validation, repaired: true, repairedValidation };
}

/**
 * When the AI (or filler) packed every day from one area, pull unused catalogue clusters
 * onto empty / under-used days so a Lebanon trip is not Beirut-only for 3 days.
 *
 * @returns {{ days: Array, diversified: boolean }}
 */
function diversifyItineraryAreas(days, catalogue, {
    controlPanel = {},
    origin = null,
    maxPerDay = 3,
    routeMatrix = null,
} = {}) {
    const list = Array.isArray(days) ? days.map((d) => (d?.toObject ? d.toObject() : d)) : [];
    if (list.length === 0) return { days: list, diversified: false };

    const allowed = allowedDayIndices(list.length, controlPanel);
    if (allowed.length < 2) return { days: list, diversified: false };

    const scheduled = [];
    list.forEach((day) => countableActivities(day).forEach((a) => scheduled.push(a)));

    const usedIds = new Set(scheduled.map((a) => String(a.activityId || a._id || '')).filter(Boolean));
    const catalogueList = (Array.isArray(catalogue) ? catalogue : []).filter((a) => a?._id);
    const availableClusters = clusterByGeography(catalogueList).filter((c) => c.centroid);
    if (availableClusters.length < 2) return { days: list, diversified: false };

    const usedClusters = clusterByGeography(scheduled.filter((a) => getCoordinates(a)));
    const usedKeys = new Set();
    usedClusters.forEach((uc) => {
        availableClusters.forEach((ac) => {
            if (!ac.centroid || !uc.centroid) return;
            const d = haversineKm(ac.centroid, uc.centroid);
            if (d !== null && d <= SAME_AREA_RADIUS_KM) usedKeys.add(ac.key);
        });
    });

    const unused = availableClusters.filter((c) => !usedKeys.has(c.key));
    if (unused.length === 0) return { days: list, diversified: false };

    // Prefer empty allowed days, then days with spare capacity.
    const targetDays = allowed
        .map((index) => ({ index, date: list[index]?.date || '', count: countableActivities(list[index]).length }))
        .sort((a, b) => a.count - b.count);

    const additions = [];
    unused.forEach((cluster) => {
        const pick = [...cluster.items]
            .filter((a) => !usedIds.has(String(a._id)))
            .sort((a, b) => (Number(b.rating) || 0) - (Number(a.rating) || 0))[0];
        if (!pick) return;
        usedIds.add(String(pick._id));
        additions.push(catalogueEntryFrom(pick));
    });
    if (additions.length === 0) return { days: list, diversified: false };

    const pool = [...scheduled, ...additions];
    const activeDays = allowed.map((index) => ({ index, date: list[index]?.date || '' }));
    const { assignments, transfers } = planActivitiesAcrossDays(pool, {
        activeDays,
        controlPanel,
        origin,
        maxPerDay,
        routeMatrix,
    });

    const breaksByDay = new Map();
    list.forEach((day, index) => {
        const breaks = (day.activities || []).filter(isBreakEntry);
        if (breaks.length) breaksByDay.set(index, breaks);
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

    // Keep the diversified plan only when it actually uses more areas.
    const afterClusters = clusterByGeography(
        rebuilt.flatMap((d) => countableActivities(d).filter((a) => getCoordinates(a)))
    );
    if (afterClusters.length <= usedClusters.length) {
        return { days: list, diversified: false };
    }

    // ...and only when it does not COST us activities. planActivitiesAcrossDays re-plans the
    // whole trip to maximise area spread, which on a big multi-area destination (Egypt)
    // scattered stops one-per-day and silently dropped the ones that no longer "fit" its
    // area-per-day layout — a densely packed 4,3,3,3,3,3,3,3 collapsed to 4,1,1,1,1,1,3,2.
    // Diversity must never trade away a fuller plan: reject it if fewer activities land.
    const beforeCount = scheduled.length;
    const afterCount = rebuilt.reduce((n, d) => n + countableActivities(d).length, 0);
    if (afterCount < beforeCount) {
        return { days: list, diversified: false };
    }

    return { days: rebuilt, diversified: true };
}

/**
 * Move activities that do not fit a day's activity start→end window onto later days.
 *
 * Walks days in order. Keeps as many activities as the Control Panel hours allow
 * (durations + travel). Anything that would overrun is pushed to the next allowed day.
 * If the last day overflows, remaining activities stay there (nowhere else to go).
 *
 * @returns {{ days: Array, spilled: number }}
 */
function spillOverflowToNextDays(days, {
    controlPanel = {},
    maxPerDay = 4,
    routeMatrix = null,
} = {}) {
    const list = Array.isArray(days) ? days.map((d) => (d?.toObject ? d.toObject() : d)) : [];
    if (list.length === 0) return { days: list, spilled: 0 };

    const allowed = allowedDayIndices(list.length, controlPanel);
    const allowedSet = new Set(allowed);
    const rebuilt = list.map((day) => ({
        ...day,
        activities: Array.isArray(day.activities) ? [...day.activities] : [],
    }));

    let spilled = 0;
    let carry = [];

    for (let index = 0; index < rebuilt.length; index++) {
        const day = rebuilt[index];
        const breaks = (day.activities || []).filter(isBreakEntry);
        const real = [
            ...carry,
            ...(day.activities || []).filter((a) => !isBreakEntry(a)),
        ];
        carry = [];

        if (!allowedSet.has(index)) {
            // Arrival/departure locked empty — push everything forward.
            if (real.length) {
                carry = real;
                spilled += real.length;
            }
            rebuilt[index] = { ...day, activities: [...breaks] };
            continue;
        }

        const kept = [];
        const dayFlags = {
            isArrival: index === 0,
            isDeparture: index === rebuilt.length - 1,
        };

        for (const act of real) {
            const proposed = [...kept, act];
            const fitsHours = dayWouldFit(day, proposed, controlPanel, routeMatrix, dayFlags);
            const fitsCount = proposed.length <= maxPerDay;
            if (fitsHours && fitsCount) {
                kept.push(act);
            } else {
                carry.push(act);
                spilled += 1;
            }
        }

        rebuilt[index] = { ...day, activities: [...kept, ...breaks] };
    }

    // Nowhere left to spill — put leftovers back on the last allowed day.
    if (carry.length && allowed.length) {
        const last = allowed[allowed.length - 1];
        const day = rebuilt[last];
        const breaks = (day.activities || []).filter(isBreakEntry);
        const real = countableActivities(day);
        rebuilt[last] = {
            ...day,
            activities: [...real, ...carry, ...breaks],
        };
    }

    return { days: rebuilt, spilled };
}

module.exports = {
    clusterName,
    describeTransfer,
    allowedDayIndices,
    enforceDayBoundaries,
    fillDaysFromCatalogue,
    trimToBudget,
    spendUpToBudget,
    selectActivitiesForTrip,
    countActiveDays,
    activityQualityScore,
    isFamousActivity,
    compareActivitiesByQuality,
    allocateDaysToClusters,
    planActivitiesAcrossDays,
    repairItineraryGeography,
    diversifyItineraryAreas,
    spillOverflowToNextDays,
};
