const Booking = require('../models/Booking');
const Activity = require('../models/Activity');
const User = require('../models/User');

const normalizeCountryKey = (value) => {
    return String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '')
        .trim();
};

const normalizeCountryLabel = (value) => {
    const raw = String(value || '').trim();
    if (!raw) return '';
    // Support values like "Turkey, Istanbul" or "Istanbul, Turkey"
    const parts = raw.split(',').map((p) => String(p || '').trim()).filter(Boolean);
    if (parts.length === 0) return '';
    return parts[0];
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

    // 1) Same-country suppliers (match against supplier profile country)
    if (countryKey) {
        const suppliers = await User.find({ role: 'supplier' }).select('_id country createdAt');
        const sameCountrySuppliers = (suppliers || []).filter((s) => normalizeCountryKey(s?.country) === countryKey);
        if (sameCountrySuppliers.length > 0) {
            const ids = sameCountrySuppliers.map((s) => s._id);
            const ratingMap = await getSupplierAvgRatings(ids);

            const ranked = sameCountrySuppliers
                .map((s) => {
                    const meta = ratingMap.get(String(s._id)) || { avgRating: 0, activityCount: 0 };
                    return {
                        supplierId: s._id,
                        avgRating: meta.avgRating,
                        activityCount: meta.activityCount,
                        createdAt: s.createdAt ? new Date(s.createdAt).getTime() : 0,
                    };
                })
                .sort((a, b) => {
                    if (b.avgRating !== a.avgRating) return b.avgRating - a.avgRating;
                    if (b.activityCount !== a.activityCount) return b.activityCount - a.activityCount;
                    return a.createdAt - b.createdAt;
                });

            if (ranked[0]?.supplierId) return ranked[0].supplierId;
        }
    }

    // 2) Fallback: highest rated overall supplier
    const allSuppliers = await User.find({ role: 'supplier' }).select('_id createdAt');
    const allIds = (allSuppliers || []).map((s) => s._id);
    const ratingMap = await getSupplierAvgRatings(allIds);

    const rankedOverall = (allSuppliers || [])
        .map((s) => {
            const meta = ratingMap.get(String(s._id)) || { avgRating: 0, activityCount: 0 };
            return {
                supplierId: s._id,
                avgRating: meta.avgRating,
                activityCount: meta.activityCount,
                createdAt: s.createdAt ? new Date(s.createdAt).getTime() : 0,
            };
        })
        .sort((a, b) => {
            if (b.avgRating !== a.avgRating) return b.avgRating - a.avgRating;
            if (b.activityCount !== a.activityCount) return b.activityCount - a.activityCount;
            return a.createdAt - b.createdAt;
        });

    return rankedOverall?.[0]?.supplierId || null;
};

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

        // Assign booking to exactly one supplier based on country + supplier avg activity rating
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
        const supplierId = req.user.id;
        const { status, limit } = req.query;

        // Only return bookings assigned to this supplier
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

        const update = { status };
        // Do not override existing supplier assignment; only set if missing
        if (String(status || '').toLowerCase() === 'confirmed') {
            const existing = await Booking.findById(id).select('supplier');
            if (!existing?.supplier) {
                update.supplier = req.user.id;
            }
        }

        const booking = await Booking.findByIdAndUpdate(id, update, { new: true });

        if (!booking) {
            return res.status(404).json({ message: 'Booking not found' });
        }

        res.json(booking);
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

        res.json(booking);
    } catch (err) {
        console.error('Error updating booking adjustment:', err.message);
        res.status(500).send('Server Error');
    }
};
