const User = require('../models/User');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const axios = require('axios');
const { sendEmail } = require('../utils/emailService');
const { normalizeEmail, findUserByEmail } = require('../utils/email');
const { validatePassword } = require('../utils/passwordPolicy');
const { createResetToken, hashResetToken, EXPIRES_MINUTES } = require('../utils/resetToken');

const BCRYPT_ROUNDS = Number(process.env.BCRYPT_ROUNDS) || 10;

const hashPassword = (plain) => bcrypt.hash(String(plain), BCRYPT_ROUNDS);

/** Sign a session token for a user document. */
const signToken = (user) =>
    new Promise((resolve, reject) => {
        jwt.sign(
            { user: { id: String(user._id || user.id), role: user.role } },
            process.env.JWT_SECRET,
            { expiresIn: Number(process.env.JWT_EXPIRES_SECONDS) || 360000 },
            (err, token) => (err ? reject(err) : resolve(token))
        );
    });

const getFrontendUrl = (req) => {
    if (process.env.FRONTEND_URL) {
        return process.env.FRONTEND_URL.replace(/\/$/, '');
    }
    const origin = req?.get ? req.get('origin') : (req?.headers?.origin || req?.headers?.referer);
    if (origin) {
        return String(origin).replace(/\/$/, '');
    }
    return 'http://localhost:5173';
};

const formatAuthUser = (user) => {
    const u = user?.toObject ? user.toObject() : user;
    return {
        id: u._id || u.id,
        _id: u._id || u.id,
        name: u.name,
        email: u.email,
        role: u.role,
        status: u.status,
        avatar: u.avatar,
        darkMode: Boolean(u.preferences?.darkMode),
    };
};

// Register User
exports.registerUser = async (req, res) => {
    let { name, email, password, role, phone, country, city, status } = req.body;
    const cleanEmail = normalizeEmail(email);
    email = cleanEmail;

    try {
        if (!cleanEmail) {
            return res.status(400).json({ msg: 'Please provide an email address' });
        }

        const policy = validatePassword(password);
        if (!policy.valid) {
            return res.status(400).json({ msg: policy.errors[0], errors: policy.errors });
        }

        // `role` is client-supplied, so only the self-service roles are accepted here.
        // An admin account can never be created through public registration.
        if (role && !['user', 'supplier'].includes(role)) {
            return res.status(400).json({ msg: 'Invalid account type' });
        }
        // Likewise `status`: a supplier must not be able to self-activate.
        status = role === 'supplier' ? 'pending' : 'active';

        let user = await findUserByEmail(User, cleanEmail);
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
                            <a href="${getFrontendUrl(req)}/login" style="background-color: #a26e35; color: white; padding: 12px 25px; text-decoration: none; border-radius: 5px; font-weight: bold;">Login to Kufi</a>
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

        const user = await findUserByEmail(User, email, { lean: true });

        // Always run a bcrypt comparison, even when the account does not exist, so the
        // response time does not reveal whether an address is registered.
        const hash = user?.password || '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv';
        const isMatch = await bcrypt.compare(String(password), hash);

        if (!user || !isMatch) {
            return res.status(400).json({ msg: 'Invalid Credentials' });
        }

        const token = await signToken(user);
        res.json({ token, user: formatAuthUser(user) });
    } catch (err) {
        console.error('Login Error:', err.message);
        res.status(500).send('Server error');
    }
};
// Get Current User Profile
exports.getProfile = async (req, res) => {
    try {
        const user = await User.findById(req.user.id).select('-password');
        if (!user) {
            return res.status(404).json({ msg: 'User not found' });
        }
        res.json(user);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server error');
    }
};

/**
 * Fields a user is allowed to change on their own profile.
 *
 * Everything else (role, status, scorePoints, verification flags, password, email) is
 * deliberately excluded: `$set` with a raw body would otherwise let any user promote
 * themselves to admin or mark their own business licence as verified.
 */
const SELF_EDITABLE_PROFILE_FIELDS = [
    'name', 'fullName', 'phone', 'country', 'dob', 'gender', 'streetNumber',
    'address', 'city', 'state', 'zipCode', 'nationality', 'avatar',
    'businessName', 'businessAddress', 'businessLicense',
];

