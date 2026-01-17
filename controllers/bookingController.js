const Booking = require('../models/Booking');

// Create Booking
exports.createBooking = async (req, res) => {
    try {
        const newBooking = new Booking(req.body);
        const booking = await newBooking.save();
        res.json(booking);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
};

// Get User Bookings
exports.getUserBookings = async (req, res) => {
    try {
        // In a real app, you'd verify the user ID from the token matches the param or use req.user.id
        const bookings = await Booking.find({ $or: [{ user: req.params.userId }, { 'contactDetails.email': req.params.email }] });
        res.json(bookings);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
};

// Get Supplier Bookings
exports.getSupplierBookings = async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 10;

        // Mock supplier bookings for now
        const bookings = [
            { title: "Safari Adventure", subtitle: "Tanzania · 5 Days", status: "Confirmed" },
            { title: "Mountain Trek", subtitle: "Nepal · 7 Days", status: "Pending" },
            { title: "Beach Resort", subtitle: "Maldives · 3 Days", status: "Confirmed" },
        ].slice(0, limit);

        res.json({ bookings });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server error');
    }
};
