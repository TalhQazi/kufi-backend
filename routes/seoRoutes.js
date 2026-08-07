/**
 * Dynamic sitemap + robots for the public site.
 *
 * The sitemap is generated from the database so newly published content becomes
 * discoverable automatically and deleted content disappears — no manual file to maintain.
 *
 * `SITE_URL` must point at the public website (not the API host); every URL in a sitemap
 * has to be on the same origin as the sitemap itself to be accepted.
 */
const express = require('express');
const router = express.Router();

const Activity = require('../models/Activity');
const Blog = require('../models/Blog');
const Country = require('../models/Country');
const Category = require('../models/Category');

const SITE_URL = String(process.env.SITE_URL || process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');

/** Static, always-present public sections. Mirrors src/utils/seoRoutes.js. */
const STATIC_ROUTES = [
    { path: '/', changefreq: 'daily', priority: '1.0' },
    { path: '/explore', changefreq: 'daily', priority: '0.9' },
    { path: '/destinations', changefreq: 'weekly', priority: '0.9' },
    { path: '/activities', changefreq: 'daily', priority: '0.9' },
    { path: '/blogs', changefreq: 'daily', priority: '0.8' },
    { path: '/about', changefreq: 'monthly', priority: '0.5' },
];

const escapeXml = (value) =>
    String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');

const toW3CDate = (value) => {
    const d = value ? new Date(value) : null;
    return d && !Number.isNaN(d.getTime()) ? d.toISOString().split('T')[0] : null;
};

function urlEntry({ loc, lastmod, changefreq, priority }) {
    return [
        '  <url>',
        `    <loc>${escapeXml(loc)}</loc>`,
        lastmod ? `    <lastmod>${lastmod}</lastmod>` : null,
        changefreq ? `    <changefreq>${changefreq}</changefreq>` : null,
        priority ? `    <priority>${priority}</priority>` : null,
        '  </url>',
    ].filter(Boolean).join('\n');
}

/**
 * Collect every public URL. Only published/approved records are included, so drafts and
 * rejected submissions never leak into the index.
 */
async function collectUrls() {
    const [activities, blogs, countries, categories] = await Promise.all([
        Activity.find({ status: 'approved' }).select('_id updatedAt createdAt').lean().maxTimeMS(10000),
        Blog.find().select('_id updatedAt createdAt').lean().maxTimeMS(10000),
        // Documents created before `status` existed have no value at all, and the schema
        // default only applies to new writes — so filtering on `status: 'active'` matched
        // nothing and every country page was missing from the sitemap. Exclude drafts
        // instead of requiring an explicit 'active'.
        Country.find({ status: { $ne: 'draft' } }).select('name status createdAt').lean().maxTimeMS(10000),
        Category.find({}).select('name createdAt').lean().maxTimeMS(10000).catch(() => []),
    ]);

    const urls = STATIC_ROUTES.map((r) => ({
        loc: `${SITE_URL}${r.path}`,
        changefreq: r.changefreq,
        priority: r.priority,
    }));

    activities.forEach((a) => urls.push({
        loc: `${SITE_URL}/activity/${a._id}`,
        lastmod: toW3CDate(a.updatedAt || a.createdAt),
        changefreq: 'weekly',
        priority: '0.8',
    }));

    blogs.forEach((b) => urls.push({
        loc: `${SITE_URL}/blog/${b._id}`,
        lastmod: toW3CDate(b.updatedAt || b.createdAt),
        changefreq: 'monthly',
        priority: '0.7',
    }));

    countries.forEach((c) => {
        if (!c?.name) return;
        urls.push({
            loc: `${SITE_URL}/destinations/${encodeURIComponent(c.name)}`,
            lastmod: toW3CDate(c.createdAt),
            changefreq: 'weekly',
            priority: '0.8',
        });
    });

    (categories || []).forEach((c) => {
        if (!c?.name) return;
        urls.push({
            loc: `${SITE_URL}/category/${encodeURIComponent(c.name)}`,
            lastmod: toW3CDate(c.createdAt),
            changefreq: 'weekly',
            priority: '0.6',
        });
    });

    // De-duplicate: a sitemap must not list the same URL twice.
    const seen = new Set();
    return urls.filter((u) => {
        if (seen.has(u.loc)) return false;
        seen.add(u.loc);
        return true;
    });
}

// @route   GET /sitemap.xml
// @access  Public
router.get('/sitemap.xml', async (req, res) => {
    try {
        const urls = await collectUrls();
        const xml = [
            '<?xml version="1.0" encoding="UTF-8"?>',
            '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
            ...urls.map(urlEntry),
            '</urlset>',
        ].join('\n');

        res.set({
            'Content-Type': 'application/xml; charset=utf-8',
            'Cache-Control': 'public, max-age=3600',
            'X-Robots-Tag': 'noindex',
        });
        res.send(xml);
    } catch (err) {
        console.error('sitemap error:', err.message);
        res.status(500).type('text/plain').send('Failed to build sitemap');
    }
});

// @route   GET /sitemap.json
// @desc    Same data as JSON, used by the frontend build to emit a static sitemap
// @access  Public
router.get('/sitemap.json', async (req, res) => {
    try {
        res.set('Cache-Control', 'public, max-age=3600');
        res.json({ siteUrl: SITE_URL, urls: await collectUrls() });
    } catch (err) {
        console.error('sitemap.json error:', err.message);
        res.status(500).json({ msg: 'Failed to build sitemap' });
    }
});

// @route   GET /robots.txt
// @desc    Robots policy for the API host. The website serves its own from /public.
// @access  Public
router.get('/robots.txt', (req, res) => {
    res.set({ 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600' });
    // The API host holds no indexable content, but the sitemap must stay reachable.
    res.send([
        'User-agent: *',
        'Disallow: /api/',
        'Disallow: /uploads/',
        'Allow: /sitemap.xml',
        '',
        `Sitemap: ${SITE_URL}/sitemap.xml`,
        '',
    ].join('\n'));
});

module.exports = router;
