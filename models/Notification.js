const mongoose = require('mongoose');

const NotificationSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true,
    },
    type: {
        type: String,
        required: true,
        trim: true,
    },
    title: {
        type: String,
        required: true,
        trim: true,
    },
    message: {
        type: String,
        required: true,
        default: '',
    },
    bookingId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Booking',
        default: null,
    },
    itineraryId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Itinerary',
        default: null,
    },
    read: {
        type: Boolean,
        default: false,
        index: true,
    },
    createdAt: {
        type: Date,
        default: Date.now,
        index: true,
    },
});

NotificationSchema.index({ userId: 1, createdAt: -1 });
NotificationSchema.index({ userId: 1, read: 1 });

module.exports = mongoose.model('Notification', NotificationSchema);
