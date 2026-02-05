const Itinerary = require('../models/Itinerary');

// Get user itineraries
exports.getUserItineraries = async (req, res) => {
    try {
        const userId = req.user?.id;

        let itineraries;
        if (userId) {
            itineraries = await Itinerary.find({ userId }).sort({ createdAt: -1 });
        } else {
            // Return empty array if no user is authenticated
            itineraries = [];
        }

        res.json(itineraries);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server error');
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

        const tripData = req.body?.tripData;
        const title = req.body?.title || tripData?.title;
        const destination = req.body?.destination || tripData?.destination || tripData?.location;

        if (!title || !destination) {
            return res.status(400).json({ msg: 'Missing required fields: title, destination' });
        }

        const itinerary = new Itinerary({
            ...req.body,
            userId,
            supplierId: role === 'supplier' ? authUserId : req.body?.supplierId,
            bookingId: req.body?.bookingId || req.body?.requestId,
            title,
            destination,
            tripData: tripData || req.body?.tripData,
            days: Array.isArray(req.body?.days) ? req.body.days : [],
        });

        await itinerary.save();
        res.status(201).json(itinerary);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server error');
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
