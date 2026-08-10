/**
 * Do startOnArrival / endOnDeparture actually change the generated plan?
 * Also checks that Save-as-Draft persists and lands the request in the Drafts tab.
 */
require('dotenv').config({ path: __dirname + '/../../.env' });
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const axios = require('axios');

const MODE = process.argv.includes('--ai') ? 'ai' : 'template';
const http = axios.create({ baseURL: 'http://localhost:5000/api', validateStatus: () => true, timeout: 300000 });
const hdr = (t) => ({ headers: { Authorization: `Bearer ${t}` } });

(async () => {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 20000 });
    const User = require('../../models/User');
    const Itinerary = require('../../models/Itinerary');
    const Booking = require('../../models/Booking');
    const { isBreakEntry } = require('../../utils/activityClassification');

    const email = `kufiprobe-tg-${Date.now()}@example.com`;
    const sup = new User({ name: 'P', email, password: await bcrypt.hash('ProbePass123!', 10), role: 'supplier', status: 'active', country: 'Egypt', city: 'Cairo' });
    await sup.save();
    const trav = new User({ name: 'T', email: `kufiprobe-tgt-${Date.now()}@example.com`, password: await bcrypt.hash('ProbePass123!', 10), role: 'user', status: 'active' });
    await trav.save();
    const { data: auth } = await http.post('/auth/login', { email, password: 'ProbePass123!' });

    const booking = new Booking({
        user: trav._id, supplier: sup._id,
        contactDetails: { firstName: 'P', lastName: 'T', email: trav.email },
        tripDetails: { country: 'Egypt', arrivalDate: '2026-09-01', departureDate: '2026-09-05' },
        items: [],
    });
    await booking.save();

    const mk = await http.post('/itineraries', {
        userId: String(trav._id), bookingId: String(booking._id),
        title: 'Toggle Probe', destination: 'Egypt', country: 'Egypt',
        startDate: '2026-09-01', endDate: '2026-09-05', numberOfTravelers: 2, budget: 5000,
    }, hdr(auth.token));
    const id = mk.data._id;

    const countOn = (days, i) => (days?.[i]?.activities || []).filter((a) => !isBreakEntry(a)).length;

    console.log(`mode=${MODE}   5-day trip (day 1 = arrival, day 5 = departure)\n`);
    console.log('startOnArrival | endOnDeparture | day1 acts | day5 acts | per-day counts');
    console.log('-'.repeat(78));

    const run = async (startOnArrival, endOnDeparture) => {
        const res = await http.post(`/itineraries/${id}/generate`, {
            mode: MODE,
            controlPanel: { startOnArrival, endOnDeparture, budgetUplift: 15, customCosts: [] },
        }, hdr(auth.token));
        const days = res.data.itinerary?.days || [];
        const per = days.map((_, i) => countOn(days, i));
        console.log(
            `${String(startOnArrival).padStart(14)} | ${String(endOnDeparture).padStart(14)} | ${String(countOn(days, 0)).padStart(9)} | ${String(countOn(days, days.length - 1)).padStart(9)} | [${per.join(', ')}]`
        );
        return { first: countOn(days, 0), last: countOn(days, days.length - 1), days };
    };

    const a = await run(false, true);   // default: no activities on arrival, activities on departure
    const b = await run(true, true);    // arrival day should now have activities
    const c = await run(false, false);  // departure day should now be empty
    const d = await run(true, false);

    console.log('\nexpectations:');
    console.log(`  startOnArrival false -> day 1 empty : ${a.first === 0 ? 'PASS' : 'FAIL (' + a.first + ' activities)'}`);
    console.log(`  startOnArrival true  -> day 1 filled: ${b.first > 0 ? 'PASS' : 'FAIL (0 activities)'}`);
    console.log(`  endOnDeparture true  -> last filled : ${a.last > 0 ? 'PASS' : 'FAIL (0 activities)'}`);
    console.log(`  endOnDeparture false -> last empty  : ${c.last === 0 ? 'PASS' : 'FAIL (' + c.last + ' activities)'}`);
    console.log(`  both true            -> day1 filled : ${d.first > 0 ? 'PASS' : 'FAIL'}`);
    console.log(`  both -> last empty                  : ${d.last === 0 ? 'PASS' : 'FAIL (' + d.last + ')'}`);

    console.log('\n== Save as Draft ==');
    const draftBody = {
        days: a.days,
        extraFields: [],
        startDate: '2026-09-01',
        endDate: '2026-09-05',
        controlPanel: { startOnArrival: false, endOnDeparture: true, budgetUplift: 15 },
        aiGenerated: true,
        generationSource: 'template',
    };
    const save = await http.put(`/itineraries/${id}/days`, draftBody, hdr(auth.token));
    console.log(`  PUT /days -> ${save.status}`);
    const reread = await Itinerary.findById(id).lean();
    console.log(`  days persisted:        ${reread.days?.length || 0}`);
    console.log(`  status:                ${reread.status}`);
    const drafts = await http.get('/supplier/bookings?tab=new&limit=50', hdr(auth.token));
    const inNew = (drafts.data.bookings || []).some((x) => String(x._id) === String(booking._id));
    const all = await http.get('/supplier/bookings?limit=50', hdr(auth.token));
    const row = (all.data.bookings || []).find((x) => String(x._id) === String(booking._id));
    console.log(`  workflowStage:         ${row?.workflowStage}`);
    console.log(`  still in "New" tab:    ${inNew ? 'YES (wrong)' : 'no'}`);
    console.log(`  -> lands in Drafts:    ${row?.workflowStage === 'draft' ? 'PASS' : 'FAIL'}`);

    await Itinerary.deleteMany({ _id: id });
    await Booking.deleteMany({ _id: booking._id });
    await require('../../models/Notification').deleteMany({ userId: { $in: [sup._id, trav._id] } });
    await User.deleteMany({ _id: { $in: [sup._id, trav._id] } });
    await mongoose.disconnect();
})().catch(async (e) => { console.error('ERR', e.message, e.stack); try { await mongoose.disconnect(); } catch { } process.exit(1); });
