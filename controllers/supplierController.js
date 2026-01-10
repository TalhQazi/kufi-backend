const Activity = require('../models/Activity');
const Booking = require('../models/Booking');

// Get Supplier Stats
exports.getSupplierStats = async (req, res) => {
    try {
        // req.user.id from auth middleware
        const myActivities = await Activity.countDocuments({ supplier: req.user.id });

        // Find bookings containing my activities (simplified for now)
        // In real app, we'd query bookings where items.activity is in myActivities list
        const activities = await Activity.find({ supplier: req.user.id }).select('_id');
        const activityIds = activities.map(a => a._id);

        const myBookings = await Booking.countDocuments({ 'items.activity': { $in: activityIds } });

        res.json({
            activities: myActivities,
            bookings: myBookings,
            revenue: myBookings * 120 // Placeholder
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
        const activities = await Activity.find({ supplier: req.user.id }).select('_id');
        const activityIds = activities.map(a => a._id);

        const bookings = await Booking.find({ 'items.activity': { $in: activityIds } })
            .populate('user', 'name email');

        res.json(bookings);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
};
