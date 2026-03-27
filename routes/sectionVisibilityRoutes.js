const express = require('express');
const router = express.Router();
const {
    getSectionVisibility,
    getSectionsByPage,
    isSectionVisible,
    updateSectionVisibility,
    toggleSection,
    resetToDefaults
} = require('../controllers/sectionVisibilityController');
const auth = require('../middleware/auth');

// Public routes
router.get('/', getSectionVisibility);
router.get('/page/:page', getSectionsByPage);
router.get('/check/:sectionId', isSectionVisible);

// Admin protected routes
router.put('/', auth(['admin']), updateSectionVisibility);
router.patch('/:sectionId', auth(['admin']), toggleSection);
router.post('/reset', auth(['admin']), resetToDefaults);

module.exports = router;
