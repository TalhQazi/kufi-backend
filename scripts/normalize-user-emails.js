/**
 * One-off migration: lower-case every stored email address.
 *
 * From now on the User schema normalizes on write, so the existing unique index on
 * `email` enforces case-insensitive uniqueness. This backfills the rows written before
 * that setter existed.
 *
 * Refuses to run if two accounts would collide, so it can never silently merge users.
 *
 *   node scripts/normalize-user-emails.js          # report only
 *   node scripts/normalize-user-emails.js --apply  # write changes
 */
require('dotenv').config({ path: __dirname + '/../.env' });
const mongoose = require('mongoose');

const APPLY = process.argv.includes('--apply');

(async () => {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 30000 });
    const User = require('../models/User');

    const users = await User.find({}).select('email').lean();
    const needsChange = users.filter((u) => u.email !== String(u.email || '').toLowerCase());

    const byLower = new Map();
    users.forEach((u) => {
        const key = String(u.email || '').toLowerCase();
        byLower.set(key, [...(byLower.get(key) || []), u]);
    });
    const collisions = [...byLower.entries()].filter(([, list]) => list.length > 1);

    console.log(`users: ${users.length}`);
    console.log(`needing normalization: ${needsChange.length}`);
    needsChange.forEach((u) => console.log(`  ${u.email}  ->  ${String(u.email).toLowerCase()}`));

    if (collisions.length > 0) {
        console.error(`\nABORT: ${collisions.length} address(es) would collide after normalization.`);
        collisions.forEach(([key, list]) => console.error(`  ${key}: ${list.map((u) => u.email).join(' | ')}`));
        console.error('Resolve these accounts manually before running with --apply.');
        await mongoose.disconnect();
        process.exit(1);
    }

    if (!APPLY) {
        console.log('\nDry run. Re-run with --apply to write these changes.');
        await mongoose.disconnect();
        return;
    }

    let updated = 0;
    for (const u of needsChange) {
        await User.collection.updateOne(
            { _id: u._id },
            { $set: { email: String(u.email).toLowerCase() } }
        );
        updated += 1;
    }
    console.log(`\nnormalized ${updated} address(es).`);
    await mongoose.disconnect();
})().catch((e) => {
    console.error('ERR', e.message);
    process.exit(1);
});
