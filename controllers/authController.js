const User = require('../models/User');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const axios = require('axios');
const crypto = require('crypto');
const { sendEmail } = require('../utils/emailService');

// Register User
exports.registerUser = async (req, res) => {
    let { name, email, password, role, phone, country, city, status } = req.body;
    email = String(email || '').trim().toLowerCase();

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

        // Send Registration Email
        try {
            const templateKey = role === 'supplier' ? 'supplierRegistration' : 'userRegistration';
            const subject = role === 'supplier' ? 'Supplier Registration Pending Approval' : 'Welcome to Kufi!';
            const message = role === 'supplier' 
                ? 'Thank you for registering as a supplier on Kufi. Your account is currently pending administrator approval. We will notify you once your account is activated.'
                : 'Welcome to Kufi! Your account has been successfully created. You can now explore destinations and book activities.';

            await sendEmail({
                to: user.email,
                subject,
                templateKey,
                html: `
                    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e1e1e1; border-radius: 10px;">
                        <h2 style="color: #a26e35;">Hello ${user.name}!</h2>
                        <p>${message}</p>
                        <div style="margin-top: 30px; text-align: center;">
                            <a href="${process.env.FRONTEND_URL || 'http://localhost:5173'}/login" style="background-color: #a26e35; color: white; padding: 12px 25px; text-decoration: none; border-radius: 5px; font-weight: bold;">Login to Kufi</a>
                        </div>
                        <p style="margin-top: 30px; font-size: 12px; color: #777;">Thank you for joining us.</p>
                    </div>
                `
            });
        } catch (emailErr) {
            console.error('Error sending registration email:', emailErr);
        }

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
    let { email, password } = req.body;

    try {
        if (!email || !password) {
            return res.status(400).json({ msg: 'Please provide email and password' });
        }

        email = String(email).trim().toLowerCase();

        const user = await User.findOne({ email }).lean();
        if (!user) {
            return res.status(400).json({ msg: 'Invalid Credentials' });
        }

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(400).json({ msg: 'Invalid Credentials' });
        }

        const payload = {
            user: {
                id: user._id || user.id,
                role: user.role
            }
        };

        jwt.sign(
            payload,
            process.env.JWT_SECRET,
            { expiresIn: 360000 },
            (err, token) => {
                if (err) throw err;
                res.json({ 
                    token, 
                    user: { 
                        id: user._id || user.id, 
                        name: user.name, 
                        email: user.email, 
                        role: user.role,
                        status: user.status
                    } 
                });
            }
        );
    } catch (err) {
        console.error('Login Error:', err.message);
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
    const { fullName, phone, country, dob, gender, streetNumber, address, city, state, zipCode, nationality, avatar, businessName, businessAddress, businessLicense } = req.body;

    // Build profile object
    const profileFields = {};
    if (fullName) profileFields.fullName = fullName;
    if (phone) profileFields.phone = phone;
    if (country) profileFields.country = country;
    if (dob) profileFields.dob = dob;
    if (gender) profileFields.gender = gender;
    if (streetNumber) profileFields.streetNumber = streetNumber;
    if (address) profileFields.address = address;
    if (city) profileFields.city = city;
    if (state) profileFields.state = state;
    if (zipCode) profileFields.zipCode = zipCode;
    if (nationality) profileFields.nationality = nationality;
    if (avatar) profileFields.avatar = avatar;
    // Supplier fields
    if (businessName) profileFields.businessName = businessName;
    if (businessAddress) profileFields.businessAddress = businessAddress;
    if (businessLicense) profileFields.businessLicense = businessLicense;
    // Set businessProfileStatus to pending if business info is provided
    if (businessName || businessAddress) {
        profileFields.businessProfileStatus = 'pending';
    }

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
};

// Change Password
exports.changePassword = async (req, res) => {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
        return res.status(400).json({ msg: 'Current password and new password are required' });
    }

    try {
        const user = await User.findById(req.user.id);
        if (!user) {
            return res.status(404).json({ msg: 'User not found' });
        }

        // Check if user has a password (Google users may not)
        const isMatch = await bcrypt.compare(currentPassword, user.password);
        if (!isMatch) {
            return res.status(400).json({ msg: 'Current password is incorrect' });
        }

        // Hash new password
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(newPassword, salt);

        user.password = hashedPassword;
        await user.save();

        res.json({ msg: 'Password updated successfully' });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server error');
    }
};

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
// Forgot Password
exports.forgotPassword = async (req, res) => {
    const { email } = req.body;

    try {
        const user = await User.findOne({ email });
        if (!user) {
            return res.status(404).json({ msg: 'No user found with that email' });
        }

        // Generate reset token
        const resetToken = crypto.randomBytes(20).toString('hex');
        user.resetPasswordToken = resetToken;
        user.resetPasswordExpires = Date.now() + 3600000; // 1 hour

        await user.save();

        // Send Email
        const resetUrl = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/#reset-password/${resetToken}`;
        
        try {
            await sendEmail({
                to: user.email,
                subject: 'Password Reset Request',
                templateKey: 'passwordReset',
                html: `
                    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e1e1e1; border-radius: 10px;">
                        <h2 style="color: #a26e35;">Password Reset</h2>
                        <p>You are receiving this because you (or someone else) have requested the reset of the password for your account.</p>
                        <p>Please click on the following button to complete the process:</p>
                        <div style="margin-top: 30px; text-align: center;">
                            <a href="${resetUrl}" style="background-color: #a26e35; color: white; padding: 12px 25px; text-decoration: none; border-radius: 5px; font-weight: bold;">Reset Password</a>
                        </div>
                        <p style="margin-top: 30px;">If you did not request this, please ignore this email and your password will remain unchanged.</p>
                    </div>
                `
            });
            res.json({ msg: 'Email sent' });
        } catch (emailErr) {
            user.resetPasswordToken = undefined;
            user.resetPasswordExpires = undefined;
            await user.save();
            console.error('Email error:', emailErr);
            res.status(500).json({ msg: 'Email could not be sent' });
        }
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server error');
    }
};

// Reset Password
exports.resetPassword = async (req, res) => {
    const { token, password } = req.body;

    try {
        const user = await User.findOne({
            resetPasswordToken: token,
            resetPasswordExpires: { $gt: Date.now() }
        });

        if (!user) {
            return res.status(400).json({ msg: 'Password reset token is invalid or has expired' });
        }

        // Set new password
        const salt = await bcrypt.genSalt(10);
        user.password = await bcrypt.hash(password, salt);
        user.resetPasswordToken = undefined;
        user.resetPasswordExpires = undefined;

        await user.save();

        res.json({ msg: 'Password has been reset' });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server error');
    }
};
