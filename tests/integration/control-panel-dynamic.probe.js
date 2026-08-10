/**
 * Is the Supplier Control Panel dynamic or static?
 *
 * For every field the panel exposes, this changes ONE value and checks the generated
 * itinerary actually reflects it. Each check is a real HTTP generate call against the
 * running server, using the same payload the builder sends (`controlPanel` supplied
 * in-flight, exactly as the "Proceed to create itinerary" screen does).
 *
 * A field is "DYNAMIC" only when the observable output changes with the setting.
 */
require('dotenv').config({ path: __dirname + '/../../.env' });
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const axios = require('axios');

const MODE = process.argv.includes('--ai') ? 'ai' : 'template';
const http = axios.create({ baseURL: 'http://localhost:5000/api', validateStatus: () => true, timeout: 300000 });
const hdr = (t) => ({ headers: { Authorization: `Bearer ${t}` } });

const { isBreakEntry } = require('../../utils/activityClassification');

const results = [];
const report = (field, dynamic, detail) => {
    results.push({ field, dynamic });
    console.log(`  ${dynamic ? 'DYNAMIC' : 'STATIC '}  ${String(field).padEnd(34)} ${detail}`);
};

const BASE_CP = {
    activityStartTime: '09:00',
    activityEndTime: '19:00',
    lunchDurationMinutes: 60,
    startOnArrival: false,
    endOnDeparture: true,
    numberOfRooms: 1,
    budgetUplift: 15,
    customCosts: [],
    perDayOverrides: [],
    hotelId: null,
};

