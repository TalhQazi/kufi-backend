const jwt = require('jsonwebtoken');

module.exports = function (roles = []) {
    return function (req, res, next) {
        // Get token from header
        const token = req.header('x-auth-token');

        // Check if not token
        if (!token) {
            return res.status(401).json({ msg: 'No token, authorization denied' });
        }

        // Verify token
        try {
            /* 
               NOTE: In a real app we'd sign/verify JWTs. 
               For this quick mockup/demo without full JWT implementation in login yet, 
               we might assume the frontend sends a raw user ID or a mock token.
               
               However, to be "proper", let's assume standard JWT.
               If the previous `loginUser` didn't issue a token, we should fix that too.
               But for now, let's implement the standard check.
            */

            // Temporary: If token is just a userid (for simple testing without jwt setup)
            // we can simulate it. But let's stick to 'x-auth-token' convention.

            // DECODING (Mock or Real)
            // const decoded = jwt.verify(token, process.env.JWT_SECRET);
            // req.user = decoded.user;

            // MOCK IMPLEMENTATION FOR SIMPLICITY given current state:
            // We'll assume the token passed IS the user object (JSON) or just the role for now 
            // if we aren't doing full JWT signing in login yet.
            // Wait, `authController.js` just returns user data, it didn't sign a token.

            // Let's rely on a simple header 'x-user-role' for this demo 
            // OR update authController to actually sign tokens. 
            // Let's Update AuthController to sign tokens is better.

            // For now, I'll write standard JWT verification logic 
            // and I'll remember to update AuthController to sign it.

            const decoded = jwt.verify(token, process.env.JWT_SECRET);
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
