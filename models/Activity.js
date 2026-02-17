const mongoose = require('mongoose');

const ActivitySchema = new mongoose.Schema({
    title: {
        type: String,
        required: true
    },
    description: {
        type: String
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
        enum: ['pending', 'approved', 'rejected'],
        default: 'pending'
    }
});

module.exports = mongoose.model('Activity', ActivitySchema);
