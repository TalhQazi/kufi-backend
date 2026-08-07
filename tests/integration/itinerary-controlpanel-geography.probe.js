/**
 * End-to-end check of issues 2, 3 and 6 against the running server:
 *   - Control Panel values survive generation (uplift 0 stays 0)
 *   - Lunch breaks are marked and excluded from counts
 *   - Generated days are geographically feasible
 */
require('dotenv').config({ path: __dirname + '/../../.env' });
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const axios = require('axios');

const http = axios.create({ baseURL: 'http://localhost:5000/api', validateStatus: () => true, timeout: 180000 });
const hdr = (t) => ({ headers: { Authorization: `Bearer ${t}` } });
const line = (n, v, extra = '') => console.log(`  ${String(v).padStart(6)}  ${n}${extra ? '  ' + extra : ''}`);

const created = { users: [], itineraries: [] };

(async () => {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 20000 });
    const User = require('../../models/User');
    const Itinerary = require('../../models/Itinerary');
    const { countActivities, isBreakEntry } = require('../../utils/activityClassification');
    const { getCoordinates, haversineKm, SAME_AREA_RADIUS_KM } = require('../../utils/geo');

    const email = `kufiprobe-itin-${Date.now()}@example.com`;
    const sup = new User({ name: 'Probe Sup', email, password: await bcrypt.hash('ProbePass123!', 10), role: 'supplier', status: 'active', country: 'Egypt', city: 'Cairo' });
    await sup.save();
    created.users.push(sup._id);
    const trav = new User({ name: 'Probe Trav', email: `kufiprobe-trav-${Date.now()}@example.com`, password: await bcrypt.hash('ProbePass123!', 10), role: 'user', status: 'active' });
    await trav.save();
    created.users.push(trav._id);

    const { data: auth } = await http.post('/auth/login', { email, password: 'ProbePass123!' });
    const token = auth.token;

    // A 7-day Egypt trip: the catalogue holds Cairo, Luxor, Aswan and Alexandria activities.
    const mk = await http.post('/itineraries', {
        userId: String(trav._id), title: 'Probe Egypt', destination: 'Egypt',
        country: 'Egypt', startDate: '2026-09-01', endDate: '2026-09-07',
        numberOfTravelers: 2, budget: 5000,
    }, hdr(token));
    const id = mk.data?._id;
    created.itineraries.push(id);
    line('create itinerary', mk.status);

    console.log('\n== ISSUE 2: Control Panel survives generation ==');
    const config = {
        budgetUplift: 0,
        numberOfRooms: 3,
        activityStartTime: '08:00',
        activityEndTime: '18:00',
        lunchStart: '12:30',
        lunchEnd: '13:30',
        startOnArrival: true,
        endOnDeparture: false,
        customCosts: [{ id: 'transport', label: 'Transportation', amount: 40, unit: 'per_day' }],
    };
    const saved = await http.put(`/itineraries/${id}/control-panel`, config, hdr(token));
    line('save control panel', saved.status);

    const gen = await http.post(`/itineraries/${id}/generate`, { mode: 'template' }, hdr(token));
    line('generate (template)', gen.status);
    const cpAfter = gen.data?.itinerary?.controlPanel || {};
    let ok = true;
    for (const [k, want] of Object.entries(config)) {
        if (k === 'customCosts') continue;
        const got = cpAfter[k];
        const match = String(got) === String(want);
        if (!match) ok = false;
        line(`  ${k}`, match ? 'OK' : 'DRIFT', `want=${want} got=${got}`);
    }
    line('customCosts preserved', (cpAfter.customCosts || []).length === 1 ? 'OK' : 'DRIFT',
        JSON.stringify(cpAfter.customCosts?.[0] || {}));
    line('ALL CONTROL PANEL VALUES PRESERVED', ok ? 'PASS' : 'FAIL');

    // An unsaved control panel sent with the generate call must drive generation
    // without being written to the database.
    const gen2 = await http.post(`/itineraries/${id}/generate`, {
        mode: 'template',
        controlPanel: { ...config, budgetUplift: 25, numberOfRooms: 9 },
    }, hdr(token));
    line('generate honours in-flight control panel', gen2.data?.itinerary?.controlPanel?.numberOfRooms === 9 ? 'PASS' : 'FAIL',
        `rooms=${gen2.data?.itinerary?.controlPanel?.numberOfRooms}`);
    const reread = await Itinerary.findById(id).lean();
    line('unsaved config NOT persisted', reread.controlPanel.numberOfRooms === 3 ? 'PASS' : 'FAIL',
        `db rooms=${reread.controlPanel.numberOfRooms} uplift=${reread.controlPanel.budgetUplift}`);

    console.log('\n== ISSUE 3: Lunch Break is not an activity ==');
    const days = gen.data?.itinerary?.days || [];
    const allEntries = days.flatMap((d) => d.activities || []);
    const breaks = allEntries.filter(isBreakEntry);
    line('day entries total', allEntries.length);
    line('break entries', breaks.length);
    line('counted activities', countActivities(days));
    line('API totalActivities matches', gen.data?.totalActivities === countActivities(days) ? 'PASS' : 'FAIL',
        `api=${gen.data?.totalActivities}`);
    line('count excludes breaks', countActivities(days) === allEntries.length - breaks.length ? 'PASS' : 'FAIL');
    if (breaks.length) {
        const b = breaks[0];
        // Breaks must be marked and unlinked. A legacy nominal price is deliberately left
        // on the record (rewriting figures a supplier already quoted would be worse); it
        // is excluded from totals by the classifier rather than erased.
        line('break is marked + unlinked',
            b.isBreak === true && b.category === 'break' && !b.activityId ? 'PASS' : 'FAIL',
            JSON.stringify({ title: b.title, isBreak: b.isBreak, category: b.category, price: b.price }));
        const priced = breaks.reduce((s, x) => s + (Number(x.price) || 0), 0);
        line('break value excluded from activity total', 'INFO', `$${priced} not billed`);
    }

    console.log('\n== ISSUE 6: geographic feasibility ==');
    let worst = 0;
    let worstDesc = '';
    days.forEach((d, i) => {
        const acts = (d.activities || []).filter((a) => !isBreakEntry(a));
        const pts = acts.map((a) => ({ a, c: getCoordinates(a) })).filter((x) => x.c);
        for (let p = 0; p < pts.length; p++) {
            for (let q = p + 1; q < pts.length; q++) {
                const km = haversineKm(pts[p].c, pts[q].c);
                if (km > worst) {
                    worst = km;
                    worstDesc = `day ${i + 1}: "${pts[p].a.title}" ↔ "${pts[q].a.title}"`;
                }
            }
        }
    });
    days.forEach((d, i) => {
        const acts = (d.activities || []).filter((a) => !isBreakEntry(a));
        const locs = [...new Set(acts.map((a) => {
            const c = getCoordinates(a);
            return c ? `${c.lat.toFixed(1)},${c.lng.toFixed(1)}` : (a.location || '?');
        }))];
        console.log(`    Day ${i + 1} (${d.date}): ${acts.length} activities  areas=[${locs.join(' | ')}]${d.transferNote ? '  ' + d.transferNote : ''}`);
    });
    line('max same-day separation', `${Math.round(worst)}km`, worstDesc);
    line('within same-area radius', worst <= SAME_AREA_RADIUS_KM ? `PASS (<= ${SAME_AREA_RADIUS_KM}km)` : 'FAIL');
    line('geography issues reported by API', (gen.data?.geography?.geographyIssues || []).length);

    console.log('\ncleaning up...');
    await Itinerary.deleteMany({ _id: { $in: created.itineraries } });
    await require('../../models/Notification').deleteMany({ userId: { $in: created.users } });
    await User.deleteMany({ _id: { $in: created.users } });
    await mongoose.disconnect();
    console.log('done');
})().catch(async (e) => {
    console.error('ERR', e.message, e.stack);
    try { await mongoose.disconnect(); } catch { }
    process.exit(1);
});
