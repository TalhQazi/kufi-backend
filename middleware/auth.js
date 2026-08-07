const jwt = require('jsonwebtoken');

/**
 * Authenticate the caller from the JWT and, optionally, require one of `roles`.
 *
 * The decoded payload is the ONLY source of caller identity — `req.user.id` and
 * `req.user.role` must never be taken from the request body or query. Controllers rely
 * on that: a supplier cannot act as another supplier because the id they are checked
 * against is the one inside their signed token.
 *
 * Tokens minted before the account's last password change are rejected, so changing a
 * password ends every other session.
 */
module.exports = function (roles = []) {
    return async function (req, res, next) {
        let token = req.header('x-auth-token') || req.header('Authorization');

        // Support Bearer token format
        if (token && token.startsWith('Bearer ')) {
            token = token.slice(7, token.length);
        }

        if (!token) {
            return res.status(401).json({ msg: 'No token, authorization denied' });
        }

        const secret = process.env.JWT_SECRET;
        if (!secret) {
            // Refuse to run on a default secret: it would make every token forgeable.
            console.error('JWT_SECRET is not configured — refusing to verify tokens.');
            return res.status(500).json({ msg: 'Server auth misconfiguration' });
        }

        let decoded;
        try {
            decoded = jwt.verify(token, secret);
        } catch (err) {
            return res.status(401).json({ msg: 'Token is not valid' });
        }

        req.user = decoded.user;
        if (!req.user?.id) {
            return res.status(401).json({ msg: 'Token is not valid' });
        }

        // Role check before the database round-trip.
        if (roles.length > 0 && !roles.includes(req.user.role)) {
            return res.status(403).json({ msg: 'Access denied: Insufficient permissions' });
        }

        try {
            const User = require('../models/User');
            const account = await User.findById(req.user.id)
                .select('role status passwordChangedAt')
                .lean();

            if (!account) {
                return res.status(401).json({ msg: 'Token is not valid' });
            }

            // A password change invalidates tokens issued before it.
            if (account.passwordChangedAt && decoded.iat) {
                const changedAtSeconds = Math.floor(new Date(account.passwordChangedAt).getTime() / 1000);
                // 1s of slack: `iat` is second-granular and can equal the change time.
                if (decoded.iat < changedAtSeconds - 1) {
                    return res.status(401).json({ msg: 'Session expired, please sign in again' });
                }
            }

            if (String(account.status || '').toLowerCase() === 'suspended') {
                return res.status(403).json({ msg: 'Account suspended' });
            }

            // Trust the stored role over the one embedded in the token, so a role change
            // takes effect immediately instead of at token expiry.
            req.user.role = account.role;
            if (roles.length > 0 && !roles.includes(req.user.role)) {
                return res.status(403).json({ msg: 'Access denied: Insufficient permissions' });
            }

            next();
        } catch (err) {
            console.error('Auth middleware error:', err.message);
            res.status(500).json({ msg: 'Server error' });
        }
    };
};
