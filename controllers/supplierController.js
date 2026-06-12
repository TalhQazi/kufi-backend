const mongoose = require('mongoose');
const Activity = require('../models/Activity');
const Booking = require('../models/Booking');
const Itinerary = require('../models/Itinerary');

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

        const [statsResult, activities] = await Promise.all([
            Booking.aggregate([
                { $match: { supplier: new mongoose.Types.ObjectId(supplierId) } },
                {
                    $group: {
                        _id: null,
                        totalBookings: { $sum: 1 },
                        confirmedBookings: { $sum: { $cond: [{ $eq: ["$status", "confirmed"] }, 1, 0] } },
                        totalRevenue: {
                            $sum: {
                                $cond: [
                                    { $eq: ["$status", "confirmed"] },
                                    { $ifNull: ["$netAmount", { $ifNull: ["$totalAmount", 0] }] },
                                    0
                                ]
                            }
                        }
                    }
                }
            ]).option({ maxTimeMS: 8000 }),
            Activity.find({ supplier: supplierId }).select('rating').lean().maxTimeMS(8000)
        ]);

        const stats = statsResult[0] || { totalBookings: 0, confirmedBookings: 0, totalRevenue: 0 };
        const ratings = activities.map(a => a.rating).filter(r => typeof r === 'number' && r > 0);
        const avgRating = ratings.length > 0 ? (ratings.reduce((a, b) => a + b, 0) / ratings.length) : 0;

        res.json({
            activities: activities.length,
            bookings: stats.totalBookings,
            revenue: stats.totalRevenue,
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
        let bookings = await Booking.find(query)
            .select('user items.activity items.title items.travelers contactDetails tripDetails location destination date dateRange startDate guests travelers pax budget tripData amount totalAmount price status avatar image profileImage preferences adjustmentCard adjustmentRequestedAt code createdAt')
            .sort({ createdAt: -1 })
            .populate('user', 'name email avatar phone')
            .populate('items.activity', 'title')
            .limit(fetchLimit)
            .lean()
            .maxTimeMS(10000);

        if (bookings.length > 0) {
            const bookingIds = bookings.map(b => b._id);
            const itineraries = await Itinerary
                .find({ bookingId: { $in: bookingIds } })
                .select('_id bookingId status aiGenerated startDate endDate updatedAt title destination days.day')
                .lean();

            const itinMap = {};
            itineraries.forEach(itin => {
                if (itin.bookingId) itinMap[String(itin.bookingId)] = itin;
            });

            bookings = bookings.map(b => ({
                ...b,
                itinerary: itinMap[String(b._id)] || null
            }));
        }

        res.json(bookings); // Note: frontend expects an array or {bookings: array} based on `rawBookings` parsing
    } catch (err) {
        console.error('Get My Bookings Error:', err.message);
        if (res.headersSent) return;
        res.status(500).send('Server Error');
    }
};
