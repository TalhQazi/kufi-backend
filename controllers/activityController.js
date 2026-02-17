const Activity = require('../models/Activity');

// Get all activities
exports.getActivities = async (req, res) => {
    try {
        const activities = await Activity.find().sort({ _id: -1 });
        res.json(activities);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
};

// Update activity (e.g. status)
exports.updateActivity = async (req, res) => {
    try {
        const activity = await Activity.findByIdAndUpdate(
            req.params.id,
            { $set: req.body },
            { new: true }
        );

        if (!activity) {
            return res.status(404).json({ msg: 'Activity not found' });
        }

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

        res.json({ msg: 'Activity deleted' });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
};

// Get single activity
exports.getActivityById = async (req, res) => {
    try {
        const activity = await Activity.findById(req.params.id);
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
        const newActivity = new Activity(req.body);
        const activity = await newActivity.save();
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
