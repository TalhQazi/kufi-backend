const mongoose = require('mongoose');

const AnalyticsSessionSchema = new mongoose.Schema({
    sessionId: {
        type: String,
        required: true,
        index: true,
        unique: true
    },
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null
    },
    role: {
        type: String,
        default: null
    },
    startedAt: {
        type: Date,
        default: Date.now,
        index: true
    },
    lastSeenAt: {
        type: Date,
        default: Date.now,
        index: true
    },
    pageViews: {
        type: Number,
        default: 0
    },
    totalSeconds: {
        type: Number,
        default: 0
    },
    lastPath: {
        type: String,
        default: ''
    }
});

module.exports = mongoose.model('AnalyticsSession', AnalyticsSessionSchema);
