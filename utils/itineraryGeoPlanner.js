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
function enforceDayBoundaries(days, { controlPanel = {}, origin = null, maxPerDay = 3 } = {}) {
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

/**
 * Schedule as much of the catalogue as the trip can genuinely hold.
 *
 * Two phases:
 *   1. every allowed day gets at least one activity, and
 *   2. days with spare capacity are topped up from whatever is left.
 *
 * Whichever generator ran can leave gaps: the model may skip days, and the
 * database-template path clones an older, shorter itinerary and pads the remainder with
 * blanks. The budget no longer trims anything, so an empty day now means "nothing was
 * assigned here", not "nothing was affordable" — and a supplier expects every day of the
 * trip to have something in it.
 *
 * Candidates are drawn from the catalogue, skipping anything already used, and chosen
 * nearest-first so filling can never wreck the route — an activity more than
 * SAME_AREA_RADIUS_KM from where a day ends is never added to it.
 *
 * @returns {{ days: Array, filled: number, toppedUp: number }}
 */
function fillDaysFromCatalogue(days, catalogue, { controlPanel = {}, maxPerDay = 3 } = {}) {
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

    for (const index of emptyIdx) {
        // Spread what is left evenly rather than dumping it all on the first empty day.
        const share = pool.length === 0
            ? 0
            : Math.max(1, Math.min(maxPerDay, Math.ceil(pool.length / remainingDays)));
        const anchor = anchorFor(index);

        const chosen = [];
        let cursor = anchor;
        while (chosen.length < share && pool.length > 0) {
            let bestIdx = 0;
            let bestScore = Infinity;
            pool.forEach((act, i) => {
                const coords = getCoordinates(act);
                const d = cursor && coords ? haversineKm(cursor, coords) : null;
                const score = d === null ? Number.MAX_SAFE_INTEGER - i : d;
                if (score < bestScore) {
                    bestScore = score;
                    bestIdx = i;
                }
            });
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
                ...chosen.map((act) => ({
                    activityId: String(act._id),
                    title: act.title,
                    description: act.description,
                    location: act.location || act.city,
                    coordinates: getCoordinates(act) || undefined,
                    duration: act.duration,
                    price: Number(act.price) || 0,
                    category: act.category || 'general',
                    isBreak: false,
                    isSupplierOnly: true,
                    backfilled: true,
                })),
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
    const toEntry = (act) => ({
        activityId: String(act._id),
        title: act.title,
        description: act.description,
        location: act.location || act.city,
        coordinates: getCoordinates(act) || undefined,
        duration: act.duration,
        price: Number(act.price) || 0,
        category: act.category || 'general',
        isBreak: false,
        isSupplierOnly: true,
        backfilled: true,
    });

    let toppedUp = 0;
    let progress = true;
    while (pool.length > 0 && progress) {
        progress = false;

        for (const index of allowed) {
            if (pool.length === 0) break;

            const current = countableActivities(rebuilt[index]);
            if (current.length >= maxPerDay) continue;

            const override = (controlPanel.perDayOverrides || []).find((o) => o.date === rebuilt[index]?.date) || {};
            const capacity = dayCapacityMinutes(controlPanel, override);

            // Minutes the day already needs, travel between stops included.
            let used = 0;
            let prev = null;
            current.forEach((a) => {
                used += parseDurationMinutes(a.durationMinutes ?? a.duration);
                const c = getCoordinates(a);
                if (prev && c) used += travelMinutesForKm(haversineKm(prev, c));
                if (c) prev = c;
            });

            // Nearest unused activity to where the day currently ends.
            let bestIdx = -1;
            let bestScore = Infinity;
            pool.forEach((act, i) => {
                const c = getCoordinates(act);
                const d = prev && c ? haversineKm(prev, c) : null;
                // Keep the day in one area: never pull in something from another base.
                if (d !== null && d > SAME_AREA_RADIUS_KM) return;
                const score = d === null ? Number.MAX_SAFE_INTEGER - i : d;
                if (score < bestScore) {
                    bestScore = score;
                    bestIdx = i;
                }
            });
            if (bestIdx === -1) continue;

            const candidate = pool[bestIdx];
            const c = getCoordinates(candidate);
            const cost = parseDurationMinutes(candidate.durationMinutes ?? candidate.duration)
                + (prev && c ? travelMinutesForKm(haversineKm(prev, c)) : 0);

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
 * trip. So: fill the days with the cheapest options first, which guarantees a complete
 * itinerary at the lowest possible cost, then spend whatever budget is left on
 * better-rated additions.
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
    const byPrice = [...rest].sort((a, b) => price(a) - price(b));

    // Stage 1 — guarantee a full trip as cheaply as possible: one activity per day.
    const minNeeded = Math.max(0, activeDays - selected.length);
    const cheapest = byPrice.slice(0, minNeeded);
    cheapest.forEach((a) => { selected.push(a); total += price(a); });

    // Stage 2 — spend what is left on the best of the remainder, never exceeding the
    // per-day cap. With no budget set, quality ordering alone applies.
    const maxWanted = Math.max(activeDays, activeDays * maxPerDay);
    const chosenIds = new Set(selected.map((a) => String(a._id)));
    const remaining = rest
        .filter((a) => !chosenIds.has(String(a._id)))
        .sort((a, b) => {
            const landmark = (x) => /pyramid|sphinx|museum|karnak|burj|eiffel|colosseum/i.test(String(x.title || ''));
            if (landmark(a) !== landmark(b)) return landmark(a) ? -1 : 1;
            return (Number(b.rating) || 0) - (Number(a.rating) || 0);
        });

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
 * Surplus activities are dropped most-expensive-first, and only from days holding more
 * than one. Every day therefore keeps at least one activity: filling the trip still wins,
 * but within that constraint the total tracks the budget. When even one activity per day
 * exceeds the budget, the plan stops there and the overrun is reported rather than hidden.
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
            if (real.length <= 1) return; // never empty a day
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
    allowedDayIndices,
    enforceDayBoundaries,
    fillDaysFromCatalogue,
    trimToBudget,
    selectActivitiesForTrip,
    allocateDaysToClusters,
    planActivitiesAcrossDays,
    repairItineraryGeography,
};
