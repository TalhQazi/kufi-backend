const mongoose = require('mongoose');

const CitySchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
  },
  country: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Country',
    required: true,
  },
  description: {
    type: String,
  },
  image: {
    type: String,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

module.exports = mongoose.model('City', CitySchema);
