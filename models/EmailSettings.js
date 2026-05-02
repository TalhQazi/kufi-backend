const mongoose = require('mongoose');

const EmailSettingsSchema = new mongoose.Schema({
    smtpHost: { type: String, default: '' },
    smtpPort: { type: Number, default: 587 },
    smtpUser: { type: String, default: '' },
    smtpPass: { type: String, default: '' },
    fromEmail: { type: String, default: '' },
    fromName: { type: String, default: 'Kufi' },
    encryption: { type: String, enum: ['none', 'ssl', 'tls'], default: 'tls' },
    
    // Template toggles
    templates: {
        userRegistration: { type: Boolean, default: true },
        supplierRegistration: { type: Boolean, default: true },
        supplierApproval: { type: Boolean, default: true },
        offerAccepted: { type: Boolean, default: true },
        offerRejected: { type: Boolean, default: true },
        itineraryReply: { type: Boolean, default: true }
    },
    updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('EmailSettings', EmailSettingsSchema);
