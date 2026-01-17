const express = require('express');
const router = express.Router();
const { getCountries, getCountryById, createCountry, updateCountry, deleteCountry } = require('../controllers/countryController');
const auth = require('../middleware/auth');

// @route   GET api/countries
// @desc    Get all countries
// @access  Public
router.get('/', getCountries);

// @route   GET api/countries/:id
// @desc    Get country by ID
// @access  Public
router.get('/:id', getCountryById);

// @route   POST api/countries
// @desc    Create new country
// @access  Private (Admin only)
router.post('/', auth(['admin']), createCountry);

// @route   PUT api/countries/:id
// @desc    Update country
// @access  Private (Admin only)
router.put('/:id', auth(['admin']), updateCountry);

// @route   DELETE api/countries/:id
// @desc    Delete country
// @access  Private (Admin only)
router.delete('/:id', auth(['admin']), deleteCountry);

module.exports = router;
