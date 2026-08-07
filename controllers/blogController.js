const Blog = require('../models/Blog');

const sanitizeBlogPayload = (body) => {
  const next = { ...(body || {}) };
  if (Object.prototype.hasOwnProperty.call(next, 'title')) {
    next.title = String(next.title || '').trim();
  }
  if (Object.prototype.hasOwnProperty.call(next, 'category')) {
    next.category = String(next.category || '').trim();
  }
  if (Object.prototype.hasOwnProperty.call(next, 'description')) {
    next.description = String(next.description || '');
  }
  if (Object.prototype.hasOwnProperty.call(next, 'image')) {
    next.image = String(next.image || '').trim();
  }
  return next;
};

/** Plain-text preview built from the stored HTML, so the list never ships full articles. */
const buildExcerpt = (html, length = 180) => {
  const text = String(html || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > length ? `${text.slice(0, length).trimEnd()}…` : text;
};

// GET /api/blogs
exports.getBlogs = async (req, res) => {
  try {
    // The listing needs a card, not a whole article. `description` holds the full post
    // body and is excluded here in favour of a short excerpt computed server-side.
    // `image` is a base64 data URI (~190KB per post) and dominates the payload, so it is
    // opt-in via ?fields=full for callers that genuinely need it.
    const wantsFull = String(req.query.fields || '').toLowerCase() === 'full';

    const limitRaw = parseInt(req.query.limit, 10);
    const pageRaw = parseInt(req.query.page, 10);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 50) : 50;
    const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;

    const query = wantsFull
      ? Blog.find().sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean()
      // Truncate the body inside MongoDB: the full article never crosses the wire, and
      // 600 characters of HTML is always enough to render a ~180 character preview.
      : Blog.aggregate([
        { $sort: { createdAt: -1 } },
        { $skip: (page - 1) * limit },
        { $limit: limit },
        {
          $project: {
            title: 1, category: 1, createdAt: 1, updatedAt: 1, author: 1,
            descriptionPreview: { $substrCP: [{ $ifNull: ['$description', ''] }, 0, 600] },
            // Images are stored as base64 data URIs averaging ~190KB. Inlining them made
            // the listing a ~1MB blocking JSON download. Send a URL instead: the browser
            // fetches them lazily, in parallel, and caches them across navigations.
            // `imageUrl` is only emitted when an image actually exists.
            hasImage: {
              $gt: [{ $strLenCP: { $ifNull: ['$image', ''] } }, 0],
            },
          },
        },
      ]).option({ maxTimeMS: 10000 });

    const [blogs, total] = await Promise.all([query, Blog.estimatedDocumentCount()]);

    const payload = blogs.map((b) => {
      if (wantsFull) return b;
      const { descriptionPreview, hasImage, ...rest } = b;
      return {
        ...rest,
        excerpt: buildExcerpt(descriptionPreview),
        imageUrl: hasImage ? `/api/blogs/${b._id}/image` : null,
      };
    });

    res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
    res.json(req.query.page || req.query.limit ? { blogs: payload, total, page, limit } : payload);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
};

// GET /api/blogs/:id
exports.getBlogById = async (req, res) => {
  try {
    const blog = await Blog.findById(req.params.id);
    if (!blog) return res.status(404).json({ msg: 'Blog not found' });
    res.json(blog);
  } catch (err) {
    console.error(err.message);
    if (err.kind === 'ObjectId') return res.status(404).json({ msg: 'Blog not found' });
    res.status(500).send('Server Error');
  }
};

/**
 * GET /api/blogs/:id/image
 *
 * Serves the stored cover image as real binary rather than a base64 blob inside JSON.
 * Two thirds of the bytes come back (base64 costs ~33% overhead), the browser can cache
 * it, and lazy-loaded cards below the fold may never request it at all.
 */
exports.getBlogImage = async (req, res) => {
  try {
    const blog = await Blog.findById(req.params.id).select('image updatedAt').lean();
    if (!blog?.image) return res.status(404).end();

    const match = /^data:([^;,]+);base64,(.*)$/s.exec(String(blog.image).trim());

    // Images uploaded as a plain URL are just redirected to.
    if (!match) {
      const raw = String(blog.image).trim();
      if (/^https?:\/\//i.test(raw) || raw.startsWith('/')) return res.redirect(302, raw);
      return res.status(404).end();
    }

    const [, contentType, base64] = match;
    const buffer = Buffer.from(base64, 'base64');
    // Content is immutable for a given blog version; ETag lets the browser revalidate
    // with a 304 instead of re-downloading.
    const etag = `W/"${blog._id}-${new Date(blog.updatedAt || 0).getTime()}"`;

    if (req.headers['if-none-match'] === etag) return res.status(304).end();

    res.set({
      'Content-Type': contentType,
      'Content-Length': String(buffer.length),
      'Cache-Control': 'public, max-age=86400, stale-while-revalidate=604800',
      ETag: etag,
    });
    res.end(buffer);
  } catch (err) {
    console.error('getBlogImage error:', err.message);
    if (err.kind === 'ObjectId') return res.status(404).end();
    res.status(500).end();
  }
};

// POST /api/blogs (Admin)
exports.createBlog = async (req, res) => {
  try {
    const safeBody = sanitizeBlogPayload(req.body);
    if (!safeBody.title) return res.status(400).json({ msg: 'Title is required' });
    const newBlog = new Blog(safeBody);
    const blog = await newBlog.save();
    res.json(blog);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
};

// PATCH/PUT /api/blogs/:id (Admin)
exports.updateBlog = async (req, res) => {
  try {
    const safeBody = sanitizeBlogPayload(req.body);
    const blog = await Blog.findByIdAndUpdate(
      req.params.id,
      { $set: safeBody },
      { new: true }
    );

    if (!blog) return res.status(404).json({ msg: 'Blog not found' });
    res.json(blog);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
};

// DELETE /api/blogs/:id (Admin)
exports.deleteBlog = async (req, res) => {
  try {
    const blog = await Blog.findByIdAndDelete(req.params.id);
    if (!blog) return res.status(404).json({ msg: 'Blog not found' });
    res.json({ msg: 'Blog deleted' });
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
};
