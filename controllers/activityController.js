const Activity = require('../models/Activity');
const { clearCache } = require('../utils/cache');

const normalizeStringArray = (value) => {
    if (!Array.isArray(value)) return [];
    return value.map((v) => String(v || '').trim()).filter(Boolean);
};

const sanitizeActivityPayload = (body) => {
    const next = { ...(body || {}) };

    if (Object.prototype.hasOwnProperty.call(next, 'highlights')) {
        next.highlights = normalizeStringArray(next.highlights);
    }

    if (Object.prototype.hasOwnProperty.call(next, 'addOns') && Array.isArray(next.addOns)) {
        next.addOns = normalizeStringArray(next.addOns);
    }

    if (Object.prototype.hasOwnProperty.call(next, 'images')) {
        next.images = normalizeStringArray(next.images);
    }

    // Handle coordinates - ensure lat/lng are numbers or null
    if (Object.prototype.hasOwnProperty.call(next, 'coordinates')) {
        const coords = next.coordinates;
        if (coords && typeof coords === 'object') {
            next.coordinates = {
                lat: coords.lat !== undefined && coords.lat !== '' ? Number(coords.lat) : null,
                lng: coords.lng !== undefined && coords.lng !== '' ? Number(coords.lng) : null
            };
        }
    }

    return next;
};

// Get all activities
exports.getActivities = async (req, res) => {
    try {
        const { country, city, category, status } = req.query;
        const filter = {};

        if (country) {
            // Support both string and ObjectId if needed, but here we assume string or handled by frontend
            filter.$or = [
                { country: country },
                { 'country.name': country },
                { location: new RegExp(country, 'i') }
            ];
        }

        if (city) {
            filter.$or = filter.$or || [];
            filter.$or.push({ location: new RegExp(city, 'i') });
        }

        if (category) {
            filter.category = category;
        }

        if (status) {
            filter.status = status;
        }

        // Exclude every heavy field from the list payload.
        // `image` and `images` are stored as base64 strings (some docs >5MB),
        // so streaming them from Atlas → backend → client made this endpoint
        // take 30+ seconds. The frontend list views render a placeholder
        // when image is null and load the full image only on the detail
        // endpoint (`GET /api/activities/:id`) when the user opens an item.
        const activities = await Activity.find(filter)
            .select('-image -images -description -addOns -coordinates')
            .lean()
            .sort({ createdAt: -1 })
            .limit(100)
            .maxTimeMS(10000);

        for (const a of activities) {
            a.image = null;
        }

        res.json(activities);
    } catch (err) {
        console.error('Error fetching activities:', err.message);
        if (res.headersSent) return;
        res.status(500).json({ message: 'Error fetching activities', error: err.message });
    }
};

// Update activity (e.g. status)
exports.updateActivity = async (req, res) => {
    try {
        const safeBody = sanitizeActivityPayload(req.body);
        const activity = await Activity.findByIdAndUpdate(
            req.params.id,
            { $set: safeBody },
            { new: true }
        );

        if (!activity) {
            return res.status(404).json({ msg: 'Activity not found' });
        }

        // Clear cache
        await clearCache('cache:/api/activities*');

        res.json(activity);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
};

// Delete activity
exports.deleteActivity = async (req, res) => {
    try {
        const activity = await Activity.findByIdAndDelete(req.params.id);

        if (!activity) {
            return res.status(404).json({ msg: 'Activity not found' });
        }

        // Clear cache
        await clearCache('cache:/api/activities*');

        res.json({ msg: 'Activity deleted' });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
};

// Get single activity
exports.getActivityById = async (req, res) => {
    try {
        const activity = await Activity.findById(req.params.id).lean();
        if (!activity) {
            return res.status(404).json({ msg: 'Activity not found' });
        }
        res.json(activity);
    } catch (err) {
        console.error(err.message);
        if (err.kind === 'ObjectId') {
            return res.status(404).json({ msg: 'Activity not found' });
        }
        res.status(500).send('Server Error');
    }
};

// Create activity (Admin)
exports.createActivity = async (req, res) => {
    try {
        const safeBody = sanitizeActivityPayload(req.body);
        const newActivity = new Activity(safeBody);
        const activity = await newActivity.save();
        
        // Clear cache
        await clearCache('cache:/api/activities*');

        res.json(activity);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
};

// Seed activities
exports.seedActivities = async (req, res) => {
    try {
        await Activity.deleteMany(); // Clear existing
        const activities = req.body; // Expecting array of activities
        const createdActivities = await Activity.insertMany(activities);
        res.json(createdActivities);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
};
