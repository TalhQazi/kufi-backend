/**
 * Exercises the admin activity reorder endpoint the way the up/down arrows use it,
 * then restores the original ordering.
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
    const Activity = require('../../models/Activity');

    // Snapshot the real ordering so it can be put back exactly as it was.
    const before = await Activity.find({}).select('_id order').lean();
    const originalOrder = new Map(before.map((a) => [String(a._id), a.order ?? 0]));
    console.log(`snapshot: ${before.length} activities, ${before.filter((a) => (a.order ?? 0) > 0).length} ranked\n`);

    const email = `kufiprobe-admin-${Date.now()}@example.com`;
    const admin = new User({ name: 'P Admin', email, password: await bcrypt.hash('ProbePass123!', 10), role: 'admin', status: 'active' });
    await admin.save();
    const supEmail = `kufiprobe-sup2-${Date.now()}@example.com`;
    const sup = new User({ name: 'P Sup', email: supEmail, password: await bcrypt.hash('ProbePass123!', 10), role: 'supplier', status: 'active', country: 'Egypt', city: 'Cairo' });
    await sup.save();

    const { data: aAuth } = await http.post('/auth/login', { email, password: 'ProbePass123!' });
    const { data: sAuth } = await http.post('/auth/login', { email: supEmail, password: 'ProbePass123!' });

    console.log('== authorization ==');
    line('no token (want 401)', (await http.put('/activities/reorder', { items: [] })).status);
    line('supplier token (want 403)', (await http.put('/activities/reorder', { items: [] }, hdr(sAuth.token))).status);
    line('empty items (want 400)', (await http.put('/activities/reorder', { items: [] }, hdr(aAuth.token))).status);
    line('bad id (want 400)', (await http.put('/activities/reorder', { items: [{ id: 'nope', order: 1 }] }, hdr(aAuth.token))).status);
    line('negative order (want 400)', (await http.put('/activities/reorder', { items: [{ id: String(before[0]._id), order: -3 }] }, hdr(aAuth.token))).status);
    line('route not shadowed by /:id', (await http.put('/activities/reorder', { items: [{ id: String(before[0]._id), order: 1 }] }, hdr(aAuth.token))).status);

    console.log('\n== the arrow interaction ==');
    const listBefore = (await http.get('/activities?fields=summary&limit=10', hdr(aAuth.token))).data;
    console.log('  initial top 5:');
    listBefore.slice(0, 5).forEach((a, i) => console.log(`    ${i + 1}. ${String(a.title).slice(0, 42).padEnd(44)} order=${a.order ?? 0}`));

    // Emulate "move row 4 up": renumber 1..N over the visible list with rows 3 and 4 swapped.
    const seq = listBefore.map((a) => String(a._id));
    [seq[2], seq[3]] = [seq[3], seq[2]];
    const items = seq.map((id, i) => ({ id, order: i + 1 }));

    const res = await http.put('/activities/reorder', { items }, hdr(aAuth.token));
    line('bulk reorder', res.status, JSON.stringify(res.data));

    const listAfter = (await http.get('/activities?fields=summary&limit=10', hdr(aAuth.token))).data;
    console.log('  after moving #4 up:');
    listAfter.slice(0, 5).forEach((a, i) => console.log(`    ${i + 1}. ${String(a.title).slice(0, 42).padEnd(44)} order=${a.order ?? 0}`));

    const movedUp = String(listAfter[2]._id) === String(listBefore[3]._id);
    const pushedDown = String(listAfter[3]._id) === String(listBefore[2]._id);
    line('the two rows swapped positions', movedUp && pushedDown ? 'PASS' : 'FAIL');
    line('order values are sequential 1..N', listAfter.slice(0, 10).every((a, i) => a.order === i + 1) ? 'PASS' : 'FAIL');
    line('public listing reflects the new order',
        String((await http.get('/activities?limit=5')).data[2]._id) === String(listBefore[3]._id) ? 'PASS' : 'FAIL');

    // Restore
    console.log('\nrestoring original ordering...');
    await Activity.bulkWrite(
        [...originalOrder.entries()].map(([id, order]) => ({
            updateOne: { filter: { _id: new mongoose.Types.ObjectId(id) }, update: { $set: { order } } },
        })),
        { ordered: false }
    );
    const after = await Activity.find({}).select('_id order').lean();
    const restored = after.every((a) => (a.order ?? 0) === originalOrder.get(String(a._id)));
    line('original ordering restored', restored ? 'PASS' : 'FAIL');

    await User.deleteMany({ _id: { $in: [admin._id, sup._id] } });
    await mongoose.disconnect();
})().catch(async (e) => { console.error('ERR', e.message); try { await mongoose.disconnect(); } catch { } process.exit(1); });
