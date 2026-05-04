const express = require('express');
const router = express.Router();
const { getActivities, getActivityById, createActivity, seedActivities, updateActivity, deleteActivity } = require('../controllers/activityController');
const auth = require('../middleware/auth');
const cache = require('../middleware/cache');

// @route   GET api/activities
// @desc    Get all activities
// @access  Public
router.get('/', getActivities);

// @route   GET api/activities/:id
// @desc    Get activity by ID
// @access  Public
//comment added now 
router.get('/:id', cache(600), getActivityById); // Cache for 10 minutes

// @route   POST api/activities
// @desc    Create an activity
// @access  Private (Admin)
router.post('/', auth(['admin']), createActivity);

// @route   PATCH api/activities/:id
// @desc    Update an activity (e.g. status)
// @access  Private (Admin)
router.patch('/:id', auth(['admin']), updateActivity);

// @route   PUT api/activities/:id
// @desc    Full update of an activity (edit fields)
// @access  Private (Admin)
router.put('/:id', auth(['admin']), updateActivity);

// @route   DELETE api/activities/:id
// @desc    Delete an activity
// @access  Private (Admin)
router.delete('/:id', auth(['admin']), deleteActivity);

// @route   POST api/activities/seed
// @desc    Seed activities
// @access  Public (for demo)
router.post('/seed', seedActivities);

module.exports = router;
