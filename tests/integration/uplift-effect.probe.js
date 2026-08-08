/**
 * Does the uplift actually change what generation produces?
 * Runs the same itinerary through generation at several uplift values and compares the
 * resulting activity spend against the computed ceiling.
 *
 *   node tests/integration/uplift-effect.probe.js            # template mode (free, deterministic)
 *   node tests/integration/uplift-effect.probe.js --ai       # real OpenAI calls
 */
require('dotenv').config({ path: __dirname + '/../../.env' });
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const axios = require('axios');

const MODE = process.argv.includes('--ai') ? 'ai' : 'template';
const BUDGET = Number(process.env.PROBE_BUDGET) || 3000;
const http = axios.create({ baseURL: 'http://localhost:5000/api', validateStatus: () => true, timeout: 300000 });
const hdr = (t) => ({ headers: { Authorization: `Bearer ${t}` } });

(async () => {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 20000 });
    const User = require('../../models/User');
    const Itinerary = require('../../models/Itinerary');
    const { countActivities, isBreakEntry } = require('../../utils/activityClassification');

    const email = `kufiprobe-uplift-${Date.now()}@example.com`;
    const sup = new User({ name: 'P', email, password: await bcrypt.hash('ProbePass123!', 10), role: 'supplier', status: 'active', country: 'Egypt', city: 'Cairo' });
    await sup.save();
    const trav = new User({ name: 'T', email: `kufiprobe-uplift-t-${Date.now()}@example.com`, password: await bcrypt.hash('ProbePass123!', 10), role: 'user', status: 'active' });
    await trav.save();
    const { data: auth } = await http.post('/auth/login', { email, password: 'ProbePass123!' });

    const mk = await http.post('/itineraries', {
        userId: String(trav._id), title: 'Uplift Probe', destination: 'Egypt', country: 'Egypt',
        startDate: '2026-09-01', endDate: '2026-09-05', numberOfTravelers: 2, budget: BUDGET,
    }, hdr(auth.token));
    const id = mk.data._id;

    console.log(`mode=${MODE}  base budget=$${BUDGET}\n`);
    console.log('uplift |  ceiling | activities | spend  | within ceiling');
    console.log('-'.repeat(60));

    const results = [];
    for (const uplift of [0, 15, 50, 100]) {
        const res = await http.post(`/itineraries/${id}/generate`, {
            mode: MODE,
            controlPanel: { budgetUplift: uplift, customCosts: [] },
        }, hdr(auth.token));

        if (res.status !== 200) {
            console.log(`${String(uplift).padStart(5)}% |  HTTP ${res.status} ${JSON.stringify(res.data).slice(0, 80)}`);
            continue;
        }
        const days = res.data.itinerary?.days || [];
        const spend = days.reduce((s, d) => s + (d.activities || [])
            .filter((a) => !isBreakEntry(a))
            .reduce((x, a) => x + (Number(a.price) || 0), 0), 0);
        const ceiling = Math.floor(BUDGET * (1 + uplift / 100));
        const n = countActivities(days);
        results.push({ uplift, spend, n });
        console.log(`${String(uplift).padStart(5)}% | ${String('$' + ceiling).padStart(8)} | ${String(n).padStart(10)} | ${String('$' + spend).padStart(6)} | ${spend <= ceiling ? 'yes' : 'NO — EXCEEDS'}`);
    }

    const distinct = new Set(results.map((r) => `${r.n}:${r.spend}`)).size;
    console.log(`\ndistinct outcomes across uplift values: ${distinct} of ${results.length}`);
    console.log(distinct > 1
        ? '>> uplift DOES change the generated itinerary'
        : '>> uplift has NO effect on the generated itinerary');

    await Itinerary.deleteMany({ _id: id });
    await require('../../models/Notification').deleteMany({ userId: { $in: [sup._id, trav._id] } });
    await User.deleteMany({ _id: { $in: [sup._id, trav._id] } });
    await mongoose.disconnect();
})().catch(async (e) => { console.error('ERR', e.message); try { await mongoose.disconnect(); } catch { } process.exit(1); });
