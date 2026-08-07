const Booking = require('../models/Booking');
const Activity = require('../models/Activity');
const User = require('../models/User');
const { sendEmail } = require('../utils/emailService');
const { notifyPreset } = require('../utils/createNotification');
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

/**
 * Can this caller act on this booking?
 *
 * - admin     : everything
 * - supplier  : only bookings assigned to them
 * - traveler  : only their own bookings (by user id, or by the contact email they used
 *               when the request was created as a guest)
 *
 * Every booking mutation goes through this. Without it any authenticated account could
 * read, confirm, re-price or mark as paid any booking in the system just by knowing its id.
 */
const canAccessBooking = (booking, user) => {
    if (!booking || !user?.id) return false;
    if (user.role === 'admin') return true;
    if (user.role === 'supplier') return String(booking.supplier || '') === String(user.id);
    return String(booking.user || '') === String(user.id);
};

/** Fields the traveler/supplier may change through the generic update endpoint. */
const BOOKING_UPDATABLE_FIELDS = new Set([
    'contactDetails', 'tripDetails', 'preferences', 'items',
    'bookingTermSelections', 'adjustmentCard', 'status',
]);

/**
 * Money and payment state are set by the payment flow and by admins only. Letting them
 * through here would allow a traveler to mark their own trip `paid` for free.
 */
const BOOKING_PRIVILEGED_FIELDS = [
    'totalAmount', 'commissionAmount', 'netAmount', 'paymentStatus',
    'stripeSessionId', 'supplier', 'user', 'transferStatus', 'transferredBy', 'rejectedSuppliers',
];

const pickBookingUpdate = (body, user) => {
    const update = {};
    Object.entries(body || {}).forEach(([key, value]) => {
        if (BOOKING_UPDATABLE_FIELDS.has(key)) update[key] = value;
    });
    // Admins retain full control, matching the admin panel's existing behaviour.
    if (user?.role === 'admin') {
        BOOKING_PRIVILEGED_FIELDS.forEach((key) => {
            if (Object.prototype.hasOwnProperty.call(body || {}, key)) update[key] = body[key];
        });
    }
    return update;
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

        // Identity: the authenticated user always wins. A client-supplied `user` id is
        // only honoured for genuine guest submissions, and even then it is discarded —
        // guests are matched by contact email instead.
        if (req.user?.id) {
            normalized.user = req.user.id;
        } else {
            delete normalized.user;
        }

        if (!String(normalized?.contactDetails?.email || '').trim()) {
            return res.status(400).json({ msg: 'A contact email is required to submit a request' });
        }

        // Supplier assignment is a platform decision, never a client input.
        const tripCountry = normalizeCountryLabel(normalized?.tripDetails?.country);
        const bestSupplierId = await pickBestSupplierIdForCountry(tripCountry);
        normalized.supplier = bestSupplierId || undefined;

        const newBooking = new Booking(normalized);
        const booking = await newBooking.save();

        try {
            const userId = booking.user;
            if (userId) {
                const destination = booking.tripDetails?.country || 'your destination';
                await notifyPreset('request_received', {
                    userId,
                    bookingId: booking._id,
                    destination,
                    sendEmailNotify: Boolean(booking.contactDetails?.email),
                    emailTo: booking.contactDetails?.email,
                    message: `We received your trip request to ${destination}.`,
                });
            }
        } catch (notifErr) {
            console.error('Error creating booking notification:', notifErr?.message || notifErr);
        }

        res.json(booking);
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
};

