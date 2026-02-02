const Booking = require('../models/Booking');
const Activity = require('../models/Activity');

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
        const { userId, email } = req.params;
        const bookings = await Booking.find({
            $or: [
                { user: userId },
                { 'contactDetails.email': email }
            ]
        }).populate('items.activity');
        res.json(bookings);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
};

// Get Supplier Bookings
exports.getSupplierBookings = async (req, res) => {
    try {
        // This is similar to supplierController.getMyBookings
        // We should ensure it fetches real data for the logged-in supplier
        const supplierId = req.user.id;

        const activities = await Activity.find({ supplier: supplierId }).select('_id');
        const activityIds = activities.map(a => a._id);

        const bookings = await Booking.find({ 'items.activity': { $in: activityIds } })
            .populate('user', 'name email')
            .populate('items.activity');

        res.json({ bookings });
    } catch (err) {
        console.error('Error fetching supplier bookings:', err.message);
        res.status(500).send('Server error');
    }
};
// Update Booking Status
exports.updateBookingStatus = async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;

        const booking = await Booking.findByIdAndUpdate(
            id,
            { status },
            { new: true }
        );

        if (!booking) {
            return res.status(404).json({ message: 'Booking not found' });
        }

        res.json(booking);
    } catch (err) {
        console.error('Error updating booking status:', err.message);
        res.status(500).send('Server Error');
    }
};
