const express = require('express');
const router = express.Router();
const {
    getCategories,
    getCategoryById,
    createCategory,
    updateCategory,
    deleteCategory
} = require('../controllers/categoryController');
const auth = require('../middleware/auth');

router.get('/', getCategories);
router.get('/:id', getCategoryById);
router.post('/', auth(['admin']), createCategory);
router.put('/:id', auth(['admin']), updateCategory);
router.delete('/:id', auth(['admin']), deleteCategory);

module.exports = router;
