const express = require('express');
const router = express.Router();
const Newsletter = require('../models/Newsletter');
const auth = require('../middleware/auth');

// @route   POST api/newsletter/subscribe
// @desc    Subscribe to newsletter
// @access  Public
router.post('/subscribe', async (req, res) => {
    const { email } = req.body;

    if (!email) {
        return res.status(400).json({ msg: 'Email is required' });
    }

    try {
        let subscriber = await Newsletter.findOne({ email });
        if (subscriber) {
            return res.status(400).json({ msg: 'You are already a member!' });
        }

        subscriber = new Newsletter({ email });
        await subscriber.save();

        res.status(201).json({ msg: 'Successfully joined! Welcome to Kufi Travel.', subscriber });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET api/newsletter/requests
// @desc    Get all membership requests
// @access  Private (Admin)
router.get('/requests', auth(), async (req, res) => {
    try {
        const requests = await Newsletter.find().sort({ createdAt: -1 });
        res.json(requests);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   DELETE api/newsletter/:id
// @desc    Delete a request
// @access  Private (Admin)
router.delete('/:id', auth(), async (req, res) => {
    try {
        await Newsletter.findByIdAndDelete(req.params.id);
        res.json({ msg: 'Request removed' });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

module.exports = router;
