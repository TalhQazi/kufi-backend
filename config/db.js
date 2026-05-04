const mongoose = require('mongoose');

const connectDB = async () => {
    try {
        const options = {
            serverSelectionTimeoutMS: 10000, // 10s to find server
            socketTimeoutMS: 45000,          // 45s for queries
            connectTimeoutMS: 10000,         // 10s for initial connection
            waitQueueTimeoutMS: 5000,        // 5s to wait for a pool connection
            maxPoolSize: 20,                 // Sufficient for high concurrency
        };
        await mongoose.connect(process.env.MONGO_URI, options);
        console.log('MongoDB Connected...');
    } catch (err) {
        console.error('MongoDB Connection Error:', err.message);
        process.exit(1);
    }
};

module.exports = connectDB;
