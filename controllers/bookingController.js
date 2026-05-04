const Booking = require('../models/Booking');
const Activity = require('../models/Activity');
const User = require('../models/User');
const { sendEmail } = require('../utils/emailService');

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
                supplier: { $in: (supplierIds || []) },
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
    ]);

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
        // Find active suppliers in the same country
        const sameCountrySuppliers = await User.find({ 
            role: 'supplier', 
            status: 'active',
            country: { $regex: new RegExp(`^${countryKey}$`, 'i') } // Basic regex or exact match
        })
        .select('_id scorePoints createdAt')
        .sort({ scorePoints: -1, createdAt: 1 })
        .limit(1)
        .lean();
        
        if (sameCountrySuppliers.length > 0) {
            return sameCountrySuppliers[0]._id;
        }
        
        // Fallback to top-ranked active supplier globally
        const topSupplier = await User.find({ role: 'supplier', status: 'active' })
            .select('_id scorePoints createdAt')
            .sort({ scorePoints: -1, createdAt: 1 })
            .limit(1)
            .lean();
        
        return topSupplier[0]?._id || null;
    } else {
        const topSupplier = await User.find({ role: 'supplier', status: 'active' })
            .select('_id scorePoints createdAt')
            .sort({ scorePoints: -1, createdAt: 1 })
            .limit(1)
            .lean();
        
        return topSupplier[0]?._id || null;
    }
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
        _id: { $nin: excluded }
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

    const bookingTermSelections = body?.bookingTermSelections || {};

    return {
        user: body?.user || body?.userId,
        items,
        contactDetails,
        tripDetails,
        preferences,
        bookingTermSelections,
    };
};

// Create Booking
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
        const { userId } = req.params;
        const emailFromQuery = req.query?.email;
        const authEmail = req.user?.email;
        const email = String(emailFromQuery || authEmail || '').trim();

        const orConditions = [{ user: userId }];
        if (email) {
            orConditions.push({ 'contactDetails.email': email });
        }

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

// Get Supplier Bookings
exports.getSupplierBookings = async (req, res) => {
    try {
        const supplierId = req.user.id;
        const { status, limit } = req.query;
        let query = { supplier: supplierId };

        if (status) {
            query.status = status;
        }

        let bookingsQuery = Booking.find(query)
            .sort({ createdAt: -1 })
            .populate('user', 'name email')
            .populate('items.activity');

        if (limit) {
            bookingsQuery = bookingsQuery.limit(parseInt(limit));
        }

        const bookings = await bookingsQuery;
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

        const normalizedStatus = String(status || '').trim().toLowerCase();
        const booking = await Booking.findById(id);

        if (!booking) {
            return res.status(404).json({ message: 'Booking not found' });
        }

        const assignedSupplierId = booking?.supplier ? String(booking.supplier) : '';
        const actorSupplierId = req?.user?.id ? String(req.user.id) : '';

        const isStatusChangeAction = normalizedStatus === 'confirmed' || normalizedStatus === 'cancelled';

        if (isStatusChangeAction && assignedSupplierId && actorSupplierId && assignedSupplierId !== actorSupplierId) {
            return res.status(403).json({ message: 'Access denied: booking is assigned to another supplier' });
        }

        if (normalizedStatus === 'confirmed') {
            booking.status = 'confirmed';
            if (!booking.supplier && actorSupplierId) {
                booking.supplier = actorSupplierId;
            }

            if (actorSupplierId && Array.isArray(booking.rejectedSuppliers)) {
                booking.rejectedSuppliers = booking.rejectedSuppliers.filter((s) => String(s) !== actorSupplierId);
            }

            const saved = await booking.save();

            // Send Acceptance Email
            try {
                await sendEmail({
                    to: booking.contactDetails?.email,
                    subject: 'Booking Request Accepted!',
                    templateKey: 'offerAccepted',
                    html: `
                        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e1e1e1; border-radius: 10px;">
                            <h2 style="color: #a26e35;">Great News!</h2>
                            <p>Your booking request for <strong>${booking.tripDetails?.country || 'your destination'}</strong> has been accepted by our supplier.</p>
                            <p>You can now proceed to view the final details and complete any remaining steps.</p>
                            <div style="margin-top: 30px; text-align: center;">
                                <a href="${process.env.FRONTEND_URL || 'http://localhost:5173'}/my-requests" style="background-color: #a26e35; color: white; padding: 12px 25px; text-decoration: none; border-radius: 5px; font-weight: bold;">View My Requests</a>
                            </div>
                        </div>
                    `
                });
            } catch (err) {
                console.error('Error sending acceptance email:', err);
            }

            return res.json(saved);
        }

        if (normalizedStatus === 'cancelled') {
            const tripCountry = normalizeCountryLabel(booking?.tripDetails?.country);
            const rejected = Array.isArray(booking.rejectedSuppliers) ? booking.rejectedSuppliers.map((s) => String(s)) : [];
            const excluded = new Set(rejected);
            if (actorSupplierId) excluded.add(actorSupplierId);

            if (actorSupplierId) {
                booking.rejectedSuppliers = Array.isArray(booking.rejectedSuppliers) ? booking.rejectedSuppliers : [];
                if (!booking.rejectedSuppliers.some((s) => String(s) === actorSupplierId)) {
                    booking.rejectedSuppliers.push(actorSupplierId);
                }
            }

            const nextSupplierId = await pickNextSupplierIdForCountry(tripCountry, Array.from(excluded));
            if (nextSupplierId) {
                booking.supplier = nextSupplierId;
                booking.status = 'pending';
            } else {
                booking.supplier = undefined;
                booking.status = 'cancelled';

                // Send Final Rejection Email
                try {
                    await sendEmail({
                        to: booking.contactDetails?.email,
                        subject: 'Update on Your Booking Request',
                        templateKey: 'offerRejected',
                        html: `
                            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e1e1e1; border-radius: 10px;">
                                <h2 style="color: #rose-600;">Booking Update</h2>
                                <p>We regret to inform you that our suppliers are currently unable to fulfill your booking request for <strong>${booking.tripDetails?.country || 'your destination'}</strong>.</p>
                                <p>Our team is looking into alternative options for you.</p>
                            </div>
                        `
                    });
                } catch (err) {
                    console.error('Error sending rejection email:', err);
                }
            }

            const saved = await booking.save();
            return res.json(saved);
        }

        booking.status = normalizedStatus || booking.status;
        const saved = await booking.save();
        return res.json(saved);
    } catch (err) {
        console.error('Error updating booking status:', err.message);
        res.status(500).send('Server Error');
    }
};

