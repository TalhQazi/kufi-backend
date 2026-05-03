const express = require('express');
const router = express.Router();
const Category = require('../models/Category');
const {
    getCategories,
    getCategoryById,
    createCategory,
    updateCategory,
    deleteCategory
} = require('../controllers/categoryController');
const auth = require('../middleware/auth');
const cache = require('../middleware/cache');

router.get('/', cache(1800), getCategories); // Cache for 30 minutes
router.get('/:id', cache(1800), getCategoryById); // Cache for 30 minutes

// Upload category icon (admin only)
router.post('/upload-icon', auth(['admin']), async (req, res) => {
    try {
        const iconDataUrl = String(req.body?.iconDataUrl || '').trim();
        if (!iconDataUrl) return res.status(400).json({ msg: 'iconDataUrl is required' });

        if (!iconDataUrl.startsWith('data:image/')) {
            return res.status(400).json({ msg: 'Only image data URLs are allowed' });
        }

        // Enforce ~5MB limit on base64 payload (approx).
        const commaIndex = iconDataUrl.indexOf(',');
        if (commaIndex === -1) return res.status(400).json({ msg: 'Invalid data URL' });
        const base64 = iconDataUrl.slice(commaIndex + 1);
        const bytes = Math.floor((base64.length * 3) / 4);
        const maxBytes = 5 * 1024 * 1024;
        if (bytes > maxBytes) return res.status(413).json({ msg: 'Icon image must be 5MB or less' });

        // Optionally validate Category model exists (keeps require used and makes intent explicit)
        if (!Category) {
            return res.status(500).json({ msg: 'Category model not available' });
        }

        res.json({ image: iconDataUrl });
    } catch (err) {
        console.error(err);
        res.status(500).json({ msg: 'Server error' });
    }
});

router.post('/', auth(['admin']), createCategory);
router.put('/:id', auth(['admin']), updateCategory);
router.delete('/:id', auth(['admin']), deleteCategory);

module.exports = router;
