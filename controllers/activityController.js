const mongoose = require('mongoose');
const Activity = require('../models/Activity');
const { clearCache } = require('../utils/cache');
const { resolveImageMime } = require('../utils/imageType');

const normalizeStringArray = (value) => {
    if (!Array.isArray(value)) return [];
    return value.map((v) => String(v || '').trim()).filter(Boolean);
};

const sanitizeActivityPayload = (body) => {
    const next = { ...(body || {}) };

    if (Object.prototype.hasOwnProperty.call(next, 'highlights')) {
        next.highlights = normalizeStringArray(next.highlights);
    }

    if (Object.prototype.hasOwnProperty.call(next, 'addOns') && Array.isArray(next.addOns)) {
        next.addOns = normalizeStringArray(next.addOns);
    }

    if (Object.prototype.hasOwnProperty.call(next, 'images')) {
        next.images = normalizeStringArray(next.images);
    }

    // Handle coordinates - ensure lat/lng are numbers or null
    if (Object.prototype.hasOwnProperty.call(next, 'coordinates')) {
        const coords = next.coordinates;
        if (coords && typeof coords === 'object') {
            next.coordinates = {
                lat: coords.lat !== undefined && coords.lat !== '' ? Number(coords.lat) : null,
                lng: coords.lng !== undefined && coords.lng !== '' ? Number(coords.lng) : null
            };
        }
    }

    if (Object.prototype.hasOwnProperty.call(next, 'order')) {
        const orderNum = Number(next.order);
        next.order = Number.isFinite(orderNum) ? orderNum : 0;
    }

    return next;
};

/**
 * Card fields only — everything a list/carousel needs, and nothing else.
 *
 * `image` is a base64 data URI averaging ~100KB (some over 4MB), so it is the single
 * biggest cost in this endpoint. Callers that only render a handful of cards should ask
 * for a `limit`; callers that do not need pictures at all can pass `fields=summary`.
 */
const LIST_EXCLUDED_FIELDS = '-images -description -addOns -coordinates';
const SUMMARY_FIELDS = '_id title location country price duration category rating reviews status order createdAt';

// Get all activities
exports.getActivities = async (req, res) => {
    try {
        const { country, city, category, status } = req.query;
        const filter = {};

        if (country) {
            // Support both string and ObjectId if needed, but here we assume string or handled by frontend
            filter.$or = [
                { country: country },
                { 'country.name': country },
                { location: new RegExp(country, 'i') }
            ];
        }

        if (city) {
            filter.$or = filter.$or || [];
            filter.$or.push({ location: new RegExp(city, 'i') });
        }

        if (category) {
            filter.category = category;
        }

        if (status) {
            filter.status = status;
        }

        // Exclude every heavy field from the list payload.
        // `image` and `images` are stored as base64 strings (some docs >5MB),
        // so streaming them from Atlas → backend → client made this endpoint
        // take 30+ seconds. The frontend list views render a placeholder
        // when image is null and load the full image only on the detail
        // endpoint (`GET /api/activities/:id`) when the user opens an item.
        const wantsSummary = String(req.query.fields || '').toLowerCase() === 'summary';
        const selectFields = wantsSummary ? SUMMARY_FIELDS : LIST_EXCLUDED_FIELDS;

        // Sorting is done in the database so `limit` returns the right rows. `order`
        // is a manual ranking where 0 means "unranked", so unranked items must sort
        // after ranked ones — hence the computed key rather than a plain sort on `order`.
        const pipeline = [
            { $match: filter },
            {
                $addFields: {
                    _rank: {
                        $cond: [{ $gt: [{ $ifNull: ['$order', 0] }, 0] }, '$order', Number.MAX_SAFE_INTEGER],
                    },
                },
            },
            { $sort: { _rank: 1, createdAt: -1, _id: -1 } },
        ];

        // Pagination. Callers that send no limit keep the previous behaviour (everything,
        // capped at 1000) so existing pages are unaffected.
        const limitRaw = parseInt(req.query.limit, 10);
        const pageRaw = parseInt(req.query.page, 10);
        const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 1000) : 1000;
        const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
        if (page > 1) pipeline.push({ $skip: (page - 1) * limit });
        pipeline.push({ $limit: limit });

        // Inclusion and exclusion cannot be mixed in one $project, so `_rank` is only
        // named in the exclusion form — the inclusion form drops it by omission.
        const projection = wantsSummary
            ? SUMMARY_FIELDS.split(' ').reduce((acc, f) => ({ ...acc, [f]: 1 }), {})
            : { images: 0, description: 0, addOns: 0, coordinates: 0, _rank: 0 };
        pipeline.push({ $project: projection });

        const activities = await Activity.aggregate(pipeline).option({ maxTimeMS: 10000 });

        res.json(activities);
    } catch (err) {
        console.error('Error fetching activities:', err.message);
        if (res.headersSent) return;
        res.status(500).json({ message: 'Error fetching activities', error: err.message });
    }
};

