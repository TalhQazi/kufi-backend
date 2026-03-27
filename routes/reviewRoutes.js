const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const {
  getReviews,
  getReviewById,
  createReview,
  updateReview,
  deleteReview,
} = require('../controllers/reviewController');

// Public
router.get('/', getReviews);
router.get('/:id', getReviewById);

// Admin
router.post('/', auth(['admin']), createReview);
router.patch('/:id', auth(['admin']), updateReview);
router.put('/:id', auth(['admin']), updateReview);
router.delete('/:id', auth(['admin']), deleteReview);

module.exports = router;
