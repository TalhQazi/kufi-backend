const Activity = require('../models/Activity');
const Booking = require('../models/Booking');

// Get Supplier Stats
exports.getSupplierStats = async (req, res) => {
    try {
        const supplierId = req.user.id;

        // 1. Get supplier's activities to find what countries they operate in
        const User = require('../models/User');
        const supplier = await User.findById(supplierId);
        const myActivities = await Activity.find({ supplier: supplierId });
        const activityIds = myActivities.map(a => a._id);

        const countriesFromActivities = myActivities.map(a => a.country).filter(Boolean);
        const myCountries = [...new Set([...countriesFromActivities, supplier?.country].filter(Boolean))];

        // 2. Build inclusive query
        let query = {
            $or: [
                { 'items.activity': { $in: activityIds } },
                { 'status': 'pending', 'tripDetails.country': { $in: myCountries } }
            ]
        };

        const totalBookings = await Booking.countDocuments(query);
        const confirmedBookings = await Booking.countDocuments({ ...query, status: 'confirmed' });

        res.json({
            activities: myActivities.length,
            bookings: totalBookings,
            revenue: confirmedBookings * 120 // Placeholder estimation
        });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
};

// Get My Activities
exports.getMyActivities = async (req, res) => {
    try {
        const activities = await Activity.find({ supplier: req.user.id });
        res.json(activities);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
};

// Create Activity (Supplier)
exports.createSupplierActivity = async (req, res) => {
    try {
        const newActivity = new Activity({
            ...req.body,
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

        // 1. Get supplier's activities to find what countries they operate in
        const User = require('../models/User');
        const supplier = await User.findById(supplierId);
        const myActivities = await Activity.find({ supplier: supplierId });
        const activityIds = myActivities.map(a => a._id);

        const countriesFromActivities = myActivities.map(a => a.country).filter(Boolean);
        const myCountries = [...new Set([...countriesFromActivities, supplier?.country].filter(Boolean))];

        // 2. Build query: 
        // - Bookings containing my specific activities
        // - OR ANY pending booking in my countries
        let query = {
            $or: [
                { 'items.activity': { $in: activityIds } },
                {
                    'status': 'pending',
                    'tripDetails.country': { $in: myCountries }
                }
            ]
        };

        // Handle status filter
        if (status) {
            query.status = status;
        }

        let bookingsQuery = Booking.find(query)
            .sort({ createdAt: -1 })
            .populate('user', 'name email')
            .populate('items.activity');

        if (limit) {
            bookingsQuery = bookingsQuery.limit(parseInt(limit));
        }

        const bookings = await bookingsQuery;

        // Return array directly for compatibility
        res.json(bookings);
    } catch (err) {
        console.error('Error fetching supplier bookings:', err.message);
        res.status(500).send('Server Error');
    }
};
