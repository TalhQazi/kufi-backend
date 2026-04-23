const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const Booking = require('../models/Booking');
const GlobalSettings = require('../models/GlobalSettings');

exports.createCheckoutSession = async (req, res) => {
    try {
        const { bookingId } = req.body;
        const booking = await Booking.findById(bookingId).populate('items.activity');

        if (!booking) {
            return res.status(404).json({ message: 'Booking not found' });
        }

        // Get commission settings
        let settings = await GlobalSettings.findOne();
        if (!settings) {
            settings = { commissionPercentage: 10 };
        }

        // Get total amount
        let totalAmount = booking.totalAmount || 0;
        
        if (totalAmount <= 0) {
            // Fallback: Parse total amount from budget (handle currency symbols etc)
            const rawBudget = booking.tripDetails?.budget || '0';
            // Simple parsing: take the first number found (e.g. "1000-3000" -> 1000)
            const matches = rawBudget.match(/\d+/);
            totalAmount = matches ? parseFloat(matches[0]) : 0;
        }

        if (totalAmount <= 0) {
            return res.status(400).json({ message: 'Invalid booking amount' });
        }

        const commissionPercentage = settings.commissionPercentage;
        const commissionAmount = (totalAmount * commissionPercentage) / 100;
        const netAmount = totalAmount - commissionAmount;

        // Update booking with calculated amounts
        booking.totalAmount = totalAmount;
        booking.commissionAmount = commissionAmount;
        booking.netAmount = netAmount;
        await booking.save();

        // Create Stripe checkout session
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [
                {
                    price_data: {
                        currency: 'usd', // Adjust currency as needed
                        product_data: {
                            name: `Booking for ${booking.tripDetails?.country || 'Trip'}`,
                            description: `${booking.items.length} Activities`,
                        },
                        unit_amount: Math.round(totalAmount * 100), // Stripe expects cents
                    },
                    quantity: 1,
                },
            ],
            mode: 'payment',
            success_url: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/#/payment-success?session_id={CHECKOUT_SESSION_ID}&booking_id=${booking._id}`,
            cancel_url: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/#/payment-failed`,
            metadata: {
                bookingId: String(booking._id),
            },
        });

        booking.stripeSessionId = session.id;
        await booking.save();

        res.json({ id: session.id, url: session.url });
    } catch (err) {
        console.error('Error creating checkout session:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

exports.handleWebhook = async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
        event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const bookingId = session.metadata.bookingId;

        await Booking.findByIdAndUpdate(bookingId, {
            paymentStatus: 'paid',
            status: 'confirmed'
        });
    }

    res.json({ received: true });
};
