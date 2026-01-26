const express = require('express');
const router = express.Router();
const { getActivities, getActivityById, createActivity, seedActivities, updateActivity, deleteActivity } = require('../controllers/activityController');

// @route   GET api/activities
// @desc    Get all activities
// @access  Public
router.get('/', getActivities);

// @route   GET api/activities/:id
// @desc    Get activity by ID
// @access  Public
//comment added
router.get('/:id', getActivityById);

// @route   POST api/activities
// @desc    Create an activity
// @access  Private (Admin)
router.post('/', createActivity);

// @route   PATCH api/activities/:id
// @desc    Update an activity (e.g. status)
// @access  Private (Admin)
router.patch('/:id', updateActivity);

// @route   DELETE api/activities/:id
// @desc    Delete an activity
// @access  Private (Admin)
router.delete('/:id', deleteActivity);

// @route   POST api/activities/seed
// @desc    Seed activities
// @access  Public (for demo)
router.post('/seed', seedActivities);

module.exports = router;
