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
    getGlobalSettings,
    updateGlobalSettings,
    toggleUserStatus,
    approveSupplier,
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

// @route   GET api/admin/settings
// @desc    Get global settings
router.get('/settings', getGlobalSettings);

// @route   PUT api/admin/settings
// @desc    Update global settings
router.put('/settings', updateGlobalSettings);

// @route   PUT api/admin/suppliers/:supplierId/verify-document
// @desc    Verify or reject supplier document (business license or profile)
router.put('/suppliers/:supplierId/verify-document', async (req, res) => {
    try {
        const { supplierId } = req.params;
        const { documentType, status } = req.body; // documentType: 'businessLicense' or 'businessProfile', status: 'verified' or 'rejected'

        const supplier = await require('../models/User').findById(supplierId);
        if (!supplier) {
            return res.status(404).json({ msg: 'Supplier not found' });
        }

        if (documentType === 'businessLicense') {
            supplier.businessLicenseStatus = status;
        } else if (documentType === 'businessProfile') {
            supplier.businessProfileStatus = status;
        }

        // Auto-update isVerified if both are verified
        if (supplier.businessLicenseStatus === 'verified' && supplier.businessProfileStatus === 'verified') {
            supplier.isVerified = true;
        } else {
            supplier.isVerified = false;
        }

        await supplier.save();
        res.json(supplier);
    } catch (error) {
        console.error('Error updating supplier document:', error);
        res.status(500).json({ msg: 'Server error' });
    }
});

// @route   PUT api/admin/suppliers/:supplierId/verify-all
// @desc    Fully verify a supplier (all documents)
router.put('/suppliers/:supplierId/verify-all', async (req, res) => {
    try {
        const { supplierId } = req.params;

        const supplier = await require('../models/User').findById(supplierId);
        if (!supplier) {
            return res.status(404).json({ msg: 'Supplier not found' });
        }

        supplier.businessLicenseStatus = 'verified';
        supplier.businessProfileStatus = 'verified';
        supplier.isVerified = true;
        supplier.status = 'active';

        await supplier.save();
        res.json(supplier);
    } catch (error) {
        console.error('Error verifying supplier:', error);
        res.status(500).json({ msg: 'Server error' });
    }
});

// @route   PATCH api/admin/users/:id/toggle
// @desc    Toggle user status
router.patch('/users/:id/toggle', toggleUserStatus);

// @route   PATCH api/admin/users/:id/approve
// @desc    Approve supplier
router.patch('/users/:id/approve', approveSupplier);

module.exports = router;
