const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const {
    getMyNotifications,
    markAsRead,
    markAllRead,
} = require('../controllers/notificationController');

// @route   GET api/notifications
// @desc    List current user's notifications (newest first)
// @access  Private
router.get('/', auth(), getMyNotifications);

// @route   PATCH api/notifications/read-all
// @desc    Mark all notifications as read
// @access  Private
router.patch('/read-all', auth(), markAllRead);

// @route   PATCH api/notifications/:id/read
// @desc    Mark a single notification as read
// @access  Private
router.patch('/:id/read', auth(), markAsRead);

module.exports = router;
