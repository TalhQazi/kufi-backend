const express = require('express');
const router = express.Router();
const GlobalSettings = require('../models/GlobalSettings');

// @route   GET api/config
// @desc    Get public configuration (GA ID, Stripe Public Key)
router.get('/', async (req, res) => {
    try {
        const settings = await GlobalSettings.findOne();
        if (!settings) {
            return res.json({
                stripePublicKey: '',
                googleAnalyticsId: ''
            });
        }
        res.json({
            stripePublicKey: settings.stripePublicKey,
            googleAnalyticsId: settings.googleAnalyticsId
        });
    } catch (err) {
        console.error('Error fetching public config:', err.message);
        res.status(500).send('Server Error');
    }
});

module.exports = router;
