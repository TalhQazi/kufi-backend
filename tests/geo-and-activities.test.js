/**
 * Unit tests for the geography planner and activity classification.
 *
 *   node --test tests/
 *
 * These are pure-function tests: no database, no network. They pin the behaviour the
 * itinerary generator depends on (issues 3 and 6).
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
    isBreakEntry,
    countActivities,
    markBreakEntries,
    buildBreakEntry,
    resolveActivityId,
} = require('../utils/activityClassification');

const {
    haversineKm,
    getCoordinates,
    clusterByGeography,
    orderClustersByRoute,
    parseDurationMinutes,
    travelMinutesForKm,
    transportModeForKm,
    dayCapacityMinutes,
    validateItineraryGeography,
    SAME_AREA_RADIUS_KM,
} = require('../utils/geo');

const { planActivitiesAcrossDays, repairItineraryGeography } = require('../utils/itineraryGeoPlanner');

// Real coordinates from the production catalogue.
const CAIRO = { lat: 29.979, lng: 31.134 };   // Giza pyramids complex
const LUXOR = { lat: 25.719, lng: 32.657 };   // Karnak
const ASWAN = { lat: 24.026, lng: 32.885 };   // Philae
const GIZA_MUSEUM = { lat: 30.0131, lng: 31.1195 };

const act = (title, coords, extra = {}) => ({
    _id: title.replace(/\s/g, '-'),
    title,
    coordinates: coords,
    location: extra.location || 'Egypt',
    price: extra.price ?? 50,
    duration: extra.duration || '2 hours',
    category: extra.category || 'culture',
    ...extra,
});

// ─── Issue 3: Lunch Break must not count as an activity ──────────────────────

test('lunch break entries are not counted as activities', () => {
    const day = {
        activities: [
            { title: 'Pyramids Tour', activityId: 'a1', category: 'culture' },
            { title: 'Museum Visit', activityId: 'a2', category: 'culture' },
            { title: 'Lunch Break', activityId: null, category: 'Dining' },
            { title: 'Nile Cruise', activityId: 'a3', category: 'culture' },
        ],
    };
    assert.equal(countActivities([day]), 3, 'the lunch break must be excluded');
});

test('break detection prefers the canonical marker over display text', () => {
    assert.equal(isBreakEntry({ title: 'Anything at all', isBreak: true }), true);
    assert.equal(isBreakEntry({ title: 'Lunch Break', category: 'break' }), true);
    assert.equal(isBreakEntry({ title: 'Free Time', activityId: null }), true);
    assert.equal(isBreakEntry({ title: 'Rest', activityId: null }), true);
});

test('a real catalogue activity is never classified as a break', () => {
    // Priced dining experiences linked to the catalogue must keep counting.
    assert.equal(isBreakEntry({ title: 'Nile River Dinner Cruise', activityId: 'x1', category: 'Dining', price: 80 }), false);
    assert.equal(isBreakEntry({ title: 'Welcome Dinner & Evening Walk', activityId: null, price: 30, category: 'dining' }), false);
    // ...even if it is literally called "Lunch", as long as it is a booked item.
    assert.equal(isBreakEntry({ title: 'Lunch', activityId: 'x2', price: 40 }), false);
});

test('markBreakEntries stamps the canonical marker and clears stale ones', () => {
    const [day] = markBreakEntries([
        {
            activities: [
                { title: 'Lunch Break', activityId: null, category: 'Dining' },
                { title: 'Pyramids Tour', activityId: 'a1', isBreak: true },
            ],
        },
    ]);
    assert.equal(day.activities[0].isBreak, true);
    assert.equal(day.activities[0].category, 'break');
    assert.equal(day.activities[1].isBreak, false, 'a catalogue activity must not stay marked as a break');
});

test('buildBreakEntry produces a zero-price, unlinked, marked entry', () => {
    const entry = buildBreakEntry({ startTime: '13:00', endTime: '14:00' });
    assert.equal(entry.isBreak, true);
    assert.equal(entry.price, 0);
    assert.equal(entry.activityId, null);
    assert.equal(countActivities([{ activities: [entry] }]), 0);
});

// ─── Geographic primitives ───────────────────────────────────────────────────

test('haversine matches known real-world distances', () => {
    assert.ok(Math.abs(haversineKm(CAIRO, LUXOR) - 497) < 15, 'Cairo→Luxor ≈ 497km');
    assert.ok(Math.abs(haversineKm(LUXOR, ASWAN) - 190) < 15, 'Luxor→Aswan ≈ 190km');
    assert.ok(haversineKm(CAIRO, GIZA_MUSEUM) < SAME_AREA_RADIUS_KM, 'Giza sites are the same area');
});

test('getCoordinates rejects unusable values', () => {
    assert.equal(getCoordinates({ coordinates: { lat: null, lng: null } }), null);
    assert.equal(getCoordinates({ coordinates: { lat: 0, lng: 0 } }), null, 'null island is not a location');
    assert.equal(getCoordinates({ coordinates: { lat: 999, lng: 1 } }), null);
    assert.deepEqual(getCoordinates({ coordinates: CAIRO }), CAIRO);
});

test('duration parsing handles the formats in the catalogue', () => {
    assert.equal(parseDurationMinutes('2 hours'), 120);
    assert.equal(parseDurationMinutes('90 mins'), 90);
    assert.equal(parseDurationMinutes('1 hour 30 minutes'), 90);
    assert.equal(parseDurationMinutes('Full day'), 480);
    assert.equal(parseDurationMinutes(''), 120, 'falls back to the default');
});

test('travel time and mode scale with distance', () => {
    assert.equal(transportModeForKm(10), 'local');
    assert.equal(transportModeForKm(200), 'road');
    assert.equal(transportModeForKm(600), 'flight');
    assert.ok(travelMinutesForKm(497) > travelMinutesForKm(50));
});

test('day capacity subtracts the lunch window', () => {
    // 09:00–19:00 is 600 minutes, minus a 60-minute lunch.
    assert.equal(
        dayCapacityMinutes({ activityStartTime: '09:00', activityEndTime: '19:00', lunchStart: '13:00', lunchEnd: '14:00' }),
        540
    );
});

// ─── Issue 6: geographic clustering ──────────────────────────────────────────

test('clustering separates distant bases and merges nearby ones', () => {
    const clusters = clusterByGeography([
        act('Pyramids', CAIRO),
        act('Grand Egyptian Museum', GIZA_MUSEUM),
        act('Karnak Temple', LUXOR),
        act('Valley of the Kings', { lat: 25.740, lng: 32.601 }),
        act('Philae Temple', ASWAN),
    ]);

    assert.equal(clusters.length, 3, 'Cairo, Luxor and Aswan are three separate bases');
    const cairo = clusters.find((c) => c.items.some((i) => i.title === 'Pyramids'));
    assert.equal(cairo.items.length, 2, 'Giza sites cluster together');
    assert.ok(clusters.every((c) => !(c.items.some((i) => i.title === 'Pyramids') && c.items.some((i) => i.title === 'Karnak Temple'))),
        'Cairo and Luxor must never share a cluster');
});

test('clustering falls back to place labels when coordinates are missing', () => {
    const clusters = clusterByGeography([
        { title: 'A', location: 'Beirut' },
        { title: 'B', location: 'Beirut' },
        { title: 'C', location: 'Byblos' },
    ]);
    assert.equal(clusters.length, 2);
});

test('route ordering visits the nearest base next', () => {
    const clusters = clusterByGeography([
        act('Philae', ASWAN),
        act('Karnak', LUXOR),
        act('Pyramids', CAIRO),
    ]);
    const ordered = orderClustersByRoute(clusters, CAIRO);
    const names = ordered.map((c) => c.items[0].title);
    assert.deepEqual(names, ['Pyramids', 'Karnak', 'Philae'], 'Cairo → Luxor → Aswan, not Cairo → Aswan → Luxor');
});

// ─── Issue 6: day planning ───────────────────────────────────────────────────

const controlPanel = {
    activityStartTime: '09:00',
    activityEndTime: '19:00',
    lunchStart: '13:00',
    lunchEnd: '14:00',
    perDayOverrides: [],
};

const activeDays = (n) =>
    Array.from({ length: n }, (_, i) => ({ index: i, date: `2026-09-0${i + 1}` }));

test('Cairo + Luxor + Aswan produce geographically grouped days', () => {
    const activities = [
        act('Pyramids', CAIRO), act('Sphinx', { lat: 29.975, lng: 31.137 }), act('Egyptian Museum', GIZA_MUSEUM),
        act('Karnak', LUXOR), act('Valley of the Kings', { lat: 25.740, lng: 32.601 }), act('Luxor Temple', { lat: 25.699, lng: 32.639 }),
        act('Philae', ASWAN), act('Abu Simbel', { lat: 24.05, lng: 32.9 }),
    ];

    const { assignments } = planActivitiesAcrossDays(activities, {
        activeDays: activeDays(7),
        controlPanel,
        origin: CAIRO,
        maxPerDay: 3,
    });

    for (const [dayIdx, list] of assignments) {
        const coords = list.map(getCoordinates).filter(Boolean);
        for (let i = 0; i < coords.length; i++) {
            for (let j = i + 1; j < coords.length; j++) {
                const d = haversineKm(coords[i], coords[j]);
                assert.ok(
                    d <= SAME_AREA_RADIUS_KM,
                    `day ${dayIdx + 1} mixes activities ${Math.round(d)}km apart: ${list.map((a) => a.title).join(', ')}`
                );
            }
        }
    }
});

test('Cairo + Giza stay on the same day — nearby places are not split', () => {
    const { assignments } = planActivitiesAcrossDays(
        [act('Pyramids', CAIRO), act('Egyptian Museum', GIZA_MUSEUM)],
        { activeDays: activeDays(3), controlPanel, origin: CAIRO, maxPerDay: 3 }
    );
    const used = [...assignments.values()].filter((l) => l.length > 0);
    assert.equal(used.length, 1, 'two Giza-area activities belong on one day');
    assert.equal(used[0].length, 2);
});

test('daily capacity is respected — long activities spill to the next day', () => {
    const longOnes = Array.from({ length: 4 }, (_, i) =>
        act(`Full day tour ${i}`, { lat: CAIRO.lat + i * 0.001, lng: CAIRO.lng }, { duration: 'Full day' })
    );
    const { assignments } = planActivitiesAcrossDays(longOnes, {
        activeDays: activeDays(4),
        controlPanel,
        origin: CAIRO,
        maxPerDay: 3,
    });
    // 540 minutes of capacity cannot hold two 480-minute tours.
    for (const [, list] of assignments) {
        assert.ok(list.length <= 1, 'a full-day tour must not share a day with another');
    }
});

// ─── Issue 6: post-generation validation and repair ──────────────────────────

test('validation flags a Cairo+Luxor day as geographically impossible', () => {
    const days = [
        {
            day: 1,
            date: '2026-09-01',
            activities: [act('Pyramids', CAIRO), act('Sphinx', { lat: 29.975, lng: 31.137 }), act('Karnak', LUXOR), act('Luxor Temple', { lat: 25.699, lng: 32.639 })],
        },
    ];
    const result = validateItineraryGeography(days, { controlPanel, isBreakEntry });
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((i) => i.type === 'geographic_spread'));
    assert.ok(result.issues[0].distanceKm > 400);
});

test('repair splits an impossible day and reports the fix', () => {
    const days = [
        { day: 1, date: '2026-09-01', activities: [act('Pyramids', CAIRO), act('Karnak', LUXOR)] },
        { day: 2, date: '2026-09-02', activities: [act('Sphinx', { lat: 29.975, lng: 31.137 }), act('Luxor Temple', { lat: 25.699, lng: 32.639 })] },
    ];

    const { days: fixed, repaired } = repairItineraryGeography(days, { controlPanel, origin: CAIRO, maxPerDay: 3 });
    assert.equal(repaired, true, 'the plan should have been reorganized');

    const after = validateItineraryGeography(fixed, { controlPanel, isBreakEntry });
    assert.ok(
        !after.issues.some((i) => i.type === 'geographic_spread'),
        'no day may still mix distant locations'
    );
});

test('repair keeps lunch breaks pinned and still excludes them from counts', () => {
    const days = [
        {
            day: 1,
            date: '2026-09-01',
            activities: [act('Pyramids', CAIRO), act('Karnak', LUXOR), buildBreakEntry({ startTime: '13:00', endTime: '14:00' })],
        },
        { day: 2, date: '2026-09-02', activities: [act('Sphinx', { lat: 29.975, lng: 31.137 })] },
    ];

    const { days: fixed } = repairItineraryGeography(days, { controlPanel, origin: CAIRO, maxPerDay: 3 });
    assert.equal(countActivities(fixed), 3, 'still 3 real activities after the repair');

    const breaks = fixed.flatMap((d) => (d.activities || []).filter(isBreakEntry));
    assert.equal(breaks.length, 1, 'the break survives the reshuffle exactly once');
});

test('a feasible plan is left untouched', () => {
    const days = [
        { day: 1, date: '2026-09-01', activities: [act('Pyramids', CAIRO), act('Egyptian Museum', GIZA_MUSEUM)] },
    ];
    const { repaired, validation } = repairItineraryGeography(days, { controlPanel, origin: CAIRO });
    assert.equal(validation.ok, true);
    assert.equal(repaired, false);
});

test('activities with no geographic data are left in generated order', () => {
    const days = [
        { day: 1, date: '2026-09-01', activities: [{ title: 'Mystery A' }, { title: 'Mystery B' }] },
    ];
    const { repaired } = repairItineraryGeography(days, { controlPanel });
    assert.equal(repaired, false, 'nothing to reason about — do not shuffle blindly');
});

// ─── Regression: models emit the string "null" as an activityId ──────────────

test('a string "null" activityId does not mask a break entry', () => {
    // Production data contained priced "Lunch Break" rows carrying the *string* "null"
    // (the AI prompt's own example asked for it). Being truthy, it made them look
    // catalogue-linked and they kept inflating activity totals.
    const entry = { title: 'Lunch Break', category: 'dining', activityId: 'null', price: 15 };
    assert.equal(isBreakEntry(entry), true);
    assert.equal(countActivities([{ activities: [entry] }]), 0);
});

test('placeholder activityId spellings all mean "no link"', () => {
    for (const id of ['null', 'NULL', 'undefined', '', '  ', 'none', 'n/a', null, undefined]) {
        assert.equal(resolveActivityId(id), null, `${JSON.stringify(id)} must resolve to null`);
        assert.equal(isBreakEntry({ title: 'Lunch Break', activityId: id }), true);
    }
});

test('a genuine activityId is preserved and still blocks break classification', () => {
    assert.equal(resolveActivityId('  698b406e95c25431747632b8 '), '698b406e95c25431747632b8');
    assert.equal(isBreakEntry({ title: 'Lunch Break', activityId: '698b406e95c25431747632b8' }), false);
});

test('marking a break normalises its id and price', () => {
    const [day] = markBreakEntries([
        { activities: [{ title: 'Lunch Break', category: 'dining', activityId: 'null', price: 15 }] },
    ]);
    const entry = day.activities[0];
    assert.equal(entry.isBreak, true);
    assert.equal(entry.activityId, null, 'the bogus string id is normalised away');
});

test('a "Leisure" category alone does not make something a break', () => {
    // "Beach Day" / "Relaxation Day" are real things the traveler does; only explicit
    // break wording (or the canonical marker) may exclude an entry.
    assert.equal(isBreakEntry({ title: 'Beach Day', category: 'Leisure', activityId: null }), false);
    assert.equal(isBreakEntry({ title: 'Relaxation Day', category: 'Leisure', activityId: null }), false);
    assert.equal(isBreakEntry({ title: 'At Leisure', category: 'Leisure', activityId: null }), true);
});
