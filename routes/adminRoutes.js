const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const {
    getSystemStats,
    getAllUsers,
    deleteUser,
    getSupplierHistory,
    getPendingActivities,
    approveActivity,
    getActivity,
    getRevenueTrend,
    getBookingsTrend,
    getAdminBookings,
    getSuppliersWithScores,
    updateSupplierScore,
    getBestSupplierForOrder,
} = require('../controllers/adminController');

// All routes require 'admin' role
router.use(auth(['admin']));

// @route   GET api/admin/stats
// @desc    Get system wide stats
router.get('/stats', getSystemStats);

// @route   GET api/admin/users
// @desc    Get all users
router.get('/users', getAllUsers);

// @route   DELETE api/admin/users/:id
// @desc    Delete user
router.delete('/users/:id', deleteUser);

// @route   GET api/admin/suppliers/:id/history
// @desc    Get supplier booking history
router.get('/suppliers/:id/history', getSupplierHistory);

// @route   GET api/admin/activities/pending
// @desc    Get pending activities
router.get('/activities/pending', getPendingActivities);

// @route   PUT api/admin/activities/:id/approve
// @desc    Approve activity
router.put('/activities/:id/approve', approveActivity);

// @route   GET api/admin/activity
// @desc    Get recent activity feed
router.get('/activity', getActivity);

// @route   GET api/admin/revenue-trend
// @desc    Get revenue trend data
router.get('/revenue-trend', getRevenueTrend);

// @route   GET api/admin/bookings-trend
// @desc    Get bookings trend data
router.get('/bookings-trend', getBookingsTrend);

router.get('/bookings', getAdminBookings);

// @route   GET api/admin/suppliers/scores
// @desc    Get all suppliers with score points
router.get('/suppliers/scores', getSuppliersWithScores);

// @route   PUT api/admin/suppliers/:supplierId/score
// @desc    Update supplier score points
router.put('/suppliers/:supplierId/score', updateSupplierScore);

// @route   GET api/admin/suppliers/best-for-order
// @desc    Get best supplier for order assignment (highest score)
router.get('/suppliers/best-for-order', getBestSupplierForOrder);

module.exports = router;
