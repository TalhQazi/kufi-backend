const mongoose = require('mongoose');
const City = require('../models/City');
const { getCache, setCache, clearCache } = require('../utils/cache');

// Get all cities
exports.getCities = async (req, res) => {
  try {
    const cacheKey = `cache:/api/cities?${new URLSearchParams(req.query).toString()}`;
    const cachedData = await getCache(cacheKey);
    if (cachedData) return res.json(cachedData);

    const match = {};

    if (req.query.country || req.query.countryName) {
      const or = [];

      if (req.query.country && mongoose.Types.ObjectId.isValid(req.query.country)) {
        or.push({ country: new mongoose.Types.ObjectId(req.query.country) });
      }

      if (req.query.countryName) {
        or.push({ country: req.query.countryName });
      }

      if (req.query.country && !mongoose.Types.ObjectId.isValid(req.query.country)) {
        or.push({ country: req.query.country });
      }

      if (or.length > 0) {
        match.$or = or;
      }
    }

    if (req.query.isTopLocation === 'true') {
      match.isTopLocation = true;
    }

    const cities = await City.aggregate([
      { $match: match },
      { $sort: { name: 1 } },
    ]).option({ maxTimeMS: 5000 });

    await setCache(cacheKey, cities, 3600); // 1h cache
    res.json(cities);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server error');
  }
};

// Get city by ID
exports.getCityById = async (req, res) => {
  try {
    const city = await City.findById(req.params.id);

    if (!city) {
      return res.status(404).json({ msg: 'City not found' });
    }

    res.json(city);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server error');
  }
};

// Create new city (admin only)
exports.createCity = async (req, res) => {
  try {
    const city = new City(req.body);
    await city.save();

    // Clear cache
    await clearCache('cache:/api/cities*');

    res.status(201).json(city);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server error');
  }
};

// Update city (admin only)
exports.updateCity = async (req, res) => {
  try {
    const city = await City.findByIdAndUpdate(
      req.params.id,
      { $set: req.body },
      { new: true }
    );

    if (!city) {
      return res.status(404).json({ msg: 'City not found' });
    }

    // Clear cache
    await clearCache('cache:/api/cities*');

    res.json(city);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server error');
  }
};

// Delete city (admin only)
exports.deleteCity = async (req, res) => {
  try {
    const city = await City.findByIdAndDelete(req.params.id);

    if (!city) {
      return res.status(404).json({ msg: 'City not found' });
    }

    // Clear cache
    await clearCache('cache:/api/cities*');

    res.json({ msg: 'City deleted' });
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server error');
  }
};
