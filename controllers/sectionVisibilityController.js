const SectionVisibility = require('../models/SectionVisibility');

// Sanitize payload
const sanitize = (str) => typeof str === 'string' ? str.trim() : str;

// Get section visibility settings (public)
const getSectionVisibility = async (req, res) => {
    try {
        const settings = await SectionVisibility.getSettings();
        res.json(settings);
    } catch (error) {
        console.error('Error fetching section visibility:', error);
        res.status(500).json({ message: 'Error fetching section visibility', error: error.message });
    }
};

// Get sections by page (public)
const getSectionsByPage = async (req, res) => {
    try {
        const { page } = req.params;
        const settings = await SectionVisibility.getSettings();
        
        // Filter sections for the specific page, also include 'all' page sections
        const sections = settings.sections.filter(s => 
            s.page === page || s.page === 'all'
        );
        
        res.json({ sections });
    } catch (error) {
        console.error('Error fetching sections by page:', error);
        res.status(500).json({ message: 'Error fetching sections', error: error.message });
    }
};

// Check if a specific section is visible (public)
const isSectionVisible = async (req, res) => {
    try {
        const { sectionId } = req.params;
        const settings = await SectionVisibility.getSettings();
        
        const section = settings.sections.find(s => s.id === sectionId);
        
        if (!section) {
            return res.status(404).json({ message: 'Section not found' });
        }
        
        res.json({ 
            id: section.id,
            name: section.name,
            isVisible: section.isVisible 
        });
    } catch (error) {
        console.error('Error checking section visibility:', error);
        res.status(500).json({ message: 'Error checking visibility', error: error.message });
    }
};

// Update section visibility (admin)
const updateSectionVisibility = async (req, res) => {
    try {
        const { sections } = req.body;
        
        if (!Array.isArray(sections)) {
            return res.status(400).json({ message: 'Sections must be an array' });
        }
        
        // Validate and sanitize sections
        const sanitizedSections = sections.map(section => ({
            id: sanitize(section.id) || '',
            name: sanitize(section.name) || '',
            description: sanitize(section.description) || '',
            title: sanitize(section.title) || '',
            heading: sanitize(section.heading) || '',
            subheading: sanitize(section.subheading) || '',
            page: sanitize(section.page) || 'home',
            isVisible: section.isVisible !== false,
            sortOrder: Number(section.sortOrder) || 0
        }));
        
        const settings = await SectionVisibility.findOneAndUpdate(
            {},
            { 
                $set: { 
                    sections: sanitizedSections,
                    updatedAt: new Date()
                }
            },
            { new: true, upsert: true }
        );
        
        res.json(settings);
    } catch (error) {
        console.error('Error updating section visibility:', error);
        res.status(500).json({ message: 'Error updating section visibility', error: error.message });
    }
};

// Toggle single section visibility (admin)
const toggleSection = async (req, res) => {
    try {
        const { sectionId } = req.params;
        const { isVisible } = req.body;
        
        const settings = await SectionVisibility.getSettings();
        
        const sectionIndex = settings.sections.findIndex(s => s.id === sectionId);
        
        if (sectionIndex === -1) {
            return res.status(404).json({ message: 'Section not found' });
        }
        
        settings.sections[sectionIndex].isVisible = isVisible;
        settings.updatedAt = new Date();
        await settings.save();
        
        res.json({
            message: 'Section visibility updated',
            section: settings.sections[sectionIndex]
        });
    } catch (error) {
        console.error('Error toggling section visibility:', error);
        res.status(500).json({ message: 'Error toggling visibility', error: error.message });
    }
};

// Reset to defaults (admin)
const resetToDefaults = async (req, res) => {
    try {
        await SectionVisibility.deleteOne({});
        const settings = await SectionVisibility.getSettings();
        
        res.json({
            message: 'Section visibility reset to defaults',
            settings
        });
    } catch (error) {
        console.error('Error resetting section visibility:', error);
        res.status(500).json({ message: 'Error resetting visibility', error: error.message });
    }
};

module.exports = {
    getSectionVisibility,
    getSectionsByPage,
    isSectionVisible,
    updateSectionVisibility,
    toggleSection,
    resetToDefaults
};
