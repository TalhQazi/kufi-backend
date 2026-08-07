const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const {
  getBlogs,
  getBlogById,
  getBlogImage,
  createBlog,
  updateBlog,
  deleteBlog,
} = require('../controllers/blogController');

// @route   GET api/blogs
// @desc    Get all blogs
// @access  Public
router.get('/', getBlogs);

// @route   GET api/blogs/:id/image
// @desc    Cover image as cacheable binary (declared before /:id so it is not shadowed)
// @access  Public
router.get('/:id/image', getBlogImage);

// @route   GET api/blogs/:id
// @desc    Get blog by ID
// @access  Public
router.get('/:id', getBlogById);

// @route   POST api/blogs
// @desc    Create a blog
// @access  Private (Admin)
router.post('/', auth(['admin']), createBlog);

// @route   PATCH api/blogs/:id
// @desc    Update blog
// @access  Private (Admin)
router.patch('/:id', auth(['admin']), updateBlog);

// @route   PUT api/blogs/:id
// @desc    Full update blog
// @access  Private (Admin)
router.put('/:id', auth(['admin']), updateBlog);

// @route   DELETE api/blogs/:id
// @desc    Delete blog
// @access  Private (Admin)
router.delete('/:id', auth(['admin']), deleteBlog);

module.exports = router;
