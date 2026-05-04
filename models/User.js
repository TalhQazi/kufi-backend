const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true
    },
    fullName: {
        type: String
    },
    email: {
        type: String,
        required: true,
        unique: true
    },
    password: {
        type: String,
        required: true
    },
    role: {
        type: String,
        enum: ['user', 'admin', 'supplier'],
        default: 'user'
    },
    status: {
        type: String,
        default: 'active'
    },
    phone: {
        type: String
    },
    country: {
        type: String
    },
    dob: {
        type: Date
    },
    gender: {
        type: String
    },
    streetNumber: {
        type: String
    },
    address: {
        type: String
    },
    city: {
        type: String
    },
    state: {
        type: String
    },
    zipCode: {
        type: String
    },
    nationality: {
        type: String
    },
    avatar: {
        type: String
    },
    scorePoints: {
        type: Number,
        default: 0,
        min: 0,
        max: 100
    },
    // Supplier verification fields
    businessName: {
        type: String
    },
    businessAddress: {
        type: String
    },
    businessLicense: {
        type: String // URL to uploaded document
    },
    businessLicenseStatus: {
        type: String,
        enum: ['pending', 'verified', 'rejected'],
        default: 'pending'
    },
    businessProfileStatus: {
        type: String,
        enum: ['pending', 'verified', 'rejected'],
        default: 'pending'
    },
    isVerified: {
        type: Boolean,
        default: false
    },
    wishlist: {
        type: [{
            countryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Country' },
            countryName: { type: String },
            countryImage: { type: String },
            addedAt: { type: Date, default: Date.now }
        }],
        default: []
    },
    createdAt: {
        type: Date,
        default: Date.now
    },
    lastReadNotifications: {
        type: Date,
        default: Date.now
    },
    resetPasswordToken: {
        type: String
    },
    resetPasswordExpires: {
        type: Date
    }
});

UserSchema.index({ role: 1, status: 1 });
UserSchema.index({ createdAt: -1 });

module.exports = mongoose.model('User', UserSchema);
