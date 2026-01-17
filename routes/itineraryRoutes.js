const express = require('express');
const router = express.Router();
const { getUserItineraries, createItinerary, getItineraryById } = require('../controllers/itineraryController');
const auth = require('../middleware/auth');

// @route   GET api/itineraries
// @desc    Get user itineraries
// @access  Private
router.get('/', auth(), getUserItineraries);

// @route   POST api/itineraries
// @desc    Create new itinerary
// @access  Private
router.post('/', auth(), createItinerary);

// @route   GET api/itineraries/:id
// @desc    Get itinerary by ID
// @access  Private
router.get('/:id', auth(), getItineraryById);

module.exports = router;
