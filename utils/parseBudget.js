/**
 * Coerce booking/itinerary budget strings ("N/A", "$1,200") to a number or undefined.
 */
function parseBudget(value) {
    if (value === null || value === undefined) return undefined;
    if (typeof value === 'number' && Number.isFinite(value)) return value;

    const raw = String(value).trim();
    if (!raw || raw === '—' || raw === '-' || /^n\/?a$/i.test(raw)) {
        return undefined;
    }

    const matches = raw.replace(/,/g, '').match(/\d+(?:\.\d+)?/g);
    if (!matches || matches.length === 0) return undefined;

    const numbers = matches.map(Number).filter(Number.isFinite);
    if (numbers.length === 0) return undefined;

    return Math.max(...numbers);
}

function applyBudgetToDocument(doc) {
    if (!doc) return doc;

    const parsed = parseBudget(doc.budget);
    if (parsed === undefined) {
        doc.budget = undefined;
        if (typeof doc.set === 'function') {
            doc.set('budget', undefined, { strict: false });
        }
        if (typeof doc.markModified === 'function') {
            doc.markModified('budget');
        }
    } else {
        doc.budget = parsed;
    }

    return doc;
}

module.exports = { parseBudget, applyBudgetToDocument };