(async () => {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 20000 });
    const User = require('../../models/User');
    const Itinerary = require('../../models/Itinerary');
    const Hotel = require('../../models/Hotel');

    const email = `kufiprobe-cpd-${Date.now()}@example.com`;
    const sup = new User({ name: 'S', email, password: await bcrypt.hash('ProbePass123!', 10), role: 'supplier', status: 'active', country: 'Egypt', city: 'Cairo' });
    await sup.save();
    const trav = new User({ name: 'T', email: `kufiprobe-cpdt-${Date.now()}@example.com`, password: await bcrypt.hash('ProbePass123!', 10), role: 'user', status: 'active' });
    await trav.save();
    const { data: auth } = await http.post('/auth/login', { email, password: 'ProbePass123!' });

    const hotel = new Hotel({ name: 'Probe Hotel', city: 'Cairo', country: 'Egypt', pricePerNight: 50 });
    await hotel.save();

    // A deliberately tight budget so ceiling-driven settings have a visible effect.
    const BUDGET = 300;
    const mk = await http.post('/itineraries', {
        userId: String(trav._id), title: 'CP Dynamic Probe', destination: 'Egypt', country: 'Egypt',
        startDate: '2026-09-01', endDate: '2026-09-07', numberOfTravelers: 2, budget: BUDGET,
    }, hdr(auth.token));
    const id = mk.data._id;

    // Persist a baseline that DIFFERS from every value tested below, so a pass can only
    // mean the in-flight panel won — never that the stored copy happened to match.
    await http.put(`/itineraries/${id}/control-panel`, {
        ...BASE_CP, activityStartTime: '07:00', activityEndTime: '23:00',
        lunchDurationMinutes: 15, startOnArrival: true, endOnDeparture: false, budgetUplift: 90,
    }, hdr(auth.token));

    const gen = async (cp, extra = {}) => {
        const res = await http.post(`/itineraries/${id}/generate`, {
            mode: MODE, controlPanel: { ...BASE_CP, ...cp }, ...extra,
        }, hdr(auth.token));
        if (res.status !== 200) throw new Error(`generate ${res.status}: ${JSON.stringify(res.data).slice(0, 120)}`);
        const days = res.data.itinerary?.days || [];
        const real = (d) => (d?.activities || []).filter((a) => !isBreakEntry(a));
        return {
            days,
            cp: res.data.itinerary?.controlPanel || {},
            budget: res.data.budget,
            count: days.reduce((s, d) => s + real(d).length, 0),
            firstStart: real(days.find((d) => real(d).length) || {})[0]?.startTime,
            day1: real(days[0] || {}).length,
            lastDay: real(days[days.length - 1] || {}).length,
            breaks: [...new Set(days.flatMap((d) => (d.activities || []).filter(isBreakEntry).map((b) => `${b.startTime}-${b.endTime}`)))],
        };
    };

    console.log(`mode=${MODE}   budget=$${BUDGET}   (stored panel deliberately differs from every test value)\n`);

    // 1. startOnArrival
    const a1 = await gen({ startOnArrival: false });
    const a2 = await gen({ startOnArrival: true });
    report('startOnArrival', a1.day1 === 0 && a2.day1 > 0, `false -> day1=${a1.day1} activities | true -> day1=${a2.day1}`);

    // 2. endOnDeparture
    const b1 = await gen({ endOnDeparture: true });
    const b2 = await gen({ endOnDeparture: false });
    report('endOnDeparture', b1.lastDay > 0 && b2.lastDay === 0, `true -> lastDay=${b1.lastDay} | false -> lastDay=${b2.lastDay}`);

    // 3. activityStartTime
    const c1 = await gen({ activityStartTime: '09:00' });
    const c2 = await gen({ activityStartTime: '06:00' });
    report('activityStartTime', c1.firstStart !== c2.firstStart, `09:00 -> first ${c1.firstStart} | 06:00 -> first ${c2.firstStart}`);

    // 4. activityEndTime (shorter day = less capacity = fewer activities)
    const d1 = await gen({ activityEndTime: '19:00' });
    const d2 = await gen({ activityEndTime: '12:00' });
    report('activityEndTime', d1.count !== d2.count, `19:00 -> ${d1.count} activities | 12:00 -> ${d2.count}`);

    // 5. lunchDurationMinutes
    const e1 = await gen({ lunchDurationMinutes: 60 });
    const e2 = await gen({ lunchDurationMinutes: 120 });
    const e3 = await gen({ lunchDurationMinutes: 0 });
    report('lunchDurationMinutes', e1.breaks[0] !== e2.breaks[0] && e3.breaks.length === 0,
        `60 -> ${e1.breaks[0]} | 120 -> ${e2.breaks[0]} | 0 -> ${e3.breaks.length ? e3.breaks[0] : 'no break'}`);

    // 6. budgetUplift. Its direct effect is the activity ceiling. Whether that changes
    //    the plan depends on the budget actually being the binding constraint, so the
    //    plan effect is measured separately with a hotel eating most of the budget.
    const f1 = await gen({ budgetUplift: 0 });
    const f2 = await gen({ budgetUplift: 100 });
    report('budgetUplift (ceiling)', f1.budget?.activityCeiling !== f2.budget?.activityCeiling,
        `0% -> $${f1.budget?.activityCeiling} | 100% -> $${f2.budget?.activityCeiling}`);

    const f3 = await gen({ budgetUplift: 0, hotelId: String(hotel._id) });
    const f4 = await gen({ budgetUplift: 100, hotelId: String(hotel._id) });
    report('budgetUplift (plan)', f3.count !== f4.count,
        `0% -> ceiling $${f3.budget?.activityCeiling}, ${f3.count} acts | 100% -> $${f4.budget?.activityCeiling}, ${f4.count} acts` +
        (f3.count === f4.count ? '  (budget not the binding constraint)' : ''));

    // 7. hotelId (hotel cost eats the ceiling)
    const g1 = await gen({ hotelId: null });
    const g2 = await gen({ hotelId: String(hotel._id) });
    report('hotelId', g1.budget?.hotelCost !== g2.budget?.hotelCost,
        `none -> hotelCost $${g1.budget?.hotelCost}, ceiling $${g1.budget?.activityCeiling} | hotel -> $${g2.budget?.hotelCost}, ceiling $${g2.budget?.activityCeiling}`);

    // 8. numberOfRooms (multiplies hotel cost)
    const h1 = await gen({ hotelId: String(hotel._id), numberOfRooms: 1 });
    const h2 = await gen({ hotelId: String(hotel._id), numberOfRooms: 3 });
    report('numberOfRooms', h1.budget?.hotelCost !== h2.budget?.hotelCost,
        `1 room -> $${h1.budget?.hotelCost} | 3 rooms -> $${h2.budget?.hotelCost}`);

    // 9. customCosts
    const i1 = await gen({ customCosts: [] });
    const i2 = await gen({ customCosts: [{ id: 'transport', label: 'Transportation', amount: 30, unit: 'per_day' }] });
    report('customCosts', i1.budget?.customCostsTotal !== i2.budget?.customCostsTotal,
        `none -> $${i1.budget?.customCostsTotal} | $30/day -> $${i2.budget?.customCostsTotal}`);

    // 10. perDayOverrides. Which days hold activities is the generator's choice (and in
    //     AI mode the model's), so pick a date that demonstrably has some before
    //     overriding it — otherwise an empty day reads as a failure that is not one.
    const baseline = await gen({});
    const firstBusy = baseline.days.find((d) => (d.activities || []).some((a) => !isBreakEntry(a)));
    const overrideDate = firstBusy?.date;
    let overriddenFirst = null;
    let baselineFirst = (firstBusy?.activities || []).filter((a) => !isBreakEntry(a))[0]?.startTime;

    if (overrideDate) {
        const j = await gen({ perDayOverrides: [{ date: overrideDate, startTime: '15:00', endTime: '20:00' }] });
        const overridden = j.days.find((d) => d.date === overrideDate);
        overriddenFirst = (overridden?.activities || []).filter((a) => !isBreakEntry(a))[0]?.startTime;
    }
    report('perDayOverrides', Boolean(overriddenFirst) && overriddenFirst !== baselineFirst,
        `${overrideDate}: default ${baselineFirst} -> overridden ${overriddenFirst || 'n/a (day left empty)'}`);

    // 11. startDate / endDate (trip length)
    const k1 = await gen({}, { startDate: '2026-09-01', endDate: '2026-09-04' });
    const k2 = await gen({}, { startDate: '2026-09-01', endDate: '2026-09-08' });
    report('startDate / endDate', k1.days.length !== k2.days.length,
        `4-day range -> ${k1.days.length} days | 8-day range -> ${k2.days.length} days`);

    // The stored copy must be untouched: generation is a preview.
    const stored = (await Itinerary.findById(id).lean()).controlPanel;
    const untouched = stored.activityStartTime === '07:00' && stored.lunchDurationMinutes === 15 && stored.budgetUplift === 90;
    console.log(`\n  ${untouched ? 'OK     ' : 'PROBLEM'}  stored panel untouched by previews   start=${stored.activityStartTime} lunch=${stored.lunchDurationMinutes}m uplift=${stored.budgetUplift}`);

    const staticFields = results.filter((r) => !r.dynamic);
    console.log(`\n  ${results.length - staticFields.length}/${results.length} Control Panel fields are DYNAMIC`);
    if (staticFields.length) console.log(`  STILL STATIC: ${staticFields.map((r) => r.field).join(', ')}`);

    // Cleanup runs before the exit code is set, so a failing run never leaves records behind.
    await Itinerary.deleteMany({ _id: id });
    await Hotel.deleteMany({ _id: hotel._id });
    await require('../../models/Notification').deleteMany({ userId: { $in: [sup._id, trav._id] } });
    await User.deleteMany({ _id: { $in: [sup._id, trav._id] } });
    await mongoose.disconnect();
    process.exit(staticFields.length ? 1 : 0);
})().catch(async (e) => { console.error('ERR', e.message); try { await mongoose.disconnect(); } catch { } process.exit(1); });
