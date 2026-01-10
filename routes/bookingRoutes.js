const express = require('express');
const router = express.Router();
const { createBooking, getUserBookings } = require('../controllers/bookingController');

// @route   POST api/bookings
// @desc    Create a booking
// @access  Public
router.post('/', createBooking);

// @route   GET api/bookings/user/:userId
// @desc    Get bookings by user ID
// @access  Private
router.get('/user/:userId', getUserBookings);

module.exports = router;
