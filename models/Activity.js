const mongoose = require('mongoose');

const ActivitySchema = new mongoose.Schema({
    title: {
        type: String,
        required: true
    },
    description: {
        type: String
    },
    highlights: {
        type: [String],
        default: []
    },
    location: {
        type: String
    },
    country: {
        type: String
    },
    price: {
        type: Number
    },
    duration: {
        type: String
    },
    image: {
        type: String
    },
    images: {
        type: [String],
        default: []
    },
    category: {
        type: String
    },
    rating: {
        type: Number,
        default: 4.5
    },
    reviews: {
        type: Number,
        default: 0
    },
    addOns: {
        type: mongoose.Schema.Types.Mixed,
        default: {}
    },
    supplier: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    },
    status: {
        type: String,
        enum: ['draft', 'pending', 'approved', 'rejected'],
        default: 'pending'
    },
    coordinates: {
        lat: {
            type: Number,
            default: null
        },
        lng: {
            type: Number,
            default: null
        }
    }
}, { timestamps: true });

ActivitySchema.index({ supplier: 1, status: 1 });
ActivitySchema.index({ status: 1, country: 1, category: 1 });
ActivitySchema.index({ location: 1, status: 1 });
ActivitySchema.index({ title: 'text', location: 'text' });
ActivitySchema.index({ country: 1, status: 1 });
ActivitySchema.index({ createdAt: -1 });

module.exports = mongoose.model('Activity', ActivitySchema);
