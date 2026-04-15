const express = require('express');

const router = express.Router();

const { createBooking, getUserBookings, getSupplierBookings, updateBookingStatus, updateBookingAdjustment } = require('../controllers/bookingController');

const auth = require('../middleware/auth');



// @route   POST api/bookings

// @desc    Create a booking

// @access  Public
// set the booking routes perfectly
router.post('/', createBooking);



// @route   GET api/bookings/user/:userId

// @desc    Get bookings by user ID

// @access  Private

router.get('/user/:userId', auth(), getUserBookings);



// @route   GET api/bookings/supplier

// @desc    Get supplier bookings

// @access  Private (Supplier only)

router.get('/supplier', auth(['supplier']), getSupplierBookings);



// @route   PATCH api/bookings/:id/status

// @desc    Update booking status

// @access  Private

router.patch('/:id/status', auth(['supplier', 'admin']), updateBookingStatus);



// @route   PATCH api/bookings/:id/adjustment

// @desc    Update booking adjustment card

// @access  Private

router.patch('/:id/adjustment', auth(), updateBookingAdjustment);



module.exports = router;

