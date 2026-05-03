const Redis = require('ioredis');

let redis;

if (process.env.REDIS_URL || process.env.REDIS_HOST) {
    const redisOptions = process.env.REDIS_URL || {
        host: process.env.REDIS_HOST || '127.0.0.1',
        port: process.env.REDIS_PORT || 6379,
        password: process.env.REDIS_PASSWORD || undefined,
        retryStrategy(times) {
            // Only retry 3 times, then stop trying to connect to Redis
            if (times > 3) {
                console.log('Redis connection failed after 3 attempts. Falling back to in-memory cache.');
                return null; // Stop retrying
            }
            return Math.min(times * 100, 2000);
        },
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
    };

    redis = new Redis(redisOptions);

    redis.on('error', (err) => {
        // Only log serious errors, not connection refused if we are in fallback mode
        if (redis.status !== 'reconnecting' && err.code !== 'ECONNREFUSED') {
            console.error('Redis error:', err.message);
        }
    });

    redis.on('connect', () => {
        console.log('Connected to Redis');
    });
} else {
    console.log('Redis configuration not found. Using in-memory fallback.');
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
