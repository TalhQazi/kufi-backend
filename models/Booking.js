const mongoose = require('mongoose');

const BookingSchema = new mongoose.Schema({
    user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    },
    supplier: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    },
    items: [
        {
            activity: {
                type: mongoose.Schema.Types.ObjectId,
                ref: 'Activity'
            },
            title: String,
            travelers: Number,
            addOns: {
                type: Map,
                of: Boolean
            }
        }
    ],
    contactDetails: {
        firstName: String,
        lastName: String,
        email: { type: String, required: true },
        phone: String
    },
    tripDetails: {
        country: String,
        arrivalDate: Date,
        departureDate: Date,
        budget: String
    },
    preferences: {
        includeHotel: Boolean,
        hotelOwn: Boolean,
        foodAllGood: Boolean,
        vegetarian: Boolean
    },
    bookingTermSelections: {
        type: Map,
        of: [String],
        default: {}
    },
    status: {
        type: String,
        enum: ['pending', 'confirmed', 'cancelled'],
        default: 'pending'
    },
    rejectedSuppliers: [
        {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User'
        }
    ],
    createdAt: {
        type: Date,
        default: Date.now
    },
    adjustmentCard: {
        type: mongoose.Schema.Types.Mixed,
        default: null
    },
    adjustmentRequestedAt: {
        type: Date,
        default: null
    },
    transferStatus: {
        type: String,
        enum: ['transferred', 'pending', 'completed'],
        default: null
    },
    transferredAt: {
        type: Date,
        default: null
    },
    transferredBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null
    },
    totalAmount: {
        type: Number,
        default: 0
    },
    commissionAmount: {
        type: Number,
        default: 0
    },
    netAmount: {
        type: Number,
        default: 0
    },
    paymentStatus: {
        type: String,
        enum: ['unpaid', 'paid', 'refunded'],
        default: 'unpaid'
    },
    stripeSessionId: String
});

BookingSchema.index({ user: 1, createdAt: -1 });
BookingSchema.index({ supplier: 1, status: 1, createdAt: -1 });
BookingSchema.index({ status: 1, createdAt: -1 });
BookingSchema.index({ createdAt: -1 });
BookingSchema.index({ 'contactDetails.email': 1 });

module.exports = mongoose.model('Booking', BookingSchema);
