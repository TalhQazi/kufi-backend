const jwt = require('jsonwebtoken');

/**
 * Populate `req.user` when a valid token is present, but never reject the request.
 *
 * Used by endpoints that must stay open to guests (a traveler can submit a trip request
 * without an account) while still binding the record to the signed-in user when there is
 * one — so identity comes from the token rather than from a client-supplied id.
 */
module.exports = function optionalAuth(req, res, next) {
    let token = req.header('x-auth-token') || req.header('Authorization');
    if (token && token.startsWith('Bearer ')) token = token.slice(7);

    if (!token || !process.env.JWT_SECRET) return next();

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        if (decoded?.user?.id) req.user = decoded.user;
    } catch {
        // An invalid or expired token is treated exactly like no token at all.
    }
    next();
};
