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

        const myActivities = await Activity.find({ supplier: supplierId }).lean();

        const ratings = (myActivities || [])
            .map((activity) => Number(activity?.rating))
            .filter((rating) => Number.isFinite(rating) && rating > 0);
        const avgRating = ratings.length > 0
            ? (ratings.reduce((sum, rating) => sum + rating, 0) / ratings.length)
            : 0;

        // Single-supplier assignment: only bookings assigned to this supplier
        const query = { supplier: supplierId };
        const totalBookings = await Booking.countDocuments(query);
        const confirmedBookings = await Booking.countDocuments({ ...query, status: 'confirmed' });

        res.json({
            activities: myActivities.length,
            bookings: totalBookings,
            revenue: confirmedBookings * 120, // Placeholder estimation
            avgRating
        });
    } catch (err) {
        console.error(err.message);
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

        // Only return bookings assigned to this supplier
        let query = { supplier: supplierId };

        // Handle status filter
        if (status) {
            query.status = status;
        }

        let bookingsQuery = Booking.find(query)
            .sort({ createdAt: -1 })
            .populate('user', 'name email')
            .populate('items.activity')
            .lean();

        // Default limit to prevent timeouts
        const fetchLimit = limit ? parseInt(limit) : 100;
        bookingsQuery = bookingsQuery.limit(fetchLimit);

        const bookings = await bookingsQuery;

        // Return array directly for compatibility
        res.json(bookings);
    } catch (err) {
        console.error('Error fetching supplier bookings:', err.message);
        res.status(500).send('Server Error');
    }
};
