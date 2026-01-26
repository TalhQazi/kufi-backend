const mongoose = require('mongoose');

const CountrySchema = new mongoose.Schema({
    name: {
        type: String,
        required: true
    },
    code: {
        type: String,
        uppercase: true
    },
    imageUrl: {
        type: String,
        default: '/assets/activity1.jpeg'
    },
    image: {
        type: String
    },
    description: {
        type: String
    },
    popularActivities: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Activity'
    }],
    cities: [{
        type: String
    }],
    featured: {
        type: Boolean,
        default: false
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
});

module.exports = mongoose.model('Country', CountrySchema);
