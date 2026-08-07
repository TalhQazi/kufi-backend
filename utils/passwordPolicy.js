/**
 * Single definition of what makes an acceptable password, used by registration,
 * change-password and reset-password so the three can never drift apart.
 *
 * Tunable via env so the policy can be tightened without a code change:
 *   PASSWORD_MIN_LENGTH   (default 8)
 *   PASSWORD_MAX_LENGTH   (default 128 — bcrypt silently truncates past 72 bytes)
 *   PASSWORD_REQUIRE_MIXED_CASE / _NUMBER / _SYMBOL  ("true" to enable)
 */

const MIN_LENGTH = Number(process.env.PASSWORD_MIN_LENGTH) || 8;
const MAX_LENGTH = Number(process.env.PASSWORD_MAX_LENGTH) || 128;
const REQUIRE_MIXED_CASE = String(process.env.PASSWORD_REQUIRE_MIXED_CASE || 'false') === 'true';
const REQUIRE_NUMBER = String(process.env.PASSWORD_REQUIRE_NUMBER || 'true') === 'true';
const REQUIRE_SYMBOL = String(process.env.PASSWORD_REQUIRE_SYMBOL || 'false') === 'true';

/**
 * @returns {{ valid: boolean, errors: string[] }} All failures, so the UI can show them
 * at once instead of making the user guess one rule at a time.
 */
function validatePassword(password) {
    const value = String(password ?? '');
    const errors = [];

    if (!value) {
        return { valid: false, errors: ['Password is required'] };
    }
    if (value.length < MIN_LENGTH) {
        errors.push(`Password must be at least ${MIN_LENGTH} characters`);
    }
    if (value.length > MAX_LENGTH) {
        errors.push(`Password must be at most ${MAX_LENGTH} characters`);
    }
    if (REQUIRE_MIXED_CASE && !(/[a-z]/.test(value) && /[A-Z]/.test(value))) {
        errors.push('Password must contain both uppercase and lowercase letters');
    }
    if (REQUIRE_NUMBER && !/\d/.test(value)) {
        errors.push('Password must contain at least one number');
    }
    if (REQUIRE_SYMBOL && !/[^A-Za-z0-9]/.test(value)) {
        errors.push('Password must contain at least one special character');
    }
    if (/^\s|\s$/.test(value)) {
        errors.push('Password must not start or end with a space');
    }

    return { valid: errors.length === 0, errors };
}

/** Policy description for clients that want to render the rules up front. */
function describePolicy() {
    return {
        minLength: MIN_LENGTH,
        maxLength: MAX_LENGTH,
        requireMixedCase: REQUIRE_MIXED_CASE,
        requireNumber: REQUIRE_NUMBER,
        requireSymbol: REQUIRE_SYMBOL,
    };
}

module.exports = { validatePassword, describePolicy, MIN_LENGTH, MAX_LENGTH };
