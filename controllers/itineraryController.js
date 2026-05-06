const mongoose = require('mongoose');
const Itinerary = require('../models/Itinerary');

// Get user itineraries
exports.getUserItineraries = async (req, res) => {
    try {
        const userId = req.user?.id;
        const role = req.user?.role;

        if (!userId) {
            return res.status(401).json({ msg: 'User not authenticated' });
        }

        if (!mongoose.Types.ObjectId.isValid(userId)) {
            return res.status(400).json({ msg: 'Invalid user ID format' });
        }

        const projection = {
            userId: 1,
            supplierId: 1,
            bookingId: 1,
            requestId: 1,
            title: 1,
            destination: 1,
            location: 1,
            status: 1,
            imageUrl: 1,
            startDate: 1,
            endDate: 1,
            numberOfTravelers: 1,
            budget: 1,
            notes: 1,
            tripData: 1,
            createdAt: 1,
            updatedAt: 1,
        };

        let itineraries;
        if (role === 'supplier') {
            itineraries = await Itinerary.find({ supplierId: userId }, projection)
                .sort({ createdAt: -1 })
                .limit(50)
                .lean()
                .maxTimeMS(8000);
        } else {
            itineraries = await Itinerary.find({ userId }, projection)
                .sort({ createdAt: -1 })
                .limit(50)
                .lean()
                .maxTimeMS(8000);
        }

        res.json(itineraries);
    } catch (err) {
        console.error('getUserItineraries error:', err?.message, err?.stack);
        res.status(500).json({ msg: 'Server error', error: err?.message });
    }
};

// Create new itinerary
exports.createItinerary = async (req, res) => {
    try {
        const authUserId = req.user?.id;
        const role = req.user?.role;

        const requestedUserId = req.body?.userId;
        const userId = role === 'supplier' ? requestedUserId : authUserId;

        if (!userId) {
            return res.status(401).json({ msg: 'User not authenticated' });
        }

        if (!mongoose.Types.ObjectId.isValid(userId)) {
            return res.status(400).json({ msg: 'Invalid userId format' });
        }

        const tripData = req.body?.tripData;
        const title = req.body?.title || tripData?.title;
        const destination = req.body?.destination || tripData?.destination || tripData?.location;

        if (!title || !destination) {
            return res.status(400).json({ msg: 'Missing required fields: title, destination' });
        }

        const bookingIdVal = req.body?.bookingId || req.body?.requestId;
        const supplierIdVal = role === 'supplier' ? authUserId : req.body?.supplierId;

        if (bookingIdVal && !mongoose.Types.ObjectId.isValid(bookingIdVal)) {
            return res.status(400).json({ msg: 'Invalid bookingId format' });
        }
        if (supplierIdVal && !mongoose.Types.ObjectId.isValid(supplierIdVal)) {
            return res.status(400).json({ msg: 'Invalid supplierId format' });
        }

        const itinerary = new Itinerary({
            ...req.body,
            userId,
            supplierId: supplierIdVal,
            bookingId: bookingIdVal,
            title,
            destination,
            tripData: tripData || req.body?.tripData,
            days: Array.isArray(req.body?.days) ? req.body.days : [],
        });

        await itinerary.save();
        res.status(201).json(itinerary);
    } catch (err) {
        console.error('createItinerary error:', err?.message, err?.stack);
        res.status(500).json({ msg: 'Server error', error: err?.message });
    }
};

// Get itinerary by ID
exports.getItineraryById = async (req, res) => {
    try {
        const itinerary = await Itinerary.findById(req.params.id);

        if (!itinerary) {
            return res.status(404).json({ msg: 'Itinerary not found' });
        }

        res.json(itinerary);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server error');
    }
};
