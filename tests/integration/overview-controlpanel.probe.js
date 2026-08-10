/**
 * The "Proceed to create itinerary" screen has its own Control Panel. Its values must
 * drive generation even when the request ALREADY has an itinerary record — which is the
 * case the builder used to drop, letting the stored copy win.
 *
 * Simulates the exact client sequence:
 *   1. an itinerary already exists with lunch = 60 min, 09:00-19:00
 *   2. the supplier changes the panel on the previous screen (lunch 120 min, 08:00-16:00)
 *   3. the builder loads the record, merges that panel over it, and generates
 */
require('dotenv').config({ path: __dirname + '/../../.env' });
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const axios = require('axios');

const http = axios.create({ baseURL: 'http://localhost:5000/api', validateStatus: () => true, timeout: 180000 });
const hdr = (t) => ({ headers: { Authorization: `Bearer ${t}` } });
const line = (n, v, extra = '') => console.log(`  ${String(v).padStart(8)}  ${n}${extra ? '  ' + extra : ''}`);

(async () => {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 20000 });
    const User = require('../../models/User');
    const Itinerary = require('../../models/Itinerary');
    const { isBreakEntry } = require('../../utils/activityClassification');

    const email = `kufiprobe-ocp-${Date.now()}@example.com`;
    const sup = new User({ name: 'S', email, password: await bcrypt.hash('ProbePass123!', 10), role: 'supplier', status: 'active', country: 'Lebanon', city: 'Beirut' });
    await sup.save();
    const trav = new User({ name: 'T', email: `kufiprobe-ocpt-${Date.now()}@example.com`, password: await bcrypt.hash('ProbePass123!', 10), role: 'user', status: 'active' });
    await trav.save();
    const { data: auth } = await http.post('/auth/login', { email, password: 'ProbePass123!' });

    // 1. An itinerary that already exists, with the stored defaults.
    const mk = await http.post('/itineraries', {
        userId: String(trav._id), title: 'Lebanon', destination: 'Lebanon', country: 'Lebanon',
        startDate: '2026-08-01', endDate: '2026-08-03', numberOfTravelers: 2, budget: 4000,
    }, hdr(auth.token));
    const id = mk.data._id;
    await http.put(`/itineraries/${id}/control-panel`, {
        activityStartTime: '09:00', activityEndTime: '19:00', lunchDurationMinutes: 60,
        startOnArrival: false, endOnDeparture: true, budgetUplift: 15,
    }, hdr(auth.token));
    const stored = (await Itinerary.findById(id).lean()).controlPanel;
    line('stored lunch', `${stored.lunchDurationMinutes}m`, `${stored.lunchStart}-${stored.lunchEnd}`);

    // 2. What the previous screen's panel emits after the supplier edits it.
    const overviewCp = {
        activityStartTime: '08:00', activityEndTime: '16:00', lunchDurationMinutes: 120,
        startOnArrival: true, endOnDeparture: false, budgetUplift: 0,
        hotelId: null, customCosts: [],
    };

    // 3. The builder merges that over the loaded record and generates with it.
    const gen = await http.post(`/itineraries/${id}/generate`, {
        mode: 'template',
        controlPanel: overviewCp,
        startDate: '2026-08-01',
        endDate: '2026-08-03',
    }, hdr(auth.token));
    line('generate', gen.status);

    const cp = gen.data.itinerary?.controlPanel || {};
    const days = gen.data.itinerary?.days || [];
    const breaks = days.flatMap((d) => (d.activities || []).filter(isBreakEntry));
    const breakWindows = [...new Set(breaks.map((b) => `${b.startTime}-${b.endTime}`))];
    const actTimes = days.flatMap((d) => (d.activities || []).filter((a) => !isBreakEntry(a)).map((a) => a.startTime)).filter(Boolean);

    console.log('');
    line('lunch duration applied', cp.lunchDurationMinutes === 120 ? 'PASS' : 'FAIL', `got ${cp.lunchDurationMinutes}m`);
    line('lunch window recentred', breakWindows.length === 1 && breakWindows[0] === '11:00-13:00' ? 'PASS' : 'FAIL', breakWindows.join(', ') || '(no breaks)');
    line('activity hours applied', actTimes.every((t) => t >= '08:00' && t < '16:00') ? 'PASS' : 'FAIL', `earliest ${actTimes.sort()[0]}, latest ${actTimes.sort().slice(-1)[0]}`);
    line('startOnArrival applied', (days[0]?.activities || []).some((a) => !isBreakEntry(a)) ? 'PASS' : 'FAIL', 'day 1 has activities');
    line('endOnDeparture applied', (days[days.length - 1]?.activities || []).every(isBreakEntry) ? 'PASS' : 'FAIL', 'last day empty');
    line('uplift applied', cp.budgetUplift === 0 ? 'PASS' : 'FAIL', `got ${cp.budgetUplift}`);

    const after = (await Itinerary.findById(id).lean()).controlPanel;
    line('DB untouched (preview only)', after.lunchDurationMinutes === 60 ? 'PASS' : 'FAIL', `db lunch ${after.lunchDurationMinutes}m`);

    days.forEach((d, i) => {
        const real = (d.activities || []).filter((a) => !isBreakEntry(a));
        const br = (d.activities || []).filter(isBreakEntry);
        console.log(`    Day ${i + 1}: ${real.length} activities ${real.map((a) => a.startTime).join(',')} | break ${br.map((b) => b.startTime + '-' + b.endTime).join(',') || '-'}`);
    });

    await Itinerary.deleteMany({ _id: id });
    await require('../../models/Notification').deleteMany({ userId: { $in: [sup._id, trav._id] } });
    await User.deleteMany({ _id: { $in: [sup._id, trav._id] } });
    await mongoose.disconnect();
})().catch(async (e) => { console.error('ERR', e.message); try { await mongoose.disconnect(); } catch { } process.exit(1); });
