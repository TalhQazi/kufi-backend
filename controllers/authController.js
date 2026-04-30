const User = require('../models/User');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { OAuth2Client } = require('google-auth-library');
const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// Register User
exports.registerUser = async (req, res) => {
    const { name, email, password, role, phone, country, city, status } = req.body;

    try {
        let user = await User.findOne({ email });
        if (user) {
            return res.status(400).json({ msg: 'User already exists' });
        }

        if (role === 'supplier') {
            if (!String(country || '').trim()) {
                return res.status(400).json({ msg: 'Country is required for supplier registration' });
            }
            if (!String(city || '').trim()) {
                return res.status(400).json({ msg: 'City is required for supplier registration' });
            }
        }

        user = new User({
            name,
            email,
            password,
            role,
            phone,
            country,
            city,
            status,
        });

        const salt = await bcrypt.genSalt(10);
        user.password = await bcrypt.hash(password, salt);

        await user.save();

        const safeUser = user.toObject();
        delete safeUser.password;

        res.status(201).json({ msg: 'User registered successfully', user: safeUser });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server error');
    }
};

// Login User
exports.loginUser = async (req, res) => {
    const { email, password } = req.body;

    try {
        const user = await User.findOne({ email });
        if (!user) {
            return res.status(400).json({ msg: 'Invalid Credentials' });
        }

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(400).json({ msg: 'Invalid Credentials' });
        }

        const payload = {
            user: {
                id: user.id,
                role: user.role
            }
        };

        jwt.sign(
            payload,
            process.env.JWT_SECRET,
            { expiresIn: 360000 },
            (err, token) => {
                if (err) throw err;
                res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
            }
        );
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server error');
    }
};
// Get Current User Profile
exports.getProfile = async (req, res) => {
    try {
        const user = await User.findById(req.user.id).select('-password');
        res.json(user);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server error');
    }
};

// Update User Profile
exports.updateProfile = async (req, res) => {
    const { fullName, phone, country, dob, gender, address, city, nationality, avatar } = req.body;

    // Build profile object
    const profileFields = {};
    if (fullName) profileFields.fullName = fullName;
    if (phone) profileFields.phone = phone;
    if (country) profileFields.country = country;
    if (dob) profileFields.dob = dob;
    if (gender) profileFields.gender = gender;
    if (address) profileFields.address = address;
    if (city) profileFields.city = city;
    if (nationality) profileFields.nationality = nationality;
    if (avatar) profileFields.avatar = avatar;

    try {
        let user = await User.findById(req.user.id);

        if (!user) return res.status(404).json({ msg: 'User not found' });

        user = await User.findByIdAndUpdate(
            req.user.id,
            { $set: profileFields },
            { new: true }
        ).select('-password');

        res.json(user);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server error');
    }
const axios = require('axios');

// Google Login
exports.googleLogin = async (req, res) => {
    const { token } = req.body; // This is the access_token from frontend

    try {
        // Fetch user info from Google using the access token
        const googleRes = await axios.get(`https://www.googleapis.com/oauth2/v3/userinfo?access_token=${token}`);
        const { name, email, picture } = googleRes.data;

        let user = await User.findOne({ email });

        if (!user) {
            user = new User({
                name,
                email,
                password: Math.random().toString(36).slice(-8),
                role: 'user',
                avatar: picture,
                status: 'active'
            });
            await user.save();
        }

        const payload = {
            user: {
                id: user.id,
                role: user.role
            }
        };

        jwt.sign(
            payload,
            process.env.JWT_SECRET,
            { expiresIn: 360000 },
            (err, token) => {
                if (err) throw err;
                res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
            }
        );
    } catch (err) {
        console.error('Google Login Error:', err.response?.data || err.message);
        res.status(500).send('Google Login failed');
    }
};
