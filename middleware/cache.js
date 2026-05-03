const { getCache, setCache } = require('../utils/cache');

const cacheMiddleware = (ttlSeconds = 3600) => {
    return async (req, res, next) => {
        // Only cache GET requests
        if (req.method !== 'GET') {
            return next();
        }

        const key = `cache:${req.originalUrl || req.url}`;
        
        try {
            const cachedData = await getCache(key);
            if (cachedData) {
                // Set a header to indicate cache hit
                res.setHeader('X-Cache', 'HIT');
                return res.json(cachedData);
            }

            // If not cached, override res.json to cache the response before sending
            const originalJson = res.json;
            res.json = function (data) {
                setCache(key, data, ttlSeconds);
                res.setHeader('X-Cache', 'MISS');
                return originalJson.call(this, data);
            };

            next();
        } catch (err) {
            console.error('Cache middleware error:', err);
            next();
        }
    };
};

module.exports = cacheMiddleware;
