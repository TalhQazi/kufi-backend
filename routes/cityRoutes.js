const express = require('express');
const router = express.Router();
const {
  getCities,
  getCityById,
  createCity,
  updateCity,
  deleteCity,
} = require('../controllers/cityController');
const auth = require('../middleware/auth');
const cache = require('../middleware/cache');

// @route   GET api/cities
// @desc    Get all cities
// @access  Public
router.get('/', cache(600), getCities); // Cache for 10 minutes

// @route   GET api/cities/:id
// @desc    Get city by ID
// @access  Public
router.get('/:id', cache(1200), getCityById); // Cache for 20 minutes

// @route   POST api/cities
// @desc    Create new city
// @access  Private (Admin only)
router.post('/', auth(['admin']), createCity);

// @route   PUT api/cities/:id
// @desc    Update city
// @access  Private (Admin only)
router.put('/:id', auth(['admin']), updateCity);

// @route   DELETE api/cities/:id
// @desc    Delete city
// @access  Private (Admin only)
router.delete('/:id', auth(['admin']), deleteCity);

module.exports = router;
