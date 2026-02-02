const Booking = require('../models/Booking');

const normalizeBookingPayload = (body) => {
    const travelersRaw = body?.travelers ?? body?.guests
    const travelers = Number(travelersRaw)
    const travelersSafe = Number.isFinite(travelers) ? travelers : undefined

    const contactDetails = body?.contactDetails || {
        firstName: body?.firstName,
        lastName: body?.lastName,
        email: body?.email,
        phone: body?.phone,
    }

    const preferences = body?.preferences || {
        includeHotel: body?.includeHotel,
        hotelOwn: body?.hotelOwn,
        foodAllGood: body?.foodAllGood,
        vegetarian: body?.vegetarian,
    }

    const tripDetails = body?.tripDetails || {
        country: body?.country || body?.location,
        arrivalDate: body?.arrivalDate,
        departureDate: body?.departureDate,
        budget: body?.budget || body?.amount,
    }

    const items = Array.isArray(body?.items)
        ? body.items
        : (Array.isArray(body?.activities) ? body.activities : [])
            .map((activityId) => ({
                activity: activityId,
                title: body?.experience,
                travelers: travelersSafe,
                addOns: body?.addOns || undefined,
            }))

    return {
        user: body?.user || body?.userId,
        items,
        contactDetails,
        tripDetails,
        preferences,
    }
}

// Create Booking
exports.createBooking = async (req, res) => {
    try {
        const normalized = normalizeBookingPayload(req.body || {});
        const newBooking = new Booking(normalized);
        const booking = await newBooking.save();
        res.json(booking);
    } catch (err) {
        console.error(err);

        if (err?.name === 'ValidationError') {
            return res.status(400).json({
                error: 'ValidationError',
                message: err.message,
                details: err.errors,
            });
        }

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
