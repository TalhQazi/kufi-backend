const mongoose = require('mongoose');

const ReviewSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ['feedback', 'country'],
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    role: {
      type: String,
      enum: ['client', 'traveler'],
      default: 'client',
      trim: true,
    },
    note: {
      type: String,
      required: true,
      default: '',
    },
    image: {
      type: String,
      default: '',
    },
    rating: {
      type: Number,
      default: 5,
      min: 1,
      max: 5,
    },
    country: {
      type: String,
      default: '',
      trim: true,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    sortOrder: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Review', ReviewSchema);
