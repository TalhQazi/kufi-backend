/**
 * Applies the classifier to the real itinerary data and reports how counts change,
 * proving the fix works on legacy rows that carry no `isBreak` marker.
 */
require('dotenv').config({ path: __dirname + '/../../.env' });
const mongoose = require('mongoose');

(async () => {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 20000 });
    const Itinerary = require('../../models/Itinerary');
    const { isBreakEntry, countActivities } = require('../../utils/activityClassification');

    // Project only what the classifier needs — the collection stores base64 images.
    const rows = await Itinerary.aggregate([
        { $match: { 'days.activities.0': { $exists: true } } },
        {
            $project: {
                destination: 1,
                days: {
                    $map: {
                        input: '$days',
                        as: 'd',
                        in: {
                            activities: {
                                $map: {
                                    input: { $ifNull: ['$$d.activities', []] },
                                    as: 'a',
                                    in: {
                                        title: '$$a.title',
                                        category: '$$a.category',
                                        activityId: '$$a.activityId',
                                        isBreak: '$$a.isBreak',
                                        price: '$$a.price',
                                    },
                                },
                            },
                        },
                    },
                },
            },
        },
    ]).option({ maxTimeMS: 60000 });

    let rawTotal = 0;
    let realTotal = 0;
    let affected = 0;
    const breakTitles = new Map();

    rows.forEach((it) => {
        const raw = (it.days || []).reduce((s, d) => s + (d.activities || []).length, 0);
        const real = countActivities(it.days);
        rawTotal += raw;
        realTotal += real;
        if (raw !== real) affected += 1;
        (it.days || []).forEach((d) => (d.activities || []).forEach((a) => {
            if (isBreakEntry(a)) breakTitles.set(a.title, (breakTitles.get(a.title) || 0) + 1);
        }));
    });

    console.log(`itineraries inspected:            ${rows.length}`);
    console.log(`day entries (old count):          ${rawTotal}`);
    console.log(`real activities (fixed count):    ${realTotal}`);
    console.log(`entries reclassified as breaks:   ${rawTotal - realTotal}`);
    console.log(`itineraries whose total changes:  ${affected}`);
    console.log('\nentries now excluded:');
    [...breakTitles.entries()].sort((a, b) => b[1] - a[1])
        .forEach(([t, n]) => console.log(`  ${String(n).padStart(3)}  "${t}"`));

    // Guard against over-matching: nothing genuinely linked to a catalogue Activity may
    // be excluded. A price alone is not proof — the AI attaches token meal costs to lunch
    // placeholders, and those are still breaks.
    const { resolveActivityId } = require('../../utils/activityClassification');
    let wronglyExcluded = 0;
    const pricedBreaks = [];
    rows.forEach((it) => (it.days || []).forEach((d) => (d.activities || []).forEach((a) => {
        if (!isBreakEntry(a)) return;
        if (resolveActivityId(a.activityId)) wronglyExcluded += 1;
        if (Number(a.price) > 0) pricedBreaks.push(`${a.title} ($${a.price})`);
    })));
    console.log(`\ncatalogue-linked items wrongly excluded: ${wronglyExcluded} (must be 0)`);
    console.log(`breaks carrying a nominal price (excluded from totals, value preserved): ${pricedBreaks.length}`);

    await mongoose.disconnect();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
