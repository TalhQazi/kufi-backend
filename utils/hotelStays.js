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

module.exports = {
    hotelIdOf,
    nightsForStay,
    sanitizeHotelStays,
    normalizeHotelStays,
    hotelDocForStay,
    hotelCostFromStays,
    hotelsByIdFromDocs,
};
