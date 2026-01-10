const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const {
    getSystemStats,
    getAllUsers,
    deleteUser,
    getPendingActivities,
    approveActivity
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

// @route   GET api/admin/activities/pending
// @desc    Get pending activities
router.get('/activities/pending', getPendingActivities);

// @route   PUT api/admin/activities/:id/approve
// @desc    Approve activity
router.put('/activities/:id/approve', approveActivity);

module.exports = router;
