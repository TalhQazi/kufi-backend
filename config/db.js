const mongoose = require('mongoose');

const connectDB = async () => {
    try {
        const options = {
            serverSelectionTimeoutMS: 5000, // 5s to find server
            socketTimeoutMS: 45000,         // 45s for queries
        };
        await mongoose.connect(process.env.MONGO_URI, options);
        console.log('MongoDB Connected...');
    } catch (err) {
        console.error('MongoDB Connection Error:', err.message);
        process.exit(1);
    }
};

module.exports = connectDB;
