const { getCache, setCache } = require('../utils/cache');

const cacheMiddleware = (ttlSeconds = 3600) => {
    return async (req, res, next) => {
        // Only cache GET requests
        if (req.method !== 'GET') {
            return next();
        }

        const key = `cache:${req.originalUrl || req.url}`;
        
        try {
            // Add a timeout to cache lookup to prevent hanging the whole request
            const cachePromise = getCache(key);
            const timeoutPromise = new Promise((resolve) => setTimeout(() => resolve(null), 200)); // 200ms timeout
            
            const cachedData = await Promise.race([cachePromise, timeoutPromise]);
            
            if (cachedData) {
                res.setHeader('X-Cache', 'HIT');
                return res.json(cachedData);
            }

            // If not cached, override res.json to cache the response
            const originalJson = res.json;
            res.json = function (data) {
                if (res.headersSent) return this;
                
                // Set cache in background without awaiting
                setCache(key, data, ttlSeconds).catch(err => console.error('Background cache set error:', err));
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
