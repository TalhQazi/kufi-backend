const Hotel = require('../models/Hotel');

exports.getHotels = async (req, res) => {
    try {
        const { country, city } = req.query;
        const filter = { status: 'active' };
        if (country) filter.country = new RegExp(`^${country.trim()}$`, 'i');
        if (city) filter.city = new RegExp(`^${city.trim()}$`, 'i');

        const hotels = await Hotel.find(filter).sort({ rating: -1 }).lean();
        res.json(hotels);
    } catch (err) {
        res.status(500).json({ msg: 'Server error', error: err.message });
    }
};

exports.getAllHotels = async (req, res) => {
    try {
        const { country, city, status } = req.query;
        const filter = {};
        if (country) filter.country = new RegExp(country.trim(), 'i');
        if (city) filter.city = new RegExp(city.trim(), 'i');
        if (status) filter.status = status;

        const hotels = await Hotel.find(filter).sort({ createdAt: -1 }).lean();
        res.json(hotels);
    } catch (err) {
        res.status(500).json({ msg: 'Server error', error: err.message });
    }
};

exports.getHotelById = async (req, res) => {
    try {
        const hotel = await Hotel.findById(req.params.id).lean();
        if (!hotel) return res.status(404).json({ msg: 'Hotel not found' });
        res.json(hotel);
    } catch (err) {
        res.status(500).json({ msg: 'Server error', error: err.message });
    }
};

exports.createHotel = async (req, res) => {
    try {
        const hotel = new Hotel(req.body);
        await hotel.save();
        res.status(201).json(hotel);
    } catch (err) {
        res.status(500).json({ msg: 'Server error', error: err.message });
    }
};

exports.updateHotel = async (req, res) => {
    try {
        const hotel = await Hotel.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
        if (!hotel) return res.status(404).json({ msg: 'Hotel not found' });
        res.json(hotel);
    } catch (err) {
        res.status(500).json({ msg: 'Server error', error: err.message });
    }
};

exports.deleteHotel = async (req, res) => {
    try {
        const hotel = await Hotel.findByIdAndDelete(req.params.id);
        if (!hotel) return res.status(404).json({ msg: 'Hotel not found' });
        res.json({ msg: 'Hotel deleted successfully' });
    } catch (err) {
        res.status(500).json({ msg: 'Server error', error: err.message });
    }
};
