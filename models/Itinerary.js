const mongoose = require('mongoose');

const ItinerarySchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    title: {
        type: String,
        required: true
    },
    destination: {
        type: String,
        required: true
    },
    location: {
        type: String
    },
    status: {
        type: String,
        enum: ['Pending', 'Pending Review', 'Supplier Replied Back', 'Ready', 'Accepted', 'Payment Completed', 'Completed', 'Rejected'],
        default: 'Pending'
    },
    imageUrl: {
        type: String,
        default: '/assets/dest-1.jpeg'
    },
    image: {
        type: String
    },
    startDate: {
        type: Date
    },
    endDate: {
        type: Date
    },
    numberOfTravelers: {
        type: Number,
        default: 1
    },
    budget: {
        type: Number
    },
    activities: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Activity'
    }],
    notes: {
        type: String
    },
    createdAt: {
        type: Date,
        default: Date.now
    },
    updatedAt: {
        type: Date,
        default: Date.now
    }
});

module.exports = mongoose.model('Itinerary', ItinerarySchema);
