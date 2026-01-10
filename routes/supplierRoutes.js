const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const {
    getSupplierStats,
    getMyActivities,
    createSupplierActivity,
    getMyBookings
} = require('../controllers/supplierController');

// All routes require 'supplier' role
router.use(auth(['supplier']));

// @route   GET api/supplier/stats
// @desc    Get dashboard stats
router.get('/stats', getSupplierStats);

// @route   GET api/supplier/activities
// @desc    Get my activities
router.get('/activities', getMyActivities);

// @route   POST api/supplier/activities
// @desc    Create new activity
router.post('/activities', createSupplierActivity);

// @route   GET api/supplier/bookings
// @desc    Get bookings for my activities
router.get('/bookings', getMyBookings);

module.exports = router;
