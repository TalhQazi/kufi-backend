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
