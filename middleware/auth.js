const jwt = require('jsonwebtoken');

module.exports = function (roles = []) {
    return function (req, res, next) {
        // Get token from header
        let token = req.header('x-auth-token') || req.header('Authorization');

        // Support Bearer token format
        if (token && token.startsWith('Bearer ')) {
            token = token.slice(7, token.length);
        }

        // Check if not token
        if (!token) {
            return res.status(401).json({ msg: 'No token, authorization denied' });
        }

        // Verify token
        try {
            const secret = process.env.JWT_SECRET || 'secret'; // Fallback for demo if not in .env
            const decoded = jwt.verify(token, secret);
            req.user = decoded.user;

            // Check Role
            if (roles.length > 0 && !roles.includes(req.user.role)) {
                return res.status(403).json({ msg: 'Access denied: Insufficient permissions' });
            }

            next();
        } catch (err) {
            res.status(401).json({ msg: 'Token is not valid' });
        }
    };
};
