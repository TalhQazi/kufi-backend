/**
 * When hotel + per-trip costs exceed the whole budget, does the traveller still get an
 * itinerary — and is the overage reported?
 *
 * Reproduces the real record that came back with 39 empty days: a 39-day Egypt trip for
 * four people at $20/person/day transport + $20/person/day food on a $3,000 budget.
 * Fixed costs are $6,240 against a $3,449 ceiling, so the old code floored the activity
 * allowance at $0 and silently returned nothing.
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

const COSTS = [
    { id: 'transportation', label: 'Transportation', amount: 20, unit: 'per_person_per_day' },
    { id: 'food', label: 'Food', amount: 20, unit: 'per_person_per_day' },
];

(async () => {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 20000 });
    const User = require('../../models/User');
    const Itinerary = require('../../models/Itinerary');
    const { isBreakEntry, countActivities } = require('../../utils/activityClassification');

    const stamp = Date.now();
    const sup = new User({ name: 'P', email: `kufiprobe-fob-${stamp}@example.com`, password: await bcrypt.hash('ProbePass123!', 10), role: 'supplier', status: 'active', country: 'Egypt', city: 'Cairo' });
    await sup.save();
    const trav = new User({ name: 'T', email: `kufiprobe-fob-t-${stamp}@example.com`, password: await bcrypt.hash('ProbePass123!', 10), role: 'user', status: 'active' });
    await trav.save();
    const { data: auth } = await http.post('/auth/login', { email: sup.email, password: 'ProbePass123!' });

    const CASES = [
        { name: 'the real 39-day record', start: '2026-09-02', end: '2026-10-10', trav: 4, budget: 3000, over: true },
        { name: 'affordable 6-day trip  ', start: '2026-09-01', end: '2026-09-06', trav: 2, budget: 3000, over: false },
        // $1,600 fixed against a $1,724 ceiling: tight, but still affordable. The
        // allowance drops to $124, which is correct, not a failure.
        { name: 'tight 10-day, 4 people ', start: '2026-09-01', end: '2026-09-10', trav: 4, budget: 1500, over: false },
        // Same trip with the budget halved — now genuinely unaffordable.
        { name: 'unaffordable 10-day    ', start: '2026-09-01', end: '2026-09-10', trav: 4, budget: 750, over: true },
    ];

    console.log(`mode=${MODE}   transport+food = $40/person/day\n`);
    for (const c of CASES) {
        const mk = await http.post('/itineraries', {
            userId: String(trav._id), title: 'FOB Probe', destination: 'Egypt', country: 'Egypt',
            startDate: c.start, endDate: c.end, numberOfTravelers: c.trav, budget: c.budget,
        }, hdr(auth.token));

        const res = await http.post(`/itineraries/${mk.data._id}/generate`, {
            mode: MODE, controlPanel: { budgetUplift: 15, customCosts: COSTS },
        }, hdr(auth.token));

        if (res.status !== 200) {
            console.log(`${c.name} | HTTP ${res.status} ${JSON.stringify(res.data).slice(0, 100)}`);
            failures += 1;
            await Itinerary.deleteMany({ _id: mk.data._id });
            continue;
        }

        const b = res.data.budget || {};
        const days = res.data.itinerary?.days || [];
        const acts = countActivities(days);
        const pp = days.reduce((s, d) => s + (d.activities || []).filter((a) => !isBreakEntry(a)).reduce((x, a) => x + (Number(a.price) || 0), 0), 0);

        console.log(
            `${c.name} | days=${String(days.length).padStart(2)} fixed=$${String(b.fixedCostsTotal).padStart(5)} ` +
            `ceiling=$${String(b.maxAllowedTotalBudget).padStart(5)} over=${String(b.fixedOverBudget).padEnd(5)} ` +
            `by=$${String(b.overBudgetBy).padStart(5)} allowance=$${String(b.activityCeiling).padStart(4)} acts=${String(acts).padStart(3)} spend/pp=$${pp}`
        );

        check(b.fixedOverBudget === c.over, `fixedOverBudget is ${c.over}`);
        if (c.over) {
            check(b.overBudgetBy > 0, `overage reported ($${b.overBudgetBy})`);
            // The whole point: an unaffordable fixed cost must not yield empty days.
            check(acts > 0, `itinerary is NOT empty (${acts} activities)`);
            check(b.activityCeiling > 0, `a reduced allowance was granted ($${b.activityCeiling})`);
        } else {
            check(b.overBudgetBy === 0, 'no overage on an affordable trip');
            check(b.activityCeiling === b.maxAllowedTotalBudget - b.fixedCostsTotal, 'allowance is the full remainder');
        }
        await Itinerary.deleteMany({ _id: mk.data._id });
    }

    await require('../../models/Notification').deleteMany({ userId: { $in: [sup._id, trav._id] } });
    await User.deleteMany({ _id: { $in: [sup._id, trav._id] } });
    await mongoose.disconnect();
    console.log(`\n${failures === 0 ? '0 FAIL' : failures + ' FAIL'}`);
    process.exit(failures === 0 ? 0 : 1);
})().catch(async (e) => { console.error('ERR', e); try { await mongoose.disconnect(); } catch { } process.exit(1); });
