const Review = require('../models/Review');

const sanitizeReviewPayload = (body) => {
  const next = { ...(body || {}) };

  if (Object.prototype.hasOwnProperty.call(next, 'type')) {
    const t = String(next.type || '').toLowerCase().trim();
    next.type = ['feedback', 'country'].includes(t) ? t : next.type;
  }

  if (Object.prototype.hasOwnProperty.call(next, 'name')) {
    next.name = String(next.name || '').trim();
  }

  if (Object.prototype.hasOwnProperty.call(next, 'role')) {
    const r = String(next.role || '').toLowerCase().trim();
    next.role = ['client', 'traveler'].includes(r) ? r : 'client';
  }

  if (Object.prototype.hasOwnProperty.call(next, 'note')) {
    next.note = String(next.note || '');
  }

  if (Object.prototype.hasOwnProperty.call(next, 'image')) {
    next.image = String(next.image || '').trim();
  }

  if (Object.prototype.hasOwnProperty.call(next, 'rating')) {
    const value = Number(next.rating);
    if (Number.isFinite(value)) next.rating = value;
  }

  if (Object.prototype.hasOwnProperty.call(next, 'country')) {
    next.country = String(next.country || '').trim();
  }

  if (Object.prototype.hasOwnProperty.call(next, 'isActive')) {
    next.isActive = Boolean(next.isActive);
  }

  if (Object.prototype.hasOwnProperty.call(next, 'sortOrder')) {
    const value = Number(next.sortOrder);
    if (Number.isFinite(value)) next.sortOrder = value;
  }

  return next;
};

exports.getReviews = async (req, res) => {
  try {
    const filter = {};

    const type = String(req.query?.type || '').toLowerCase().trim();
    if (type && ['feedback', 'country'].includes(type)) {
      filter.type = type;
    }

    const country = String(req.query?.country || '').trim();
    if (country) {
      filter.country = country;
    }

    const includeInactive = String(req.query?.includeInactive || '').toLowerCase().trim() === 'true';
    if (!includeInactive) {
      filter.isActive = true;
    }

    const reviews = await Review.find(filter)
      .sort({ sortOrder: 1, createdAt: -1 })
      .limit(20)
      .lean();
    res.json(reviews);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
};

exports.getReviewById = async (req, res) => {
  try {
    const review = await Review.findById(req.params.id).lean();
    if (!review) return res.status(404).json({ msg: 'Review not found' });
    res.json(review);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
};

exports.createReview = async (req, res) => {
  try {
    const safeBody = sanitizeReviewPayload(req.body);

    const t = String(safeBody.type || '').toLowerCase().trim();
    if (!['feedback', 'country'].includes(t)) {
      return res.status(400).json({ msg: 'Valid type is required' });
    }

    if (!safeBody.name) return res.status(400).json({ msg: 'Name is required' });
    if (!safeBody.note) return res.status(400).json({ msg: 'Review note is required' });

    const review = new Review({
      ...safeBody,
      type: t,
    });

    const saved = await review.save();
    res.status(201).json(saved);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
};

exports.updateReview = async (req, res) => {
  try {
    const safeBody = sanitizeReviewPayload(req.body);

    if (Object.prototype.hasOwnProperty.call(safeBody, 'type')) {
      delete safeBody.type;
    }

    const review = await Review.findByIdAndUpdate(
      req.params.id,
      { $set: safeBody },
      { new: true }
    );

    if (!review) return res.status(404).json({ msg: 'Review not found' });
    res.json(review);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
};

exports.deleteReview = async (req, res) => {
  try {
    const review = await Review.findByIdAndDelete(req.params.id);
    if (!review) return res.status(404).json({ msg: 'Review not found' });
    res.json({ msg: 'Review deleted' });
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
};
