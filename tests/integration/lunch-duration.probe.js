/**
 * The lunch break is configured as a duration only and must apply to EVERY day,
 * centred in the activity window and moving with the start/end times.
 */
require('dotenv').config({ path: __dirname + '/../../.env' });
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const axios = require('axios');

const http = axios.create({ baseURL: 'http://localhost:5000/api', validateStatus: () => true, timeout: 300000 });
const hdr = (t) => ({ headers: { Authorization: `Bearer ${t}` } });

(async () => {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 20000 });
    const User = require('../../models/User');
    const Itinerary = require('../../models/Itinerary');
    const { isBreakEntry } = require('../../utils/activityClassification');

    const email = `kufiprobe-ld-${Date.now()}@example.com`;
    const sup = new User({ name: 'P', email, password: await bcrypt.hash('ProbePass123!', 10), role: 'supplier', status: 'active', country: 'Egypt', city: 'Cairo' });
    await sup.save();
    const trav = new User({ name: 'T', email: `kufiprobe-ldt-${Date.now()}@example.com`, password: await bcrypt.hash('ProbePass123!', 10), role: 'user', status: 'active' });
    await trav.save();
    const { data: auth } = await http.post('/auth/login', { email, password: 'ProbePass123!' });

    const mk = await http.post('/itineraries', {
        userId: String(trav._id), title: 'Lunch Probe', destination: 'Egypt', country: 'Egypt',
        startDate: '2026-09-01', endDate: '2026-09-05', numberOfTravelers: 2, budget: 5000,
    }, hdr(auth.token));
    const id = mk.data._id;

    console.log('window       dur  | stored window | break entries per day | days with a break');
    console.log('-'.repeat(88));

    const run = async (activityStartTime, activityEndTime, lunchDurationMinutes) => {
        const cp = { activityStartTime, activityEndTime, lunchDurationMinutes, startOnArrival: true, endOnDeparture: true, budgetUplift: 15, customCosts: [] };
        await http.put(`/itineraries/${id}/control-panel`, cp, hdr(auth.token));
        const stored = await Itinerary.findById(id).lean();
        const res = await http.post(`/itineraries/${id}/generate`, { mode: 'template', controlPanel: cp }, hdr(auth.token));
        const days = res.data.itinerary?.days || [];
        const perDay = days.map((d) => (d.activities || []).filter(isBreakEntry).length);
        const daysWithActivities = days.filter((d) => (d.activities || []).some((a) => !isBreakEntry(a))).length;
        const daysWithBreak = days.filter((d) => (d.activities || []).some(isBreakEntry)).length;
        const times = [...new Set(days.flatMap((d) => (d.activities || []).filter(isBreakEntry).map((b) => `${b.startTime}-${b.endTime}`)))];
        console.log(
            `${activityStartTime}-${activityEndTime} ${String(lunchDurationMinutes).padStart(4)}m | ` +
            `${(stored.controlPanel.lunchStart + '-' + stored.controlPanel.lunchEnd).padEnd(13)} | ` +
            `[${perDay.join(', ')}]`.padEnd(21) + ` | ${daysWithBreak}/${daysWithActivities}  break times: ${times.join(' ') || '(none)'}`
        );
        return { stored: stored.controlPanel, daysWithBreak, daysWithActivities, times };
    };

    const a = await run('09:00', '19:00', 60);
    const b = await run('08:00', '18:00', 60);
    const c = await run('09:00', '19:00', 90);
    const d = await run('09:00', '19:00', 0);

    console.log('\nchecks:');
    console.log(`  duration stored and window derived  : ${a.stored.lunchDurationMinutes === 60 && a.stored.lunchStart === '13:30' ? 'PASS' : 'FAIL (' + a.stored.lunchStart + '-' + a.stored.lunchEnd + ')'}`);
    console.log(`  window moves with activity hours    : ${b.stored.lunchStart === '12:30' ? 'PASS' : 'FAIL (' + b.stored.lunchStart + ')'}`);
    console.log(`  longer duration widens the window   : ${c.stored.lunchStart === '13:15' && c.stored.lunchEnd === '14:45' ? 'PASS' : 'FAIL (' + c.stored.lunchStart + '-' + c.stored.lunchEnd + ')'}`);
    console.log(`  applies to EVERY day with activities: ${a.daysWithBreak === a.daysWithActivities ? 'PASS' : 'FAIL (' + a.daysWithBreak + '/' + a.daysWithActivities + ')'}`);
    console.log(`  one identical window across days    : ${a.times.length === 1 ? 'PASS (' + a.times[0] + ')' : 'FAIL (' + a.times.join(', ') + ')'}`);
    console.log(`  duration 0 -> no break scheduled    : ${d.stored.lunchDurationMinutes === 0 ? 'PASS' : 'FAIL (' + d.stored.lunchDurationMinutes + ')'}`);

    await Itinerary.deleteMany({ _id: id });
    await require('../../models/Notification').deleteMany({ userId: { $in: [sup._id, trav._id] } });
    await User.deleteMany({ _id: { $in: [sup._id, trav._id] } });
    await mongoose.disconnect();
})().catch(async (e) => { console.error('ERR', e.message, e.stack); try { await mongoose.disconnect(); } catch { } process.exit(1); });
