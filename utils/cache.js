const Redis = require('ioredis');

let redis;

if (process.env.REDIS_URL || process.env.REDIS_HOST) {
    redis = new Redis(process.env.REDIS_URL || {
        host: process.env.REDIS_HOST || '127.0.0.1',
        port: process.env.REDIS_PORT || 6379,
        password: process.env.REDIS_PASSWORD || undefined,
    });

    redis.on('error', (err) => {
        console.error('Redis connection error:', err);
    });

    redis.on('connect', () => {
        console.log('Connected to Redis');
    });
} else {
    console.log('Redis configuration not found. Caching will be disabled or use in-memory fallback.');
}

// Simple in-memory fallback if Redis is not available
const memoryCache = new Map();

const setCache = async (key, value, ttlSeconds = 3600) => {
    if (redis && redis.status === 'ready') {
        try {
            await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
        } catch (err) {
            console.error('Redis set error:', err);
        }
    } else {
        memoryCache.set(key, {
            value,
            expiry: Date.now() + (ttlSeconds * 1000)
        });
    }
};

const getCache = async (key) => {
    if (redis && redis.status === 'ready') {
        try {
            const data = await redis.get(key);
            return data ? JSON.parse(data) : null;
        } catch (err) {
            console.error('Redis get error:', err);
            return null;
        }
    } else {
        const cached = memoryCache.get(key);
        if (cached) {
            if (Date.now() < cached.expiry) {
                return cached.value;
            } else {
                memoryCache.delete(key);
            }
        }
        return null;
    }
};

const clearCache = async (pattern) => {
    if (redis && redis.status === 'ready') {
        try {
            const keys = await redis.keys(pattern);
            if (keys.length > 0) {
                await redis.del(keys);
            }
        } catch (err) {
            console.error('Redis clear error:', err);
        }
    } else {
        // Clear all memory cache for simplicity or match pattern
        memoryCache.clear();
    }
};

module.exports = {
    setCache,
    getCache,
    clearCache,
    redis
};
