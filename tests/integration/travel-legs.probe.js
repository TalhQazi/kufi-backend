/**
 * Is a travel leg reported for every pair of stops we can actually measure?
 *
 * Three outcomes are possible and all three must be distinguishable:
 *   minutes > 0   two different places — show the time
 *   minutes === 0 identical coordinates (one venue, two listings) — nothing to show
 *   minutes null  a position is missing — say so instead of printing nothing
 *
 * The first stop of each day is measured from the hotel, so a hotel WITH coordinates
 * must produce a `travelFromOrigin` leg and one without must produce null.
 */
require('dotenv').config({ path: __dirname + '/../../.env' });
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const axios = require('axios');

const MODE = process.argv.includes('--ai') ? 'ai' : 'template';
const http = axios.create({ baseURL: 'http://localhost:5000/api', validateStatus: () => true, timeout: 300000 });
const hdr = (t) => ({ headers: { Authorization: `Bearer ${t}` } });

let failures = 0;
const check = (ok, label) => { if (!ok) failures += 1; console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}`); };

(async () => {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 20000 });
    const User = require('../../models/User');
    const Itinerary = require('../../models/Itinerary');
    const Hotel = require('../../models/Hotel');
    const { isBreakEntry } = require('../../utils/activityClassification');
    const { getCoordinates } = require('../../utils/geo');

    const stamp = Date.now();
    const sup = new User({ name: 'P', email: `kufiprobe-legs-${stamp}@example.com`, password: await bcrypt.hash('ProbePass123!', 10), role: 'supplier', status: 'active', country: 'Egypt', city: 'Cairo' });
    await sup.save();
    const trav = new User({ name: 'T', email: `kufiprobe-legs-t-${stamp}@example.com`, password: await bcrypt.hash('ProbePass123!', 10), role: 'user', status: 'active' });
    await trav.save();
    const { data: auth } = await http.post('/auth/login', { email: sup.email, password: 'ProbePass123!' });

    // Downtown Cairo, ~13km from the Giza plateau — far enough that the leg is real.
    const placed = await Hotel.create({
        name: `Probe Hotel ${stamp}`, country: 'Egypt', city: 'Cairo', pricePerNight: 0, rooms: 1,
        latitude: 30.0444, longitude: 31.2357, coordinates: { lat: 30.0444, lng: 31.2357 }, status: 'active',
    });
    const unplaced = await Hotel.create({
        name: `Probe Hotel NoCoords ${stamp}`, country: 'Egypt', city: 'Cairo', pricePerNight: 0, rooms: 1, status: 'active',
    });

    const run = async (hotel) => {
        const mk = await http.post('/itineraries', {
            userId: String(trav._id), title: 'Travel Legs Probe', destination: 'Egypt', country: 'Egypt',
            startDate: '2026-09-01', endDate: '2026-09-05', numberOfTravelers: 2, budget: 2000,
        }, hdr(auth.token));
        const res = await http.post(`/itineraries/${mk.data._id}/generate`, {
            mode: MODE, controlPanel: { budgetUplift: 15, hotelId: String(hotel._id), customCosts: [] },
        }, hdr(auth.token));
        await Itinerary.deleteMany({ _id: mk.data._id });
        if (res.status !== 200) throw new Error(`HTTP ${res.status} ${JSON.stringify(res.data).slice(0, 120)}`);
        return res.data.itinerary?.days || [];
    };

    const stats = (days) => {
        const out = { originLegs: 0, timed: 0, sameSpot: 0, unknown: 0, firstStops: 0, self: 0, previous: 0, origin: 0, silent: 0 };
        for (const day of days) {
            const acts = (day.activities || []).filter((a) => !isBreakEntry(a));
            acts.forEach((a, i) => {
                const raw = a.travelFromPreviousMinutes;
                if (i === 0 && acts.length) out.firstStops += 1;
                if (a.travelFromOrigin) out.originLegs += 1;
                if (raw === null || raw === undefined) {
                    out.unknown += 1;
                    if (a.travelUnknownReason) out[a.travelUnknownReason] += 1;
                    else out.silent += 1;
                } else if (Number(raw) > 0) out.timed += 1;
                else out.sameSpot += 1;
            });
        }
        return out;
    };

    // Every "unavailable" row must name a record that really is missing a position.
    const blameIsCorrect = (days, hotelHasCoords) => {
        const wrong = [];
        for (const day of days) {
            const acts = (day.activities || []).filter((x) => !isBreakEntry(x));
            acts.forEach((a, i) => {
                const reason = a.travelUnknownReason;
                if (!reason) return;
                if (reason === 'self' && getCoordinates(a)) wrong.push(`${a.title}: blamed itself but HAS coords`);
                if (reason === 'previous' && (i === 0 || getCoordinates(acts[i - 1]))) wrong.push(`${a.title}: blamed previous but it HAS coords`);
                if (reason === 'origin' && (i !== 0 || hotelHasCoords)) wrong.push(`${a.title}: blamed hotel wrongly`);
            });
        }
        return wrong;
    };

    console.log(`mode=${MODE}\n`);

    console.log('hotel WITH coordinates:');
    const withCoords = await run(placed);
    const a = stats(withCoords);
    console.log(`   originLegs=${a.originLegs} timed=${a.timed} sameSpot=${a.sameSpot} unknown=${a.unknown} (self=${a.self} previous=${a.previous} origin=${a.origin})`);
    check(a.originLegs > 0, `at least one leg is measured from the hotel (${a.originLegs})`);
    check(a.timed > 0, `real travel times are reported (${a.timed} legs)`);
    // Every first stop that has coordinates should be measured from the hotel.
    const firstWithCoords = withCoords.reduce((n, d) => {
        const acts = (d.activities || []).filter((x) => !isBreakEntry(x));
        return n + (acts[0] && getCoordinates(acts[0]) ? 1 : 0);
    }, 0);
    check(a.originLegs === firstWithCoords, `every locatable first stop got a hotel leg (${a.originLegs}/${firstWithCoords})`);

    console.log('\nhotel WITHOUT coordinates:');
    const noCoords = await run(unplaced);
    const b = stats(noCoords);
    console.log(`   originLegs=${b.originLegs} timed=${b.timed} sameSpot=${b.sameSpot} unknown=${b.unknown} (self=${b.self} previous=${b.previous} origin=${b.origin})`);
    check(b.originLegs === 0, 'no hotel leg is invented when the hotel has no position');
    check(b.unknown > 0, `unmeasurable legs are reported as unknown, not as zero (${b.unknown})`);
    check(b.origin > 0, `an unlocated hotel is blamed on the hotel, not the activity (${b.origin})`);

    console.log('\nblame accuracy:');
    const wrongA = blameIsCorrect(withCoords, true);
    const wrongB = blameIsCorrect(noCoords, false);
    [...wrongA, ...wrongB].slice(0, 5).forEach((w) => console.log('     ' + w));
    check(wrongA.length === 0 && wrongB.length === 0, `every "unavailable" row names a record that really lacks a position (${wrongA.length + wrongB.length} wrong)`);
    check(a.silent === 0 && b.silent === 0, 'no unmeasurable leg is left without a reason');

    // A zero must only ever mean "identical coordinates".
    let badZero = 0;
    for (const day of withCoords) {
        const acts = (day.activities || []).filter((x) => !isBreakEntry(x));
        for (let i = 1; i < acts.length; i += 1) {
            if (Number(acts[i].travelFromPreviousMinutes) === 0) {
                const p = getCoordinates(acts[i - 1]);
                const c = getCoordinates(acts[i]);
                if (p && c && (p.lat !== c.lat || p.lng !== c.lng)) badZero += 1;
            }
        }
    }
    console.log();
    check(badZero === 0, `no distinct pair of stops is priced at zero travel (${badZero} offenders)`);

    await Hotel.deleteMany({ _id: { $in: [placed._id, unplaced._id] } });
    await require('../../models/Notification').deleteMany({ userId: { $in: [sup._id, trav._id] } });
    await User.deleteMany({ _id: { $in: [sup._id, trav._id] } });
    await mongoose.disconnect();
    console.log(`\n${failures === 0 ? '0 FAIL' : failures + ' FAIL'}`);
    process.exit(failures === 0 ? 0 : 1);
})().catch(async (e) => { console.error('ERR', e.message); try { await mongoose.disconnect(); } catch { } process.exit(1); });