/**
 * GET /api/activities/:id/image
 *
 * Serves the stored cover image as real binary instead of a base64 blob.
 *
 * Activity images average ~136KB as base64 and some exceed 4MB. Embedding them in
 * itinerary documents made a single itinerary average 852KB (largest: 7.1MB for 13
 * activities). Generated itineraries now store this URL instead, so the bytes are
 * fetched once per image and cached by the browser rather than duplicated into every
 * itinerary that uses the activity.
 */
exports.getActivityImage = async (req, res) => {
    try {
        if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(404).end();

        const activity = await Activity.findById(req.params.id).select('image updatedAt').lean();
        if (!activity?.image) return res.status(404).end();

        const raw = String(activity.image).trim();
        const match = /^data:([^;,]+);base64,(.*)$/s.exec(raw);

        // Images stored as a plain URL are simply redirected to.
        if (!match) {
            if (/^https?:\/\//i.test(raw) || raw.startsWith('/')) return res.redirect(302, raw);
            return res.status(404).end();
        }

        const [, declaredType, base64] = match;
        const buffer = Buffer.from(base64, 'base64');
        // Most uploads recorded 'application/octet-stream'; the bytes are authoritative.
        const contentType = resolveImageMime(buffer, declaredType);
        const etag = `W/"${activity._id}-${new Date(activity.updatedAt || 0).getTime()}"`;

        if (req.headers['if-none-match'] === etag) return res.status(304).end();

        res.set({
            'Content-Type': contentType,
            'Content-Length': String(buffer.length),
            'Cache-Control': 'public, max-age=86400, stale-while-revalidate=604800',
            ETag: etag,
        });
        res.end(buffer);
    } catch (err) {
        console.error('getActivityImage error:', err.message);
        if (err.kind === 'ObjectId') return res.status(404).end();
        res.status(500).end();
    }
};

/**
 * Bulk-set display order.
 *
 * The admin list lets an activity be nudged up or down, which renumbers the whole
 * sequence. Doing that one PUT per row would be ~128 requests and could leave the
 * ordering half-applied, so the reordered set is written in a single bulk operation.
 *
 * Body: { items: [{ id, order }, ...] }
 */
exports.reorderActivities = async (req, res) => {
    try {
        const items = Array.isArray(req.body?.items) ? req.body.items : null;
        if (!items || items.length === 0) {
            return res.status(400).json({ msg: 'items must be a non-empty array of { id, order }' });
        }
        if (items.length > 2000) {
            return res.status(400).json({ msg: 'Too many items in one reorder request' });
        }

        const operations = [];
        for (const entry of items) {
            const id = entry?.id ?? entry?._id;
            const order = Number(entry?.order);
            if (!mongoose.Types.ObjectId.isValid(id)) {
                return res.status(400).json({ msg: `Invalid activity id: ${id}` });
            }
            if (!Number.isFinite(order) || order < 0) {
                return res.status(400).json({ msg: `Invalid order for ${id}` });
            }
            operations.push({
                updateOne: { filter: { _id: new mongoose.Types.ObjectId(id) }, update: { $set: { order } } },
            });
        }

        const result = await Activity.bulkWrite(operations, { ordered: false });
        await clearCache('cache:/api/activities*');

        res.json({
            msg: 'Order updated',
            matched: result.matchedCount ?? 0,
            modified: result.modifiedCount ?? 0,
        });
    } catch (err) {
        console.error('reorderActivities error:', err.message);
        res.status(500).send('Server Error');
    }
};

// Update activity (e.g. status)
exports.updateActivity = async (req, res) => {
    try {
        const safeBody = sanitizeActivityPayload(req.body);
        const activity = await Activity.findByIdAndUpdate(
            req.params.id,
            { $set: safeBody },
            { new: true }
        );

        if (!activity) {
            return res.status(404).json({ msg: 'Activity not found' });
        }

        // Clear cache
        await clearCache('cache:/api/activities*');

        res.json(activity);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
};

// Delete activity
exports.deleteActivity = async (req, res) => {
    try {
        const activity = await Activity.findByIdAndDelete(req.params.id);

        if (!activity) {
            return res.status(404).json({ msg: 'Activity not found' });
        }

        // Clear cache
        await clearCache('cache:/api/activities*');

        res.json({ msg: 'Activity deleted' });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
};

// Get single activity
exports.getActivityById = async (req, res) => {
    try {
        const activity = await Activity.findById(req.params.id).lean();
        if (!activity) {
            return res.status(404).json({ msg: 'Activity not found' });
        }
        res.json(activity);
    } catch (err) {
        console.error(err.message);
        if (err.kind === 'ObjectId') {
            return res.status(404).json({ msg: 'Activity not found' });
        }
        res.status(500).send('Server Error');
    }
};

// Create activity (Admin)
exports.createActivity = async (req, res) => {
    try {
        const safeBody = sanitizeActivityPayload(req.body);
        const newActivity = new Activity(safeBody);
        const activity = await newActivity.save();
        
        // Clear cache
        await clearCache('cache:/api/activities*');

        res.json(activity);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
};

// Seed activities
exports.seedActivities = async (req, res) => {
    try {
        await Activity.deleteMany(); // Clear existing
        const activities = req.body; // Expecting array of activities
        const createdActivities = await Activity.insertMany(activities);
        res.json(createdActivities);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
};
