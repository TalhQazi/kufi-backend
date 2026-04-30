const mongoose = require('mongoose');

const legalContentSchema = new mongoose.Schema({
    type: {
        type: String,
        enum: ['terms', 'privacy', 'faqs', 'support', 'about'],
        required: true,
        unique: true
    },
    title: {
        type: String,
        required: true,
        default: function() {
            const titles = {
                'terms': 'Terms & Conditions',
                'privacy': 'Privacy Policy',
                'faqs': 'Frequently Asked Questions',
                'support': 'Support',
                'about': 'About Us'
            };
            return titles[this.type] || 'Content';
        }
    },
    content: {
        type: String,
        required: true,
        default: ''
    },
    isActive: {
        type: Boolean,
        default: true
    },
    updatedAt: {
        type: Date,
        default: Date.now
    }
}, { timestamps: true });

// Static method to get content by type
legalContentSchema.statics.getByType = async function(type) {
    return await this.findOne({ type, isActive: true });
};

// Static method to initialize default content
legalContentSchema.statics.initializeDefaults = async function() {
    const defaults = [
        {
            type: 'terms',
            title: 'Terms & Conditions',
            content: '<p>Terms and conditions content goes here...</p>'
        },
        {
            type: 'privacy',
            title: 'Privacy Policy',
            content: '<p>Privacy policy content goes here...</p>'
        },
        {
            type: 'faqs',
            title: 'Frequently Asked Questions',
            content: '<p>FAQs content goes here...</p>'
        },
        {
            type: 'support',
            title: 'Support',
            content: '<p>Support content goes here...</p>'
        },
        {
            type: 'about',
            title: 'About Us',
            content: '<p>Learn more about Kufi Travel and our mission to provide seamless booking experiences.</p>'
        }
    ];

    for (const item of defaults) {
        const exists = await this.findOne({ type: item.type });
        if (!exists) {
            await this.create(item);
        }
    }
};

module.exports = mongoose.model('LegalContent', legalContentSchema);
