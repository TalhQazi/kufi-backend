const User = require('../models/User');

/**
 * Push delivery for in-app notifications.
 *
 * This is the dispatch point only. It reads whatever push subscriptions are stored on
 * the user document and delivers to them. It is a deliberate no-op when:
 *   - the `web-push` package is not installed, or
 *   - VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY are not configured, or
 *   - the traveler has no registered device token.
 *
 * NOTE: nothing currently writes push subscriptions onto users — there is no device
 * registration endpoint and no service worker in the client. Until those exist this
 * always short-circuits at `no registered device token`, which is why travelers get the
 * email and the in-app notification but never a push.
 */

let webpush = null;
let configured = false;
let warned = false;

try {
    // Optional dependency: absent in the current install, present once push is enabled.
    // eslint-disable-next-line global-require, import/no-extraneous-dependencies
    webpush = require('web-push');
} catch {
    webpush = null;
}

if (webpush && process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    try {
        webpush.setVapidDetails(
            process.env.VAPID_SUBJECT || 'mailto:support@kufitravel.com',
            process.env.VAPID_PUBLIC_KEY,
            process.env.VAPID_PRIVATE_KEY
        );
        configured = true;
    } catch (err) {
        console.error('pushService: failed to configure VAPID details:', err?.message || err);
    }
}

function readSubscriptions(user) {
    const raw = user?.pushSubscriptions || user?.deviceTokens || user?.pushTokens;
    if (!raw) return [];
    return (Array.isArray(raw) ? raw : [raw]).filter(Boolean);
}

/**
 * Deliver a push notification to every device the traveler has registered.
 * Never throws — notification creation must not fail because push delivery did.
 *
 * @returns {Promise<{sent:number, skipped?:string}>}
 */
async function sendPushNotification({ userId, title, body, data = {} } = {}) {
    if (!userId || !title) return { sent: 0, skipped: 'missing userId/title' };

    if (!configured) {
        if (!warned) {
            warned = true;
            console.warn(
                'pushService: push delivery disabled — %s. In-app notifications and email are unaffected.',
                !webpush ? 'the `web-push` package is not installed' : 'VAPID keys are not configured'
            );
        }
        return { sent: 0, skipped: 'push not configured' };
    }

    let subscriptions = [];
    try {
        const user = await User.findById(userId)
            .select('pushSubscriptions deviceTokens pushTokens')
            .lean();
        subscriptions = readSubscriptions(user);
    } catch (err) {
        console.error('pushService: could not load subscriptions:', err?.message || err);
        return { sent: 0, skipped: 'lookup failed' };
    }

    if (subscriptions.length === 0) return { sent: 0, skipped: 'no registered device token' };

    const payload = JSON.stringify({ title, body: body || title, data });
    let sent = 0;

    await Promise.all(
        subscriptions.map(async (subscription) => {
            try {
                await webpush.sendNotification(subscription, payload);
                sent += 1;
            } catch (err) {
                // 404/410 mean the subscription is dead; anything else is transient.
                const statusCode = err?.statusCode;
                if (statusCode !== 404 && statusCode !== 410) {
                    console.error('pushService: send failed:', err?.message || err);
                }
            }
        })
    );

    return { sent };
}

module.exports = { sendPushNotification };
