const mongoose = require('mongoose');
require('dotenv').config();

const options = {
    serverSelectionTimeoutMS: 60000,
    socketTimeoutMS: 60000,
    connectTimeoutMS: 60000,
    waitQueueTimeoutMS: 10000,
    maxPoolSize: 20,
};

mongoose.connect(process.env.MONGO_URI, options).then(async () => {
    try {
        console.log("Connected to MongoDB.");

        const itineraryIndexes = await mongoose.connection.db.collection('itineraries').indexes();
        console.log("Itineraries collection indexes:");
        console.log(JSON.stringify(itineraryIndexes, null, 2));

        const bookingIndexes = await mongoose.connection.db.collection('bookings').indexes();
        console.log("\nBookings collection indexes:");
        console.log(JSON.stringify(bookingIndexes, null, 2));

    } catch (e) {
        console.error("Failed to list indexes:", e);
    }
    process.exit(0);
});
