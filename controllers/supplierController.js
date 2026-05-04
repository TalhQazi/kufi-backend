const mongoose = require('mongoose');
const Activity = require('../models/Activity');
const Booking = require('../models/Booking');

const normalizeStringArray = (value) => {
    if (!Array.isArray(value)) return [];
    return value.map((v) => String(v || '').trim()).filter(Boolean);
};

const sanitizeActivityPayload = (body) => {
    const next = { ...(body || {}) };

    if (Object.prototype.hasOwnProperty.call(next, 'highlights')) {
        next.highlights = normalizeStringArray(next.highlights);
    }

    if (Object.prototype.hasOwnProperty.call(next, 'addOns') && Array.isArray(next.addOns)) {
        next.addOns = normalizeStringArray(next.addOns);
    }

    return next;
};

// Get Supplier Stats
exports.getSupplierStats = async (req, res) => {
    try {
        const supplierId = req.user.id;

        const query = { supplier: supplierId };
        const [totalBookings, confirmedBookings, activities, revenueResult] = await Promise.all([
            Booking.countDocuments(query).maxTimeMS(3000),
            Booking.countDocuments({ ...query, status: 'confirmed' }).maxTimeMS(3000),
            Activity.find({ supplier: supplierId }).select('rating').lean().maxTimeMS(3000),
            Booking.aggregate([
                { $match: { supplier: new mongoose.Types.ObjectId(supplierId), status: 'confirmed' } },
                { $group: { _id: null, total: { $sum: { $ifNull: ["$netAmount", { $ifNull: ["$totalAmount", 0] }] } } } }
            ]).option({ maxTimeMS: 3000 })
        ]);

        const totalRevenue = revenueResult[0]?.total || 0;
        const ratings = activities.map(a => a.rating).filter(r => typeof r === 'number' && r > 0);
        const avgRating = ratings.length > 0 ? (ratings.reduce((a, b) => a + b, 0) / ratings.length) : 0;

        res.json({
            activities: activities.length,
            bookings: totalBookings,
            revenue: totalRevenue,
            avgRating
        });
    } catch (err) {
        console.error('Supplier Stats Error:', err.message);
        res.status(500).send('Server Error');
    }
};

// Get My Activities
exports.getMyActivities = async (req, res) => {
    try {
        const activities = await Activity.find({ supplier: req.user.id }).lean();
        res.json(activities);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
};

// Create Activity (Supplier)
exports.createSupplierActivity = async (req, res) => {
    try {
        const safeBody = sanitizeActivityPayload(req.body);
        const newActivity = new Activity({
            ...safeBody,
            supplier: req.user.id,
            status: 'pending' // Force pending for review
        });
        const activity = await newActivity.save();
        res.json(activity);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
};

// Get My Bookings
exports.getMyBookings = async (req, res) => {
    try {
        const supplierId = req.user.id;
        const { status, limit } = req.query;

        let query = { supplier: supplierId };
        if (status) query.status = status;

        const fetchLimit = limit ? parseInt(limit) : 50; 

        const bookings = await Booking.find(query)
            .sort({ createdAt: -1 })
            .populate('user', 'name email')
            .populate('items.activity', 'title image')
            .limit(fetchLimit)
            .lean()
            .maxTimeMS(10000); 

        res.json(bookings);
    } catch (err) {
        console.error('Get My Bookings Error:', err.message);
        if (res.headersSent) return;
        res.status(500).send('Server Error');
    }
};
