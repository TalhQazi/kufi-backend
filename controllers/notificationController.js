const Notification = require('../models/Notification');
const mongoose = require('mongoose');

exports.getMyNotifications = async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ msg: 'Unauthorized' });

        const notifications = await Notification.find({ userId })
            .sort({ createdAt: -1 })
            .limit(100)
            .lean();

        const unreadCount = await Notification.countDocuments({ userId, read: false });

        res.json({ notifications, unreadCount });
    } catch (err) {
        console.error('getMyNotifications error:', err?.message || err);
        res.status(500).json({ msg: 'Server error' });
    }
};

exports.markAsRead = async (req, res) => {
    try {
        const userId = req.user?.id;
        const { id } = req.params;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ msg: 'Invalid notification id' });
        }

        const notification = await Notification.findOneAndUpdate(
            { _id: id, userId },
            { $set: { read: true } },
            { new: true }
        ).lean();

        if (!notification) {
            return res.status(404).json({ msg: 'Notification not found' });
        }

        res.json(notification);
    } catch (err) {
        console.error('markAsRead error:', err?.message || err);
        res.status(500).json({ msg: 'Server error' });
    }
};

exports.markAllRead = async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ msg: 'Unauthorized' });

        const result = await Notification.updateMany(
            { userId, read: false },
            { $set: { read: true } }
        );

        res.json({
            success: true,
            modifiedCount: result.modifiedCount ?? result.nModified ?? 0,
        });
    } catch (err) {
        console.error('markAllRead error:', err?.message || err);
        res.status(500).json({ msg: 'Server error' });
    }
};
