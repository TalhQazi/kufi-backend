const express = require('express');
const router = express.Router();
const {
    getUserItineraries,
    createItinerary,
    getItineraryById,
    generateItinerary,
    saveControlPanel,
    saveDays,
} = require('../controllers/itineraryController');
const auth = require('../middleware/auth');

router.get('/', auth(), getUserItineraries);
router.post('/', auth(), createItinerary);
router.get('/:id', auth(), getItineraryById);
router.post('/:id/generate', auth(), generateItinerary);
router.put('/:id/control-panel', auth(), saveControlPanel);
router.put('/:id/days', auth(), saveDays);

module.exports = router;
