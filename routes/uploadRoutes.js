const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const upload = require('../middleware/upload');

// @route   POST api/upload/business-license
// @desc    Upload business license document
// @access  Private (Supplier)
router.post('/business-license', auth(['supplier']), upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ msg: 'No file uploaded' });
        }
        
        // Return the file URL
        const fileUrl = `/uploads/${req.file.filename}`;
        res.json({ url: fileUrl, fileUrl });
    } catch (error) {
        console.error('Error uploading business license:', error);
        res.status(500).json({ msg: 'Server error' });
    }
});

module.exports = router;
