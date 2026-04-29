const express = require('express');
const router = express.Router();
const { createCheckoutSession, handleWebhook, getPublicSettings } = require('../controllers/paymentController');
const auth = require('../middleware/auth');

router.get('/settings', getPublicSettings);
router.post('/create-checkout-session', auth(['user', 'admin', 'supplier']), createCheckoutSession);
router.post('/webhook', express.raw({ type: 'application/json' }), handleWebhook);


module.exports = router;
