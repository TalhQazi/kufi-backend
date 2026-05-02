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

        // Verify we have host and user
        if (!settings.smtpHost || !settings.smtpUser) {
            console.warn('SMTP settings are incomplete. Cannot send email.');
            return null;
        }

        // Create transporter
        const transporter = nodemailer.createTransport({
            host: settings.smtpHost,
            port: settings.smtpPort,
            secure: settings.encryption === 'ssl', // true for 465, false for other ports
            auth: {
                user: settings.smtpUser,
                pass: settings.smtpPass,
            },
            tls: {
                // Do not fail on invalid certs
                rejectUnauthorized: false
            }
        });

        // Send mail
        const info = await transporter.sendMail({
            from: `"${settings.fromName}" <${settings.fromEmail || settings.smtpUser}>`,
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
