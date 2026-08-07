/**
 * Read-only(ish) probe: creates two throwaway suppliers + a traveler, exercises the
 * supplier flows against the running server, then deletes everything it created.
 */
require('dotenv').config({ path: __dirname + '/../../.env' });
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const axios = require('axios');

const BASE = process.env.PROBE_BASE || 'http://localhost:5000/api';
const http = axios.create({ baseURL: BASE, validateStatus: () => true, timeout: 60000 });

const TAG = 'kufiprobe';
const created = { users: [], activities: [], bookings: [], itineraries: [] };

async function mkUser(role, email, extra = {}) {
    const User = require('../../models/User');
    const u = new User({
        name: `Probe ${role}`,
        email,
        password: await bcrypt.hash('ProbePass123!', 10),
        role,
        status: 'active',
        country: 'Egypt',
        city: 'Cairo',
        ...extra,
    });
    await u.save();
    created.users.push(u._id);
    return u;
}

async function login(email, password = 'ProbePass123!') {
    const r = await http.post('/auth/login', { email, password });
    return { status: r.status, token: r.data?.token, body: r.data };
}

const hdr = (t) => ({ headers: { Authorization: `Bearer ${t}` } });
const line = (n, s, extra = '') => console.log(`  ${String(s).padStart(3)}  ${n}${extra ? '  ' + extra : ''}`);

