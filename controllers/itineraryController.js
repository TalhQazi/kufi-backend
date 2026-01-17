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
        const userId = req.user?.id;

        if (!userId) {
            return res.status(401).json({ msg: 'User not authenticated' });
        }

        const itinerary = new Itinerary({
            ...req.body,
            userId
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
