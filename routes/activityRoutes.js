const express = require('express');
const router = express.Router();
const { getActivities, getActivityById, createActivity, seedActivities, updateActivity, deleteActivity, reorderActivities, getActivityImage } = require('../controllers/activityController');
const auth = require('../middleware/auth');
const cache = require('../middleware/cache');

// @route   GET api/activities
// @desc    Get all activities
// @access  Public
router.get('/', cache(60), getActivities);

// Cover image must be declared before `/:id` so it is not captured as an id.
router.get('/:id/image', getActivityImage);

router.get('/:id', cache(600), getActivityById);

router.post('/', auth(['admin']), createActivity);

// @route   PUT api/activities/reorder
// @desc    Bulk-update display order. Declared before '/:id' so it is not shadowed.
// @access  Private (Admin)
router.put('/reorder', auth(['admin']), reorderActivities);

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
