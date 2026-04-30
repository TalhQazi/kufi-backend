const mongoose = require('mongoose');
const City = require('../models/City');

// Get all cities
exports.getCities = async (req, res) => {
  try {
    // NOTE: City.country is typed as ObjectId in Mongoose, but legacy data may store it as a string.
    // Using aggregate avoids Mongoose casting errors when filtering by a string countryName.
    const match = {};

    if (req.query.country || req.query.countryName) {
      const or = [];

      if (req.query.country && mongoose.Types.ObjectId.isValid(req.query.country)) {
        or.push({ country: new mongoose.Types.ObjectId(req.query.country) });
      }

      if (req.query.countryName) {
        or.push({ country: req.query.countryName });
      }

      // If country was provided but not a valid ObjectId, treat it as a string fallback.
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
    ]);

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

    res.json({ msg: 'City deleted' });
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server error');
  }
};
