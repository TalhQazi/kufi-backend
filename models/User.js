const mongoose = require('mongoose');
const { normalizeEmail } = require('../utils/email');

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
        unique: true,
        // Emails are case-insensitive. Storing a single normalized form is what makes
        // the existing unique index enforce that: two accounts can no longer differ by
        // casing alone. Every read path normalizes too (see utils/email.js).
        set: normalizeEmail,
        trim: true,
        lowercase: true
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
    // SHA-256 digest of the reset token. The token itself is only ever sent by email,
    // so a database leak cannot be replayed against the reset endpoint.
    resetPasswordToken: {
        type: String,
        select: false
    },
    resetPasswordExpires: {
        type: Date,
        select: false
    },
    // Set on every password change/reset. Tokens issued before this moment are rejected
    // by the auth middleware, which is what logs other sessions out.
    passwordChangedAt: {
        type: Date
    },
    preferences: {
        darkMode: {
            type: Boolean,
            default: false
        }
    }
});

UserSchema.index({ role: 1, status: 1 });
UserSchema.index({ createdAt: -1 });
// Reset lookups are by token digest, so keep them indexed and sparse (almost every
// document has no pending reset).
UserSchema.index({ resetPasswordToken: 1 }, { sparse: true });

module.exports = mongoose.model('User', UserSchema);
