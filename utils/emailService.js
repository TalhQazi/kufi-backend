const nodemailer = require('nodemailer');
const EmailSettings = require('../models/EmailSettings');

/**
 * Sends an email using dynamic SMTP settings from the database.
 * @param {Object} options - Email options
 * @param {string} options.to - Recipient email
 * @param {string} options.subject - Email subject
 * @param {string} options.html - HTML content
 * @param {string} options.templateKey - The key in settings.templates to check if enabled
 */
const sendEmail = async ({ to, subject, html, templateKey }) => {
    try {
        // Fetch current email settings
        let settings = await EmailSettings.findOne();
        if (!settings) {
            console.warn('Email settings not found in database. Using defaults.');
            settings = new EmailSettings();
        }

        // Check if this specific template is enabled
        if (templateKey && settings.templates[templateKey] === false) {
            console.log(`Email template "${templateKey}" is disabled. Skipping email.`);
            return null;
        }

        // Verify we have host and user (check DB settings first, then env variables)
        const smtpHost = settings.smtpHost || process.env.SMTP_HOST;
        const smtpUser = settings.smtpUser || process.env.SMTP_USER;
        const smtpPass = settings.smtpPass || process.env.SMTP_PASS;
        const smtpPort = settings.smtpPort || process.env.SMTP_PORT || 587;
        const encryption = settings.encryption || process.env.SMTP_ENCRYPTION || 'tls';
        const fromName = settings.fromName || process.env.SMTP_FROM_NAME || 'Kufi Travel';
        const fromEmail = settings.fromEmail || process.env.SMTP_FROM || smtpUser;

        if (!smtpHost || !smtpUser) {
            console.warn('SMTP settings are incomplete. Cannot send email.');
            return null;
        }

        // Create transporter
        const transporter = nodemailer.createTransport({
            host: smtpHost,
            port: Number(smtpPort),
            secure: encryption === 'ssl' || String(smtpPort) === '465', // true for 465, false for other ports
            auth: {
                user: smtpUser,
                pass: smtpPass,
            },
            tls: {
                // Do not fail on invalid certs
                rejectUnauthorized: false
            }
        });

        // Send mail
        const info = await transporter.sendMail({
            from: `"${fromName}" <${fromEmail}>`,
            to,
            subject,
            html,
        });

        console.log('Message sent: %s', info.messageId);
        return info;
    } catch (error) {
        console.error('Error sending email:', error);
        throw error;
    }
};

module.exports = { sendEmail };
