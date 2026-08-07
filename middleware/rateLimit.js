/**
 * Lightweight fixed-window rate limiter for credential endpoints.
 *
 * Deliberately in-process: the app already falls back to an in-memory cache when Redis
 * is unavailable, and a per-instance limit is far better than none. It exists to blunt
 * password guessing and reset-email flooding, not to be a global quota system.
 *
 * Crawlers are unaffected — this is only mounted on auth routes, never on public content.
 */

const WINDOW_MS = Number(process.env.AUTH_RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000;
const MAX_ATTEMPTS = Number(process.env.AUTH_RATE_LIMIT_MAX) || 10;

/** key -> { count, resetAt } */
const buckets = new Map();

// Bound memory: drop expired buckets periodically rather than on every request.
const SWEEP_MS = 60 * 1000;
const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
        if (bucket.resetAt <= now) buckets.delete(key);
    }
}, SWEEP_MS);
if (typeof sweeper.unref === 'function') sweeper.unref();

/** Client identity: proxy-aware IP, plus the submitted email when there is one. */
function defaultKey(req) {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    const ip = forwarded || req.ip || req.socket?.remoteAddress || 'unknown';
    const email = String(req.body?.email || '').trim().toLowerCase();
    return email ? `${ip}|${email}` : ip;
}

/**
 * @param {{ max?: number, windowMs?: number, keyGenerator?: Function, scope?: string }} options
 */
function rateLimit(options = {}) {
    const max = options.max || MAX_ATTEMPTS;
    const windowMs = options.windowMs || WINDOW_MS;
    const keyGenerator = options.keyGenerator || defaultKey;
    const scope = options.scope || 'default';

    return function rateLimiter(req, res, next) {
        const key = `${scope}:${keyGenerator(req)}`;
        const now = Date.now();
        let bucket = buckets.get(key);

        if (!bucket || bucket.resetAt <= now) {
            bucket = { count: 0, resetAt: now + windowMs };
            buckets.set(key, bucket);
        }

        bucket.count += 1;

        const remaining = Math.max(0, max - bucket.count);
        res.setHeader('X-RateLimit-Limit', String(max));
        res.setHeader('X-RateLimit-Remaining', String(remaining));
        res.setHeader('X-RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)));

        if (bucket.count > max) {
            const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
            res.setHeader('Retry-After', String(retryAfter));
            return res.status(429).json({
                msg: `Too many attempts. Please try again in ${Math.ceil(retryAfter / 60)} minute(s).`,
            });
        }

        next();
    };
}

/** Drop a client's counter after a legitimate success, so honest users are not punished. */
rateLimit.reset = function resetBucket(req, scope = 'default') {
    buckets.delete(`${scope}:${defaultKey(req)}`);
};

rateLimit._buckets = buckets;

module.exports = rateLimit;
