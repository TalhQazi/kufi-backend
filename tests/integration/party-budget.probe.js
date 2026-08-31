/**
 * Does the ported v148 budget model actually spend the budget?
 *
 * Generates the same trip at several party sizes and with per-person food/transport
 * costs, and checks three things end to end:
 *   1. activity spend scales with the number of travellers;
 *   2. the party total lands inside the traveller's budget;
 *   3. every day except the departure day names the hotel slept in that night.
 *
 *   node tests/integration/party-budget.probe.js          # template mode (free)
 *   node tests/integration/party-budget.probe.js --ai     # real OpenAI calls
 */
require('dotenv').config({ path: __dirname + '/../../.env' });
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const axios = require('axios');

const MODE = process.argv.includes('--ai') ? 'ai' : 'template';
const BUDGET = Number(process.env.PROBE_BUDGET) || 5000;
const http = axios.create({ baseURL: 'http://localhost:5000/api', validateStatus: () => true, timeout: 300000 });
const hdr = (t) => ({ headers: { Authorization: `Bearer ${t}` } });

let failures = 0;
const check = (ok, label) => {
    if (!ok) failures += 1;
    console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}`);
};

(async () => {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 20000 });
    const User = require('../../models/User');
    const Itinerary = require('../../models/Itinerary');
    const Hotel = require('../../models/Hotel');
    const { isBreakEntry, countActivities } = require('../../utils/activityClassification');

    const stamp = Date.now();
    const sup = new User({ name: 'P', email: `kufiprobe-party-${stamp}@example.com`, password: await bcrypt.hash('ProbePass123!', 10), role: 'supplier', status: 'active', country: 'Egypt', city: 'Cairo' });
    await sup.save();
    const trav = new User({ name: 'T', email: `kufiprobe-party-t-${stamp}@example.com`, password: await bcrypt.hash('ProbePass123!', 10), role: 'user', status: 'active' });
    await trav.save();
    const { data: auth } = await http.post('/auth/login', { email: sup.email, password: 'ProbePass123!' });

    const hotel = await Hotel.findOne({ country: /egypt/i }).lean();
    console.log(`mode=${MODE}  budget=$${BUDGET}  hotel=${hotel?.name || 'none'}\n`);

    const created = [];
    console.log('travellers | ceiling | /person | acts | spend/person | party spend | util');
    console.log('-'.repeat(80));

    for (const travellers of [1, 2, 4]) {
        const mk = await http.post('/itineraries', {
            userId: String(trav._id), title: `Party Probe ${travellers}`, destination: 'Egypt', country: 'Egypt',
            startDate: '2026-09-01', endDate: '2026-09-07', numberOfTravelers: travellers, budget: BUDGET,
        }, hdr(auth.token));
        created.push(mk.data._id);

        const res = await http.post(`/itineraries/${mk.data._id}/generate`, {
            mode: MODE,
            controlPanel: {
                budgetUplift: 0,
                numberOfRooms: Math.ceil(travellers / 2),
                ...(hotel ? { hotelId: String(hotel._id), hotelBaseArea: hotel.city || '' } : {}),
                customCosts: [
                    { id: 'min-charge', label: 'Minimum charge', amount: 100, unit: 'flat' },
                    { id: 'transportation', label: 'Transportation', amount: 15, unit: 'per_person_per_day' },
                    { id: 'food', label: 'Food', amount: 30, unit: 'per_person_per_day' },
                ],
            },
        }, hdr(auth.token));

        if (res.status !== 200) {
            console.log(`${String(travellers).padStart(10)} | HTTP ${res.status} ${JSON.stringify(res.data).slice(0, 90)}`);
            failures += 1;
            continue;
        }

        const b = res.data.budget || {};
        const days = res.data.itinerary?.days || [];
        const perPerson = days.reduce((s, d) => s + (d.activities || [])
            .filter((a) => !isBreakEntry(a))
            .reduce((x, a) => x + (Number(a.price) || 0), 0), 0);
        const party = perPerson * travellers;

        console.log(
            `${String(travellers).padStart(10)} | ${String('$' + (b.activityCeiling ?? 0)).padStart(7)} | ` +
            `${String('$' + (b.perTravellerActivityCeiling ?? 0)).padStart(7)} | ${String(countActivities(days)).padStart(4)} | ` +
            `${String('$' + perPerson).padStart(12)} | ${String('$' + party).padStart(11)} | ` +
            `${b.activityUtilizationPercent ?? '—'}%`
        );

        check(b.travellers === travellers, `breakdown reports ${travellers} traveller(s)`);
        check(b.activitySpendTotal === party, `party spend ${b.activitySpendTotal} matches recomputed ${party}`);
        check(
            perPerson <= (b.perTravellerActivityCeiling ?? Infinity),
            `per-person spend $${perPerson} stays inside the per-person ceiling $${b.perTravellerActivityCeiling}`
        );
        check(
            party + b.hotelCost + b.customCostsTotal <= b.maxAllowedTotalBudget,
            `party total $${party + b.hotelCost + b.customCostsTotal} stays inside the trip ceiling $${b.maxAllowedTotalBudget}`
        );

        if (travellers === 4) {
            // Costs charged per head per day must have grown with the party.
            check(b.customCostsTotal === 100 + (15 + 30) * 7 * 4, `per-person-per-day costs scaled: $${b.customCostsTotal}`);
        }
        if (hotel) {
            const named = days.filter((d) => d.overnightHotel?.name).length;
            check(named === days.length - 1, `overnight hotel named on ${days.length - 1} of ${days.length} days (got ${named})`);
            check(
                !days[days.length - 1]?.overnightHotel,
                'departure day carries no overnight hotel'
            );
        }
    }

    await Itinerary.deleteMany({ _id: { $in: created } });
    await User.deleteMany({ _id: { $in: [sup._id, trav._id] } });
    await mongoose.disconnect();

    console.log(`\n${failures === 0 ? '0 FAIL' : failures + ' FAIL'}`);
    process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
