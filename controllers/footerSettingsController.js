const FooterSettings = require('../models/FooterSettings');
const path = require('path');

// Sanitize payload
const sanitize = (str) => typeof str === 'string' ? str.trim() : str;

// Get footer settings (public)
const getFooterSettings = async (req, res) => {
    try {
        const settings = await FooterSettings.getSettings();
        res.json(settings);
    } catch (error) {
        console.error('Error fetching footer settings:', error);
        res.status(500).json({ message: 'Error fetching footer settings', error: error.message });
    }
};

// Update footer settings (admin)
const updateFooterSettings = async (req, res) => {
    try {
        const updateData = {};

        // Handle contact info
        if (req.body.contactInfo) {
            updateData.contactInfo = {
                title: sanitize(req.body.contactInfo.title) || 'Quick contact',
                items: Array.isArray(req.body.contactInfo.items) 
                    ? req.body.contactInfo.items.map(item => ({
                        type: sanitize(item.type) || 'other',
                        label: sanitize(item.label) || '',
                        value: sanitize(item.value) || '',
                        icon: item.icon || 'Globe',
                        sortOrder: Number(item.sortOrder) || 0,
                        isActive: item.isActive !== false
                    }))
                    : undefined
            };
        }

        // Handle social icons
        if (req.body.socialIcons) {
            updateData.socialIcons = req.body.socialIcons.map(icon => ({
                name: sanitize(icon.name) || '',
                url: sanitize(icon.url) || '#',
                iconImage: icon.iconImage || null,
                sortOrder: Number(icon.sortOrder) || 0,
                isActive: icon.isActive !== false
            }));
        }

        // Handle payment methods
        if (req.body.paymentMethods) {
            updateData.paymentMethods = req.body.paymentMethods.map(pm => ({
                name: sanitize(pm.name) || '',
                iconImage: pm.iconImage || '',
                sortOrder: Number(pm.sortOrder) || 0,
                isActive: pm.isActive !== false
            }));
        }

        // Handle brand section
        if (req.body.brandSection) {
            updateData.brandSection = {
                logo: req.body.brandSection.logo || '/assets/navbar.png',
                description: sanitize(req.body.brandSection.description) || '',
                socialTitle: sanitize(req.body.brandSection.socialTitle) || 'Connect with us'
            };
        }

        // Handle services
        if (req.body.services) {
            updateData.services = {
                title: sanitize(req.body.services.title) || 'Our Services',
                items: Array.isArray(req.body.services.items)
                    ? req.body.services.items.map(item => ({
                        label: sanitize(item.label) || '',
                        url: sanitize(item.url) || '#',
                        sortOrder: Number(item.sortOrder) || 0,
                        isActive: item.isActive !== false
                    }))
                    : undefined
            };
        }

        // Handle quick links
        if (req.body.quickLinks) {
            updateData.quickLinks = {
                title: sanitize(req.body.quickLinks.title) || 'Quick Link',
                items: Array.isArray(req.body.quickLinks.items)
                    ? req.body.quickLinks.items.map(item => ({
                        label: sanitize(item.label) || '',
                        url: sanitize(item.url) || '#',
                        sortOrder: Number(item.sortOrder) || 0,
                        isActive: item.isActive !== false
                    }))
                    : undefined
            };
        }

        // Handle newsletter
        if (req.body.newsletter) {
            updateData.newsletter = {
                title: sanitize(req.body.newsletter.title) || 'Become a member',
                placeholder: sanitize(req.body.newsletter.placeholder) || 'Enter your email',
                isActive: req.body.newsletter.isActive !== false
            };
        }

        // Handle copyright
        if (req.body.copyright !== undefined) {
            updateData.copyright = sanitize(req.body.copyright) || '';
        }

        updateData.updatedAt = new Date();

        const settings = await FooterSettings.findOneAndUpdate(
            {},
            { $set: updateData },
            { new: true, upsert: true }
        );

        res.json(settings);
    } catch (error) {
        console.error('Error updating footer settings:', error);
        res.status(500).json({ message: 'Error updating footer settings', error: error.message });
    }
};

// Upload image (for social icons and payment methods) - stores as base64 in MongoDB
const uploadFooterImage = async (req, res) => {
    try {
        // Check if base64 image is provided in body
        if (req.body && req.body.image) {
            const { image, name } = req.body;
            
            // Validate base64 image
            if (!image.startsWith('data:image/')) {
                return res.status(400).json({ message: 'Invalid image format. Must be base64 data URL.' });
            }

            // Return the base64 data directly (it will be stored in MongoDB with the footer settings)
            res.json({ 
                url: image,
                name: name || 'image',
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
        console.error('Error uploading footer image:', error);
        res.status(500).json({ message: 'Error uploading image', error: error.message });
    }
};

module.exports = {
    getFooterSettings,
    updateFooterSettings,
    uploadFooterImage
};
