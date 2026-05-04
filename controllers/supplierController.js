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
            Booking.countDocuments(query).maxTimeMS(8000),
            Booking.countDocuments({ ...query, status: 'confirmed' }).maxTimeMS(8000),
            Activity.find({ supplier: supplierId }).select('rating').lean().maxTimeMS(8000),
            Booking.aggregate([
                { $match: { supplier: new mongoose.Types.ObjectId(supplierId), status: 'confirmed' } },
                { $group: { _id: null, total: { $sum: { $ifNull: ["$netAmount", { $ifNull: ["$totalAmount", 0] }] } } } }
            ]).option({ maxTimeMS: 8000 })
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
        // Exclude heavy/base64 fields from the list payload (see
        // activityController.getActivities for full rationale). The frontend
        // shows a placeholder when image is null and loads the full image
        // from the detail endpoint when the user opens an item.
        const activities = await Activity.find({ supplier: req.user.id })
            .select('-image -images -description -addOns -coordinates')
            .lean()
            .sort({ createdAt: -1 })
            .limit(200)
            .maxTimeMS(10000);

        for (const a of activities) {
            a.image = null;
        }

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

        // Don't pull `image` via populate — some activities store 5MB base64
        // strings in that field which makes this endpoint take 30+ seconds.
        // The supplier UI doesn't display activity thumbnails on bookings.
        const bookings = await Booking.find(query)
            .sort({ createdAt: -1 })
            .populate('user', 'name email')
            .populate('items.activity', 'title')
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