(async () => {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 20000 });
    console.log('connected\n');

    const eA = `${TAG}-a-${Date.now()}@example.com`;
    const eB = `${TAG}-b-${Date.now()}@example.com`;
    const eT = `${TAG}-t-${Date.now()}@example.com`;
    const supA = await mkUser('supplier', eA);
    const supB = await mkUser('supplier', eB);
    const trav = await mkUser('user', eT);

    const la = await login(eA);
    const lb = await login(eB);
    const lt = await login(eT);
    console.log('== LOGIN ==');
    line('supplier A login', la.status);
    line('supplier B login', lb.status);
    line('traveler login', lt.status);

    console.log('\n== ISSUE 11: case-insensitive email ==');
    line('login with UPPERCASE email', (await login(eA.toUpperCase())).status);
    line('login with MiXeD email', (await login(eA.replace(/(.)/g, (c, _, i) => (i % 2 ? c.toUpperCase() : c)))).status);
    const dup = await http.post('/auth/register', { name: 'Dup', email: eA.toUpperCase(), password: 'ProbePass123!', role: 'user' });
    line('register duplicate w/ different case (want 400)', dup.status, JSON.stringify(dup.data).slice(0, 60));

    console.log('\n== ISSUE 1: supplier submits an experience/request ==');
    const actPayload = {
        title: `${TAG} experience`, description: 'probe', location: 'Cairo, Egypt',
        country: 'Egypt', price: 100, duration: '2 hours', category: 'culture',
        coordinates: { lat: 30.0444, lng: 31.2357 },
    };
    const cr = await http.post('/supplier/activities', actPayload, hdr(la.token));
    line('POST /supplier/activities (create)', cr.status);
    if (cr.data?._id) created.activities.push(cr.data._id);
    line('  -> supplier field set server-side?', String(cr.data?.supplier) === String(supA._id) ? 'YES' : `NO (${cr.data?.supplier})`);
    line('  -> status forced pending?', cr.data?.status);

    const spoof = await http.post('/supplier/activities', { ...actPayload, title: `${TAG} spoof`, supplier: String(supB._id) }, hdr(la.token));
    if (spoof.data?._id) created.activities.push(spoof.data._id);
    line('POST with spoofed supplierId in body', spoof.status,
        String(spoof.data?.supplier) === String(supA._id) ? 'ignored (good)' : `HONORED (BAD: ${spoof.data?.supplier})`);

    const dupe = await http.post('/supplier/activities', actPayload, hdr(la.token));
    line('POST duplicate submission (want 409)', dupe.status);
    if (dupe.data?._id) created.activities.push(dupe.data._id);
    line('POST missing required fields (want 400)', (await http.post('/supplier/activities', { description: 'x' }, hdr(la.token))).status);

    if (cr.data?._id) {
        const upd = await http.put(`/supplier/activities/${cr.data._id}`, { ...actPayload, price: 150 }, hdr(la.token));
        line('PUT /supplier/activities/:id (supplier edits OWN)', upd.status, `price=${upd.data?.price} status=${upd.data?.status}`);
        const foreignEdit = await http.put(`/supplier/activities/${cr.data._id}`, { ...actPayload, price: 1 }, hdr(lb.token));
        line('supplier B edits supplier A experience (want 403)', foreignEdit.status);
        const foreignDel = await http.delete(`/supplier/activities/${cr.data._id}`, hdr(lb.token));
        line('supplier B deletes supplier A experience (want 403)', foreignDel.status);
        const del = await http.delete(`/supplier/activities/${cr.data._id}`, hdr(la.token));
        line('DELETE /supplier/activities/:id (supplier deletes OWN)', del.status);
        line('admin-only PUT /activities/:id still blocks suppliers',
            (await http.put(`/activities/${spoof.data?._id}`, actPayload, hdr(la.token))).status);
    }
    line('POST /supplier/activities  no token', (await http.post('/supplier/activities', actPayload)).status);
    line('POST /supplier/activities  bad token', (await http.post('/supplier/activities', actPayload, hdr('garbage.token.here'))).status);
    line('POST /supplier/activities  traveler token (want 403)', (await http.post('/supplier/activities', actPayload, hdr(lt.token))).status);
    line('GET  /supplier/activities  listing', (await http.get('/supplier/activities', hdr(la.token))).status);

    console.log('\n== ISSUE 12: booking IDOR / trust of client identity ==');
    const bk = await http.post('/bookings', {
        user: String(trav._id),
        contactDetails: { firstName: 'Probe', lastName: 'T', email: eT },
        tripDetails: { country: 'Egypt', arrivalDate: '2026-09-01', departureDate: '2026-09-05', budget: '2000' },
        items: [],
    });
    line('POST /bookings  UNAUTHENTICATED (public)', bk.status);
    if (bk.data?._id) created.bookings.push(bk.data._id);
    if (bk.data?._id) {
        const other = await http.patch(`/bookings/${bk.data._id}/status`, { status: 'confirmed' }, hdr(lb.token));
        line('supplier B changes status of booking not assigned to them', other.status, other.status === 200 ? '<-- IDOR' : '');
        const own = await http.patch(`/bookings/${bk.data._id}`, { totalAmount: 999999, paymentStatus: 'paid' }, hdr(lt.token));
        line('traveler sets own booking paymentStatus=paid + amount', own.status, own.status === 200 ? '<-- IDOR' : '');
        const read = await http.get(`/bookings/user/${trav._id}`, hdr(lb.token));
        line('supplier B reads traveler bookings by userId', read.status, read.status === 200 ? '<-- IDOR' : '');
    }

    console.log('\n== ISSUE 2: control panel / uplift persistence ==');
    const itn = await http.post('/itineraries', {
        userId: String(trav._id), title: 'Probe Trip', destination: 'Cairo',
        country: 'Egypt', city: 'Cairo', startDate: '2026-09-01', endDate: '2026-09-05',
        numberOfTravelers: 2, budget: 2000,
    }, hdr(la.token));
    line('POST /itineraries as supplier A', itn.status);
    const itnId = itn.data?._id;
    if (itnId) created.itineraries.push(itnId);

    if (itnId) {
        const cp0 = await http.put(`/itineraries/${itnId}/control-panel`, { budgetUplift: 0, numberOfRooms: 3 }, hdr(la.token));
        line('PUT control-panel budgetUplift=0', cp0.status, `stored=${cp0.data?.controlPanel?.budgetUplift}`);
        const gen = await http.post(`/itineraries/${itnId}/generate`, { mode: 'template' }, hdr(la.token));
        line('POST generate (template)', gen.status, `cp.budgetUplift after generate=${gen.data?.itinerary?.controlPanel?.budgetUplift}`);
        line('  days returned', gen.data?.itinerary?.days?.length ?? 0);
        const foreign = await http.post(`/itineraries/${itnId}/generate`, { mode: 'template' }, hdr(lb.token));
        line('supplier B generates supplier A itinerary', foreign.status, foreign.status === 200 ? '<-- IDOR' : '');
        const readB = await http.get(`/itineraries/${itnId}`, hdr(lb.token));
        line('supplier B reads supplier A itinerary', readB.status, readB.status === 200 ? '<-- IDOR' : '');
        const cpB = await http.put(`/itineraries/${itnId}/control-panel`, { budgetUplift: 99 }, hdr(lb.token));
        line('supplier B overwrites supplier A control panel', cpB.status, cpB.status === 200 ? '<-- IDOR' : '');
    }

    console.log('\n== ISSUE 9: change password ==');
    const cp1 = await http.post('/auth/change-password', { currentPassword: 'WRONG', newPassword: 'NewProbe123!' }, hdr(la.token));
    line('wrong current password (want 400)', cp1.status, JSON.stringify(cp1.data).slice(0, 60));
    const cp2 = await http.post('/auth/change-password', { currentPassword: 'ProbePass123!', newPassword: 'NewProbe123!' }, hdr(la.token));
    line('correct current password', cp2.status, JSON.stringify(cp2.data).slice(0, 80));
    line('login with OLD password after change (want 400)', (await login(eA, 'ProbePass123!')).status);
    const relogin = await login(eA, 'NewProbe123!');
    line('login with NEW password', relogin.status);
    // The change-password response hands back a fresh token so the caller stays signed in.
    line('token returned by change-password works', (await http.get('/auth/profile', hdr(cp2.data?.token))).status);
    const cp3 = await http.post('/auth/change-password', { currentPassword: 'NewProbe123!', newPassword: 'NewProbe123!' }, hdr(relogin.token));
    line('new password == old password (want 400)', cp3.status, JSON.stringify(cp3.data).slice(0, 60));
    const cp4 = await http.post('/auth/change-password', { currentPassword: 'NewProbe123!', newPassword: '123' }, hdr(relogin.token));
    line('weak new password "123" (want 400)', cp4.status, JSON.stringify(cp4.data).slice(0, 70));
    const cp5 = await http.post('/auth/change-password', { currentPassword: 'NewProbe123!', newPassword: 'AnotherPass9!', confirmPassword: 'Mismatch9!' }, hdr(relogin.token));
    line('confirmPassword mismatch (want 400)', cp5.status, JSON.stringify(cp5.data).slice(0, 60));
    line('OLD token usable after password change (want 401)',
        (await http.get('/auth/profile', hdr(la.token))).status);

    console.log('\n== profile update ==');
    line('PATCH /auth/profile', (await http.patch('/auth/profile', { city: 'Giza' }, hdr(lt.token))).status);

    console.log('\n== ISSUE 10: password reset token ==');
    const fp = await http.post('/auth/forgot-password', { email: eT });
    line('POST forgot-password (existing user)', fp.status, JSON.stringify(fp.data).slice(0, 70));
    const fp404 = await http.post('/auth/forgot-password', { email: 'definitely-not-here@example.com' });
    line('POST forgot-password (unknown user)', fp404.status, fp404.status === 404 ? '<-- USER ENUMERATION' : '');
    const User = require('../../models/User');
    const { hashResetToken } = require('../../utils/resetToken');
    const fresh = await User.findById(trav._id).select('+resetPasswordToken +resetPasswordExpires').lean();
    const storedHash = fresh?.resetPasswordToken;
    line('reset token stored as', storedHash ? (storedHash.length === 64 ? 'SHA-256 HASH (good)' : `plaintext-ish len=${storedHash.length}`) : 'none');
    line('token expiry set', fresh?.resetPasswordExpires ? new Date(fresh.resetPasswordExpires).toISOString() : 'none');

    // The emailed token is never stored, so reconstruct one the same way the controller
    // does and write its digest — this is exactly what a real link carries.
    const rawToken = require('crypto').randomBytes(32).toString('hex');
    await User.findByIdAndUpdate(trav._id, {
        resetPasswordToken: hashResetToken(rawToken),
        resetPasswordExpires: new Date(Date.now() + 60 * 60 * 1000),
    });
    line('reset with WEAK password (want 400)', (await http.post('/auth/reset-password', { token: rawToken, password: '123' })).status);
    line('reset with the raw DB value instead of the token (want 400)',
        (await http.post('/auth/reset-password', { token: hashResetToken(rawToken), password: 'ResetProbe123!' })).status);
    line('reset with valid token', (await http.post('/auth/reset-password', { token: rawToken, password: 'ResetProbe123!' })).status);
    line('REUSE same token (want 400)', (await http.post('/auth/reset-password', { token: rawToken, password: 'ResetProbe456!' })).status);
    line('login with the reset password', (await login(eT, 'ResetProbe123!')).status);
    line('traveler OLD token after reset (want 401)', (await http.get('/auth/profile', hdr(lt.token))).status);

    const expiredRaw = require('crypto').randomBytes(32).toString('hex');
    await User.findByIdAndUpdate(trav._id, {
        resetPasswordToken: hashResetToken(expiredRaw),
        resetPasswordExpires: new Date(Date.now() - 1000),
    });
    line('EXPIRED token (want 400)', (await http.post('/auth/reset-password', { token: expiredRaw, password: 'X1234567!' })).status);
    line('unknown token (want 400)', (await http.post('/auth/reset-password', { token: 'nope', password: 'X1234567!' })).status);

    console.log('\n== ISSUE 4/5: SEO endpoints ==');
    for (const p of ['/robots.txt', '/sitemap.xml']) {
        const r = await axios.get(`http://localhost:5000${p}`, { validateStatus: () => true });
        line(`GET ${p}`, r.status);
    }

    console.log('\n== rate limiting ==');
    const t0 = Date.now();
    const codes = [];
    for (let i = 0; i < 25; i++) {
        codes.push((await http.post('/auth/login', { email: eB, password: 'wrong' + i })).status);
    }
    line('25 failed logins in ' + (Date.now() - t0) + 'ms', [...new Set(codes)].join(','), codes.every((c) => c === 400) ? '<-- NO RATE LIMIT' : '');

    // cleanup
    console.log('\ncleaning up...');
    await require('../../models/Activity').deleteMany({ _id: { $in: created.activities } });
    await require('../../models/Booking').deleteMany({ _id: { $in: created.bookings } });
    await require('../../models/Itinerary').deleteMany({ _id: { $in: created.itineraries } });
    await require('../../models/Notification').deleteMany({ userId: { $in: created.users } });
    await User.deleteMany({ _id: { $in: created.users } });
    await User.deleteMany({ email: /kufiprobe/i });
    console.log('done');
    await mongoose.disconnect();
})().catch(async (e) => {
    console.error('ERR', e.message, e.stack);
    try { await mongoose.disconnect(); } catch { }
    process.exit(1);
});
