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
        const {
            status,
            limit,
            page = 1,
            search = '',
            sort = 'createdAt',
            order = 'desc',
            paymentStatus,
            tab,
        } = req.query;

        let query = { supplier: new mongoose.Types.ObjectId(supplierId) };
        if (status) query.status = status;

        // Itinerary lifecycle drives the request tabs.
        //   Pending / Pending Review          -> still a supplier draft (stays in "New Requests")
        //   Supplier Replied Back / Ready     -> sent to the traveler ("In Progress")
        //   Accepted / Payment Completed /    -> traveler accepted ("Upcoming Trip" / Booking)
        //   Completed
        // NOTE: `aiGenerated` is deliberately NOT used here. Generating with AI is not an
        // action the traveler ever sees, so it must never move a request between tabs.
        const SENT_TO_TRAVELER_STATUSES = ['Supplier Replied Back', 'Ready'];
        const TRAVELER_ACCEPTED_STATUSES = ['Accepted', 'Payment Completed', 'Completed'];

        const trackedItineraries = await Itinerary.find({
            bookingId: { $ne: null },
            status: { $in: [...SENT_TO_TRAVELER_STATUSES, ...TRAVELER_ACCEPTED_STATUSES] }
        }).select('bookingId status').lean().maxTimeMS(5000);

        const toObjectIds = (list) => list
            .filter(Boolean)
            .filter((id) => mongoose.Types.ObjectId.isValid(id))
            .map((id) => new mongoose.Types.ObjectId(id));

        const sentBookingIds = toObjectIds(
            trackedItineraries
                .filter((i) => SENT_TO_TRAVELER_STATUSES.includes(i.status))
                .map((i) => i.bookingId)
        );
        const acceptedBookingIds = toObjectIds(
            trackedItineraries
                .filter((i) => TRAVELER_ACCEPTED_STATUSES.includes(i.status))
                .map((i) => i.bookingId)
        );

        // Tab conditions live in $and so a later `search` $or cannot overwrite them.
        const tabConditions = [];

        if (tab === 'new') {
            // New requests: not yet sent to the traveler and not yet paid.
            query.status = { $in: ['pending', 'confirmed', 'accepted'] };
            tabConditions.push({ paymentStatus: { $ne: 'paid' } });
            const excluded = [...sentBookingIds, ...acceptedBookingIds];
            if (excluded.length > 0) {
                tabConditions.push({ _id: { $nin: excluded } });
            }
        } else if (tab === 'in_progress') {
            // In Progress: itinerary sent to the traveler, awaiting their acceptance/payment.
            tabConditions.push({ paymentStatus: { $ne: 'paid' } });
            tabConditions.push({ _id: { $in: sentBookingIds } });
            if (acceptedBookingIds.length > 0) {
                tabConditions.push({ _id: { $nin: acceptedBookingIds } });
            }
        } else if (tab === 'upcoming') {
            // Upcoming Trip / Booking: traveler accepted the itinerary (or already paid).
            tabConditions.push({
                $or: [
                    { paymentStatus: 'paid' },
                    ...(acceptedBookingIds.length > 0 ? [{ _id: { $in: acceptedBookingIds } }] : []),
                ],
            });
        }

        if (tabConditions.length > 0) {
            query.$and = [...(query.$and || []), ...tabConditions];
        }

        if (paymentStatus) {
            query.paymentStatus = paymentStatus;
        }

        const searchTerm = String(search || '').trim();
        if (searchTerm) {
            const rx = new RegExp(searchTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
            query.$or = [
                { 'contactDetails.firstName': rx },
                { 'contactDetails.lastName': rx },
                { 'contactDetails.email': rx },
                { 'contactDetails.name': rx },
                { 'tripDetails.destination': rx },
                { 'tripDetails.country': rx },
                { 'tripDetails.city': rx },
                { destination: rx },
                { location: rx },
                { code: rx },
            ];
        }

        const pageNum = Math.max(1, parseInt(page, 10) || 1);
        const hasPaging = req.query.page != null || req.query.tab != null || req.query.search;
        const pageSize = hasPaging
            ? Math.min(100, Math.max(1, parseInt(limit, 10) || 20))
            : Math.min(200, Math.max(1, parseInt(limit, 10) || 100));
        const sortField = ['createdAt', 'status', 'date'].includes(String(sort))
            ? String(sort)
            : 'createdAt';
        const sortDir = String(order).toLowerCase() === 'asc' ? 1 : -1;

        const total = await Booking.countDocuments(query).maxTimeMS(10000);

        let bookings = await Booking.find(query)
            .select('user items.activity items.title items.travelers contactDetails tripDetails location destination date dateRange startDate guests travelers pax budget tripData amount totalAmount price status paymentStatus avatar image profileImage preferences adjustmentCard adjustmentRequestedAt code createdAt updatedAt')
            .sort({ [sortField]: sortDir })
            .skip((pageNum - 1) * pageSize)
            .limit(pageSize)
            .populate('user', 'name email avatar phone')
            .populate('items.activity', 'title')
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

        res.json({
            bookings,
            pagination: {
                page: pageNum,
                limit: pageSize,
                total,
                totalPages: Math.max(1, Math.ceil(total / pageSize)),
            },
        });
    } catch (err) {
        console.error('Get My Bookings Error:', err.message);
        if (res.headersSent) return;
        res.status(500).send('Server Error');
    }
};
