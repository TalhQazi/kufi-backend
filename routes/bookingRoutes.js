const express = require('express');
const router = express.Router();
const { createBooking, getUserBookings, getSupplierBookings } = require('../controllers/bookingController');
const auth = require('../middleware/auth');

// @route   POST api/bookings
// @desc    Create a booking
// @access  Public
router.post('/', createBooking);

// @route   GET api/bookings/user/:userId
// @desc    Get bookings by user ID
// @access  Private
router.get('/user/:userId', getUserBookings);

// @route   GET api/bookings/supplier
// @desc    Get supplier bookings
// @access  Private (Supplier only)
router.get('/supplier', auth(['supplier']), getSupplierBookings);

module.exports = router;
