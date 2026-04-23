const mongoose = require('mongoose');

const GlobalSettingsSchema = new mongoose.Schema({
    commissionPercentage: {
        type: Number,
        default: 10, // Default 10%
    },
    stripePublicKey: {
        type: String,
        default: ''
    },
    updatedAt: {
        type: Date,
        default: Date.now
    }
}, { timestamps: true });

module.exports = mongoose.model('GlobalSettings', GlobalSettingsSchema);
