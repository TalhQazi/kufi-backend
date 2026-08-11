const Hotel = require('../models/Hotel');

const escapeRegExp = (value) => String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Active hotels for a destination.
 *
 * The city filter is a narrowing hint, not a hard requirement. A trip is often described
 * only by its country, and hotels are filed under specific city names ("Beirut City",
 * "Nile River"), so an exact city match frequently eliminated every hotel and left the
 * supplier's dropdown empty. When a city yields nothing, the country result is returned
 * instead — an imprecise city should widen the search, never blank it.
 */
exports.getHotels = async (req, res) => {
    try {
        const { country, city } = req.query;
        const base = { status: 'active' };
        if (country) base.country = new RegExp(`^${escapeRegExp(country.trim())}$`, 'i');

        const sorted = (q) => Hotel.find(q).sort({ sortOrder: 1, name: 1 }).lean();

        if (city) {
            // Substring rather than exact: "Beirut" should find "Beirut City".
            const narrowed = { ...base, city: new RegExp(escapeRegExp(city.trim()), 'i') };
            const matches = await sorted(narrowed);
            if (matches.length > 0) return res.json(matches);
        }

        res.json(await sorted(base));
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

        const hotels = await Hotel.find(filter).sort({ sortOrder: 1, name: 1 }).lean();
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
