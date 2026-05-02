const express = require('express');
const router = express.Router();
const { registerUser, loginUser, getProfile, updateProfile, changePassword, googleLogin } = require('../controllers/authController');
const auth = require('../middleware/auth');

// @route   POST api/auth/register
// @desc    Register user
// @access  Public
router.post('/register', registerUser);

// @route   POST api/auth/login
// @desc    Login user
// @access  Public
router.post('/login', loginUser);

// @route   POST api/auth/google
// @desc    Google login
// @access  Public
router.post('/google', googleLogin);

// @route   GET api/auth/profile
// @desc    Get current user profile
// @access  Private
router.get('/profile', auth(), getProfile);

// @route   PATCH api/auth/profile
// @desc    Update user profile
// @access  Private
router.patch('/profile', auth(), updateProfile);

// @route   POST api/auth/change-password
// @desc    Change user password
// @access  Private
router.post('/change-password', auth(), changePassword);

// @route   GET api/auth/wishlist
// @desc    Get user's wishlist
// @access  Private
router.get('/wishlist', auth(), async (req, res) => {
    try {
        const user = await require('../models/User').findById(req.user.id).select('wishlist');
        res.json(user.wishlist || []);
    } catch (error) {
        console.error('Error fetching wishlist:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

// @route   POST api/auth/wishlist
// @desc    Add country to wishlist
// @access  Private
router.post('/wishlist', auth(), async (req, res) => {
    try {
        const { countryId, countryName, countryImage } = req.body;
        
        if (!countryId || !countryName) {
            return res.status(400).json({ message: 'Country ID and name are required' });
        }

        const User = require('../models/User');
        const user = await User.findById(req.user.id);
        
        // Check if already in wishlist
        const exists = user.wishlist.some(item => item.countryId.toString() === countryId);
        if (exists) {
            return res.status(400).json({ message: 'Country already in wishlist' });
        }
        
        user.wishlist.push({ countryId, countryName, countryImage });
        await user.save();
        
        res.json({ message: 'Added to wishlist', wishlist: user.wishlist });
    } catch (error) {
        console.error('Error adding to wishlist:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

// @route   DELETE api/auth/wishlist/:countryId
// @desc    Remove country from wishlist
// @access  Private
router.delete('/wishlist/:countryId', auth(), async (req, res) => {
    try {
        const User = require('../models/User');
        const user = await User.findById(req.user.id);
        
        user.wishlist = user.wishlist.filter(item => item.countryId.toString() !== req.params.countryId);
        await user.save();
        
        res.json({ message: 'Removed from wishlist', wishlist: user.wishlist });
    } catch (error) {
        console.error('Error removing from wishlist:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

module.exports = router;
