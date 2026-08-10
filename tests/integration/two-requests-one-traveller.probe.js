/**
 * One traveller, two separate trip requests to the SAME country.
 *
 * Confirms that building an itinerary for one request touches only that request:
 * a separate itinerary per booking, no shared record, and generating or saving one
 * leaves the other untouched.
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
    const Booking = require('../../models/Booking');
    const Itinerary = require('../../models/Itinerary');
    const { countActivities, isBreakEntry } = require('../../utils/activityClassification');

    const supEmail = `kufiprobe-2r-s-${Date.now()}@example.com`;
    const sup = new User({ name: 'S', email: supEmail, password: await bcrypt.hash('ProbePass123!', 10), role: 'supplier', status: 'active', country: 'Lebanon', city: 'Beirut' });
    await sup.save();
    const travEmail = `kufiprobe-2r-t-${Date.now()}@example.com`;
    const trav = new User({ name: 'Sara Probe', email: travEmail, password: await bcrypt.hash('ProbePass123!', 10), role: 'user', status: 'active' });
    await trav.save();
    const { data: auth } = await http.post('/auth/login', { email: supEmail, password: 'ProbePass123!' });

    // Same traveller, same country, different dates — the reported scenario.
    const mkBooking = async (arrivalDate, departureDate) => {
        const b = new Booking({
            user: trav._id, supplier: sup._id, status: 'confirmed',
            contactDetails: { firstName: 'Sara', lastName: 'Probe', email: travEmail },
            tripDetails: { country: 'Lebanon', arrivalDate, departureDate, budget: '4000' },
            items: [],
        });
        await b.save();
        return b;
    };
    const bookingA = await mkBooking('2026-08-01', '2026-08-05');
    const bookingB = await mkBooking('2026-11-10', '2026-11-14');

    console.log('one traveller, two Lebanon trips:\n');
    line('booking A', String(bookingA._id), 'Aug 1-5');
    line('booking B', String(bookingB._id), 'Nov 10-14');

    // The supplier opens request A and builds its itinerary.
    console.log('\n== build the itinerary for request A only ==');
    const createA = await http.post('/itineraries', {
        userId: String(trav._id), bookingId: String(bookingA._id),
        title: 'Lebanon', destination: 'Lebanon', country: 'Lebanon',
        startDate: '2026-08-01', endDate: '2026-08-05', numberOfTravelers: 2, budget: 4000,
    }, hdr(auth.token));
    line('create itinerary A', createA.status);
    const itinA = createA.data._id;

    const genA = await http.post(`/itineraries/${itinA}/generate`, {
        mode: 'template',
        controlPanel: { activityStartTime: '09:00', activityEndTime: '19:00', lunchDurationMinutes: 60, startOnArrival: false, endOnDeparture: true, budgetUplift: 15, customCosts: [] },
    }, hdr(auth.token));
    line('generate A', genA.status, `${countActivities(genA.data.itinerary?.days)} activities`);
    await http.put(`/itineraries/${itinA}/days`, {
        days: genA.data.itinerary.days, extraFields: [], startDate: '2026-08-01', endDate: '2026-08-05',
    }, hdr(auth.token));
    line('save A as draft', 'ok');

    // Nothing should exist for B yet.
    console.log('\n== did anything happen to request B? ==');
    const itinsForB = await Itinerary.countDocuments({ bookingId: bookingB._id });
    line('itineraries for booking B', itinsForB, itinsForB === 0 ? 'PASS (untouched)' : 'FAIL — B was generated too');
    const lookupB = await http.get(`/itineraries/booking/${bookingB._id}`, hdr(auth.token));
    line('GET /itineraries/booking/B', lookupB.status, lookupB.status === 404 ? 'PASS (no itinerary yet)' : 'FAIL');

    const totalForTraveller = await Itinerary.countDocuments({ userId: trav._id });
    line('itineraries for this traveller', totalForTraveller, totalForTraveller === 1 ? 'PASS (only A)' : 'FAIL');

    // Now build B and confirm the two stay independent.
    console.log('\n== now build request B ==');
    const createB = await http.post('/itineraries', {
        userId: String(trav._id), bookingId: String(bookingB._id),
        title: 'Lebanon', destination: 'Lebanon', country: 'Lebanon',
        startDate: '2026-11-10', endDate: '2026-11-14', numberOfTravelers: 2, budget: 4000,
    }, hdr(auth.token));
    const itinB = createB.data._id;
    line('create itinerary B', createB.status);
    line('A and B are different records', String(itinA) !== String(itinB) ? 'PASS' : 'FAIL', `${itinA} vs ${itinB}`);

    const genB = await http.post(`/itineraries/${itinB}/generate`, {
        mode: 'template',
        controlPanel: { activityStartTime: '11:00', activityEndTime: '17:00', lunchDurationMinutes: 120, startOnArrival: true, endOnDeparture: false, budgetUplift: 0, customCosts: [] },
    }, hdr(auth.token));
    line('generate B (different control panel)', genB.status);

    // A must be exactly as it was left.
    const docA = await Itinerary.findById(itinA).lean();
    const docB = await Itinerary.findById(itinB).lean();
    console.log('');
    line('A still has its saved days', docA.days?.length || 0, docA.days?.length > 0 ? 'PASS' : 'FAIL');
    line('A dates unchanged', new Date(docA.startDate).toISOString().slice(0, 10), 'expected 2026-08-01');
    line('B dates independent', new Date(docB.startDate).toISOString().slice(0, 10), 'expected 2026-11-10');
    line('A control panel untouched by B', docA.controlPanel.lunchDurationMinutes !== 120 ? 'PASS' : 'FAIL',
        `A lunch=${docA.controlPanel.lunchDurationMinutes}m`);
    line('each booking maps to exactly one itinerary',
        (await Itinerary.countDocuments({ bookingId: bookingA._id })) === 1 &&
        (await Itinerary.countDocuments({ bookingId: bookingB._id })) === 1 ? 'PASS' : 'FAIL');

    // Re-creating for the same booking must return the existing record, not a duplicate.
    const dupe = await http.post('/itineraries', {
        userId: String(trav._id), bookingId: String(bookingA._id),
        title: 'Lebanon', destination: 'Lebanon', country: 'Lebanon',
        startDate: '2026-08-01', endDate: '2026-08-05', numberOfTravelers: 2, budget: 4000,
    }, hdr(auth.token));
    line('reopening A returns the same itinerary', String(dupe.data._id) === String(itinA) ? 'PASS' : 'FAIL');
    line('still one itinerary for booking A', await Itinerary.countDocuments({ bookingId: bookingA._id }));

    await Itinerary.deleteMany({ _id: { $in: [itinA, itinB] } });
    await Booking.deleteMany({ _id: { $in: [bookingA._id, bookingB._id] } });
    await require('../../models/Notification').deleteMany({ userId: { $in: [sup._id, trav._id] } });
    await User.deleteMany({ _id: { $in: [sup._id, trav._id] } });
    await mongoose.disconnect();
})().catch(async (e) => { console.error('ERR', e.message); try { await mongoose.disconnect(); } catch { } process.exit(1); });
