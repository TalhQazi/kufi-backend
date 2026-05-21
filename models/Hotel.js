const mongoose = require('mongoose');

const HotelSchema = new mongoose.Schema({
    name: { type: String, required: true, trim: true },
    country: { type: String, required: true, trim: true },
    city: { type: String, required: true, trim: true },
    pricePerNight: { type: Number, required: true, default: 0 },
    rooms: { type: Number, default: 1 },
    images: [{ type: String }],
    rating: { type: Number, default: 4.0, min: 0, max: 5 },
    description: { type: String, default: '' },
    amenities: [{ type: String }],
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
}, { timestamps: true });

HotelSchema.index({ country: 1, city: 1, status: 1 });

module.exports = mongoose.model('Hotel', HotelSchema);
