const BookingTerm = require('../models/BookingTerm');

// Sanitize payload
const sanitizePayload = (data) => {
    const { title, options, selectionType, isActive, sortOrder } = data;
    const payload = {};

    if (title !== undefined) payload.title = String(title).trim();
    if (options !== undefined) {
        payload.options = Array.isArray(options)
            ? options.map(o => String(o || '').trim()).filter(Boolean)
            : [];
    }
    if (selectionType !== undefined) {
        payload.selectionType = selectionType === 'multiple' ? 'multiple' : 'single';
    }
    if (isActive !== undefined) payload.isActive = Boolean(isActive);
    if (sortOrder !== undefined) payload.sortOrder = Number(sortOrder) || 0;

    return payload;
};

// Get all booking terms
const getAllBookingTerms = async (req, res) => {
    try {
        const { isActive } = req.query;
        const filter = {};
        
        if (isActive !== undefined) {
            filter.isActive = isActive === 'true';
        }

        const terms = await BookingTerm.find(filter)
            .sort({ sortOrder: 1, createdAt: -1 });

        res.status(200).json(terms);
    } catch (error) {
        console.error('Error fetching booking terms:', error);
        res.status(500).json({ message: 'Failed to fetch booking terms', error: error.message });
    }
};

// Get single booking term by ID
const getBookingTermById = async (req, res) => {
    try {
        const term = await BookingTerm.findById(req.params.id);
        if (!term) {
            return res.status(404).json({ message: 'Booking term not found' });
        }
        res.status(200).json(term);
    } catch (error) {
        console.error('Error fetching booking term:', error);
        res.status(500).json({ message: 'Failed to fetch booking term', error: error.message });
    }
};

// Create new booking term
const createBookingTerm = async (req, res) => {
    try {
        const payload = sanitizePayload(req.body);

        if (!payload.title) {
            return res.status(400).json({ message: 'Title is required' });
        }

        if (!payload.options || payload.options.length === 0) {
            return res.status(400).json({ message: 'At least one option is required' });
        }

        const term = new BookingTerm(payload);
        await term.save();

        res.status(201).json({ message: 'Booking term created successfully', term });
    } catch (error) {
        console.error('Error creating booking term:', error);
        res.status(500).json({ message: 'Failed to create booking term', error: error.message });
    }
};

// Update booking term
const updateBookingTerm = async (req, res) => {
    try {
        const payload = sanitizePayload(req.body);

        const term = await BookingTerm.findByIdAndUpdate(
            req.params.id,
            payload,
            { new: true, runValidators: true }
        );

        if (!term) {
            return res.status(404).json({ message: 'Booking term not found' });
        }

        res.status(200).json({ message: 'Booking term updated successfully', term });
    } catch (error) {
        console.error('Error updating booking term:', error);
        res.status(500).json({ message: 'Failed to update booking term', error: error.message });
    }
};

// Delete booking term
const deleteBookingTerm = async (req, res) => {
    try {
        const term = await BookingTerm.findByIdAndDelete(req.params.id);

        if (!term) {
            return res.status(404).json({ message: 'Booking term not found' });
        }

        res.status(200).json({ message: 'Booking term deleted successfully' });
    } catch (error) {
        console.error('Error deleting booking term:', error);
        res.status(500).json({ message: 'Failed to delete booking term', error: error.message });
    }
};

module.exports = {
    getAllBookingTerms,
    getBookingTermById,
    createBookingTerm,
    updateBookingTerm,
    deleteBookingTerm
};
