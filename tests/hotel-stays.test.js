const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const {
    nightsForStay,
    hotelCostFromStays,
    normalizeHotelStays,
} = require('../utils/hotelStays');

const idA = new mongoose.Types.ObjectId().toString();
const idB = new mongoose.Types.ObjectId().toString();

test('nights split evenly when stays leave nights at 0', () => {
    const stays = [{ nights: 0 }, { nights: 0 }, { nights: 0 }];
    assert.equal(nightsForStay(stays[0], 0, stays, 5), 2);
    assert.equal(nightsForStay(stays[1], 1, stays, 5), 2);
    assert.equal(nightsForStay(stays[2], 2, stays, 5), 1);
});

test('explicit nights on a stay are used as-is', () => {
    const stays = [{ nights: 3 }, { nights: 2 }];
    assert.equal(nightsForStay(stays[0], 0, stays, 10), 3);
    assert.equal(nightsForStay(stays[1], 1, stays, 10), 2);
});

test('hotel cost sums each stay rate × nights × rooms', () => {
    const stays = [{ hotelId: idA, nights: 3 }, { hotelId: idB, nights: 2 }];
    const hotels = { [idA]: { pricePerNight: 80 }, [idB]: { pricePerNight: 60 } };
    assert.equal(hotelCostFromStays(stays, hotels, 2, 5), (80 * 3 + 60 * 2) * 2);
});

test('legacy hotelId becomes a single stay', () => {
    const out = normalizeHotelStays({ hotelId: idA, hotelBaseArea: 'Cairo' });
    assert.equal(out.length, 1);
    assert.equal(out[0].hotelId, idA);
    assert.equal(out[0].area, 'Cairo');
});
