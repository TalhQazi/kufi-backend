/**
 * Calendar-date helpers that treat YYYY-MM-DD as local calendar days
 * (no UTC shift from `new Date('YYYY-MM-DD')` + toISOString).
 */

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function toDateString(value) {
    if (!value) return null;
    if (value instanceof Date && !isNaN(value.getTime())) {
        const y = value.getFullYear();
        const m = String(value.getMonth() + 1).padStart(2, '0');
        const d = String(value.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    }
    const raw = String(value).trim();
    const iso = raw.match(/^(\d{4}-\d{2}-\d{2})/);
    if (iso) return iso[1];
    const parsed = new Date(raw);
    if (!isNaN(parsed.getTime())) {
        const y = parsed.getFullYear();
        const m = String(parsed.getMonth() + 1).padStart(2, '0');
        const d = String(parsed.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    }
    return null;
}

function parseParts(dateStr) {
    const s = toDateString(dateStr);
    if (!s) return null;
    const [y, m, d] = s.split('-').map(Number);
    if (!y || !m || !d) return null;
    return { y, m, d, s };
}

function addDays(dateStr, n) {
    const parts = parseParts(dateStr);
    if (!parts) return '';
    const dt = new Date(parts.y, parts.m - 1, parts.d);
    dt.setDate(dt.getDate() + Number(n || 0));
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, '0');
    const d = String(dt.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function daysBetween(start, end) {
    const a = parseParts(start);
    const b = parseParts(end);
    if (!a || !b) return 1;
    const aDt = new Date(a.y, a.m - 1, a.d);
    const bDt = new Date(b.y, b.m - 1, b.d);
    const diff = Math.round((bDt - aDt) / (1000 * 60 * 60 * 24));
    return Math.max(1, diff + 1);
}

function nightsBetween(start, end) {
    const a = parseParts(start);
    const b = parseParts(end);
    if (!a || !b) return 0;
    const aDt = new Date(a.y, a.m - 1, a.d);
    const bDt = new Date(b.y, b.m - 1, b.d);
    return Math.max(0, Math.round((bDt - aDt) / (1000 * 60 * 60 * 24)));
}

function getDayName(dateStr) {
    const parts = parseParts(dateStr);
    if (!parts) return '';
    const dt = new Date(parts.y, parts.m - 1, parts.d);
    return DAY_NAMES[dt.getDay()] || '';
}

function buildTripDates(start, end) {
    const startStr = toDateString(start);
    const endStr = toDateString(end);
    if (!startStr || !endStr) return [];
    const total = daysBetween(startStr, endStr);
    const dates = [];
    for (let i = 0; i < total; i++) {
        dates.push(addDays(startStr, i));
    }
    return dates;
}

module.exports = {
    DAY_NAMES,
    toDateString,
    addDays,
    daysBetween,
    nightsBetween,
    getDayName,
    buildTripDates,
};
