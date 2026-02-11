const User = require('../models/User');
const Activity = require('../models/Activity');
const Booking = require('../models/Booking');

const parseBudgetNumber = (value) => {
    if (!value) return 0;
    const raw = String(value);
    const digits = raw.replace(/[^0-9.]/g, '');
    const num = Number(digits);
    return Number.isFinite(num) ? num : 0;
};

const timeAgo = (date) => {
    if (!date) return '';
    const now = Date.now();
    const ts = new Date(date).getTime();
    if (!Number.isFinite(ts)) return '';
    const diffSec = Math.max(0, Math.floor((now - ts) / 1000));

    if (diffSec < 60) return `${diffSec} seconds ago`;
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin} minutes ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr} hours ago`;
    const diffDay = Math.floor(diffHr / 24);
    return `${diffDay} days ago`;
};

// Get System Stats
exports.getSystemStats = async (req, res) => {
    try {
        const totalUsers = await User.countDocuments({ role: 'user' });
        const totalSuppliers = await User.countDocuments({ role: 'supplier' });

        const [totalActivities, totalBookings, pendingRequests] = await Promise.all([
            Activity.countDocuments(),
            Booking.countDocuments(),
            Booking.countDocuments({ status: 'pending' })
        ]);

        const confirmedBookings = await Booking.find({ status: 'confirmed' }).select('tripDetails');
        const revenue = (confirmedBookings || []).reduce((sum, b) => sum + parseBudgetNumber(b.tripDetails?.budget), 0);

        // These are not tracked in DB yet; keep safe defaults so UI doesn't break.
        const reportedIssues = 0;

        res.json({
            users: totalUsers,
            suppliers: totalSuppliers,
            activities: totalActivities,
            bookings: totalBookings,
            pendingRequests,
            revenue,
            reportedIssues
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
// Get Recent Activity Feed
exports.getActivity = async (req, res) => {
    try {
        const limit = 10;

        const [recentSuppliers, recentBookings, pendingActivities] = await Promise.all([
            User.find({ role: 'supplier' }).sort({ createdAt: -1 }).limit(4).select('name fullName createdAt'),
            Booking.find().sort({ createdAt: -1 }).limit(4).select('createdAt status supplier user'),
            Activity.find({ status: 'pending' }).sort({ _id: -1 }).limit(4).select('title supplier')
        ]);

        const feed = [];

        (recentSuppliers || []).forEach((s) => {
            const name = s.fullName || s.name || 'Supplier';
            feed.push({
                iconType: 'users',
                iconBg: 'bg-emerald-50 text-emerald-600',
                title: `New supplier registration awaiting approval`,
                time: timeAgo(s.createdAt)
            });
        });

        (recentBookings || []).forEach((b) => {
            feed.push({
                iconType: 'clock',
                iconBg: 'bg-blue-50 text-blue-600',
                title: `Traveler booking request submitted`,
                time: timeAgo(b.createdAt)
            });
        });

        (pendingActivities || []).forEach((a) => {
            feed.push({
                iconType: 'bell',
                iconBg: 'bg-slate-50 text-slate-600',
                title: `New activity submitted: ${a.title || 'Activity'}`,
                time: 'Pending'
            });
        });

        const sorted = feed
            .map((item, idx) => ({ ...item, _idx: idx }))
            .slice(0, limit)
            .map(({ _idx, ...rest }) => rest);

        res.json({ activities: sorted });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
};

// Get Revenue Trend Data
exports.getRevenueTrend = async (req, res) => {
    try {
        // Mock revenue trend data
        const data = {
            labels: ["Jan", "Feb", "Mar", "Apr", "May", "Jun"],
            data: [45000, 52000, 48000, 61000, 55000, 67000]
        };
        res.json(data);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
};

// Get Bookings Trend Data
exports.getBookingsTrend = async (req, res) => {
    try {
        // Mock bookings trend data
        const data = {
            labels: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
            data: [45, 52, 47, 61, 58, 73, 69]
        };
        res.json(data);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
};
exports.getAdminBookings = async (req, res) => {
  try {
    // Sab bookings, latest pehle
    const bookings = await Booking.find().sort({ createdAt: -1 });
 
    // Abhi ke liye full documents bhej do – frontend hum ne already
    // itna robust bana diya hai ke different fields handle kar lega
    res.json(bookings);
  } catch (err) {
    console.error('Error fetching admin bookings:', err.message);
    res.status(500).send('Server Error');
  }
};
