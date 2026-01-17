const Booking = require('../models/Booking');

// Get supplier analytics
exports.getSupplierAnalytics = async (req, res) => {
    try {
        // Mock data for now - in production, calculate from actual bookings
        const overview = [
            { label: "Total Revenue", value: "$12,450", delta: "+12.5%", icon: "DollarSign" },
            { label: "Active Bookings", value: "24", delta: "+8", icon: "CalendarDays" },
            { label: "Average Rating", value: "4.8", delta: "+0.3", icon: "Star" },
            { label: "Experiences", value: "12", delta: "+2", icon: "Briefcase" },
        ];

        const travelerStats = [
            { label: "Total Pending Requests", value: 5, icon: "Clock3" },
            { label: "Accepted Requests", value: 18, icon: "Check" },
            { label: "Rejected Requests", value: 2, icon: "XIcon" },
        ];

        res.json({ overview, travelerStats });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server error');
    }
};
