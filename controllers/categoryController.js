const Category = require('../models/Category');

const sanitizeCategoryPayload = (body) => {
    const next = { ...(body || {}) };

    if (Object.prototype.hasOwnProperty.call(next, 'name')) {
        next.name = String(next.name || '').trim();
    }
    if (Object.prototype.hasOwnProperty.call(next, 'description')) {
        next.description = String(next.description || '').trim();
    }
    if (Object.prototype.hasOwnProperty.call(next, 'image')) {
        next.image = String(next.image || '').trim();
    }

    return next;
};

exports.getCategories = async (req, res) => {
    try {
        const categories = await Category.find().sort({ name: 1 });
        res.json(categories);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server error');
    }
};

exports.getCategoryById = async (req, res) => {
    try {
        const category = await Category.findById(req.params.id);
        if (!category) {
            return res.status(404).json({ msg: 'Category not found' });
        }
        res.json(category);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server error');
    }
};

exports.createCategory = async (req, res) => {
    try {
        const safeBody = sanitizeCategoryPayload(req.body);
        if (!safeBody.name) {
            return res.status(400).json({ msg: 'Category name is required' });
        }

        const category = new Category(safeBody);
        await category.save();
        res.status(201).json(category);
    } catch (err) {
        console.error(err.message);
        if (err.code === 11000) {
            return res.status(400).json({ msg: 'Category already exists' });
        }
        res.status(500).send('Server error');
    }
};

exports.updateCategory = async (req, res) => {
    try {
        const safeBody = sanitizeCategoryPayload(req.body);
        const category = await Category.findByIdAndUpdate(
            req.params.id,
            { $set: safeBody },
            { new: true }
        );

        if (!category) {
            return res.status(404).json({ msg: 'Category not found' });
        }

        res.json(category);
    } catch (err) {
        console.error(err.message);
        if (err.code === 11000) {
            return res.status(400).json({ msg: 'Category already exists' });
        }
        res.status(500).send('Server error');
    }
};

exports.deleteCategory = async (req, res) => {
    try {
        const category = await Category.findByIdAndDelete(req.params.id);

        if (!category) {
            return res.status(404).json({ msg: 'Category not found' });
        }

        res.json({ msg: 'Category deleted' });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server error');
    }
};
