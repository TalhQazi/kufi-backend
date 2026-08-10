const Notification = require('../models/Notification');
const User = require('../models/User');
const { sendEmail } = require('./emailService');
const { sendPushNotification } = require('./pushService');

/**
 * Create an in-app notification and optionally email the user.
 * @param {Object} options
 * @param {string|ObjectId} options.userId
 * @param {string} options.type
 * @param {string} options.title
 * @param {string} options.message
 * @param {string|ObjectId} [options.bookingId]
 * @param {string|ObjectId} [options.itineraryId]
 * @param {boolean} [options.sendEmailNotify=false]
 * @param {string} [options.emailTo]
 * @param {string} [options.emailSubject]
 * @param {string} [options.emailHtml]
 * @param {string} [options.templateKey]
 */
async function createNotification({
    userId,
    type,
    title,
    message,
    bookingId = null,
    itineraryId = null,
    sendEmailNotify = false,
    emailTo,
    emailSubject,
    emailHtml,
    templateKey,
} = {}) {
    if (!userId || !type || !title) {
        console.warn('createNotification: missing required fields', { userId, type, title });
        return null;
    }

    try {
        const notification = await Notification.create({
            userId,
            type,
            title,
            message: message || title,
            bookingId: bookingId || null,
            itineraryId: itineraryId || null,
            read: false,
            createdAt: new Date(),
        });

        // Push mirrors every in-app notification. No-ops when push is not configured or
        // the user has no registered device token; never blocks notification creation.
        try {
            await sendPushNotification({
                userId,
                title,
                body: message || title,
                data: {
                    type,
                    bookingId: bookingId ? String(bookingId) : null,
                    itineraryId: itineraryId ? String(itineraryId) : null,
                },
            });
        } catch (pushErr) {
            console.error('createNotification push error:', pushErr?.message || pushErr);
        }

        if (sendEmailNotify) {
            try {
                let to = emailTo;
                if (!to) {
                    const user = await User.findById(userId).select('email').lean();
                    to = user?.email;
                }
                if (to) {
                    await sendEmail({
                        to,
                        subject: emailSubject || title,
                        html: emailHtml || `<p>${message || title}</p>`,
                        templateKey: templateKey || 'itineraryReply',
                    });
                }
            } catch (emailErr) {
                console.error('createNotification email error:', emailErr?.message || emailErr);
            }
        }

        return notification;
    } catch (err) {
        console.error('createNotification error:', err?.message || err);
        return null;
    }
}

const NOTIFICATION_PRESETS = {
    request_received: {
        type: 'request_received',
        title: 'Request Received',
        message: 'We received your trip request and will assign a supplier shortly.',
    },
    under_review: {
        type: 'under_review',
        title: 'Under Review',
        message: 'Your trip request is under review by your travel partner.',
    },
    itinerary_generated: {
        type: 'itinerary_generated',
        title: 'Itinerary Generated',
        message: 'Your personalized itinerary is ready to view.',
    },
    itinerary_updated: {
        type: 'itinerary_updated',
        title: 'Itinerary Updated',
        message: 'Your itinerary has been updated by your travel partner.',
    },
    approved: {
        type: 'approved',
        title: 'Approved',
        message: 'Your itinerary has been approved.',
    },
    accepted: {
        type: 'accepted',
        title: 'Accepted',
        message: 'Your trip request has been accepted.',
    },
    rejected: {
        type: 'rejected',
        title: 'Rejected',
        message: 'Your trip request was rejected.',
    },
    cancelled: {
        type: 'cancelled',
        title: 'Cancelled',
        message: 'Your trip request has been cancelled.',
    },
    // Addressed to the SUPPLIER, not the traveller: the traveller has asked for a change
    // to an itinerary that was already sent, and the supplier has to act on it. Without
    // this the adjustment sat silently on the booking and was only discovered by chance.
    adjustment_requested: {
        type: 'adjustment_requested',
        title: 'Adjustment Requested',
        message: 'A traveller has requested an adjustment to their itinerary.',
    },
    // Confirmation back to the traveller, so they can see the request was actually sent.
    adjustment_sent: {
        type: 'adjustment_sent',
        title: 'Adjustment Request Sent',
        message: 'Your adjustment request has been sent to your travel partner.',
    },
};

async function notifyPreset(presetKey, { userId, bookingId, itineraryId, message, destination, sendEmailNotify = true, emailTo } = {}) {
    const preset = NOTIFICATION_PRESETS[presetKey];
    if (!preset || !userId) return null;

    const destSuffix = destination ? ` (${destination})` : '';
    return createNotification({
        userId,
        type: preset.type,
        title: preset.title,
        message: message || `${preset.message}${destSuffix}`,
        bookingId,
        itineraryId,
        sendEmailNotify,
        emailTo,
        emailSubject: `${preset.title}${destSuffix}`,
        emailHtml: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e1e1e1; border-radius: 10px;"><h2 style="color: #a26e35;">${preset.title}</h2><p>${message || preset.message}${destSuffix ? ` — <strong>${destination}</strong>` : ''}</p><p style="margin-top: 20px; font-size: 12px; color: #777;">Thank you for choosing Kufi Travel.</p></div>`,
    });
}

module.exports = {
    createNotification,
    notifyPreset,
    NOTIFICATION_PRESETS,
};
