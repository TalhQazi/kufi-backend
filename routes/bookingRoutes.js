const express = require('express');

const router = express.Router();

const { createBooking, getUserBookings, getSupplierBookings, updateBookingStatus, updateBookingAdjustment, updateBooking } = require('../controllers/bookingController');


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

// @route   GET api/bookings
// @desc    Get current user's bookings
// @access  Private
router.get('/', auth(), async (req, res) => {
    try {
        const userId = req.user.id;
        const bookings = await require('../models/Booking').find({ user: userId })
            .populate('items.activity', 'title imageUrl images image location')
            .sort({ createdAt: -1 });
        res.json(bookings);
    } catch (error) {
        console.error('Error fetching user bookings:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

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



// @route   PATCH api/bookings/:id
// @desc    Update a booking
// @access  Private
router.patch('/:id', auth(), updateBooking);

// @route   PATCH api/bookings/:id/transfer
// @desc    Transfer booking to another supplier
// @access  Private (Admin only)
router.patch('/:id/transfer', auth(['admin']), require('../controllers/bookingController').transferBooking);

module.exports = router;


