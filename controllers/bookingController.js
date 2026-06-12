const Booking = require('../models/Booking');
const Activity = require('../models/Activity');
const User = require('../models/User');
const { sendEmail } = require('../utils/emailService');
const mongoose = require('mongoose');

// Normalize country key
const normalizeCountryKey = (value) => {
    return String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '')
        .trim();
};

const normalizeCountryLabel = (value) => {
    const raw = String(value || '').trim();
    if (!raw) return '';
    const parts = raw.split(',').map((p) => String(p || '').trim()).filter(Boolean);
    if (parts.length === 0) return '';
    if (parts.length === 1) return parts[0];
    return parts[parts.length - 1];
};

const getSupplierAvgRatings = async (supplierIds) => {
    const ids = (supplierIds || []).map((id) => String(id)).filter(Boolean);
    if (ids.length === 0) return new Map();

    const rows = await Activity.aggregate([
        {
            $match: {
                supplier: { $in: (supplierIds || []).map(id => new mongoose.Types.ObjectId(id)) },
                rating: { $gt: 0 },
            },
        },
        {
            $group: {
                _id: '$supplier',
                avgRating: { $avg: '$rating' },
                activityCount: { $sum: 1 },
            },
        },
    ]).option({ maxTimeMS: 5000 });

    const map = new Map();
    (rows || []).forEach((row) => {
        map.set(String(row._id), {
            avgRating: Number(row?.avgRating) || 0,
            activityCount: Number(row?.activityCount) || 0,
        });
    });
    return map;
};

const pickBestSupplierIdForCountry = async (countryLabel) => {
    const normalizedLabel = normalizeCountryLabel(countryLabel);
    const countryKey = normalizeCountryKey(normalizedLabel);

    if (countryKey) {
        const sameCountrySuppliers = await User.find({ 
            role: 'supplier', 
            status: 'active',
            country: { $regex: new RegExp(`^${countryKey}$`, 'i') }
        })
        .select('_id scorePoints createdAt')
        .sort({ scorePoints: -1, createdAt: 1 })
        .limit(1)
        .lean();
        
        if (sameCountrySuppliers.length > 0) {
            return sameCountrySuppliers[0]._id;
        }
    }
    
    const topSupplier = await User.find({ role: 'supplier', status: 'active' })
        .select('_id scorePoints createdAt')
        .sort({ scorePoints: -1, createdAt: 1 })
        .limit(1)
        .lean();
    
    return topSupplier[0]?._id || null;
};

const pickNextSupplierIdForCountry = async (countryLabel, excludedSupplierIds = []) => {
    const normalizedLabel = normalizeCountryLabel(countryLabel);
    const countryKey = normalizeCountryKey(normalizedLabel);
    const excluded = (excludedSupplierIds || []).map((id) => String(id)).filter(Boolean);

    if (!countryKey) return null;

    const suppliers = await User.find({ 
        role: 'supplier', 
        status: 'active',
        country: { $regex: new RegExp(`^${countryKey}$`, 'i') },
        _id: { $nin: excluded.map(id => new mongoose.Types.ObjectId(id)) }
    })
        .select('_id scorePoints createdAt')
        .sort({ scorePoints: -1, createdAt: 1 })
        .limit(1)
        .lean();
    
    return suppliers[0]?._id || null;
};

const normalizeBookingPayload = (body) => {
    const travelersRaw = body?.travelers ?? body?.guests;
    const travelers = Number(travelersRaw);
    const travelersSafe = Number.isFinite(travelers) ? travelers : undefined;

    const contactDetails = body?.contactDetails || {
        firstName: body?.firstName,
        lastName: body?.lastName,
        email: body?.email,
        phone: body?.phone,
    };

    const preferences = body?.preferences || {
        includeHotel: body?.includeHotel,
        hotelOwn: body?.hotelOwn,
        foodAllGood: body?.foodAllGood,
        vegetarian: body?.vegetarian,
    };

    const tripDetails = body?.tripDetails || {
        country: body?.country || body?.location,
        arrivalDate: body?.arrivalDate,
        departureDate: body?.departureDate,
        budget: body?.budget || body?.amount,
    };

    const items = Array.isArray(body?.items)
        ? body.items
        : (Array.isArray(body?.activities) ? body.activities : [])
            .map((activityId) => ({
                activity: activityId,
                title: body?.experience,
                travelers: travelersSafe,
                addOns: body?.addOns || undefined,
            }));

    return {
        user: body?.user || body?.userId,
        items,
        contactDetails,
        tripDetails,
        preferences,
        bookingTermSelections: body?.bookingTermSelections || {},
    };
};

