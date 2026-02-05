const Booking = require('../models/Booking');
const Activity = require('../models/Activity');

// Get supplier analytics
exports.getSupplierAnalytics = async (req, res) => {
    try {
        const supplierId = req.user.id;

        // 1. Get supplier's activities
        const myActivities = await Activity.find({ supplier: supplierId }).select('_id');
        const activityIds = myActivities.map(a => a._id);

        // 2. Get bookings containing these activities
        const bookings = await Booking.find({ 'items.activity': { $in: activityIds } });

        // 3. Calculate statistics
        const pendingRequests = bookings.filter(b => b.status === 'pending').length;
        const acceptedRequests = bookings.filter(b => b.status === 'confirmed').length;
        const rejectedRequests = bookings.filter(b => b.status === 'cancelled').length;

        const totalRevenue = bookings
            .filter(b => b.status === 'confirmed')
            .reduce((sum, b) => {
                // Simplified revenue calculation: sum of item prices if available, or trip budget
                // For now, let's use a placeholder if prices aren't fully structured
                return sum + (parseInt(b.tripDetails?.budget?.replace(/[^0-9]/g, '')) || 0);
            }, 0);

        const overview = [
            { label: "Total Revenue", value: `$${totalRevenue.toLocaleString()}`, delta: "Real-time", icon: "DollarSign" },
            { label: "Active Bookings", value: String(bookings.filter(b => b.status === 'confirmed').length), delta: "Total", icon: "CalendarDays" },
            { label: "Average Rating", value: "4.8", delta: "+0.3", icon: "Star" }, // Keep rating mockup for now
            { label: "Experiences", value: String(myActivities.length), delta: "Active", icon: "Briefcase" },
        ];

        const travelerStats = [
            { label: "Total Pending Requests", value: pendingRequests, icon: "Clock3" },
            { label: "Accepted Requests", value: acceptedRequests, icon: "Check" },
            { label: "Rejected Requests", value: rejectedRequests, icon: "XIcon" },
        ];

        res.json({ overview, travelerStats });
    } catch (err) {
        console.error('Error fetching supplier analytics:', err.message);
        res.status(500).send('Server error');
    }
};
