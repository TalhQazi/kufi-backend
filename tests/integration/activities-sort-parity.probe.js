/**
 * Confirms the new database-side sort in getActivities returns the same order as the
 * previous in-JS sort, so pagination did not silently reshuffle the catalogue.
 */
require('dotenv').config({ path: __dirname + '/../../.env' });
const mongoose = require('mongoose');
const axios = require('axios');

(async () => {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 20000 });
    const Activity = require('../../models/Activity');

    // The original implementation, reproduced verbatim.
    const raw = await Activity.find({}).select('-images -description -addOns -coordinates').sort({ createdAt: -1 }).lean().limit(1000);
    raw.sort((a, b) => {
        const orderA = Number(a.order) || 0;
        const orderB = Number(b.order) || 0;
        if (orderA > 0 && orderB > 0) return orderA - orderB;
        if (orderA > 0 && orderB === 0) return -1;
        if (orderA === 0 && orderB > 0) return 1;
        const dateA = new Date(a.createdAt || a._id?.getTimestamp?.() || 0).getTime();
        const dateB = new Date(b.createdAt || b._id?.getTimestamp?.() || 0).getTime();
        return dateB - dateA;
    });
    const oldOrder = raw.map((a) => String(a._id));

    const { data } = await axios.get('http://localhost:5000/api/activities', { timeout: 180000 });
    const newOrder = data.map((a) => String(a._id));

    console.log('old count:', oldOrder.length, ' new count:', newOrder.length);
    const identical = JSON.stringify(oldOrder) === JSON.stringify(newOrder);
    console.log('full ordering identical:', identical ? 'YES' : 'NO');
    if (!identical) {
        for (let i = 0; i < Math.max(oldOrder.length, newOrder.length); i++) {
            if (oldOrder[i] !== newOrder[i]) {
                console.log(`first divergence at index ${i}: old=${oldOrder[i]} new=${newOrder[i]}`);
                const o = raw.find((x) => String(x._id) === oldOrder[i]);
                const n = data.find((x) => String(x._id) === newOrder[i]);
                console.log('  old:', o?.title, 'order=', o?.order, 'createdAt=', o?.createdAt);
                console.log('  new:', n?.title, 'order=', n?.order, 'createdAt=', n?.createdAt);
                break;
            }
        }
    }

    // Paginated slices must line up with the same global ordering.
    const { data: page1 } = await axios.get('http://localhost:5000/api/activities?limit=10&page=1');
    const { data: page2 } = await axios.get('http://localhost:5000/api/activities?limit=10&page=2');
    console.log('page1 matches items 0-9:  ', JSON.stringify(page1.map((a) => String(a._id))) === JSON.stringify(newOrder.slice(0, 10)) ? 'YES' : 'NO');
    console.log('page2 matches items 10-19:', JSON.stringify(page2.map((a) => String(a._id))) === JSON.stringify(newOrder.slice(10, 20)) ? 'YES' : 'NO');
    console.log('no overlap between pages: ', page1.every((a) => !page2.some((b) => String(b._id) === String(a._id))) ? 'YES' : 'NO');

    await mongoose.disconnect();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