// Update Booking Adjustment Card
exports.updateBookingAdjustment = async (req, res) => {
    try {
        const { id } = req.params;
        const card = req.body?.card;

        if (!id) {
            return res.status(400).json({ message: 'Missing booking id' });
        }

        if (!card || typeof card !== 'object') {
            return res.status(400).json({ message: 'Missing adjustment card' });
        }

        const fields = [card?.title, card?.description, card?.location, card?.cost, card?.imageDataUrl];
        const hasAny = fields.some((v) => String(v || '').trim());
        if (!hasAny) {
            return res.status(400).json({ message: 'Adjustment card is empty' });
        }

        const update = {
            adjustmentCard: {
                title: String(card?.title || '').trim(),
                description: String(card?.description || '').trim(),
                location: String(card?.location || '').trim(),
                cost: String(card?.cost || '').trim(),
                imageDataUrl: String(card?.imageDataUrl || '').trim(),
            },
            adjustmentRequestedAt: new Date(),
        };

        const booking = await Booking.findByIdAndUpdate(id, update, { new: true }).populate('items.activity');
        if (!booking) {
            return res.status(404).json({ message: 'Booking not found' });
        }

        // Send Itinerary Update Email
        try {
            await sendEmail({
                to: booking.contactDetails?.email,
                subject: 'New Itinerary Suggestion for Your Trip',
                templateKey: 'itineraryReply',
                html: `
                    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e1e1e1; border-radius: 10px;">
                        <h2 style="color: #a26e35;">Itinerary Updated</h2>
                        <p>A supplier has sent a new itinerary suggestion or adjustment for your trip to <strong>${booking.tripDetails?.country || 'your destination'}</strong>.</p>
                        <p><strong>Message:</strong> ${card.description || 'New details added'}</p>
                        <div style="margin-top: 30px; text-align: center;">
                            <a href="${process.env.FRONTEND_URL || 'http://localhost:5173'}/my-requests" style="background-color: #a26e35; color: white; padding: 12px 25px; text-decoration: none; border-radius: 5px; font-weight: bold;">Review Itinerary</a>
                        </div>
                    </div>
                `
            });
        } catch (emailErr) {
            console.error('Error sending itinerary update email:', emailErr);
        }

        res.json(booking);
    } catch (err) {
        console.error('Error updating booking adjustment:', err.message);
        res.status(500).send('Server Error');
    }
};

// Update Booking
exports.updateBooking = async (req, res) => {
    try {
        const { id } = req.params;
        const { contactDetails, tripDetails, totalAmount } = req.body;

        const booking = await Booking.findById(id);
        if (!booking) {
            return res.status(404).json({ message: 'Booking not found' });
        }

        if (contactDetails) {
            booking.contactDetails = { 
                ...booking.contactDetails.toObject(), 
                ...contactDetails 
            };
        }
        if (tripDetails) {
            booking.tripDetails = { 
                ...booking.tripDetails.toObject(), 
                ...tripDetails 
            };
        }
        if (totalAmount !== undefined) {
            booking.totalAmount = totalAmount;
        }

        await booking.save();
        res.json(booking);
    } catch (err) {
        console.error('Error updating booking:', err.message);
        res.status(500).send('Server Error');
    }
};

// Transfer Booking to another supplier
exports.transferBooking = async (req, res) => {
    try {
        const { id } = req.params;
        const { supplierId } = req.body;

        const booking = await Booking.findById(id);
        if (!booking) {
            return res.status(404).json({ message: 'Booking not found' });
        }

        let targetSupplierId = supplierId;
        if (!targetSupplierId) {
            const tripCountry = normalizeCountryLabel(booking?.tripDetails?.country);
            const rejected = Array.isArray(booking.rejectedSuppliers) ? booking.rejectedSuppliers.map((s) => String(s)) : [];
            const excluded = new Set(rejected);
            if (booking.supplier) excluded.add(String(booking.supplier));
            
            const nextSupplierId = await pickNextSupplierIdForCountry(tripCountry, Array.from(excluded));
            if (!nextSupplierId) {
                return res.status(400).json({ message: 'No other suppliers available for this country' });
            }
            targetSupplierId = nextSupplierId;
        }

        const newSupplier = await User.findOne({ _id: targetSupplierId, role: 'supplier' });
        if (!newSupplier) {
            return res.status(404).json({ message: 'Target supplier not found' });
        }

        booking.supplier = targetSupplierId;
        booking.status = 'pending';
        booking.rejectedSuppliers = (booking.rejectedSuppliers || []).filter(s => String(s) !== String(targetSupplierId));

        await booking.save();
        res.json({ message: 'Booking transferred successfully', booking });
    } catch (err) {
        console.error('Error transferring booking:', err.message);
        res.status(500).send('Server Error');
    }
};
