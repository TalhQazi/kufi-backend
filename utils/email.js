/**
 * Canonical email handling.
 *
 * Email addresses are case-insensitive in practice, so the application stores and
 * compares them in a single normalized (lower-cased, trimmed) form. Every lookup goes
 * through `findUserByEmail` so login, registration, password reset and verification
 * can never disagree about what "the same account" means.
 *
 * Legacy rows written before normalization may still hold mixed-case addresses, so the
 * lookup falls back to an anchored case-insensitive regex. New writes are always
 * normalized (see the `email` setter on the User schema), so that fallback shrinks to
 * nothing over time.
 */

/** Lower-cased, trimmed address. Returns '' for nullish/blank input. */
function normalizeEmail(value) {
    return String(value ?? '').trim().toLowerCase();
}

function escapeRegExp(value) {
    return String(value ?? '').replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
}

/** Anchored, case-insensitive matcher for a single address. */
function emailMatchRegex(value) {
    return new RegExp(`^${escapeRegExp(normalizeEmail(value))}$`, 'i');
}

/**
 * Mongo filter matching one address regardless of stored casing.
 * Cheap equality first so the unique index on `email` is used whenever possible.
 */
function emailQuery(value) {
    const clean = normalizeEmail(value);
    return { $or: [{ email: clean }, { email: emailMatchRegex(clean) }] };
}

/**
 * The single entry point for "find the account for this address".
 * @param {import('mongoose').Model} User
 * @param {string} value raw, user-supplied address
 * @param {{ lean?: boolean, select?: string }} [options]
 */
function findUserByEmail(User, value, options = {}) {
    const clean = normalizeEmail(value);
    if (!clean) return Promise.resolve(null);

    let query = User.findOne(emailQuery(clean));
    if (options.select) query = query.select(options.select);
    if (options.lean) query = query.lean();
    return query;
}

module.exports = { normalizeEmail, emailMatchRegex, emailQuery, findUserByEmail, escapeRegExp };
