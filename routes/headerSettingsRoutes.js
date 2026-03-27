const express = require('express');
const router = express.Router();
const {
    getHeaderSettings,
    updateHeaderSettings,
    uploadHeaderLogo
} = require('../controllers/headerSettingsController');
const auth = require('../middleware/auth');
const upload = require('../middleware/upload');

// Public route - get header settings
router.get('/', getHeaderSettings);

// Admin protected routes
router.put('/', auth(['admin']), updateHeaderSettings);
router.patch('/', auth(['admin']), updateHeaderSettings);

// Upload logo route
router.post('/upload', auth(['admin']), upload.single('image'), uploadHeaderLogo);

module.exports = router;
