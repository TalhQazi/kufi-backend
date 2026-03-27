const mongoose = require('mongoose');

const contactItemSchema = new mongoose.Schema({
    type: {
        type: String,
        enum: ['email', 'phone', 'address', 'other'],
        required: true
    },
    label: {
        type: String,
        required: true
    },
    value: {
        type: String,
        required: true
    },
    icon: {
        type: String,
        enum: ['MapPin', 'Phone', 'Mail', 'Globe', 'Home'],
        default: 'Globe'
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

const socialIconSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true
    },
    url: {
        type: String,
        required: true
    },
    iconImage: {
        type: String,
        default: null
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

const paymentMethodSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true
    },
    iconImage: {
        type: String,
        required: true
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

const footerSettingsSchema = new mongoose.Schema({
    contactInfo: {
        title: {
            type: String,
            default: 'Quick contact'
        },
        items: [contactItemSchema]
    },
    socialIcons: [socialIconSchema],
    paymentMethods: [paymentMethodSchema],
    brandSection: {
        logo: {
            type: String,
            default: '/assets/navbar.png'
        },
        description: {
            type: String,
            default: 'stepping outside comfort zones, embracing the unfamiliar, and creating lasting memories'
        },
        socialTitle: {
            type: String,
            default: 'Connect with us'
        }
    },
    services: {
        title: {
            type: String,
            default: 'Our Services'
        },
        items: [{
            label: String,
            url: String,
            sortOrder: { type: Number, default: 0 },
            isActive: { type: Boolean, default: true }
        }]
    },
    quickLinks: {
        title: {
            type: String,
            default: 'Quick Link'
        },
        items: [{
            label: String,
            url: String,
            sortOrder: { type: Number, default: 0 },
            isActive: { type: Boolean, default: true }
        }]
    },
    newsletter: {
        title: {
            type: String,
            default: 'Become a member'
        },
        placeholder: {
            type: String,
            default: 'Enter your email'
        },
        isActive: {
            type: Boolean,
            default: true
        }
    },
    copyright: {
        type: String,
        default: '© Copyright lorem ipsum amet dolor All Rights Reserved.'
    },
    updatedAt: {
        type: Date,
        default: Date.now
    }
}, { timestamps: true });

// Ensure only one document exists
footerSettingsSchema.statics.getSettings = async function() {
    let settings = await this.findOne();
    if (!settings) {
        settings = await this.create({});
    }
    return settings;
};

module.exports = mongoose.model('FooterSettings', footerSettingsSchema);
