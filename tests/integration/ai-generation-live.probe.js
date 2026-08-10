/**
 * Runs a real AI generation through the API and reports the token usage the server
 * logged, plus whether the resulting itinerary is still correct.
 */
require('dotenv').config({ path: __dirname + '/../../.env' });
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const axios = require('axios');

const http = axios.create({ baseURL: 'http://localhost:5000/api', validateStatus: () => true, timeout: 300000 });
const hdr = (t) => ({ headers: { Authorization: `Bearer ${t}` } });
const line = (n, v, extra = '') => console.log(`  ${String(v).padStart(8)}  ${n}${extra ? '  ' + extra : ''}`);

(async () => {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 20000 });
    const User = require('../../models/User');
    const Itinerary = require('../../models/Itinerary');
    const { countActivities, isBreakEntry } = require('../../utils/activityClassification');
    const { getCoordinates, haversineKm, SAME_AREA_RADIUS_KM } = require('../../utils/geo');

    const email = `kufiprobe-ai-${Date.now()}@example.com`;
    const sup = new User({ name: 'S', email, password: await bcrypt.hash('ProbePass123!', 10), role: 'supplier', status: 'active', country: 'Egypt', city: 'Cairo' });
    await sup.save();
    const trav = new User({ name: 'T', email: `kufiprobe-ait-${Date.now()}@example.com`, password: await bcrypt.hash('ProbePass123!', 10), role: 'user', status: 'active' });
    await trav.save();
    const { data: auth } = await http.post('/auth/login', { email, password: 'ProbePass123!' });

    const mk = await http.post('/itineraries', {
        userId: String(trav._id), title: 'AI Token Probe', destination: 'Egypt', country: 'Egypt',
        startDate: '2026-09-01', endDate: '2026-09-07', numberOfTravelers: 2, budget: 4000,
    }, hdr(auth.token));
    const id = mk.data._id;

    const t0 = Date.now();
    const gen = await http.post(`/itineraries/${id}/generate`, {
        mode: 'ai',
        controlPanel: { activityStartTime: '09:00', activityEndTime: '19:00', lunchDurationMinutes: 60, startOnArrival: false, endOnDeparture: true, budgetUplift: 15, customCosts: [] },
    }, hdr(auth.token));
    const ms = Date.now() - t0;

    line('generate', gen.status, gen.data?.warning ? `WARNING: ${gen.data.warning}` : '');
    line('source', gen.data?.source);
    line('latency', `${(ms / 1000).toFixed(1)}s`);

    const days = gen.data.itinerary?.days || [];
    line('days', days.length);
    line('activities counted', gen.data.totalActivities);
    line('breaks', days.flatMap((d) => (d.activities || []).filter(isBreakEntry)).length);

    // Correctness must survive the token reduction.
    let worst = 0;
    days.forEach((d) => {
        const pts = (d.activities || []).filter((a) => !isBreakEntry(a)).map(getCoordinates).filter(Boolean);
        for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
            worst = Math.max(worst, haversineKm(pts[i], pts[j]));
        }
    });
    line('max same-day spread', `${Math.round(worst)}km`, worst <= SAME_AREA_RADIUS_KM ? 'PASS' : 'FAIL');
    line('day 1 empty (startOnArrival=false)', (days[0]?.activities || []).filter((a) => !isBreakEntry(a)).length === 0 ? 'PASS' : 'FAIL');
    const titles = days.flatMap((d) => (d.activities || []).filter((a) => !isBreakEntry(a)).map((a) => a.title));
    line('no duplicate activities', new Set(titles).size === titles.length ? 'PASS' : `FAIL (${titles.length - new Set(titles).size} dupes)`);
    const linked = days.flatMap((d) => (d.activities || []).filter((a) => !isBreakEntry(a))).filter((a) => a.activityId);
    line('linked to catalogue', `${linked.length}/${titles.length}`, 'resolved from #numbers');
    const spend = days.flatMap((d) => (d.activities || []).filter((a) => !isBreakEntry(a))).reduce((s, a) => s + (Number(a.price) || 0), 0);
    line('activity spend', `$${spend}`, `ceiling $${gen.data?.budget?.activityCeiling}`);

    days.forEach((d, i) => {
        const real = (d.activities || []).filter((a) => !isBreakEntry(a));
        console.log(`    Day ${i + 1}: ${real.map((a) => `${a.startTime} ${String(a.title).slice(0, 30)}`).join(' | ') || '(free)'}`);
    });

    // Stored size: base64 images used to be duplicated into every day entry.
    const doc = await Itinerary.findById(id).lean();
    const bytes = Buffer.byteLength(JSON.stringify(doc));
    const b64 = (doc.days || []).flatMap((d) => d.activities || [])
        .reduce((s2, a) => s2 + (String(a.image || '').startsWith('data:') ? String(a.image).length : 0), 0);
    line('stored itinerary size', `${(bytes / 1024).toFixed(0)} KB`, `base64 in days: ${(b64 / 1024).toFixed(0)} KB`);
    const sample = (doc.days || []).flatMap((d) => d.activities || []).find((a) => a.image);
    line('image field form', sample ? (String(sample.image).startsWith('data:') ? 'BASE64 (bad)' : sample.image) : '(none)');

    // The server logs exact token usage per generation. Point PROBE_SERVER_LOG at wherever
    // you redirected `node server.js` to see it; otherwise read it from the server console.
    const logPath = process.env.PROBE_SERVER_LOG;
    if (logPath && require('fs').existsSync(logPath)) {
        console.log('\n  -> server-side token log:');
        require('fs').readFileSync(logPath, 'utf8')
            .split('\n').filter((l) => l.includes('AI tokens')).slice(-3)
            .forEach((l) => console.log('    ' + l.trim()));
    } else {
        console.log('\n  -> token usage is logged by the server (set PROBE_SERVER_LOG to surface it here)');
    }

    await Itinerary.deleteMany({ _id: id });
    await require('../../models/Notification').deleteMany({ userId: { $in: [sup._id, trav._id] } });
    await User.deleteMany({ _id: { $in: [sup._id, trav._id] } });
    await mongoose.disconnect();
})().catch(async (e) => { console.error('ERR', e.message); try { await mongoose.disconnect(); } catch { } process.exit(1); });
