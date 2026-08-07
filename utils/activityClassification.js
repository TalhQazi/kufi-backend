/**
 * What counts as an "activity" on an itinerary day.
 *
 * Itinerary days hold two different kinds of entry in the same `activities` array:
 *   - real activities  — something the traveler does, usually backed by a catalogue
 *                        Activity document and carrying a price.
 *   - schedule breaks  — lunch/rest placeholders the generator inserts so the timeline
 *                        reads correctly. They are not things the traveler booked.
 *
 * Only the first kind may be counted in totals, statistics or "top activities".
 *
 * Classification is by system identifier, not display text:
 *   0. a link to a catalogue Activity (`activityId`) disqualifies an entry outright —
 *      something the traveler can book is never a break, whatever it is called and
 *      whatever flags a previous write left on it. Breaks are always created unlinked
 *      (see `buildBreakEntry`), so this can only ever reject contradictory data.
 *   1. `isBreak: true`         — the canonical marker stamped by the generator.
 *   2. `category` in BREAK_CATEGORIES.
 *   3. legacy fallback         — entries written before the marker existed are matched
 *                                on a narrow title pattern. A booked "Nile River Dinner
 *                                Cruise" has an activityId and is never a break.
 *
 * The mirror of this file on the frontend is
 * `src/utils/activityClassification.js` — keep the two rule sets in sync.
 */

/** Canonical category stamped on generated break entries. */
const BREAK_CATEGORY = 'break';

const BREAK_CATEGORIES = new Set([
    'break',
    'lunch',
    'lunch break',
    'lunchbreak',
    'meal break',
    'rest',
    'free time',
    'freetime',
]);

/**
 * Narrow, anchored patterns for legacy rows with no marker. Deliberately does NOT match
 * "dinner"/"breakfast" on their own — those are frequently real, priced experiences.
 */
const LEGACY_BREAK_TITLES = [
    /^(lunch|dinner|breakfast|meal|coffee|tea)?\s*break$/i,
    /^break\s*(for\s*)?(lunch|dinner|breakfast|meal)?$/i,
    /^free\s*time$/i,
    /^rest(\s*(time|period))?$/i,
    /^at\s*leisure$/i,
    /^leisure\s*time$/i,
    /^lunch$/i,
];

const normalize = (value) => String(value ?? '').trim().toLowerCase();

/**
 * A real catalogue link, or null.
 *
 * Language models routinely emit the *string* `"null"` (the prompt's own example asked
 * for it), and `""`/`"undefined"` show up too. Those are all "no link" — treating them as
 * truthy is what let priced "Lunch Break" rows escape classification and keep inflating
 * activity totals.
 */
function resolveActivityId(value) {
    if (value === null || value === undefined) return null;
    const raw = String(value).trim();
    if (!raw || ['null', 'undefined', 'none', 'nil', 'n/a'].includes(raw.toLowerCase())) return null;
    return raw;
}

/** True when this day entry is a schedule break rather than a real activity. */
function isBreakEntry(entry) {
    if (!entry || typeof entry !== 'object') return false;

    // 0. A bookable, catalogue-linked item is always a real activity. Checked first so a
    //    stale marker can never silently drop a booked experience from the totals.
    if (resolveActivityId(entry.activityId)) return false;

    // 1. Canonical marker.
    if (entry.isBreak === true) return true;

    // 2. Category-based classification.
    if (BREAK_CATEGORIES.has(normalize(entry.category))) return true;

    // 3. Legacy fallback for rows written before the marker existed.
    const title = normalize(entry.title);
    if (!title) return false;
    return LEGACY_BREAK_TITLES.some((rx) => rx.test(title));
}

/** True when this day entry should be counted as an activity. */
const isCountableActivity = (entry) => !isBreakEntry(entry);

/** Real activities on a single day, breaks removed. */
function countableActivities(day) {
    const list = Array.isArray(day?.activities) ? day.activities : [];
    return list.filter(isCountableActivity);
}

/** Total number of real activities across every day of an itinerary. */
function countActivities(days) {
    if (!Array.isArray(days)) return 0;
    return days.reduce((sum, day) => sum + countableActivities(day).length, 0);
}

/**
 * Stamp the canonical marker onto entries that classify as breaks, so data written from
 * now on is self-describing and the legacy title fallback is no longer needed.
 */
function markBreakEntries(days) {
    if (!Array.isArray(days)) return days;
    return days.map((day) => {
        const item = day?.toObject ? day.toObject() : day;
        const list = Array.isArray(item?.activities) ? item.activities : [];
        return {
            ...item,
            activities: list.map((entry) => {
                const act = entry?.toObject ? entry.toObject() : entry;
                if (!isBreakEntry(act)) {
                    // Never leave a stale `true` on something that is a real activity.
                    return act?.isBreak ? { ...act, isBreak: false } : act;
                }
                return { ...act, isBreak: true, category: BREAK_CATEGORY, activityId: null };
            }),
        };
    });
}

/** A schedule break entry in the shape the itinerary day array expects. */
function buildBreakEntry({ title = 'Lunch Break', description = '', startTime = '', endTime = '' } = {}) {
    return {
        activityId: null,
        title,
        description,
        startTime,
        endTime,
        price: 0,
        category: BREAK_CATEGORY,
        image: '',
        isBreak: true,
        isSupplierOnly: true,
    };
}

module.exports = {
    BREAK_CATEGORY,
    BREAK_CATEGORIES,
    resolveActivityId,
    isBreakEntry,
    isCountableActivity,
    countableActivities,
    countActivities,
    markBreakEntries,
    buildBreakEntry,
};
