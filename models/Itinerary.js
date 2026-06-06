const mongoose = require('mongoose');
const { applyBudgetToDocument } = require('../utils/parseBudget');

const ItinerarySchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    bookingId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Booking'
    },
    supplierId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
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
    tripData: {
        type: mongoose.Schema.Types.Mixed
    },
    days: {
        type: [mongoose.Schema.Types.Mixed],
        default: []
    },
    country: {
        type: String,
        trim: true
    },
    city: {
        type: String,
        trim: true
    },
    aiGenerated: {
        type: Boolean,
        default: false
    },
    aiGeneratedAt: {
        type: Date
    },
    generationSource: {
        type: String,
        enum: ['ai', 'template'],
        default: 'ai'
    },
    controlPanel: {
        activityStartTime: { type: String, default: '09:00' },
        activityEndTime: { type: String, default: '19:00' },
        lunchStart: { type: String, default: '13:00' },
        lunchEnd: { type: String, default: '14:00' },
        startOnArrival: { type: Boolean, default: false },
        endOnDeparture: { type: Boolean, default: false },
        perDayOverrides: [{
            date: String,
            startTime: String,
            endTime: String,
            lunchStart: String,
            lunchEnd: String
        }],
        hotelId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hotel' },
        numberOfRooms: { type: Number, default: 1 },
        budgetUplift: { type: Number, default: 15 }
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

ItinerarySchema.index({ userId: 1, createdAt: -1 });
ItinerarySchema.index({ supplierId: 1, createdAt: -1 });
ItinerarySchema.index({ bookingId: 1 });
ItinerarySchema.index({ country: 1, city: 1, aiGenerated: 1 });

// Fix legacy string budgets ("N/A", "$500") before validation/save
ItinerarySchema.pre('validate', function sanitizeBudget() {
    applyBudgetToDocument(this);
});

module.exports = mongoose.model('Itinerary', ItinerarySchema);
