const express = require('express');
const router = express.Router();
const {
    getSupplierAnalytics,
    getAdminAnalytics,
    trackPageView,
    trackHeartbeat
} = require('../controllers/analyticsController');
const auth = require('../middleware/auth');

// @route   GET api/analytics/supplier
// @desc    Get supplier analytics
// @access  Private (Supplier only)
router.get('/supplier', auth(['supplier']), getSupplierAnalytics);

// @route   GET api/analytics/admin
// @desc    Get admin analytics dashboard data
// @access  Private (Admin only)
router.get('/admin', auth(['admin']), getAdminAnalytics);

// @route   POST api/analytics/track/pageview
// @desc    Track a page view for traffic analytics
// @access  Public
router.post('/track/pageview', trackPageView);

// @route   POST api/analytics/track/heartbeat
// @desc    Track session heartbeat (time on site / active users)
// @access  Public
router.post('/track/heartbeat', trackHeartbeat);

module.exports = router;
