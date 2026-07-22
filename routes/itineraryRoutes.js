const express = require('express');
const router = express.Router();
const {
    getUserItineraries,
    getAllItinerariesAdmin,
    createItinerary,
    getItineraryById,
    getItineraryByBookingId,
    generateItinerary,
    saveControlPanel,
    saveDays,
    submitItinerary,
    clearActivities,
} = require('../controllers/itineraryController');
const auth = require('../middleware/auth');

router.get('/', auth(), getUserItineraries);
router.get('/admin/all', auth(['admin']), getAllItinerariesAdmin);
router.post('/', auth(), createItinerary);
router.get('/booking/:bookingId', auth(), getItineraryByBookingId);
router.get('/:id', auth(), getItineraryById);
router.post('/:id/generate', auth(), generateItinerary);
router.put('/:id/control-panel', auth(), saveControlPanel);
router.put('/:id/days', auth(), saveDays);
router.post('/:id/submit', auth(), submitItinerary);
router.post('/:id/clear-activities', auth(['admin']), clearActivities);

module.exports = router;
