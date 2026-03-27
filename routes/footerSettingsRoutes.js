const express = require('express');
const router = express.Router();
const {
    getFooterSettings,
    updateFooterSettings,
    uploadFooterImage
} = require('../controllers/footerSettingsController');
const auth = require('../middleware/auth');
const upload = require('../middleware/upload');

// Public route - get footer settings
router.get('/', getFooterSettings);

// Admin protected routes
router.put('/', auth(['admin']), updateFooterSettings);
router.patch('/', auth(['admin']), updateFooterSettings);

// Upload image route (for social icons and payment methods)
router.post('/upload', auth(['admin']), upload.single('image'), uploadFooterImage);

module.exports = router;
