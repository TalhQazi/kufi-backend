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

        // Itinerary lifecycle drives every supplier surface. One classification, used for
        // the request tabs, the Drafts panel and Booking History, so a booking can never
        // show up in two sections at once.
        //   Pending / Pending Review + days   -> supplier draft ("Drafts")
        //   Supplier Replied Back / Ready     -> sent to the traveler ("In Progress")
        //   Accepted / Payment Completed /    -> traveler accepted ("Booking History")
        //   Completed
        // NOTE: `aiGenerated` is deliberately NOT used here. Generating with AI is not an
        // action the traveler ever sees, so it must never move a request between tabs.
        const DRAFT_STATUSES = ['Pending', 'Pending Review'];
        const SENT_TO_TRAVELER_STATUSES = ['Supplier Replied Back', 'Ready'];
        const TRAVELER_ACCEPTED_STATUSES = ['Accepted', 'Payment Completed', 'Completed'];

        // A draft only counts once it actually holds itinerary days — an empty record is
        // just the placeholder created when the supplier opens a request.
        const trackedItineraries = await Itinerary.find({
            bookingId: { $ne: null },
            $or: [
                { status: { $in: [...SENT_TO_TRAVELER_STATUSES, ...TRAVELER_ACCEPTED_STATUSES] } },
                { status: { $in: DRAFT_STATUSES }, 'days.0': { $exists: true } },
            ],
        }, { bookingId: 1, status: 1 }).lean().maxTimeMS(5000);

        const toObjectIds = (list) => list
            .filter(Boolean)
            .filter((id) => mongoose.Types.ObjectId.isValid(id))
            .map((id) => new mongoose.Types.ObjectId(id));

        const bookingIdsWithStatus = (statuses) => toObjectIds(
            trackedItineraries
                .filter((i) => statuses.includes(i.status))
                .map((i) => i.bookingId)
        );

        const sentBookingIds = bookingIdsWithStatus(SENT_TO_TRAVELER_STATUSES);
        const acceptedBookingIds = bookingIdsWithStatus(TRAVELER_ACCEPTED_STATUSES);
        // The status sets are disjoint, so anything left matched the draft branch above
        // and is therefore a draft with days.
        const draftBookingIds = bookingIdsWithStatus(DRAFT_STATUSES);

        // Tab conditions live in $and so a later `search` $or cannot overwrite them.
        const tabConditions = [];

        if (tab === 'new') {
            // New requests: nothing has been built yet. Once AI generation is auto-saved
            // as a draft the request belongs to Drafts only, never to both.
            query.status = { $in: ['pending', 'confirmed', 'accepted'] };
            tabConditions.push({ paymentStatus: { $ne: 'paid' } });
            const excluded = [...draftBookingIds, ...sentBookingIds, ...acceptedBookingIds];
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

            // Single source of truth for which supplier section a booking belongs to.
            // The frontend switches on this instead of re-deriving the rules, so the
            // sections cannot disagree.
            //   'new'       -> New Requests
            //   'draft'     -> Drafts (itinerary built but not sent)
            //   'sent'      -> In Progress (awaiting the traveler)
            //   'booked'    -> Booking History (traveler accepted or paid)
            //   'cancelled' -> rejected/cancelled request that never became a booking
            const resolveWorkflowStage = (booking, itin) => {
                const bookingStatus = String(booking?.status || '').trim().toLowerCase();
                const isPaid = String(booking?.paymentStatus || '').trim().toLowerCase() === 'paid';
                const itinStatus = itin?.status;

                // Traveler acceptance / payment wins, so a booking that was later
                // cancelled still stays in Booking History.
                if (isPaid || TRAVELER_ACCEPTED_STATUSES.includes(itinStatus)) return 'booked';
                if (bookingStatus === 'cancelled') return 'cancelled';
                if (SENT_TO_TRAVELER_STATUSES.includes(itinStatus)) return 'sent';
                if (DRAFT_STATUSES.includes(itinStatus) && Array.isArray(itin?.days) && itin.days.length > 0) {
                    return 'draft';
                }
                return 'new';
            };

            bookings = bookings.map(b => {
                const itinerary = itinMap[String(b._id)] || null;
                return {
                    ...b,
                    itinerary,
                    workflowStage: resolveWorkflowStage(b, itinerary),
                };
            });
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
