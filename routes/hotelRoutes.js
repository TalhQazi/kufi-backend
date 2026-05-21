const express = require('express');
const router = express.Router();
const { getHotels, getAllHotels, getHotelById, createHotel, updateHotel, deleteHotel } = require('../controllers/hotelController');
const auth = require('../middleware/auth');

// Public/supplier: active hotels filtered by country+city
router.get('/', auth(), getHotels);

// Admin: all hotels with any status
router.get('/all', auth(['admin']), getAllHotels);

router.get('/:id', auth(), getHotelById);

router.post('/', auth(['admin', 'supplier']), createHotel);

router.put('/:id', auth(['admin', 'supplier']), updateHotel);

router.delete('/:id', auth(['admin']), deleteHotel);

module.exports = router;
