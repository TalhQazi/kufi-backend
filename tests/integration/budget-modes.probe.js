/**
 * The budget adjustment control has three settings. Do all three reach generation?
 *
 *   + tolerance   → trip may exceed the customer's budget by that percentage
 *   - tolerance   → trip is held below the customer's budget
 *   fixed amount  → the entered figure replaces the customer's budget entirely
 *
 *   node tests/integration/budget-modes.probe.js         # template mode (free)
 *   node tests/integration/budget-modes.probe.js --ai    # real OpenAI calls
 */
require('dotenv').config({ path: __dirname + '/../../.env' });
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const axios = require('axios');

const MODE = process.argv.includes('--ai') ? 'ai' : 'template';
const BUDGET = Number(process.env.PROBE_BUDGET) || 2000;
const http = axios.create({ baseURL: 'http://localhost:5000/api', validateStatus: () => true, timeout: 300000 });
const hdr = (t) => ({ headers: { Authorization: `Bearer ${t}` } });

let failures = 0;
const check = (ok, label) => {
    if (!ok) failures += 1;
    console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}`);
};

const CASES = [
    { name: '+50% tolerance', cp: { budgetMode: 'percent', budgetUplift: 50 }, expectCeiling: Math.floor(BUDGET * 1.5) },
    { name: '  0% tolerance', cp: { budgetMode: 'percent', budgetUplift: 0 }, expectCeiling: BUDGET },
    { name: '-20% tolerance', cp: { budgetMode: 'percent', budgetUplift: -20 }, expectCeiling: Math.floor(BUDGET * 0.8) },
    { name: 'fixed $3500   ', cp: { budgetMode: 'amount', budgetAmount: 3500, budgetUplift: 50 }, expectCeiling: 3500 },
    { name: 'fixed $600    ', cp: { budgetMode: 'amount', budgetAmount: 600, budgetUplift: 50 }, expectCeiling: 600 },
    // A fixed budget of 0 means "not set": the percentage must take over again.
    { name: 'amount w/ 0   ', cp: { budgetMode: 'amount', budgetAmount: 0, budgetUplift: 25 }, expectCeiling: Math.floor(BUDGET * 1.25) },
];

(async () => {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 20000 });
    const User = require('../../models/User');
    const Itinerary = require('../../models/Itinerary');
    const { isBreakEntry, countActivities } = require('../../utils/activityClassification');

    const stamp = Date.now();
    const sup = new User({ name: 'P', email: `kufiprobe-bmode-${stamp}@example.com`, password: await bcrypt.hash('ProbePass123!', 10), role: 'supplier', status: 'active', country: 'Egypt', city: 'Cairo' });
    await sup.save();
    const trav = new User({ name: 'T', email: `kufiprobe-bmode-t-${stamp}@example.com`, password: await bcrypt.hash('ProbePass123!', 10), role: 'user', status: 'active' });
    await trav.save();
    const { data: auth } = await http.post('/auth/login', { email: sup.email, password: 'ProbePass123!' });

    const mk = await http.post('/itineraries', {
        userId: String(trav._id), title: 'Budget Mode Probe', destination: 'Egypt', country: 'Egypt',
        startDate: '2026-09-01', endDate: '2026-09-06', numberOfTravelers: 2, budget: BUDGET,
    }, hdr(auth.token));
    const id = mk.data._id;

    console.log(`mode=${MODE}  customer budget=$${BUDGET}  travellers=2\n`);
    console.log('setting        | mode    | ceiling | /person | acts | spend/pp | party  | within');
    console.log('-'.repeat(84));

    const outcomes = [];
    for (const c of CASES) {
        const res = await http.post(`/itineraries/${id}/generate`, {
            mode: MODE,
            controlPanel: { ...c.cp, customCosts: [] },
        }, hdr(auth.token));

        if (res.status !== 200) {
            console.log(`${c.name} | HTTP ${res.status} ${JSON.stringify(res.data).slice(0, 80)}`);
            failures += 1;
            continue;
        }

        const b = res.data.budget || {};
        const days = res.data.itinerary?.days || [];
        const pp = days.reduce((s, d) => s + (d.activities || [])
            .filter((a) => !isBreakEntry(a))
            .reduce((x, a) => x + (Number(a.price) || 0), 0), 0);
        const party = pp * 2;
        outcomes.push(`${countActivities(days)}:${pp}`);

        console.log(
            `${c.name} | ${String(b.budgetMode).padEnd(7)} | ${String('$' + b.maxAllowedTotalBudget).padStart(7)} | ` +
            `${String('$' + b.perTravellerActivityCeiling).padStart(7)} | ${String(countActivities(days)).padStart(4)} | ` +
            `${String('$' + pp).padStart(8)} | ${String('$' + party).padStart(6)} | ${party <= b.maxAllowedTotalBudget ? 'yes' : 'NO'}`
        );

        check(b.maxAllowedTotalBudget === c.expectCeiling, `ceiling is $${c.expectCeiling} (got $${b.maxAllowedTotalBudget})`);
        check(party <= b.maxAllowedTotalBudget, `party spend $${party} stays inside the ceiling`);
    }

    // The three ceilings differ enough that the plans must differ too, or the setting
    // is being read but not acted on.
    const distinct = new Set(outcomes).size;
    console.log(`\ndistinct itineraries across ${outcomes.length} settings: ${distinct}`);
    check(distinct > 1, 'the budget setting changes the generated itinerary');

    await Itinerary.deleteMany({ _id: id });
    await require('../../models/Notification').deleteMany({ userId: { $in: [sup._id, trav._id] } });
    await User.deleteMany({ _id: { $in: [sup._id, trav._id] } });
    await mongoose.disconnect();

    console.log(`\n${failures === 0 ? '0 FAIL' : failures + ' FAIL'}`);
    process.exit(failures === 0 ? 0 : 1);
})().catch(async (e) => { console.error('ERR', e); try { await mongoose.disconnect(); } catch { } process.exit(1); });
