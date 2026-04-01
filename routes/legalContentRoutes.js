const express = require('express');
const router = express.Router();
const LegalContent = require('../models/LegalContent');
const auth = require('../middleware/auth');

// Get all legal content (public)
router.get('/', async (req, res) => {
    try {
        const content = await LegalContent.find({ isActive: true });
        res.json(content);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// Get content by type (public)
router.get('/:type', async (req, res) => {
    try {
        const { type } = req.params;
        const content = await LegalContent.getByType(type);
        
        if (!content) {
            return res.status(404).json({ message: 'Content not found' });
        }
        
        res.json(content);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// Get all content (admin - includes inactive)
router.get('/admin/all', auth(), async (req, res) => {
    try {
        const content = await LegalContent.find();
        res.json(content);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// Update content by type (admin only)
router.put('/:type', auth(), async (req, res) => {
    try {
        const { type } = req.params;
        const { title, content, isActive } = req.body;
        
        const updated = await LegalContent.findOneAndUpdate(
            { type },
            { 
                title, 
                content, 
                isActive,
                updatedAt: new Date()
            },
            { new: true, upsert: true }
        );
        
        res.json(updated);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// Initialize default content (admin only)
router.post('/init', auth(), async (req, res) => {
    try {
        await LegalContent.initializeDefaults();
        const content = await LegalContent.find();
        res.json({ message: 'Defaults initialized', content });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

module.exports = router;
