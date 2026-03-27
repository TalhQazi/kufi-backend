const mongoose = require('mongoose');

const sectionSchema = new mongoose.Schema({
    id: {
        type: String,
        required: true,
        unique: true
    },
    name: {
        type: String,
        required: true
    },
    description: {
        type: String,
        default: ''
    },
    page: {
        type: String,
        required: true,
        enum: ['home', 'country', 'category', 'all']
    },
    isVisible: {
        type: Boolean,
        default: true
    },
    sortOrder: {
        type: Number,
        default: 0
    }
}, { _id: true });

const sectionVisibilitySchema = new mongoose.Schema({
    sections: [sectionSchema],
    updatedAt: {
        type: Date,
        default: Date.now
    }
}, { timestamps: true });

// Default sections configuration
const DEFAULT_SECTIONS = [
    // Home Page Sections
    { id: 'hero', name: 'Hero Section', description: 'Main banner with search CTA', page: 'home', isVisible: true, sortOrder: 0 },
    { id: 'search', name: 'Search Bar', description: 'Search functionality below hero', page: 'home', isVisible: true, sortOrder: 1 },
    { id: 'destinations', name: 'Destinations Section', description: 'Popular destinations carousel', page: 'home', isVisible: true, sortOrder: 2 },
    { id: 'categories', name: 'Categories Section', description: 'Experience categories grid', page: 'home', isVisible: true, sortOrder: 3 },
    { id: 'top-locations', name: 'Top Locations', description: 'Featured locations showcase', page: 'home', isVisible: true, sortOrder: 4 },
    { id: 'top-activities', name: 'Top Activities', description: 'Featured activities cards', page: 'home', isVisible: true, sortOrder: 5 },
    { id: 'booking-system', name: 'Booking System', description: 'How to book steps', page: 'home', isVisible: true, sortOrder: 6 },
    { id: 'feedback', name: 'Feedback/Reviews', description: 'Customer testimonials', page: 'home', isVisible: true, sortOrder: 7 },
    { id: 'services', name: 'Services Section', description: 'Our services showcase', page: 'home', isVisible: true, sortOrder: 8 },
    { id: 'blog', name: 'Blog Section', description: 'Latest blog posts', page: 'home', isVisible: true, sortOrder: 9 },
    
    // Country Details Page Sections
    { id: 'country-hero', name: 'Country Hero', description: 'Country banner image', page: 'country', isVisible: true, sortOrder: 0 },
    { id: 'country-about', name: 'About Country', description: 'Country description', page: 'country', isVisible: true, sortOrder: 1 },
    { id: 'country-cities', name: 'Cities Section', description: 'Cities in the country', page: 'country', isVisible: true, sortOrder: 2 },
    { id: 'country-categories', name: 'Top Categories', description: 'Category icons for country', page: 'country', isVisible: true, sortOrder: 3 },
    { id: 'country-experiences', name: 'Popular Experiences', description: 'Activities/experiences list', page: 'country', isVisible: true, sortOrder: 4 },
    { id: 'country-feedback', name: 'Country Feedback', description: 'Reviews for this country', page: 'country', isVisible: true, sortOrder: 5 },
    { id: 'country-blog', name: 'Country Blog', description: 'Related blog posts', page: 'country', isVisible: true, sortOrder: 6 }
];

// Ensure only one document exists and return with defaults
sectionVisibilitySchema.statics.getSettings = async function() {
    let settings = await this.findOne();
    if (!settings) {
        // Create default settings
        settings = await this.create({ sections: DEFAULT_SECTIONS });
    } else {
        // Check if new sections need to be added (backward compatibility)
        const existingIds = settings.sections.map(s => s.id);
        const newSections = DEFAULT_SECTIONS.filter(s => !existingIds.includes(s.id));
        
        if (newSections.length > 0) {
            settings.sections.push(...newSections);
            await settings.save();
        }
    }
    return settings;
};

module.exports = mongoose.model('SectionVisibility', sectionVisibilitySchema);
