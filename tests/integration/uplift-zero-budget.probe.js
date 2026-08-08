/**
 * Exactly what uplift = 0 does to the activity budget, including the case where hotel
 * and custom costs already consume the traveler's budget.
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
    const Hotel = require('../../models/Hotel');
    const { countActivities, isBreakEntry } = require('../../utils/activityClassification');

    const email = `kufiprobe-u0-${Date.now()}@example.com`;
    const sup = new User({ name: 'P', email, password: await bcrypt.hash('ProbePass123!', 10), role: 'supplier', status: 'active', country: 'Egypt', city: 'Cairo' });
    await sup.save();
    const trav = new User({ name: 'T', email: `kufiprobe-u0t-${Date.now()}@example.com`, password: await bcrypt.hash('ProbePass123!', 10), role: 'user', status: 'active' });
    await trav.save();
    const { data: auth } = await http.post('/auth/login', { email, password: 'ProbePass123!' });

    const hotel = new Hotel({ name: 'Probe Hotel', city: 'Cairo', country: 'Egypt', pricePerNight: 60 });
    await hotel.save();

    const BUDGET = 400;
    const mk = await http.post('/itineraries', {
        userId: String(trav._id), title: 'Uplift0 Probe', destination: 'Egypt', country: 'Egypt',
        startDate: '2026-09-01', endDate: '2026-09-05', numberOfTravelers: 2, budget: BUDGET,
    }, hdr(auth.token));
    const id = mk.data._id;

    const NIGHTS = 4;          // 5-day trip
    const HOTEL = 60 * NIGHTS; // 1 room
    console.log(`traveler budget            $${BUDGET}`);
    console.log(`hotel (4 nights x $60)     $${HOTEL}`);
    console.log('');
    console.log('scenario                              | ceiling for activities | activities | spend');
    console.log('-'.repeat(90));

    const run = async (label, cp) => {
        const res = await http.post(`/itineraries/${id}/generate`, { mode: 'template', controlPanel: cp }, hdr(auth.token));
        const days = res.data.itinerary?.days || [];
        const spend = days.reduce((s, d) => s + (d.activities || [])
            .filter((a) => !isBreakEntry(a))
            .reduce((x, a) => x + (Number(a.price) || 0), 0), 0);
        const custom = (cp.customCosts || []).reduce((s, c) => s + (c.unit === 'per_day' ? c.amount * 5 : c.amount), 0);
        const hotelCost = cp.hotelId ? HOTEL * (cp.numberOfRooms || 1) : 0;
        const ceiling = Math.max(0, Math.floor(BUDGET * (1 + (cp.budgetUplift || 0) / 100)) - hotelCost - custom);
        console.log(
            `${label.padEnd(37)} | ${String('$' + ceiling).padStart(22)} | ${String(countActivities(days)).padStart(10)} | $${spend}`
        );
        return { ceiling, n: countActivities(days), spend };
    };

    await run('uplift 0%,  no hotel', { budgetUplift: 0, customCosts: [] });
    await run('uplift 15%, no hotel', { budgetUplift: 15, customCosts: [] });
    console.log('');
    await run('uplift 0%,  hotel', { budgetUplift: 0, hotelId: String(hotel._id), numberOfRooms: 1, customCosts: [] });
    await run('uplift 15%, hotel', { budgetUplift: 15, hotelId: String(hotel._id), numberOfRooms: 1, customCosts: [] });
    console.log('');
    console.log('-- hotel alone already exceeds the budget --');
    const empty = await run('uplift 0%,  hotel x2 rooms', { budgetUplift: 0, hotelId: String(hotel._id), numberOfRooms: 2, customCosts: [] });
    const rescued = await run('uplift 100%, hotel x2 rooms', { budgetUplift: 100, hotelId: String(hotel._id), numberOfRooms: 2, customCosts: [] });

    console.log('');
    console.log(empty.n === 0
        ? '>> With uplift 0 and the hotel over budget, the ceiling hits $0 and NO activities are scheduled.'
        : `>> uplift 0 + over-budget hotel still scheduled ${empty.n} activities (ceiling $${empty.ceiling}).`);
    console.log(`>> Raising uplift to 100% restores headroom: ${rescued.n} activities.`);

    await Itinerary.deleteMany({ _id: id });
    await Hotel.deleteMany({ _id: hotel._id });
    await require('../../models/Notification').deleteMany({ userId: { $in: [sup._id, trav._id] } });
    await User.deleteMany({ _id: { $in: [sup._id, trav._id] } });
    await mongoose.disconnect();
})().catch(async (e) => { console.error('ERR', e.message); try { await mongoose.disconnect(); } catch { } process.exit(1); });
