/**
 * Password reset tokens.
 *
 * The token that goes in the email is high-entropy random; only its SHA-256 digest is
 * stored. A leaked database therefore cannot be used to take over accounts, and the
 * lookup stays a single indexed equality match.
 *
 * Expiry is configurable via PASSWORD_RESET_EXPIRES_MINUTES (default 60).
 */

const crypto = require('crypto');

const TOKEN_BYTES = 32; // 256 bits
const EXPIRES_MINUTES = Number(process.env.PASSWORD_RESET_EXPIRES_MINUTES) || 60;

/**
 * @returns {{ token: string, tokenHash: string, expiresAt: Date, expiresInMinutes: number }}
 * `token` is emailed to the user and never stored; `tokenHash` is what goes in the DB.
 */
function createResetToken() {
    const token = crypto.randomBytes(TOKEN_BYTES).toString('hex');
    return {
        token,
        tokenHash: hashResetToken(token),
        expiresAt: new Date(Date.now() + EXPIRES_MINUTES * 60 * 1000),
        expiresInMinutes: EXPIRES_MINUTES,
    };
}

/** Digest used for storage and lookup. */
function hashResetToken(token) {
    return crypto.createHash('sha256').update(String(token ?? '')).digest('hex');
}

module.exports = { createResetToken, hashResetToken, EXPIRES_MINUTES };
