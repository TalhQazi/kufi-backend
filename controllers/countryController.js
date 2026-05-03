const Country = require('../models/Country');
const { clearCache } = require('../utils/cache');

// Get all countries
exports.getCountries = async (req, res) => {
    try {
        const countries = await Country.find().sort({ name: 1 });
        res.json(countries);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server error');
    }
};

// Get country by ID
exports.getCountryById = async (req, res) => {
    try {
        const country = await Country.findById(req.params.id).populate('popularActivities');

        if (!country) {
            return res.status(404).json({ msg: 'Country not found' });
        }

        res.json(country);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server error');
    }
};

// Create new country (admin only)
exports.createCountry = async (req, res) => {
    try {
        const country = new Country(req.body);
        await country.save();

        // Clear cache
        await clearCache('cache:/api/countries*');

        res.status(201).json(country);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server error');
    }
};

// Update country (admin only)
exports.updateCountry = async (req, res) => {
    try {
        const country = await Country.findByIdAndUpdate(
            req.params.id,
            { $set: req.body },
            { new: true }
        );

        if (!country) {
            return res.status(404).json({ msg: 'Country not found' });
        }

        // Clear cache
        await clearCache('cache:/api/countries*');

        res.json(country);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server error');
    }
};

// Delete country (admin only)
exports.deleteCountry = async (req, res) => {
    try {
        const country = await Country.findByIdAndDelete(req.params.id);

        if (!country) {
            return res.status(404).json({ msg: 'Country not found' });
        }

        // Clear cache
        await clearCache('cache:/api/countries*');

        res.json({ msg: 'Country deleted' });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server error');
    }
};
