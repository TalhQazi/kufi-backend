const express = require('express');
const router = express.Router();
const { registerUser, loginUser, getProfile, updateProfile } = require('../controllers/authController');
const auth = require('../middleware/auth');

// @route   POST api/auth/register
// @desc    Register user
// @access  Public
router.post('/register', registerUser);

// @route   POST api/auth/login
// @desc    Login user
// @access  Public
router.post('/login', loginUser);

// @route   GET api/auth/profile
// @desc    Get current user profile
// @access  Private
router.get('/profile', auth(), getProfile);

// @route   PATCH api/auth/profile
// @desc    Update user profile
// @access  Private
router.patch('/profile', auth(), updateProfile);

module.exports = router;
