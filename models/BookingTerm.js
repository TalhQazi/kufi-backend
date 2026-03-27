const mongoose = require('mongoose');

const BookingTermSchema = new mongoose.Schema({
    title: {
        type: String,
        required: true,
        trim: true
    },
    options: {
        type: [String],
        default: [],
        validate: {
            validator: function(v) {
                return v.length > 0;
            },
            message: 'At least one option is required'
        }
    },
    selectionType: {
        type: String,
        enum: ['single', 'multiple'],
        default: 'single'
    },
    isActive: {
        type: Boolean,
        default: true
    },
    sortOrder: {
        type: Number,
        default: 0
    }
}, {
    timestamps: true
});

module.exports = mongoose.model('BookingTerm', BookingTermSchema);
