/**
 * Multiple hotel stays on an itinerary Control Panel.
 *
 * Legacy records store a single `hotelId`. New records store `hotelStays[]`
 * (one row per area). Cost and the Distance Matrix origin always read through
 * these helpers so both shapes stay equivalent.
 */
const mongoose = require('mongoose');

function hotelIdOf(value) {
    if (!value) return '';
    if (typeof value === 'object') return String(value._id || '').trim();
    const id = String(value).trim();
    return id === 'null' || id === 'undefined' ? '' : id;
}

function nightsForStay(stay, index, stays, tripNights) {
    const list = Array.isArray(stays) ? stays : [];
    const assigned = list.reduce((sum, s) => sum + Math.max(0, Number(s.nights) || 0), 0);
    if (assigned > 0) return Math.max(0, Number(stay?.nights) || 0);
    const n = Math.max(0, Number(tripNights) || 0);
    const count = list.length || 1;
    const base = Math.floor(n / count);
    const rem = n % count;
    return base + (index < rem ? 1 : 0);
}

function sanitizeHotelStays(list) {
    return (Array.isArray(list) ? list : []).map((s, i) => {
        const hotelId = hotelIdOf(s?.hotelId);
        if (!hotelId || !mongoose.Types.ObjectId.isValid(hotelId)) return null;
        return {
            id: s.id || `stay-${i}`,
            hotelId,
            area: String(s.area || '').trim(),
            nights: Math.max(0, Number(s.nights) || 0),
        };
    }).filter(Boolean);
}

function normalizeHotelStays(cp = {}) {
    const fromArray = sanitizeHotelStays(cp.hotelStays);
    if (fromArray.length) return fromArray;
    const legacy = hotelIdOf(cp.hotelId);
    if (!legacy || !mongoose.Types.ObjectId.isValid(legacy)) return [];
    return [{
        id: 'stay-legacy',
        hotelId: legacy,
        area: String(cp.hotelBaseArea || '').trim(),
        nights: 0,
    }];
}

function hotelDocForStay(stay, hotelsById = {}) {
    if (stay?.hotelId && typeof stay.hotelId === 'object' && stay.hotelId.pricePerNight != null) {
        return stay.hotelId;
    }
    const id = hotelIdOf(stay?.hotelId);
    return hotelsById[id] || hotelsById[String(id)] || null;
}

function hotelCostFromStays(stays, hotelsById, rooms, tripNights) {
    const r = Math.max(1, Number(rooms) || 1);
    const list = Array.isArray(stays) ? stays : [];
    return list.reduce((sum, stay, i) => {
        const hotel = hotelDocForStay(stay, hotelsById);
        const rate = Number(hotel?.pricePerNight) || 0;
        const n = nightsForStay(stay, i, list, tripNights);
        return sum + rate * n * r;
    }, 0);
}

function hotelsByIdFromDocs(docs) {
    const map = {};
    (Array.isArray(docs) ? docs : []).forEach((h) => {
        if (h?._id) map[String(h._id)] = h;
    });
    return map;
}

/**
 * Which hotel the travellers sleep in after each day.
 *
 * Stays are consumed in order, each covering `nightsForStay` consecutive nights, using
 * the same split as the cost calculation so the displayed hotel and the billed hotel can
 * never disagree. Night `i` follows day `i`, so a trip of N days has N-1 nights and the
 * departure day returns `null` — nobody sleeps there.
 *
 * Returns one entry per day: `{ hotelId, name, area, pricePerNight }` or `null`.
 */
function overnightStayPlan(stays, hotelsById = {}, tripDays = 0) {
    const days = Math.max(0, Number(tripDays) || 0);
    const plan = new Array(days).fill(null);
    const list = Array.isArray(stays) ? stays : [];
    if (!days || !list.length) return plan;

    const nights = Math.max(0, days - 1);
    let night = 0;

    for (let i = 0; i < list.length && night < nights; i += 1) {
        const stay = list[i];
        const hotel = hotelDocForStay(stay, hotelsById);
        const entry = {
            hotelId: hotelIdOf(stay?.hotelId),
            name: String(hotel?.name || '').trim(),
            area: String(stay?.area || hotel?.city || '').trim(),
            pricePerNight: Number(hotel?.pricePerNight) || 0,
        };
        const span = nightsForStay(stay, i, list, nights);
        for (let n = 0; n < span && night < nights; n += 1, night += 1) {
            plan[night] = entry;
        }
    }

    // An explicit night allocation that is short of the trip length leaves a tail of
    // days with no hotel. Carry the last stay forward rather than showing a blank.
    const last = plan[night - 1];
    if (last) {
        for (let d = night; d < nights; d += 1) plan[d] = last;
    }

    return plan;
}

module.exports = {
    hotelIdOf,
    nightsForStay,
    overnightStayPlan,
    sanitizeHotelStays,
    normalizeHotelStays,
    hotelDocForStay,
    hotelCostFromStays,
    hotelsByIdFromDocs,
};
