const express = require('express');
const router = express.Router();
const {
    getAllBookingTerms,
    getBookingTermById,
    createBookingTerm,
    updateBookingTerm,
    deleteBookingTerm
} = require('../controllers/bookingTermController');
const auth = require('../middleware/auth');

// Public routes
router.get('/', getAllBookingTerms);
router.get('/:id', getBookingTermById);

// Admin protected routes
router.post('/', auth(['admin']), createBookingTerm);
router.put('/:id', auth(['admin']), updateBookingTerm);
router.patch('/:id', auth(['admin']), updateBookingTerm);
router.delete('/:id', auth(['admin']), deleteBookingTerm);

module.exports = router;
