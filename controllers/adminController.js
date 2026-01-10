const User = require('../models/User');
const Activity = require('../models/Activity');
const Booking = require('../models/Booking');

// Get System Stats
exports.getSystemStats = async (req, res) => {
    try {
        const totalUsers = await User.countDocuments({ role: 'user' });
        const totalSuppliers = await User.countDocuments({ role: 'supplier' });
        const totalActivities = await Activity.countDocuments();
        const totalBookings = await Booking.countDocuments();

        // Simple mock revenue
        const revenue = totalBookings * 100; // Placeholder calculation

        res.json({
            users: totalUsers,
            suppliers: totalSuppliers,
            activities: totalActivities,
            bookings: totalBookings,
            revenue
        });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
};

// Get All Users
exports.getAllUsers = async (req, res) => {
    try {
        const users = await User.find().select('-password');
        res.json(users);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
};

// Delete User
exports.deleteUser = async (req, res) => {
    try {
        await User.findByIdAndDelete(req.params.id);
        res.json({ msg: 'User deleted' });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
};

// Get Pending Activities
exports.getPendingActivities = async (req, res) => {
    try {
        const activities = await Activity.find({ status: 'pending' }).populate('supplier', 'name email');
        res.json(activities);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
};

// Approve Activity
exports.approveActivity = async (req, res) => {
    try {
        const activity = await Activity.findById(req.params.id);
        if (!activity) return res.status(404).json({ msg: 'Activity not found' });

        activity.status = 'approved';
        await activity.save();
        res.json(activity);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
};
