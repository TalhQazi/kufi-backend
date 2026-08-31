/**
 * Trip cost model.
 *
 * A traveller's budget covers the whole trip, not just the sightseeing. Before this
 * module the only fixed costs deducted from the budget were the hotel and a flat/per-day
 * custom cost, and activity prices were counted once regardless of party size. A $5,000
 * request for four people therefore looked unspendable: the catalogue's per-head prices
 * could never add up to it.
 *
 * Two rules fix that, and both live here so the API, the planner and the supplier UI
 * cannot drift apart:
 *
 *   1. Custom costs carry a unit. Food and transportation are charged per person per
 *      day; a minimum charge is flat. `flat` and `per_day` keep their old meaning so
 *      existing itineraries are costed exactly as before.
 *   2. Activity prices are per person. The party pays `price * travellers`.
 */

/** How each custom-cost unit expands into a trip total. */
const COST_UNITS = {
    flat: (amount) => amount,
    per_day: (amount, days) => amount * days,
    per_person: (amount, days, travellers) => amount * travellers,
    per_person_per_day: (amount, days, travellers) => amount * days * travellers,
};

const UNIT_KEYS = Object.freeze(Object.keys(COST_UNITS));

/** Human-readable suffix for a cost line, e.g. " ($20/day × 7 × 4 travellers)". */
const UNIT_LABELS = {
    flat: () => '',
    per_day: (amount, days) => ` ($${amount}/day × ${days})`,
    per_person: (amount, days, travellers) => ` ($${amount}/person × ${travellers})`,
    per_person_per_day: (amount, days, travellers) =>
        ` ($${amount}/person/day × ${days} × ${travellers})`,
};

/** Coerce anything to a known unit. Unknown values fall back to the safest reading. */
function normalizeCostUnit(value) {
    const unit = String(value || '').trim();
    return Object.prototype.hasOwnProperty.call(COST_UNITS, unit) ? unit : 'flat';
}

function positiveInt(value, fallback = 1) {
    const n = Math.floor(Number(value));
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Trip total for one custom-cost row. */
function customCostTotal(cost, { tripDays = 1, travellers = 1 } = {}) {
    const amount = Number(cost?.amount) || 0;
    if (!amount) return 0;
    const days = positiveInt(tripDays);
    const people = positiveInt(travellers);
    return COST_UNITS[normalizeCostUnit(cost?.unit)](amount, days, people);
}

/**
 * Cost lines for display, with the arithmetic spelled out in the label so a supplier
 * can see why a $20 food line became $560.
 */
function customCostLines(list, { tripDays = 1, travellers = 1 } = {}) {
    const days = positiveInt(tripDays);
    const people = positiveInt(travellers);
    return (Array.isArray(list) ? list : [])
        .map((cost) => {
            const amount = Number(cost?.amount) || 0;
            if (!amount) return null;
            const unit = normalizeCostUnit(cost?.unit);
            return {
                id: cost?.id || cost?.label || unit,
                label: `${cost?.label || 'Custom cost'}${UNIT_LABELS[unit](amount, days, people)}`,
                unit,
                amount,
                total: COST_UNITS[unit](amount, days, people),
            };
        })
        .filter(Boolean);
}

/** Sum of every custom-cost row across the trip. */
function customCostsTotal(list, options = {}) {
    return (Array.isArray(list) ? list : []).reduce(
        (sum, cost) => sum + customCostTotal(cost, options),
        0
    );
}

/**
 * What the whole party pays for a per-head activity spend.
 *
 * The planner works in per-person prices — that is how the catalogue stores them, and
 * it keeps quality scoring independent of party size — so the party total is only ever
 * derived at the edges: the response payload and the supplier's totals.
 */
function partyActivityCost(perPersonSpend, travellers = 1) {
    return (Number(perPersonSpend) || 0) * positiveInt(travellers);
}

/**
 * The per-person ceiling the planner may spend to.
 *
 * Dividing the party ceiling is equivalent to multiplying every price by the party size
 * — activities scale linearly and identically — but leaves every price comparison,
 * quality score and swap rule in the planner untouched.
 */
function perTravellerCeiling(partyCeiling, travellers = 1) {
    const ceiling = Number(partyCeiling) || 0;
    if (ceiling <= 0) return 0;
    return Math.floor(ceiling / positiveInt(travellers));
}

module.exports = {
    COST_UNITS,
    UNIT_KEYS,
    normalizeCostUnit,
    customCostTotal,
    customCostLines,
    customCostsTotal,
    partyActivityCost,
    perTravellerCeiling,
};
