const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bodyParser = require('body-parser');
require('dotenv').config();

const connectDB = require('./config/db');

const app = express();

// Middleware
app.use(cors());
app.use(bodyParser.json({ limit: '20mb' }));

// Connect to Database
connectDB();

// Init Middleware
app.use(express.json({ limit: '20mb', extended: false }));

// Define Routes
app.use('/api/auth', require('./routes/authRoutes'));
app.use('/api/activities', require('./routes/activityRoutes'));
app.use('/api/bookings', require('./routes/bookingRoutes'));
app.use('/api/admin', require('./routes/adminRoutes'));
app.use('/api/supplier', require('./routes/supplierRoutes'));
app.use('/api/analytics', require('./routes/analyticsRoutes'));
app.use('/api/itineraries', require('./routes/itineraryRoutes'));
app.use('/api/countries', require('./routes/countryRoutes'));
app.use('/api/cities', require('./routes/cityRoutes'));
app.use('/api/categories', require('./routes/categoryRoutes'));

// Health Check
app.get('/health', (req, res) => {
    res.json({
        status: 'OK',
        uptime: process.uptime(),
        timestamp: new Date()
    });
});

// Routes Placeholder
app.get('/', (req, res) => {
    res.send('Kufi Backend API is running');
});

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