// Update User Profile
exports.updateProfile = async (req, res) => {
    const body = req.body || {};
    const profileFields = {};

    for (const field of SELF_EDITABLE_PROFILE_FIELDS) {
        const value = body[field];
        // Allow clearing a field with an explicit empty string, but ignore undefined/null
        // so a partial update never wipes data the client did not send.
        if (value !== undefined && value !== null) {
            profileFields[field] = value;
        }
    }

    // Re-submitting business details puts the supplier back into the approval queue.
    if (body.businessName || body.businessAddress) {
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

// Get user UI preferences (dark mode, etc.)
exports.getPreferences = async (req, res) => {
    try {
        const user = await User.findById(req.user.id).select('preferences');
        if (!user) return res.status(404).json({ msg: 'User not found' });

        res.json({ darkMode: Boolean(user.preferences?.darkMode) });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server error');
    }
};

// Update user UI preferences
exports.updatePreferences = async (req, res) => {
    const { darkMode } = req.body;

    if (typeof darkMode !== 'boolean') {
        return res.status(400).json({ msg: 'darkMode must be a boolean' });
    }

    try {
        const user = await User.findByIdAndUpdate(
            req.user.id,
            { $set: { 'preferences.darkMode': darkMode } },
            { new: true }
        ).select('preferences');

        if (!user) return res.status(404).json({ msg: 'User not found' });

        res.json({ darkMode: Boolean(user.preferences?.darkMode) });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server error');
    }
};

// Change Password
exports.changePassword = async (req, res) => {
    const { currentPassword, newPassword, confirmPassword } = req.body || {};

    if (!currentPassword || !newPassword) {
        return res.status(400).json({ msg: 'Current password and new password are required' });
    }

    // The client also checks this, but the API is the boundary that has to hold.
    if (confirmPassword !== undefined && String(confirmPassword) !== String(newPassword)) {
        return res.status(400).json({ msg: 'New password and confirmation do not match' });
    }

    const policy = validatePassword(newPassword);
    if (!policy.valid) {
        return res.status(400).json({ msg: policy.errors[0], errors: policy.errors });
    }

    try {
        const user = await User.findById(req.user.id);
        if (!user) {
            return res.status(404).json({ msg: 'User not found' });
        }

        const isMatch = await bcrypt.compare(String(currentPassword), user.password || '');
        if (!isMatch) {
            return res.status(400).json({ msg: 'Current password is incorrect' });
        }

        const isSameAsOld = await bcrypt.compare(String(newPassword), user.password || '');
        if (isSameAsOld) {
            return res.status(400).json({ msg: 'New password must be different from the current password' });
        }

        user.password = await hashPassword(newPassword);
        // Invalidates every token issued before now (see middleware/auth.js), so other
        // sessions are signed out. Any pending reset link is voided too.
        user.passwordChangedAt = new Date();
        user.resetPasswordToken = undefined;
        user.resetPasswordExpires = undefined;
        await user.save();

        // The caller stays signed in: hand back a token minted after the change.
        const token = await signToken(user);
        res.json({ msg: 'Password updated successfully', token });
    } catch (err) {
        console.error('changePassword error:', err.message);
        res.status(500).send('Server error');
    }
};

// Google Login
exports.googleLogin = async (req, res) => {
    const { token } = req.body; // This is the access_token from frontend

    try {
        // Fetch user info from Google using the access token
        const googleRes = await axios.get(`https://www.googleapis.com/oauth2/v3/userinfo?access_token=${token}`);
        const { name, picture } = googleRes.data;
        // Google may return the address in any casing; normalizing here is what stops a
        // second account being created for a user who already signed up with a password.
        const email = normalizeEmail(googleRes.data?.email);

        if (!email) {
            return res.status(400).json({ msg: 'Google account did not provide an email address' });
        }

        let user = await findUserByEmail(User, email);
        let isNewUser = false;

        if (!user) {
            user = new User({
                name,
                email,
                // Placeholder credential: this account signs in through Google. Random
                // bytes rather than Math.random so it can never be guessed.
                password: await hashPassword(require('crypto').randomBytes(32).toString('hex')),
                role: 'user',
                avatar: picture,
                status: 'active'
            });
            await user.save();
            isNewUser = true;
        } else if (!user.avatar && picture) {
            user.avatar = picture;
            await user.save();
        }

        const payload = {
            user: {
                id: user.id,
                role: user.role
            }
        };

        if (isNewUser) {
            try {
                await sendEmail({
                    to: user.email,
                    subject: 'Welcome to Kufi!',
                    templateKey: 'userRegistration',
                    html: `
                        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e1e1e1; border-radius: 10px;">
                            <h2 style="color: #a26e35;">Hello ${user.name}!</h2>
                            <p>Welcome to Kufi! Your account has been successfully created via Google. You can now explore destinations and book activities.</p>
                            <div style="margin-top: 30px; text-align: center;">
                                <a href="${process.env.FRONTEND_URL || 'http://localhost:5173'}/login" style="background-color: #a26e35; color: white; padding: 12px 25px; text-decoration: none; border-radius: 5px; font-weight: bold;">Start Exploring</a>
                            </div>
                            <p style="margin-top: 30px; font-size: 12px; color: #777;">Thank you for joining us.</p>
                        </div>
                    `
                });
            } catch (emailErr) {
                console.error('Error sending Google registration email:', emailErr);
            }
        }

        jwt.sign(
            payload,
            process.env.JWT_SECRET,
            { expiresIn: 360000 },
            (err, token) => {
                if (err) throw err;
                res.json({ token, user: formatAuthUser(user) });
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

    // Identical response whether or not the address exists — otherwise this endpoint is
    // an account-enumeration oracle.
    const genericResponse = {
        msg: 'If an account exists for that email address, a password reset link has been sent.',
    };

    try {
        const cleanEmail = normalizeEmail(email);
        if (!cleanEmail) {
            return res.status(400).json({ msg: 'Please provide an email address' });
        }

        const user = await findUserByEmail(User, cleanEmail);

        if (!user) {
            return res.json(genericResponse);
        }

        // Random token; only its digest is persisted.
        const { token: resetToken, tokenHash, expiresAt, expiresInMinutes } = createResetToken();
        user.resetPasswordToken = tokenHash;
        user.resetPasswordExpires = expiresAt;

        await user.save();

        // Send Email
        const baseUrl = getFrontendUrl(req);
        const resetUrl = `${baseUrl}/reset-password/${resetToken}`;

        try {
            const emailResult = await sendEmail({
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
                        <p style="margin-top: 20px; font-size: 13px; color: #777;">This link expires in ${expiresInMinutes} minutes and can only be used once.</p>
                        <p style="margin-top: 30px;">If you did not request this, please ignore this email and your password will remain unchanged.</p>
                    </div>
                `
            });

            if (emailResult === null) {
                user.resetPasswordToken = undefined;
                user.resetPasswordExpires = undefined;
                await user.save();
                return res.status(500).json({ msg: 'Email service is not configured. Please contact administrator.' });
            }

            res.json(genericResponse);
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
    const { token, password } = req.body || {};

    try {
        if (!token) {
            return res.status(400).json({ msg: 'Password reset token is invalid or has expired' });
        }

        const policy = validatePassword(password);
        if (!policy.valid) {
            return res.status(400).json({ msg: policy.errors[0], errors: policy.errors });
        }

        // Look the token up by digest; `resetPasswordToken` is `select: false`, so it has
        // to be requested explicitly.
        const user = await User.findOne({
            resetPasswordToken: hashResetToken(token),
            resetPasswordExpires: { $gt: new Date() }
        }).select('+resetPasswordToken +resetPasswordExpires');

        if (!user) {
            return res.status(400).json({ msg: 'Password reset token is invalid or has expired' });
        }

        user.password = await hashPassword(password);
        // Consume the token so the same link cannot be replayed...
        user.resetPasswordToken = undefined;
        user.resetPasswordExpires = undefined;
        // ...and sign out every session that existed before the reset.
        user.passwordChangedAt = new Date();

        await user.save();

        res.json({ msg: 'Password has been reset' });
    } catch (err) {
        console.error('resetPassword error:', err.message);
        res.status(500).send('Server error');
    }
};

// Expose the active password policy so the UI can show the rules before submission.
exports.getPasswordPolicy = (req, res) => {
    res.json({ ...require('../utils/passwordPolicy').describePolicy(), resetExpiresMinutes: EXPIRES_MINUTES });
};
