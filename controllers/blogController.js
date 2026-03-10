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

// GET /api/blogs
exports.getBlogs = async (req, res) => {
  try {
    const blogs = await Blog.find().sort({ createdAt: -1 });
    res.json(blogs);
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
