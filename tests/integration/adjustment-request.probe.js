/**
 * "Request Adjustment": does it reach the supplier?
 *
 * Reproduces both the booking-id case and the itinerary-id case, because the traveller
 * view derives its key as `request?.id || request?._id || itineraryId` — so when the
 * itinerary is opened from history (no `request`) it sends the ITINERARY id to a
 * /bookings/:id endpoint.
 */
require('dotenv').config({ path: __dirname + '/../../.env' });
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const axios = require('axios');

const http = axios.create({ baseURL: 'http://localhost:5000/api', validateStatus: () => true, timeout: 120000 });
const hdr = (t) => ({ headers: { Authorization: `Bearer ${t}` } });
const line = (n, v, extra = '') => console.log(`  ${String(v).padStart(6)}  ${n}${extra ? '  ' + extra : ''}`);

(async () => {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 20000 });
    const User = require('../../models/User');
    const Booking = require('../../models/Booking');
    const Itinerary = require('../../models/Itinerary');
    const Notification = require('../../models/Notification');

    const supEmail = `kufiprobe-adj-s-${Date.now()}@example.com`;
    const sup = new User({ name: 'S', email: supEmail, password: await bcrypt.hash('ProbePass123!', 10), role: 'supplier', status: 'active', country: 'Egypt', city: 'Cairo' });
    await sup.save();
    const travEmail = `kufiprobe-adj-t-${Date.now()}@example.com`;
    const trav = new User({ name: 'T', email: travEmail, password: await bcrypt.hash('ProbePass123!', 10), role: 'user', status: 'active' });
    await trav.save();

    const { data: sAuth } = await http.post('/auth/login', { email: supEmail, password: 'ProbePass123!' });
    const { data: tAuth } = await http.post('/auth/login', { email: travEmail, password: 'ProbePass123!' });

    const booking = new Booking({
        user: trav._id, supplier: sup._id, status: 'confirmed',
        contactDetails: { firstName: 'T', lastName: 'X', email: travEmail },
        tripDetails: { country: 'Egypt', arrivalDate: '2026-09-01', departureDate: '2026-09-05' },
        items: [],
    });
    await booking.save();

    const itinerary = new Itinerary({
        userId: trav._id, supplierId: sup._id, bookingId: booking._id,
        title: 'Adj Probe', destination: 'Egypt', country: 'Egypt',
        status: 'Supplier Replied Back',
        startDate: '2026-09-01', endDate: '2026-09-05',
        days: [{ day: 1, date: '2026-09-01', activities: [] }],
    });
    await itinerary.save();

    const card = { title: 'Add a Nile cruise', description: 'Please add an evening cruise', location: 'Cairo', cost: '120', imageDataUrl: '' };

    console.log('== the traveller sends an adjustment ==');
    const byBooking = await http.patch(`/bookings/${booking._id}/adjustment`, { card }, hdr(tAuth.token));
    line('PATCH /bookings/<bookingId>/adjustment', byBooking.status);

    // What the itinerary-history entry point actually sends.
    const byItinerary = await http.patch(`/bookings/${itinerary._id}/adjustment`, { card }, hdr(tAuth.token));
    line('PATCH /bookings/<ITINERARY id>/adjustment', byItinerary.status,
        byItinerary.status !== 200 ? '<-- silently swallowed by the UI, user still sees "sent!"' : '');

    console.log('\n== does it reach the supplier? ==');
    const fresh = await Booking.findById(booking._id).lean();
    line('adjustmentCard stored on the booking', fresh?.adjustmentCard ? 'yes' : 'NO');
    line('adjustmentRequestedAt set', fresh?.adjustmentRequestedAt ? 'yes' : 'NO');

    const supplierNotes = await Notification.find({ userId: sup._id }).lean();
    line('notifications for the SUPPLIER', supplierNotes.length, supplierNotes.length === 0 ? '<-- supplier is never told' : supplierNotes.map((n) => n.type).join(','));

    const list = await http.get('/supplier/bookings?limit=50', hdr(sAuth.token));
    const row = (list.data.bookings || []).find((b) => String(b._id) === String(booking._id));
    line('booking visible to supplier', row ? 'yes' : 'NO');
    line('  workflowStage', row?.workflowStage);
    line('  adjustmentCard present in payload', row?.adjustmentCard ? 'yes' : 'NO');
    line('booking status after adjustment', fresh?.status);
    line('itinerary status after adjustment', (await Itinerary.findById(itinerary._id).lean())?.status);

    console.log('\n== which supplier tab does it land in? ==');
    for (const tab of ['new', 'in_progress', 'upcoming']) {
        const r = await http.get(`/supplier/bookings?tab=${tab}&limit=50`, hdr(sAuth.token));
        const found = (r.data.bookings || []).some((b) => String(b._id) === String(booking._id));
        line(`tab=${tab}`, found ? 'FOUND' : '-');
    }

    console.log('\n== supplier dashboard signal ==');
    const dash = await http.get('/supplier/bookings', hdr(sAuth.token));
    const withCards = (dash.data.bookings || []).filter((b) => {
        const c = b?.adjustmentCard;
        return c && [c.title, c.description, c.location, c.cost, c.imageDataUrl].some((v) => String(v || '').trim());
    });
    line('bookings the dashboard counts as needing adjustment', withCards.length, withCards.length > 0 ? '-> banner shows' : '-> NO banner');
    line('traveller confirmation notification', (await Notification.countDocuments({ userId: trav._id, type: 'adjustment_sent' })));

    console.log('\n== authorization ==');
    const other = new User({ name: 'O', email: `kufiprobe-adj-o-${Date.now()}@example.com`, password: await bcrypt.hash('ProbePass123!', 10), role: 'user', status: 'active' });
    await other.save();
    const { data: oAuth } = await http.post('/auth/login', { email: other.email, password: 'ProbePass123!' });
    line('another traveller adjusts this booking (want 403)', (await http.patch(`/bookings/${booking._id}/adjustment`, { card }, hdr(oAuth.token))).status);
    line('unauthenticated (want 401)', (await http.patch(`/bookings/${booking._id}/adjustment`, { card })).status);
    line('empty card (want 400)', (await http.patch(`/bookings/${booking._id}/adjustment`, { card: {} }, hdr(tAuth.token))).status);
    await User.deleteMany({ _id: other._id });

    await Notification.deleteMany({ userId: { $in: [sup._id, trav._id] } });
    await Itinerary.deleteMany({ _id: itinerary._id });
    await Booking.deleteMany({ _id: booking._id });
    await User.deleteMany({ _id: { $in: [sup._id, trav._id] } });
    await mongoose.disconnect();
})().catch(async (e) => { console.error('ERR', e.message); try { await mongoose.disconnect(); } catch { } process.exit(1); });
