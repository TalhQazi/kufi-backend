const mongoose = require('mongoose');

const AnalyticsDailySchema = new mongoose.Schema({
    day: {
        type: String,
        required: true,
        unique: true,
        index: true
    },
    visitors: {
        type: Number,
        default: 0
    },
    pageViews: {
        type: Number,
        default: 0
    }
});

module.exports = mongoose.model('AnalyticsDaily', AnalyticsDailySchema);
