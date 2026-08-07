const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const {
    getSupplierStats,
    getMyActivities,
    createSupplierActivity,
    updateSupplierActivity,
    deleteSupplierActivity,
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
// @desc    Submit a new experience (always created as 'pending' for admin review)
router.post('/activities', createSupplierActivity);

// @route   PUT/PATCH api/supplier/activities/:id
// @desc    Update one of my own experiences. Ownership is enforced server-side.
router.put('/activities/:id', updateSupplierActivity);
router.patch('/activities/:id', updateSupplierActivity);

// @route   DELETE api/supplier/activities/:id
// @desc    Delete one of my own experiences
router.delete('/activities/:id', deleteSupplierActivity);

// @route   GET api/supplier/bookings
// @desc    Get bookings for my activities
router.get('/bookings', getMyBookings);

module.exports = router;
