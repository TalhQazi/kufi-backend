const Booking = require('../models/Booking');

const Activity = require('../models/Activity');

const User = require('../models/User');


//normailze country key
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



    // Find suppliers sorted by admin-assigned scorePoints (highest first)

    let query = { role: 'supplier', status: 'active' };

    if (countryKey) {

        // First try: find same-country suppliers

        const suppliers = await User.find({ role: 'supplier' }).select('_id country scorePoints createdAt');

        const sameCountrySuppliers = (suppliers || []).filter((s) => normalizeCountryKey(s?.country) === countryKey);

        

        if (sameCountrySuppliers.length > 0) {

            // Sort by scorePoints (highest first), then by createdAt

            const ranked = sameCountrySuppliers

                .map((s) => ({

                    supplierId: s._id,

                    scorePoints: s.scorePoints || 0,

                    createdAt: s.createdAt ? new Date(s.createdAt).getTime() : 0,

                }))

                .sort((a, b) => {

                    if (b.scorePoints !== a.scorePoints) return b.scorePoints - a.scorePoints;

                    return a.createdAt - b.createdAt;

                });



            if (ranked[0]?.supplierId) return ranked[0].supplierId;

        }

        

        // If no same-country supplier, find highest scored supplier from any country

        const allSuppliers = await User.find(query)

            .select('_id country scorePoints createdAt')

            .sort({ scorePoints: -1, createdAt: 1 });

        

        if (allSuppliers.length > 0) {

            return allSuppliers[0]._id;

        }

    } else {

        // No country specified, return highest scored supplier

        const suppliers = await User.find(query)

            .select('_id scorePoints createdAt')

            .sort({ scorePoints: -1, createdAt: 1 })

            .limit(1);

        

        if (suppliers.length > 0) {

            return suppliers[0]._id;

        }

    }



    return null;

};



const pickNextSupplierIdForCountry = async (countryLabel, excludedSupplierIds = []) => {

    const normalizedLabel = normalizeCountryLabel(countryLabel);

    const countryKey = normalizeCountryKey(normalizedLabel);

    const excluded = new Set((excludedSupplierIds || []).map((id) => String(id)).filter(Boolean));



    if (!countryKey) return null;



    // Find same-country suppliers sorted by scorePoints (highest first)

    const suppliers = await User.find({ 

        role: 'supplier', 

        status: 'active',

        _id: { $nin: Array.from(excluded) }

    })

        .select('_id country scorePoints createdAt')

        .sort({ scorePoints: -1, createdAt: 1 });

    

    const sameCountrySuppliers = (suppliers || [])

        .filter((supplier) => normalizeCountryKey(supplier?.country) === countryKey);



    if (sameCountrySuppliers.length === 0) return null;



    // Return the highest scored supplier from same country

    return sameCountrySuppliers[0]?._id || null;

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



    // Extract booking term selections from the request
    const bookingTermSelections = body?.bookingTermSelections || {}

    return {

        user: body?.user || body?.userId,

        items,

        contactDetails,

        tripDetails,

        preferences,

        bookingTermSelections,

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

            .populate('items.activity');



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

            return res.json(saved);

        }



        if (normalizedStatus === 'cancelled') {

            // Supplier rejected: reroute to next same-country supplier.

            const tripCountry = normalizeCountryLabel(booking?.tripDetails?.country);

            const rejected = Array.isArray(booking.rejectedSuppliers) ? booking.rejectedSuppliers.map((s) => String(s)) : [];

            const excluded = new Set(rejected);

            if (actorSupplierId) excluded.add(actorSupplierId);



            // Persist rejection.

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
