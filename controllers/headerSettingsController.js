const HeaderSettings = require('../models/HeaderSettings');
const { getCache, setCache, clearCache } = require('../utils/cache');

// Sanitize payload
const sanitize = (str) => typeof str === 'string' ? str.trim() : str;

// Get header settings (public)
const getHeaderSettings = async (req, res) => {
    try {
        const cacheKey = 'cache:/api/header';
        const cachedData = await getCache(cacheKey);
        if (cachedData) return res.json(cachedData);

        const settings = await HeaderSettings.findOne().lean().maxTimeMS(3000);
        const data = settings || {};
        
        await setCache(cacheKey, data, 86400); // 24h cache
        res.json(data);
    } catch (error) {
        console.error('Error fetching header settings:', error);
        res.status(500).json({ message: 'Error fetching header settings', error: error.message });
    }
};

// Update header settings (admin)
const updateHeaderSettings = async (req, res) => {
    try {
        const updateData = {};

        // Handle logo
        if (req.body.logo !== undefined) {
            updateData.logo = req.body.logo || '/assets/navbar.png';
        }

        // Handle nav items
        if (req.body.navItems) {
            updateData.navItems = req.body.navItems.map(item => ({
                id: sanitize(item.id) || '',
                label: sanitize(item.label) || '',
                url: sanitize(item.url) || '#',
                sortOrder: Number(item.sortOrder) || 0,
                isActive: item.isActive !== false
            }));
        }

        // Handle contact info
        if (req.body.contactInfo) {
            updateData.contactInfo = {
                phone: sanitize(req.body.contactInfo.phone) || '',
                isActive: req.body.contactInfo.isActive !== false
            };
        }

        // Handle auth button
        if (req.body.authButton) {
            updateData.authButton = {
                label: sanitize(req.body.authButton.label) || 'Login/Signup',
                isActive: req.body.authButton.isActive !== false
            };
        }

        updateData.updatedAt = new Date();

        const settings = await HeaderSettings.findOneAndUpdate(
            {},
            { $set: updateData },
            { new: true, upsert: true }
        );

        // Clear cache
        await clearCache('cache:/api/header*');

        res.json(settings);
    } catch (error) {
        console.error('Error updating header settings:', error);
        res.status(500).json({ message: 'Error updating header settings', error: error.message });
    }
};

// Upload logo image (base64)
const uploadHeaderLogo = async (req, res) => {
    try {
        // Check if base64 image is provided in body
        if (req.body && req.body.image) {
            const { image, name } = req.body;
            
            // Validate base64 image
            if (!image.startsWith('data:image/')) {
                return res.status(400).json({ message: 'Invalid image format. Must be base64 data URL.' });
            }

            // Return the base64 data directly
            res.json({ 
                url: image,
                name: name || 'logo',
                type: 'base64'
            });
            return;
        }

        // Fallback: if file upload is used
        if (!req.file) {
            return res.status(400).json({ message: 'No image provided' });
        }

        // Read file and convert to base64
        const fs = require('fs');
        const fileData = fs.readFileSync(req.file.path);
        const base64Image = `data:${req.file.mimetype};base64,${fileData.toString('base64')}`;
        
        // Clean up the uploaded file
        fs.unlinkSync(req.file.path);
        
        res.json({ 
            url: base64Image,
            filename: req.file.filename,
            type: 'base64'
        });
    } catch (error) {
        console.error('Error uploading header logo:', error);
        res.status(500).json({ message: 'Error uploading logo', error: error.message });
    }
};

module.exports = {
    getHeaderSettings,
    updateHeaderSettings,
    uploadHeaderLogo
};
