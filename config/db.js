const mongoose = require('mongoose');

const connectDB = async () => {
    try {
        const options = {
            serverSelectionTimeoutMS: 60000, // 60s to find server
            socketTimeoutMS: 60000,          // 60s for queries
            connectTimeoutMS: 60000,         // 60s for initial connection
            waitQueueTimeoutMS: 10000,       // 10s to wait for a pool connection
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