exports.getUserBookings = async (req, res) => {
    try {
        const { userId } = req.params;

        // A user may only read their own bookings. Previously any authenticated account
        // could enumerate anyone's trips (and their contact details) by id.
        if (req.user?.role !== 'admin' && String(userId) !== String(req.user?.id)) {
            return res.status(403).json({ msg: 'Access denied' });
        }

        // Guest requests are linked by contact email, so include the caller's own
        // address — but never an arbitrary one supplied in the query string.
        const account = await User.findById(req.user.id).select('email').lean();
        const email = String(account?.email || '').trim();

        const orConditions = [{ user: userId }];
        if (email) orConditions.push({ 'contactDetails.email': email });

        const bookings = await Booking.find({ $or: orConditions })
            .sort({ createdAt: -1 })
            .limit(100)
            .populate('items.activity')
            .populate('supplier', 'name email businessName')
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
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ message: 'Invalid booking id' });
        }
        const booking = await Booking.findById(id);

        if (!booking) return res.status(404).json({ message: 'Booking not found' });

        // Only the assigned supplier (or an admin) may move a request through its
        // lifecycle. Without this, any supplier could confirm or cancel a competitor's
        // bookings.
        if (!canAccessBooking(booking, req.user)) {
            return res.status(403).json({ message: 'Access denied' });
        }

        const normalizedStatus = String(status || '').trim().toLowerCase();

        const destination = booking.tripDetails?.country || booking.destination || 'your destination';
        const userId = booking.user;

        if (normalizedStatus === 'confirmed') {
            booking.status = 'confirmed';
            await booking.save();

            // Notify traveler that supplier accepted their request
            try {
                const recipientEmail = booking.contactDetails?.email;
                const travelerName = booking.contactDetails?.firstName || booking.contactDetails?.name || 'Traveler';
                if (userId) {
                    await notifyPreset('accepted', {
                        userId,
                        bookingId: booking._id,
                        destination,
                        sendEmailNotify: Boolean(recipientEmail),
                        emailTo: recipientEmail,
                        message: `Your trip request to ${destination} has been accepted. Your supplier is preparing your itinerary.`,
                    });
                } else if (recipientEmail) {
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
                console.error('Error sending booking accepted notification:', emailErr);
            }

            return res.json(booking);
        }

        if (normalizedStatus === 'cancelled' || normalizedStatus === 'canceled') {
            booking.status = 'cancelled';
            await booking.save();
            try {
                if (userId) {
                    await notifyPreset('cancelled', {
                        userId,
                        bookingId: booking._id,
                        destination,
                        message: `Your trip request to ${destination} has been cancelled.`,
                    });
                }
            } catch (notifErr) {
                console.error('Error creating cancelled notification:', notifErr?.message || notifErr);
            }
            return res.json(booking);
        }

        if (normalizedStatus === 'rejected') {
            booking.status = 'cancelled';
            await booking.save();
            try {
                if (userId) {
                    await notifyPreset('rejected', {
                        userId,
                        bookingId: booking._id,
                        destination,
                        message: `Your trip request to ${destination} was rejected.`,
                    });
                }
            } catch (notifErr) {
                console.error('Error creating rejected notification:', notifErr?.message || notifErr);
            }
            return res.json(booking);
        }

        if (normalizedStatus === 'under_review' || normalizedStatus === 'under review' || normalizedStatus === 'pending review') {
            booking.status = booking.status || 'pending';
            await booking.save();
            try {
                if (userId) {
                    await notifyPreset('under_review', {
                        userId,
                        bookingId: booking._id,
                        destination,
                        message: `Your trip request to ${destination} is under review.`,
                    });
                }
            } catch (notifErr) {
                console.error('Error creating under review notification:', notifErr?.message || notifErr);
            }
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

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ message: 'Invalid booking id' });
        }

        const existing = await Booking.findById(id).select('user supplier').lean();
        if (!existing) return res.status(404).json({ message: 'Booking not found' });
        if (!canAccessBooking(existing, req.user)) {
            return res.status(403).json({ message: 'Access denied' });
        }

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
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ message: 'Invalid booking id' });
        }
        const prev = await Booking.findById(id);
        if (!prev) return res.status(404).json({ message: 'Booking not found' });

        if (!canAccessBooking(prev, req.user)) {
            return res.status(403).json({ message: 'Access denied' });
        }

        // Allowlist: `$set` on a raw body previously let a traveler set their own
        // booking to paymentStatus 'paid' and rewrite the amount.
        const update = pickBookingUpdate(req.body, req.user);
        if (Object.keys(update).length === 0) {
            return res.status(400).json({ message: 'No updatable fields supplied' });
        }

        const booking = await Booking.findByIdAndUpdate(id, { $set: update }, { new: true }).lean();
        if (!booking) return res.status(404).json({ message: 'Booking not found' });

        try {
            const nextStatus = String(req.body?.status || '').trim().toLowerCase();
            const prevStatus = String(prev.status || '').trim().toLowerCase();
            const userId = booking.user;
            const destination = booking.tripDetails?.country || 'your destination';
            if (userId && nextStatus && nextStatus !== prevStatus) {
                if (nextStatus === 'confirmed') {
                    await notifyPreset('accepted', { userId, bookingId: booking._id, destination });
                } else if (nextStatus === 'cancelled' || nextStatus === 'canceled') {
                    await notifyPreset('cancelled', { userId, bookingId: booking._id, destination });
                } else if (nextStatus === 'rejected') {
                    await notifyPreset('rejected', { userId, bookingId: booking._id, destination });
                }
            }
        } catch (notifErr) {
            console.error('Error notifying on booking update:', notifErr?.message || notifErr);
        }

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