exports.createBooking = async (req, res) => {
    try {
        const normalized = normalizeBookingPayload(req.body || {});
        const tripCountry = normalizeCountryLabel(normalized?.tripDetails?.country);
        const bestSupplierId = await pickBestSupplierIdForCountry(tripCountry);
        if (bestSupplierId) {
            normalized.supplier = bestSupplierId;
        }

        const newBooking = new Booking(normalized);
        const booking = await newBooking.save();
        res.json(booking);
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
};

exports.getUserBookings = async (req, res) => {
    try {
        const { userId } = req.params;
        const email = String(req.query?.email || req.user?.email || '').trim();

        const orConditions = [{ user: userId }];
        if (email) orConditions.push({ 'contactDetails.email': email });

        const bookings = await Booking.find({ $or: orConditions })
            .sort({ createdAt: -1 })
            .limit(100)
            .populate('items.activity')
            .lean();

        res.json({ bookings });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
};

exports.getSupplierBookings = async (req, res) => {
    try {
        const supplierId = req.user.id;
        const { status, limit } = req.query;
        let query = { supplier: supplierId };
        if (status) query.status = status;

        let bookings = await Booking.find(query)
            .sort({ createdAt: -1 })
            .populate('user', 'name email')
            .populate('items.activity')
            .limit(limit ? parseInt(limit) : 100)
            .lean();

        if (bookings.length > 0) {
            const bookingIds = bookings.map(b => b._id);
            const itineraries = await mongoose.model('Itinerary')
                .find({ bookingId: { $in: bookingIds } })
                .select('_id status aiGenerated days startDate endDate updatedAt title destination')
                .lean();

            const itinMap = {};
            itineraries.forEach(itin => {
                if (itin.bookingId) itinMap[String(itin.bookingId)] = itin;
            });

            bookings = bookings.map(b => ({
                ...b,
                itinerary: itinMap[String(b._id)] || null
            }));
        }

        res.json({ bookings });
    } catch (err) {
        console.error('Error fetching supplier bookings:', err.message);
        res.status(500).send('Server error');
    }
};

exports.updateBookingStatus = async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;
        const booking = await Booking.findById(id);

        if (!booking) return res.status(404).json({ message: 'Booking not found' });

        const normalizedStatus = String(status || '').trim().toLowerCase();

        if (normalizedStatus === 'confirmed') {
            booking.status = 'confirmed';
            await booking.save();

            // Notify traveler that supplier accepted their request
            try {
                const recipientEmail = booking.contactDetails?.email;
                const travelerName = booking.contactDetails?.firstName || booking.contactDetails?.name || 'Traveler';
                const destination = booking.tripDetails?.country || booking.destination || 'your destination';
                if (recipientEmail) {
                    await sendEmail({
                        to: recipientEmail,
                        subject: 'Your Trip Request Has Been Accepted!',
                        templateKey: 'itineraryReply',
                        html: `
                            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e1e1e1; border-radius: 10px;">
                                <h2 style="color: #a26e35;">Great news, ${travelerName}!</h2>
                                <p>Your trip request to <strong>${destination}</strong> has been accepted by a supplier. They are now preparing your personalized itinerary.</p>
                                <p>You will receive another email once your itinerary is ready to view.</p>
                                <div style="margin-top: 30px; text-align: center;">
                                    <a href="${process.env.FRONTEND_URL || 'http://localhost:5173'}" style="background-color: #a26e35; color: white; padding: 12px 25px; text-decoration: none; border-radius: 5px; font-weight: bold;">View My Dashboard</a>
                                </div>
                                <p style="margin-top: 30px; font-size: 12px; color: #777;">Thank you for choosing Kufi Travel.</p>
                            </div>
                        `
                    });
                }
            } catch (emailErr) {
                console.error('Error sending booking accepted email:', emailErr);
            }

            return res.json(booking);
        }

        if (normalizedStatus === 'cancelled') {
            booking.status = 'cancelled';
            await booking.save();
            return res.json(booking);
        }

        booking.status = normalizedStatus || booking.status;
        await booking.save();
        res.json(booking);
    } catch (err) {
        console.error('Error updating booking status:', err.message);
        res.status(500).send('Server Error');
    }
};

exports.updateBookingAdjustment = async (req, res) => {
    try {
        const { id } = req.params;
        const card = req.body?.card;

        const update = {
            adjustmentCard: card,
            adjustmentRequestedAt: new Date(),
        };

        const booking = await Booking.findByIdAndUpdate(id, update, { new: true }).lean();
        if (!booking) return res.status(404).json({ message: 'Booking not found' });

        res.json(booking);
    } catch (err) {
        console.error('Error updating booking adjustment:', err.message);
        res.status(500).send('Server Error');
    }
};

exports.updateBooking = async (req, res) => {
    try {
        const { id } = req.params;
        const booking = await Booking.findByIdAndUpdate(id, { $set: req.body }, { new: true }).lean();
        if (!booking) return res.status(404).json({ message: 'Booking not found' });
        res.json(booking);
    } catch (err) {
        console.error('Error updating booking:', err.message);
        res.status(500).send('Server Error');
    }
};

exports.transferBooking = async (req, res) => {
    try {
        const { id } = req.params;
        const { supplierId } = req.body;
        const booking = await Booking.findByIdAndUpdate(id, { supplier: supplierId, status: 'pending' }, { new: true }).lean();
        if (!booking) return res.status(404).json({ message: 'Booking not found' });
        res.json(booking);
    } catch (err) {
        console.error('Error transferring booking:', err.message);
        res.status(500).send('Server Error');
    }
};
