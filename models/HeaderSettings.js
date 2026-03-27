const mongoose = require('mongoose');

const navItemSchema = new mongoose.Schema({
    id: {
        type: String,
        required: true
    },
    label: {
        type: String,
        required: true
    },
    url: {
        type: String,
        default: '#'
    },
    sortOrder: {
        type: Number,
        default: 0
    },
    isActive: {
        type: Boolean,
        default: true
    }
}, { _id: true });

const headerSettingsSchema = new mongoose.Schema({
    logo: {
        type: String,
        default: '/assets/navbar.png'
    },
    navItems: [navItemSchema],
    contactInfo: {
        phone: {
            type: String,
            default: '+0 123 456 789'
        },
        isActive: {
            type: Boolean,
            default: true
        }
    },
    authButton: {
        label: {
            type: String,
            default: 'Login/Signup'
        },
        isActive: {
            type: Boolean,
            default: true
        }
    },
    updatedAt: {
        type: Date,
        default: Date.now
    }
}, { timestamps: true });

// Ensure only one document exists
headerSettingsSchema.statics.getSettings = async function() {
    let settings = await this.findOne();
    if (!settings) {
        // Create default settings
        settings = await this.create({
            navItems: [
                { id: 'home', label: 'Home', url: '#home', sortOrder: 0, isActive: true },
                { id: 'destinations', label: 'Destinations', url: '#destinations', sortOrder: 1, isActive: true },
                { id: 'top-locations', label: 'Top Locations', url: '#top-locations', sortOrder: 2, isActive: true },
                { id: 'blog', label: 'Blog', url: '#blog', sortOrder: 3, isActive: true }
            ]
        });
    }
    return settings;
};

module.exports = mongoose.model('HeaderSettings', headerSettingsSchema);
