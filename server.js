const express = require('express');
const cors = require('cors');
const compression = require('compression');
const bodyParser = require('body-parser');
const path = require('path');
const timeout = require('connect-timeout');

require('dotenv').config();

const connectDB = require('./config/db');

const app = express();

// Middleware
app.use(timeout('30s'));
app.use(cors());
app.use(compression());
app.use(bodyParser.json({ limit: '20mb' }));
app.use(bodyParser.urlencoded({ limit: '20mb', extended: true }));

// Halt on timeout
const haltOnTimeout = (req, res, next) => {
    if (!req.timedout) next();
};
app.use(haltOnTimeout);

// Connect to Database
connectDB();

// Serve uploads
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Define Routes
app.use('/api/auth', require('./routes/authRoutes'));
app.use('/api/activities', require('./routes/activityRoutes'));
app.use('/api/bookings', require('./routes/bookingRoutes'));
app.use('/api/admin', require('./routes/adminRoutes'));
app.use('/api/config', require('./routes/publicConfigRoutes'));
app.use('/api/supplier', require('./routes/supplierRoutes'));
app.use('/api/analytics', require('./routes/analyticsRoutes'));
app.use('/api/itineraries', require('./routes/itineraryRoutes'));
app.use('/api/countries', require('./routes/countryRoutes'));
app.use('/api/cities', require('./routes/cityRoutes'));
app.use('/api/categories', require('./routes/categoryRoutes'));
app.use('/api/blogs', require('./routes/blogRoutes'));
app.use('/api/reviews', require('./routes/reviewRoutes'));
app.use('/api/booking-terms', require('./routes/bookingTermRoutes'));
app.use('/api/footer', require('./routes/footerSettingsRoutes'));
app.use('/api/header', require('./routes/headerSettingsRoutes'));
app.use('/api/sections', require('./routes/sectionVisibilityRoutes'));
app.use('/api/payment', require('./routes/paymentRoutes'));
app.use('/api/legal-content', require('./routes/legalContentRoutes'));
app.use('/api/newsletter', require('./routes/newsletterRoutes'));
app.use('/api/upload', require('./routes/uploadRoutes'));

// Health Check
app.get('/health', (req, res) => {
    res.json({
        status: 'OK',
        uptime: process.uptime(),
        timestamp: new Date()
    });
});

app.get('/', (req, res) => {
    res.send('Kufi Backend API is running');
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
