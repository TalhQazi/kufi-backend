const express = require('express');
const router = express.Router();
const { getSupplierAnalytics } = require('../controllers/analyticsController');
const auth = require('../middleware/auth');

// @route   GET api/analytics/supplier
// @desc    Get supplier analytics
// @access  Private (Supplier only)
router.get('/supplier', auth(['supplier']), getSupplierAnalytics);

module.exports = router;
