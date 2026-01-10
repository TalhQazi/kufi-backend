const express = require('express');
const router = express.Router();
const { getActivities, getActivityById, createActivity, seedActivities } = require('../controllers/activityController');

// @route   GET api/activities
// @desc    Get all activities
// @access  Public
router.get('/', getActivities);

// @route   GET api/activities/:id
// @desc    Get activity by ID
// @access  Public
router.get('/:id', getActivityById);

// @route   POST api/activities
// @desc    Create an activity
// @access  Private (Admin)
router.post('/', createActivity);

// @route   POST api/activities/seed
// @desc    Seed activities
// @access  Public (for demo)
router.post('/seed', seedActivities);

module.exports = router;
