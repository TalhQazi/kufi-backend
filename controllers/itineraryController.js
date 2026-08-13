const mongoose = require('mongoose');
const OpenAI = require('openai');
const bcrypt = require('bcryptjs');
const Itinerary = require('../models/Itinerary');
const Activity = require('../models/Activity');
const Hotel = require('../models/Hotel');
const Booking = require('../models/Booking');
const User = require('../models/User');
const { parseBudget, applyBudgetToDocument } = require('../utils/parseBudget');
const { sendEmail } = require('../utils/emailService');
const { notifyPreset } = require('../utils/createNotification');
const {
    toDateString,
    addDays,
    daysBetween,
    getDayName,
} = require('../utils/calendarDate');
const {
    isBreakEntry,
    countActivities,
    markBreakEntries,
    buildBreakEntry,
    resolveActivityId,
} = require('../utils/activityClassification');
const {
    getCoordinates,
    haversineKm,
    travelMinutesForKm,
    clusterByGeography,
    validateItineraryGeography,
    parseDurationMinutes,
    SAME_AREA_RADIUS_KM,
    FLIGHT_THRESHOLD_KM,
    resolveLunchWindow,
    parseTimeToMinutes,
    minutesToTime,
    roundUpToStep,
} = require('../utils/geo');
const {
    planActivitiesAcrossDays,
    repairItineraryGeography,
    describeTransfer,
    enforceDayBoundaries,
    fillDaysFromCatalogue,
    trimToBudget,
    selectActivitiesForTrip,
} = require('../utils/itineraryGeoPlanner');

// ─── helpers ────────────────────────────────────────────────────────────────

function escapeRegExp(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getOpenAIClient() {
    const key = process.env.OPENAI_API_KEY;
    if (!key) return null;
    return new OpenAI({ apiKey: key });
}

/**
 * Who may see an itinerary: the traveler it belongs to, the supplier building it, or an
 * admin. Every itinerary route resolves the document through `loadItineraryFor` so no
 * handler can forget the check.
 */
function canAccessItinerary(itinerary, user) {
    if (!itinerary || !user?.id) return false;
    if (user.role === 'admin') return true;
    if (user.role === 'supplier') return String(itinerary.supplierId || '') === String(user.id);
    return String(itinerary.userId || '') === String(user.id);
}

/** Only the owning supplier (or an admin) may edit or generate an itinerary. */
function canEditItinerary(itinerary, user) {
    if (!itinerary || !user?.id) return false;
    if (user.role === 'admin') return true;
    return user.role === 'supplier' && String(itinerary.supplierId || '') === String(user.id);
}

/**
 * Load an itinerary and authorize the caller in one step.
 *
 * Responds and returns null when the itinerary is missing or the caller is not allowed
 * to touch it, so handlers can simply `if (!itinerary) return;`.
 *
 * @param {'read'|'edit'} mode
 */
async function loadItineraryFor(req, res, mode = 'read', { lean = false } = {}) {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
        res.status(400).json({ msg: 'Invalid itinerary id' });
        return null;
    }

    const query = Itinerary.findById(id);
    const itinerary = lean ? await query.lean() : await query;
    if (!itinerary) {
        res.status(404).json({ msg: 'Itinerary not found' });
        return null;
    }

    const allowed = mode === 'edit'
        ? canEditItinerary(itinerary, req.user)
        : canAccessItinerary(itinerary, req.user);

    if (!allowed) {
        // 404 rather than 403: a caller with no rights to this record should not be able
        // to confirm that it exists.
        res.status(404).json({ msg: 'Itinerary not found' });
        return null;
    }

    return itinerary;
}

function getActivitiesForBudget(bookingActivities, activities, budget) {
    const required = Array.isArray(bookingActivities) ? bookingActivities : [];
    const available = Array.isArray(activities) ? activities : [];
    
    if (budget === undefined || budget === null || typeof budget !== 'number') {
        return required.length > 0 ? required : available;
    }

    const selected = [...required];
    let total = required.reduce((sum, a) => sum + (Number(a.price) || 0), 0);

    const requiredIds = new Set(required.map(r => String(r._id)));
    const remainingAvailable = available.filter(a => !requiredIds.has(String(a._id)));

    // Sort remaining available activities by price ascending to fit as many as possible
    const sortedAvailable = [...remainingAvailable].sort((a, b) => (Number(a.price) || 0) - (Number(b.price) || 0));

    for (const act of sortedAvailable) {
        const price = Number(act.price) || 0;
        if (total + price <= budget) {
            selected.push(act);
            total += price;
        }
    }

    return selected;
}

function getActivityTimeSlot(index, startStr, endStr, lunchStartStr, lunchEndStr, lunchDurationMins) {
    const toMin = (t) => {
        if (!t) return 0;
        const [h, m] = t.split(':').map(Number);
        return h * 60 + (m || 0);
    };
    const toTimeStr = (m) => {
        const h = Math.floor(m / 60) % 24;
        const mins = m % 60;
        return `${String(h).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
    };

    const dayStart = toMin(startStr || '09:00');
    const dayEnd = toMin(endStr || '19:00');
    const lunchStart = toMin(lunchStartStr || '13:00');
    
    let lunchEnd = toMin(lunchEndStr || '14:00');
    if (Number.isFinite(Number(lunchDurationMins)) && Number(lunchDurationMins) > 0) {
        lunchEnd = lunchStart + Number(lunchDurationMins);
    }

    const slotDuration = 120; // 2 hours
    const slots = [];
    let current = dayStart;

    while (current + slotDuration <= dayEnd) {
        const slotEnd = current + slotDuration;
        const overlapsLunch = (current < lunchEnd && slotEnd > lunchStart);

        if (overlapsLunch) {
            current = lunchEnd;
            continue;
        }

        slots.push({ start: current, end: slotEnd });
        current = slotEnd;
    }

    const slot = slots[index % (slots.length || 1)] || { start: dayStart, end: dayStart + slotDuration };
    return {
        startTime: toTimeStr(slot.start),
        endTime: toTimeStr(slot.end)
    };
}

/**
 * Total price of the real activities in a plan.
 *
 * Schedule breaks are never billable, so they are excluded.
 *
 * The budget is ADVISORY, not a filter. Activities used to be dropped once the cumulative
 * price passed the ceiling, which is what left most of a long trip empty: a 10-day
 * itinerary on a small budget produced one populated day and nine blank ones. Trip length
 * now wins — every day is filled, and the summary flags the overrun instead.
 */
function sumActivitySpend(days) {
    return (Array.isArray(days) ? days : []).reduce((total, d) => {
        const item = d?.toObject ? d.toObject() : d;
        return total + (item.activities || [])
            .filter((a) => !isBreakEntry(a))
            .reduce((s, a) => s + (Number(a.price) || 0), 0);
    }, 0);
}

/**
 * Where an activity's cover image lives.
 *
 * Day entries store this path rather than the base64 blob. Embedding the image made a
 * generated itinerary average 852KB (the largest was 7.1MB for 13 activities), and the
 * same picture was duplicated into every itinerary that used the activity.
 */
function activityImageUrl(activityId) {
    return activityId ? `/api/activities/${activityId}/image` : '';
}

/**
 * Upper bound on real activities in a single day.
 *
 * A coarse guard that sits on top of the real constraint — the day's time budget
 * (durations plus travel), which is enforced separately. Measured on an 8-day Egypt trip:
 * 3/day scheduled 21 activities, 4/day scheduled 26, and 5/day also scheduled 26 because
 * time capacity became the binding limit. Neither 4 nor 5 produced a single overrunning
 * day, so 4 is the point where the cap stops doing the work and capacity takes over.
 */
const MAX_ACTIVITIES_PER_DAY = Number(process.env.ITINERARY_MAX_ACTIVITIES_PER_DAY) || 4;

/**
 * How many catalogue rows are offered to the model.
 *
 * The catalogue was ~85% of the prompt (104 rows ≈ 5,700 of 6,749 input tokens for one
 * Egypt trip) while a 7-day itinerary can only use ~20 of them. Offering a well-chosen
 * shortlist costs a fraction and produces the same plan.
 */
const AI_CATALOGUE_LIMIT = Number(process.env.ITINERARY_AI_CATALOGUE_LIMIT) || 45;

/**
 * Pick the activities worth showing the model.
 *
 * Naively slicing the list would silently drop whole destinations — Cairo has far more
 * rows than Luxor or Aswan, so the top 45 by rating would be all-Cairo and a multi-city
 * trip could never be planned. Instead the catalogue is clustered geographically and
 * drawn from round-robin, so every base stays represented.
 *
 * Activities that cannot fit the budget ceiling on their own are dropped first: the model
 * can never legitimately use them.
 */
function selectCatalogueForPrompt(activities, { limit = AI_CATALOGUE_LIMIT, activityBudget, required = [] } = {}) {
    const list = (Array.isArray(activities) ? activities : []).filter(Boolean);
    if (list.length <= limit) return list;

    const requiredIds = new Set((required || []).map((a) => String(a?._id)).filter(Boolean));

    // Price is no longer a gate. The budget is advisory, and excluding expensive
    // activities here starved long trips of anything to schedule.
    const affordable = list;

    const clusters = clusterByGeography(affordable).map((c) => ({
        ...c,
        // Best first within each area.
        items: [...c.items].sort((a, b) => (Number(b.rating) || 0) - (Number(a.rating) || 0)),
    }));

    // Anything the traveler explicitly asked for is never dropped.
    const picked = affordable.filter((a) => requiredIds.has(String(a._id)));
    const seen = new Set(picked.map((a) => String(a._id)));

    let cursor = 0;
    while (picked.length < limit) {
        let addedThisPass = false;
        for (const cluster of clusters) {
            if (picked.length >= limit) break;
            const next = cluster.items[cursor];
            if (!next) continue;
            const key = String(next._id);
            if (seen.has(key)) continue;
            seen.add(key);
            picked.push(next);
            addedThisPass = true;
        }
        if (!addedThisPass) break;
        cursor += 1;
    }

    return picked;
}

/**
 * Render the shortlist for the prompt.
 *
 * Deliberately terse. Each row used to carry a 24-character hex ObjectId (~12 tokens on
 * its own) plus a `location` that was identical on every row. Short `#N` handles are
 * mapped back to real ids server-side, coordinates are rounded to 2dp (~1km, ample for a
 * 60km grouping rule), and the redundant location is omitted.
 */
function buildCataloguePrompt(shortlist, { destination = '' } = {}) {
    const indexToActivity = new Map();

    const lines = shortlist.map((a, i) => {
        const handle = i + 1;
        indexToActivity.set(handle, a);

        const c = getCoordinates(a);
        const place = String(a.city || a.location || '').trim();
        const parts = [`#${handle} ${a.title}`];
        if (c) parts.push(`${c.lat.toFixed(2)},${c.lng.toFixed(2)}`);
        // Only worth sending when it distinguishes this row from the destination itself.
        if (place && place.toLowerCase() !== String(destination).toLowerCase()) parts.push(place);
        parts.push(String(a.duration || '2h').replace(/\s*hours?/i, 'h').replace(/\s*mins?/i, 'm'));
        parts.push(`$${Number(a.price) || 0}`);
        if (a.category) parts.push(String(a.category).toLowerCase());

        return parts.join(' | ');
    });

    return { text: lines.join('\n'), indexToActivity };
}

function buildDefaultDays(itinerary, activities = [], isBookingSpecific = false, activityBudget = undefined, { hotelCoords = null } = {}) {
    const cp = itinerary.controlPanel || {};
    const startDate = toDateString(itinerary.startDate);
    const endDate = toDateString(itinerary.endDate);
    const tripDays = (startDate && endDate) ? daysBetween(startDate, endDate) : 3;
    
    // Respect the budget constraint
    // Cheapest-first to guarantee a full trip, then the best of what the budget allows.
    const activeDayCount = countActiveDays(itinerary, tripDays);
    const usableActs = selectActivitiesForTrip(activities, {
        required: isBookingSpecific ? activities : [],
        budget: activityBudget !== undefined ? activityBudget : itinerary.budget,
        activeDays: activeDayCount,
        maxPerDay: MAX_ACTIVITIES_PER_DAY,
    });

    // Prioritize landmark/iconic activities (e.g. Pyramids, Sphinx)
    const sortedActs = [...usableActs].sort((a, b) => {
        const titleA = String(a.title || '').toLowerCase();
        const titleB = String(b.title || '').toLowerCase();
        const isLandmarkA = /pyramid|sphinx|museum|karnak|burj|eiffel|colosseum/i.test(titleA);
        const isLandmarkB = /pyramid|sphinx|museum|karnak|burj|eiffel|colosseum/i.test(titleB);
        if (isLandmarkA && !isLandmarkB) return -1;
        if (!isLandmarkA && isLandmarkB) return 1;
        return (Number(b.rating) || 0) - (Number(a.rating) || 0);
    });

    const endOnDeparture = cp.endOnDeparture !== false;

    const days = [];
    const activeDayIndices = [];
    for (let idx = 0; idx < tripDays; idx++) {
        const newDate = startDate ? addDays(startDate, idx) : '';
        const isArrival = idx === 0;
        const isDeparture = idx === tripDays - 1;

        let isActive = true;
        if (isArrival && !cp.startOnArrival) {
            isActive = false;
        }
        if (isDeparture && !endOnDeparture) {
            isActive = false;
        }

        days.push({
            day: idx + 1,
            date: newDate,
            dayName: getDayName(newDate),
            isArrivalDay: isArrival,
            isDepartureDay: isDeparture,
            arrivalNote: isArrival && !cp.startOnArrival ? 'Arrival Day — Airport to Hotel transfer provided.' : (isArrival ? 'Arrival Day — Checked in and ready for activities.' : undefined),
            departureNote: isDeparture ? 'Departure Day — Hotel to Airport transfer provided.' : undefined,
            activities: [],
        });

        if (isActive) {
            activeDayIndices.push(idx);
        }
    }

    if (activeDayIndices.length === 0) {
        for (let idx = 0; idx < tripDays; idx++) {
            activeDayIndices.push(idx);
        }
    }

    // Group activities by real geography (coordinates first, place labels as fallback)
    // and lay them out so each day stays within one area and within its time budget.
    // The previous version grouped on a location string only, which put Cairo and Luxor
    // activities on the same day whenever both were labelled "Egypt".
    const activeDays = activeDayIndices.map((index) => ({ index, date: days[index].date }));
    const candidateActs = isBookingSpecific ? sortedActs : sortedActs.slice(0, activeDayIndices.length * 4);

    const { assignments, transfers } = planActivitiesAcrossDays(candidateActs, {
        activeDays,
        controlPanel: cp,
        origin: hotelCoords || null,
        maxPerDay: MAX_ACTIVITIES_PER_DAY,
    });

    activeDayIndices.forEach((dayIdx) => {
        const targetDate = days[dayIdx].date;
        const dayOverride = (cp.perDayOverrides || []).find(o => o.date === targetDate) || {};

        const activityStartTime = dayOverride.startTime || cp.activityStartTime || '09:00';
        const activityEndTime = dayOverride.endTime || cp.activityEndTime || '19:00';
        // Centred in the day's activity window from the configured duration, so the same
        // setting applies consistently to every day.
        const { lunchStart, lunchEnd } = resolveLunchWindow(cp, dayOverride);

        const transfer = transfers.get(dayIdx);
        if (transfer) {
            days[dayIdx].transferNote = describeTransfer(transfer);
            days[dayIdx].transfer = transfer;
        }

        (assignments.get(dayIdx) || []).forEach((act, existingCount) => {
            const { startTime, endTime } = getActivityTimeSlot(
                existingCount,
                activityStartTime,
                activityEndTime,
                lunchStart,
                lunchEnd
            );

            days[dayIdx].activities.push({
                activityId: act._id ? String(act._id) : null,
                title: act.title || '',
                description: act.description || '',
                location: act.location || act.city || itinerary.city || '',
                coordinates: getCoordinates(act) || undefined,
                duration: act.duration || undefined,
                startTime,
                endTime,
                price: Number(act.price) || 0,
                category: act.category || 'general',
                image: activityImageUrl(act._id),
                isBreak: false,
                isSupplierOnly: true,
            });
        });

        // The lunch break is added centrally by applyDaySchedule, so every generation
        // path ends up with exactly one break at the configured window.
    });

    return days;
}

/**
 * Re-attach catalogue data (coordinates, duration, location) to day entries.
 *
 * Days cloned from an older itinerary — or returned by the model — carry only what was
 * stored at the time, and entries written before coordinates existed have none. Without
 * this the geographic validation layer has nothing to measure and silently does nothing,
 * so a cloned Cairo+Luxor day would pass straight through.
 *
 * Matches on activityId first, then on an exact title, and leaves untouched anything it
 * cannot resolve.
 */
function hydrateDayActivities(days, catalogue) {
    const byId = new Map();
    const byTitle = new Map();
    (catalogue || []).forEach((a) => {
        byId.set(String(a._id), a);
        const t = String(a.title || '').trim().toLowerCase();
        if (t && !byTitle.has(t)) byTitle.set(t, a);
    });

    return (Array.isArray(days) ? days : []).map((day) => {
        const item = day?.toObject ? day.toObject() : day;
        const activities = Array.isArray(item?.activities) ? item.activities : [];
        return {
            ...item,
            activities: activities.map((entry) => {
                const act = entry?.toObject ? entry.toObject() : entry;
                if (isBreakEntry(act)) return act;

                const linkedId = resolveActivityId(act.activityId);
                const match =
                    (linkedId && byId.get(linkedId)) ||
                    byTitle.get(String(act.title || '').trim().toLowerCase());

                if (!match) return { ...act, activityId: linkedId };

                const coords = getCoordinates(act) || getCoordinates(match);
                return {
                    ...act,
                    activityId: linkedId || String(match._id),
                    // Replace any inherited base64 blob with the URL form.
                    image: activityImageUrl(linkedId || match._id),
                    coordinates: coords || act.coordinates,
                    duration: act.duration || match.duration,
                    location: act.location || match.location || match.city,
                };
            }),
        };
    });
}

// Shift template days to new itinerary's dates, keep activity structure intact
function adaptDaysToItinerary(templateDays, itinerary) {
    const startDate = toDateString(itinerary.startDate);
    const endDate = toDateString(itinerary.endDate);

    const tripLength = (startDate && endDate)
        ? daysBetween(startDate, endDate)
        : templateDays.length;

    // Trim or pad to match trip length
    let days = [...templateDays];
    if (days.length > tripLength) days = days.slice(0, tripLength);
    while (days.length < tripLength) {
        days.push({ day: days.length + 1, activities: [] });
    }

    return days.map((d, idx) => {
        const newDate = startDate ? addDays(startDate, idx) : (d.date || '');
        const isArrival = idx === 0;
        const isDeparture = idx === days.length - 1;
        return {
            ...d,
            day: idx + 1,
            date: newDate,
            dayName: getDayName(newDate),
            isArrivalDay: isArrival,
            isDepartureDay: isDeparture,
            departureNote: isDeparture ? (d.departureNote || 'Departure Day — Hotel to Airport transfer provided.') : undefined,
            arrivalNote: isArrival ? (d.arrivalNote || 'Arrival Day — Checked in and ready for activities.') : undefined,
        };
    });
}

// ─── GET user itineraries ────────────────────────────────────────────────────

exports.getUserItineraries = async (req, res) => {
    try {
        const userId = req.user?.id;
        const role = req.user?.role;

        if (!userId) return res.status(401).json({ msg: 'User not authenticated' });
        if (!mongoose.Types.ObjectId.isValid(userId)) return res.status(400).json({ msg: 'Invalid user ID format' });

        const projection = {
            userId: 1, supplierId: 1, bookingId: 1, requestId: 1,
            title: 1, destination: 1, location: 1, status: 1, imageUrl: 1,
            startDate: 1, endDate: 1, numberOfTravelers: 1, budget: 1,
            notes: 1, tripData: 1, country: 1, city: 1, aiGenerated: 1,
            aiGeneratedAt: 1, generationSource: 1, createdAt: 1, updatedAt: 1,
        };

        let itineraries;
        if (role === 'supplier') {
            itineraries = await Itinerary.find({ supplierId: userId }, projection)
                .populate('supplierId', 'name avatar profileImage')
                .sort({ createdAt: -1 }).limit(50).lean().maxTimeMS(8000);
        } else {
            itineraries = await Itinerary.find({ userId }, projection)
                .populate('supplierId', 'name avatar profileImage')
                .sort({ createdAt: -1 }).limit(50).lean().maxTimeMS(8000);
        }

        res.json(itineraries);
    } catch (err) {
        console.error('getUserItineraries error:', err?.message);
        res.status(500).json({ msg: 'Server error', error: err?.message });
    }
};

// ─── ADMIN list all itineraries ──────────────────────────────────────────────

exports.getAllItinerariesAdmin = async (req, res) => {
    try {
        if (req.user?.role !== 'admin') {
            return res.status(403).json({ msg: 'Admin only' });
        }
        const itineraries = await Itinerary.find({})
            .select('title destination status days startDate endDate createdAt updatedAt supplierId userId bookingId')
            .sort({ updatedAt: -1 })
            .limit(200)
            .lean();
        res.json(Array.isArray(itineraries) ? itineraries : []);
    } catch (err) {
        console.error('getAllItinerariesAdmin error:', err?.message || err);
        res.json([]);
    }
};

// ─── CREATE itinerary ────────────────────────────────────────────────────────

exports.createItinerary = async (req, res) => {
    try {
        const authUserId = req.user?.id;
        const role = req.user?.role;

        const requestedUserId = req.body?.userId;
        let userId = role === 'supplier' ? requestedUserId : authUserId;

        const bookingIdValEarly = req.body?.bookingId || req.body?.requestId;
        let bookingDoc = null;
        if (bookingIdValEarly && mongoose.Types.ObjectId.isValid(bookingIdValEarly)) {
            bookingDoc = await Booking.findById(bookingIdValEarly);
            if (bookingDoc) {
                // A supplier may only build an itinerary for a request that was routed
                // to them — otherwise they could attach themselves to any booking in
                // the system and read the traveler's details.
                if (role === 'supplier' && String(bookingDoc.supplier || '') !== String(authUserId)) {
                    return res.status(403).json({ msg: 'This request is not assigned to you' });
                }
                if (role !== 'supplier' && role !== 'admin' && String(bookingDoc.user || '') !== String(authUserId)) {
                    return res.status(403).json({ msg: 'Access denied' });
                }
                // The traveler on the booking is authoritative — not a client-supplied id.
                userId = bookingDoc.user || userId;
            }
        }

        // If traveler user is still not resolved, resolve by email or create a placeholder guest account
        if (!userId && bookingDoc && bookingDoc.contactDetails?.email) {
            const emailClean = String(bookingDoc.contactDetails.email).trim().toLowerCase();
            let existingUser = await User.findOne({ email: new RegExp(`^${escapeRegExp(emailClean)}$`, 'i') });
            if (existingUser) {
                userId = existingUser._id;
            } else {
                const name = `${bookingDoc.contactDetails.firstName || ''} ${bookingDoc.contactDetails.lastName || ''}`.trim() || 'Guest Traveler';
                const hashedPassword = await bcrypt.hash('KufiGuest123!', 10);
                const newUser = new User({
                    name,
                    email: emailClean,
                    password: hashedPassword,
                    role: 'user',
                    status: 'active',
                    phone: bookingDoc.contactDetails.phone || '',
                });
                await newUser.save();
                userId = newUser._id;
            }
            bookingDoc.user = userId;
            await bookingDoc.save();
        }

        if (!userId) return res.status(400).json({ msg: 'Traveler user is required on this booking' });
        if (!mongoose.Types.ObjectId.isValid(userId)) return res.status(400).json({ msg: 'Invalid userId format' });

        const tripData = req.body?.tripData;
        const title = req.body?.title || tripData?.title;
        const destination = req.body?.destination || tripData?.destination || tripData?.location;

        const bookingIdVal = req.body?.bookingId || req.body?.requestId;
        // A supplier is always recorded as themselves; only an admin may assign one.
        const supplierIdVal = role === 'supplier'
            ? authUserId
            : (role === 'admin' ? req.body?.supplierId : undefined);

        if (bookingIdVal && !mongoose.Types.ObjectId.isValid(bookingIdVal)) return res.status(400).json({ msg: 'Invalid bookingId format' });
        if (supplierIdVal && !mongoose.Types.ObjectId.isValid(supplierIdVal)) return res.status(400).json({ msg: 'Invalid supplierId format' });

        if (bookingIdVal) {
            const existingForBooking = await Itinerary.findOne({ bookingId: bookingIdVal });
            if (existingForBooking) {
                applyBudgetToDocument(existingForBooking);
                await existingForBooking.save();
                await existingForBooking.populate('controlPanel.hotelId');
                return res.json(existingForBooking);
            }
        }

        const country = req.body?.country || tripData?.country || '';
        const city = req.body?.city || tripData?.city || '';
        const resolvedDestination = destination || city || country;

        if (!resolvedDestination) {
            return res.status(400).json({ msg: 'Missing required fields: destination (or country/city)' });
        }

        const parsedBudget = parseBudget(req.body?.budget ?? tripData?.budget);
        const itineraryData = {
            userId,
            supplierId: supplierIdVal,
            bookingId: bookingIdVal,
            title: title || resolvedDestination,
            destination: resolvedDestination,
            country: country || undefined,
            city: city || undefined,
            location: req.body?.location,
            startDate: req.body?.startDate,
            endDate: req.body?.endDate,
            numberOfTravelers: Number(req.body?.numberOfTravelers) || 2,
            tripData: tripData || req.body?.tripData,
            days: Array.isArray(req.body?.days) ? req.body.days : [],
            controlPanel: req.body?.controlPanel || undefined,
        };
        if (parsedBudget !== undefined) {
            itineraryData.budget = parsedBudget;
        }

        const itinerary = new Itinerary(itineraryData);

        await itinerary.save();
        await itinerary.populate('controlPanel.hotelId');

        try {
            if (itinerary.userId) {
                await notifyPreset('under_review', {
                    userId: itinerary.userId,
                    bookingId: itinerary.bookingId,
                    itineraryId: itinerary._id,
                    destination: itinerary.destination,
                    message: `Your trip to ${itinerary.destination || 'your destination'} is under review.`,
                });
            }
        } catch (notifErr) {
            console.error('Error creating under_review notification:', notifErr?.message || notifErr);
        }

        res.status(201).json(itinerary);
    } catch (err) {
        console.error('createItinerary error:', err?.message);
        res.status(500).json({ msg: 'Server error', error: err?.message });
    }
};

// ─── GET by ID ───────────────────────────────────────────────────────────────

exports.getItineraryById = async (req, res) => {
    try {
        const itinerary = await loadItineraryFor(req, res, 'read');
        if (!itinerary) return;
        await itinerary.populate('controlPanel.hotelId');
        res.json(itinerary.toObject());
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ msg: 'Server error', error: err?.message });
    }
};

exports.getItineraryByBookingId = async (req, res) => {
    try {
        const { bookingId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(bookingId)) {
            return res.status(400).json({ msg: 'Invalid bookingId format' });
        }

        const itinerary = await Itinerary.findOne({ bookingId }).populate('controlPanel.hotelId').lean();

        if (!itinerary) return res.status(404).json({ msg: 'Itinerary not found for this booking' });
        if (!canAccessItinerary(itinerary, req.user)) {
            return res.status(404).json({ msg: 'Itinerary not found for this booking' });
        }
        res.json(itinerary);
    } catch (err) {
        console.error('getItineraryByBookingId error:', err?.message);
        res.status(500).json({ msg: 'Server error', error: err?.message });
    }
};

async function fetchActivitiesForDestination(country, city) {
    const query = { status: 'approved' };
    const orClause = [];
    if (country) orClause.push({ country: new RegExp(`^${escapeRegExp(country)}$`, 'i') });
    if (city) orClause.push({ location: new RegExp(escapeRegExp(city), 'i') });
    if (orClause.length) query.$or = orClause;
    return Activity.find(query)
        // `coordinates` drives geographic grouping. `image`/`images` are deliberately NOT
        // selected: they are base64 (86% of this query's bytes) and day entries reference
        // the image by URL instead of embedding it.
        .select('_id title description duration price category location country city coordinates rating reviews highlights')
        .lean();
}

/**
 * Turn the model's reply into day objects.
 *
 * The compact format is `[{ day, ids:[#n], custom:[{title,...}] }]`. `response_format:
 * json_object` means the reply is an object, so the array may be wrapped under any key.
 *
 * The previous verbose shape (full activity objects per day) is still accepted, so a
 * model that ignores the instruction — or a cached/older response — does not break
 * generation.
 *
 * @returns {Array} days in the shape the enrichment step expects
 */
function parseAiItineraryReply(rawContent, { indexToActivity, tripDays }) {
    const raw = String(rawContent || '').trim();
    const cleaned = raw.startsWith('[') || raw.startsWith('{')
        ? raw
        : raw.replace(/```json\n?/i, '').replace(/```\n?$/, '').trim();

    const parsed = JSON.parse(cleaned);

    // Unwrap. `json_object` mode forces an object reply, and the wrapper key varies, so
    // several shapes have to be tolerated. The generic search only accepts arrays that
    // actually look like days — otherwise a reply of `{"day":1,"ids":[]}` would have its
    // `ids` array mistaken for the day list and produce an empty itinerary.
    const looksLikeDayList = (v) =>
        Array.isArray(v) && v.length > 0 && v.every(
            (e) => e && typeof e === 'object' && !Array.isArray(e) &&
                ('ids' in e || 'activityIds' in e || 'activities' in e || 'day' in e)
        );

    let list = null;
    if (looksLikeDayList(parsed)) list = parsed;
    else if (looksLikeDayList(parsed?.days)) list = parsed.days;
    else if (looksLikeDayList(parsed?.itinerary)) list = parsed.itinerary;
    else list = Object.values(parsed || {}).find(looksLikeDayList) || null;

    // A bare single day object is a valid (if unhelpful) reply — treat it as a one-item list.
    if (!list && parsed && typeof parsed === 'object' && ('ids' in parsed || 'activities' in parsed)) {
        list = [parsed];
    }

    if (!Array.isArray(list) || list.length === 0) {
        throw new Error('AI reply did not contain a usable day array');
    }
    if (tripDays) list = list.slice(0, tripDays);

    // The prompt forbids repeats, but the model does not always comply — and asking it to
    // fill every day makes repetition more tempting. Deduplicate here so the same
    // activity can never appear on two days of one itinerary.
    const seenIds = new Set();
    const seenTitles = new Set();

    return list.map((entry, idx) => {
        const day = entry || {};

        // Verbose shape: activities already spelled out.
        if (Array.isArray(day.activities)) {
            return { ...day, day: idx + 1 };
        }

        // Compact shape: resolve #numbers back to catalogue activities.
        const ids = Array.isArray(day.ids) ? day.ids : (Array.isArray(day.activityIds) ? day.activityIds : []);
        const fromCatalogue = ids
            .map((n) => indexToActivity.get(Number(String(n).replace('#', ''))))
            .filter(Boolean)
            .filter((act) => {
                const key = String(act._id);
                if (seenIds.has(key)) return false;
                seenIds.add(key);
                return true;
            })
            .map((act) => ({
                activityId: String(act._id),
                title: act.title,
                description: act.description,
                location: act.location || act.city,
                coordinates: getCoordinates(act) || undefined,
                duration: act.duration,
                price: Number(act.price) || 0,
                category: act.category || 'general',
                image: activityImageUrl(act._id),
                isBreak: false,
                isSupplierOnly: true,
            }));

        const custom = (Array.isArray(day.custom) ? day.custom : [])
            .filter((c) => String(c?.title || '').trim())
            .filter((c) => {
                // Custom entries have no id, so they are deduplicated on title.
                const key = String(c.title).trim().toLowerCase();
                if (seenTitles.has(key)) return false;
                seenTitles.add(key);
                return true;
            })
            .map((c) => ({
                activityId: null,
                title: String(c.title).trim(),
                description: String(c.description || '').trim(),
                location: String(c.location || '').trim(),
                duration: c.duration || undefined,
                price: Number(c.price) || 0,
                category: String(c.category || 'general').toLowerCase(),
                image: '',
                isBreak: false,
                isSupplierOnly: true,
            }));

        return { day: idx + 1, activities: [...fromCatalogue, ...custom] };
    });
}

/**
 * Impose the Control Panel's daily schedule on a finished plan.
 *
 * Runs on every generation path — AI, database template and built-from-catalogue — so the
 * supplier's settings are always what the itinerary reflects. Previously only the
 * built-from-catalogue path consulted them: a cloned template kept whatever times and
 * lunch break the *original* itinerary had, which is why changing the activity hours or
 * the lunch duration appeared to do nothing.
 *
 * For each day it:
 *   - re-slots the real activities into the configured activity window, and
 *   - replaces any break entries with exactly one lunch break at the derived window
 *     (or none at all when the duration is zero).
 */
function applyDaySchedule(days, controlPanel = {}, tripStartDate = null) {
    const cp = controlPanel?.toObject ? controlPanel.toObject() : (controlPanel || {});
    const start = toDateString(tripStartDate);

    return (Array.isArray(days) ? days : []).map((day, idx) => {
        const item = day?.toObject ? day.toObject() : day;
        const entries = Array.isArray(item?.activities) ? item.activities : [];
        const real = entries.filter((a) => !isBreakEntry(a));

        if (real.length === 0) return { ...item, activities: [] };

        // The calendar date has to be derived here, not read off the day: per-day
        // overrides are keyed by date, and dates are only stamped later by
        // normalizeTripDays. On the AI path the day carried no date at all, so overrides
        // silently matched nothing.
        const date = (start ? addDays(start, idx) : '') || toDateString(item.date) || item.date || '';
        const override = (cp.perDayOverrides || []).find((o) => o.date === date) || {};
        const activityStartTime = override.startTime || cp.activityStartTime || '09:00';
        const activityEndTime = override.endTime || cp.activityEndTime || '19:00';
        const { lunchStart, lunchEnd, durationMinutes } = resolveLunchWindow(cp, override);

        // Pack the day sequentially from its start time, stepping over the lunch window
        // and using each activity's real duration.
        //
        // The previous approach indexed into a fixed list of two-hour slots and wrapped
        // with `index % slots.length`, so a day with more activities than slots handed
        // two of them the *same* start time (both showing 08:00). Packing forwards can
        // never collide.
        const dayStart = parseTimeToMinutes(activityStartTime, 9 * 60);
        const dayEnd = parseTimeToMinutes(activityEndTime, 19 * 60);
        const breakStart = parseTimeToMinutes(lunchStart, null);
        const breakEnd = parseTimeToMinutes(lunchEnd, null);
        const hasBreak = durationMinutes > 0 && breakStart !== null && breakEnd !== null;

        let cursor = dayStart;
        let previousCoords = null;

        const scheduled = real.map((act) => {
            const length = Math.max(15, parseDurationMinutes(act.durationMinutes ?? act.duration));
            const here = getCoordinates(act);

            // Getting between two places takes time. The capacity planner and the
            // geographic validator already charged for it, but the clock did not — so a
            // 20km hop was printed as if the traveller teleported. The gap is now real.
            let travelMinutes = 0;
            if (previousCoords && here) {
                const km = haversineKm(previousCoords, here);
                if (km !== null) travelMinutes = travelMinutesForKm(km);
                cursor += travelMinutes;
            }

            // Prefer not to straddle the lunch break — but only step over it when the
            // activity genuinely fits in what is left of the day. Pushing unconditionally
            // meant a 5-hour tour that could not finish before lunch was moved wholly
            // after it, wasting the entire morning and ending at 22:07. A long activity
            // simply spans lunch, which is what happens in reality.
            if (hasBreak && cursor < breakEnd && cursor + length > breakStart) {
                const fitsAfterBreak = breakEnd + length <= dayEnd;
                if (fitsAfterBreak) cursor = breakEnd;
            }

            // Snap the start onto the scheduling grid so clock times stay tidy even when
            // an activity's duration is not a round number. Snapping forward only ever
            // adds a little slack — it can never create an overlap.
            const startMinutes = cursor === dayStart ? cursor : roundUpToStep(cursor);
            const endMinutes = startMinutes + length;
            cursor = endMinutes;
            if (here) previousCoords = here;

            return {
                ...act,
                startTime: minutesToTime(startMinutes),
                // Not clamped to the day end any more. Now that travel is accounted for,
                // clamping would hide a genuine overrun behind a plausible-looking time.
                endTime: minutesToTime(endMinutes),
                // Exposed so the UI can show "30 min travel" between two stops.
                travelFromPreviousMinutes: travelMinutes,
            };
        });

        // A single break, on every day that actually has activities.
        const breaks = durationMinutes > 0
            ? [buildBreakEntry({
                title: 'Lunch Break',
                description: 'Time set aside for lunch.',
                startTime: lunchStart,
                endTime: lunchEnd,
            })]
            : [];

        const dayEndsAt = scheduled.length ? parseTimeToMinutes(scheduled[scheduled.length - 1].endTime, dayEnd) : dayEnd;

        return {
            ...item,
            activities: [...scheduled, ...breaks],
            // > 0 when travel pushed the day past its configured end time.
            overrunMinutes: Math.max(0, dayEndsAt - dayEnd),
        };
    });
}

/**
 * Normalize day metadata without dropping empty departure/arrival days.
 *
 * `tripStartDate` makes the calendar deterministic: day N is always start + N-1. The AI
 * reply no longer echoes dates back (it costs tokens and the value is derivable), so
 * without this the AI path produced days with empty `date` and `dayName`.
 */
function normalizeTripDays(days, tripStartDate = null) {
    if (!Array.isArray(days) || days.length === 0) return days;

    const start = toDateString(tripStartDate);

    // Stamp the canonical break marker so persisted data is self-describing and the
    // legacy title-matching fallback stops being needed for anything written from here on.
    const marked = markBreakEntries(days);

    return marked.map((d, idx) => {
        const item = d.toObject ? d.toObject() : d;
        const isArrival = idx === 0;
        const isDeparture = idx === marked.length - 1;
        // Prefer the trip's own calendar; fall back to whatever the day carried.
        const derivedDate = (start ? addDays(start, idx) : '') || toDateString(item.date) || item.date || '';
        return {
            ...item,
            day: idx + 1,
            date: derivedDate,
            dayName: getDayName(derivedDate) || item.dayName || '',
            isArrivalDay: isArrival,
            isDepartureDay: isDeparture,
            departureNote: isDeparture
                ? (item.departureNote || 'Departure Day — Hotel to Airport transfer provided.')
                : undefined,
            arrivalNote: isArrival
                ? (item.arrivalNote || 'Arrival Day — Checked in and ready for activities.')
                : undefined,
        };
    });
}

/**
 * Apply generated days to the itinerary document.
 *
 * By default the result is NOT written to the database: the supplier must stay in
 * control of when a generated itinerary becomes a draft ("Save to Draft") or is sent
 * to the traveler ("Send to Traveler"). Persisting here is what used to turn every AI
 * run into an immediate draft and silently move the request between supplier tabs.
 * Pass { persist: true } to opt back into the old write-through behaviour.
 */
async function saveGeneratedDays(itinerary, days, source, { persist = false, hotelCoords = null, budget = null, catalogue = [] } = {}) {
    applyBudgetToDocument(itinerary);

    // ── Post-generation validation layer ────────────────────────────────────────
    // Whatever produced these days (AI, template, or an adapted database template) may
    // have ignored geography. Validate travel distance, travel time and daily capacity,
    // and reorganize when the plan is not physically possible.
    const controlPanel = itinerary.controlPanel?.toObject
        ? itinerary.controlPanel.toObject()
        : (itinerary.controlPanel || {});

    // The arrival/departure toggles are enforced here rather than inside one generator.
    // The template-clone path copies days from an older itinerary and never consulted
    // them, so flipping "Start activities on arrival day" used to change nothing.
    const { days: boundedDays, changed: boundariesChanged } = enforceDayBoundaries(days, {
        controlPanel,
        origin: hotelCoords,
        maxPerDay: MAX_ACTIVITIES_PER_DAY,
    });

    // Budget no longer trims the plan, so an empty day means nothing was assigned there.
    // Fill those from the catalogue before validating, so additions are checked too.
    const { days: filledDays, filled: daysBackfilled, toppedUp: daysToppedUp } = fillDaysFromCatalogue(boundedDays, catalogue, {
        controlPanel,
        maxPerDay: MAX_ACTIVITIES_PER_DAY,
    });

    // Bring the cost back toward the budget — without emptying any day. This runs on every
    // path, including the template clone that bypasses the generators' own selection.
    const { days: budgetedDays, removed: budgetRemovals, spend: activitySpend } = trimToBudget(filledDays, {
        budget: budget?.activityCeiling,
        controlPanel,
    });

    const { days: safeDays, validation, repaired, repairedValidation } = repairItineraryGeography(budgetedDays, {
        controlPanel,
        origin: hotelCoords,
        maxPerDay: MAX_ACTIVITIES_PER_DAY,
    });

    const finalValidation = repaired ? repairedValidation : validation;

    // Impose the Control Panel's activity hours and lunch break, whichever generator
    // produced these days.
    itinerary.days = normalizeTripDays(applyDaySchedule(safeDays, controlPanel, itinerary.startDate), itinerary.startDate);
    itinerary.aiGenerated = true;
    itinerary.aiGeneratedAt = new Date();
    itinerary.generationSource = source === 'database' || source === 'template' ? 'template' : 'ai';
    itinerary.updatedAt = new Date();
    if (persist) {
        await itinerary.save();
    }
    await itinerary.populate('controlPanel.hotelId');
    return resPayload(itinerary, source, persist, {
        geographyRepaired: repaired,
        dayBoundariesEnforced: boundariesChanged,
        daysBackfilled,
        daysToppedUp,
        geographyIssues: finalValidation.issues,
        dayReports: finalValidation.dayReports,
    }, budget ? {
        ...budget,
        activitySpend,
        overBudget: activitySpend > budget.activityCeiling,
        trimmedForBudget: budgetRemovals,
    } : budget);
}

function resPayload(itinerary, source, persisted = false, geography = null, budget = null) {
    const doc = itinerary.toObject ? itinerary.toObject() : itinerary;
    return {
        itinerary: doc,
        source,
        persisted,
        // Counted with breaks excluded, so the API and the UI can never disagree.
        totalActivities: countActivities(doc.days),
        ...(geography ? { geography } : {}),
        ...(budget ? { budget } : {}),
    };
}

// ─── GENERATE itinerary with AI ──────────────────────────────────────────────

exports.generateItinerary = async (req, res) => {
    try {
        const itinerary = await loadItineraryFor(req, res, 'edit');
        if (!itinerary) return;

        applyBudgetToDocument(itinerary);

        // The supplier may have changed the Control Panel without saving it yet.
        // Generation must honour what is on their screen, so an in-flight control panel
        // is applied to the in-memory document for this run. It is only written to the
        // database when the caller explicitly asks to persist — otherwise generating
        // would silently commit configuration the supplier had not saved.
        if (req.body?.controlPanel && typeof req.body.controlPanel === 'object') {
            const incoming = { ...req.body.controlPanel };
            delete incoming.startDate;
            delete incoming.endDate;
            if (Object.prototype.hasOwnProperty.call(incoming, 'hotelId')) {
                incoming.hotelId = incoming.hotelId && mongoose.Types.ObjectId.isValid(incoming.hotelId)
                    ? incoming.hotelId
                    : null;
            }
            itinerary.set('controlPanel', normalizeControlPanel({
                ...(itinerary.controlPanel?.toObject ? itinerary.controlPanel.toObject() : itinerary.controlPanel || {}),
                ...incoming,
            }));
        }
        if (req.body?.startDate) itinerary.startDate = req.body.startDate;
        if (req.body?.endDate) itinerary.endDate = req.body.endDate;

        const country = (itinerary.country || itinerary.tripData?.country || itinerary.destination || '').trim();
        const city = (itinerary.city || itinerary.tripData?.city || itinerary.tripData?.destination || '').trim();

        if (!country && !city) {
            return res.status(400).json({ msg: 'Itinerary must have country or city to generate' });
        }

        // Fetch general approved activities for the destination
        const activities = await fetchActivitiesForDestination(country, city);

        // Fetch traveler's selected activities from the booking if applicable
        let bookingActivities = [];
        if (itinerary.bookingId && mongoose.Types.ObjectId.isValid(itinerary.bookingId)) {
            const booking = await Booking.findById(itinerary.bookingId).populate({ path: 'items.activity', select: '-image' }).lean();
            if (booking && Array.isArray(booking.items)) {
                bookingActivities = booking.items.map(item => {
                    if (item.activity && typeof item.activity === 'object') {
                        return item.activity;
                    } else {
                        return {
                            _id: item.activity || null,
                            title: item.title,
                            description: '',
                            price: 0,
                            category: 'general',
                            image: ''
                        };
                    }
                }).filter(Boolean);
            }
        }

        // LOAD HOTEL AND CALCULATE ACTIVITY BUDGET EARLY
        let hotel = null;
        if (itinerary.controlPanel?.hotelId && mongoose.Types.ObjectId.isValid(itinerary.controlPanel.hotelId)) {
            hotel = await Hotel.findById(itinerary.controlPanel.hotelId).lean();
        }

        const cp = itinerary.controlPanel || {};
        // The trip starts from the hotel when one is selected, so it anchors the route.
        const hotelCoords = getCoordinates(hotel);
        const startDate = toDateString(itinerary.startDate);
        const endDate = toDateString(itinerary.endDate);
        const tripDays = (startDate && endDate) ? daysBetween(startDate, endDate) : 3;

        // Calculate available budget for activities using uplift as TOLERANCE (not surcharge reduction)
        // `??` not `||`: an uplift of 0 is a deliberate "no tolerance", not a missing value.
        let upliftRaw = cp.budgetUplift ?? 15;
        let upliftPct = Math.min(Math.max((upliftRaw > 0 && upliftRaw < 1) ? upliftRaw : (Number(upliftRaw) / 100), 0), 1);
        let hotelCost = 0;
        if (hotel) {
            const nights = Math.max(1, tripDays - 1);
            const rooms = cp.numberOfRooms || 1;
            hotelCost = (hotel.pricePerNight || 0) * nights * rooms;
        }

        const customCostsTotal = (Array.isArray(cp.customCosts) ? cp.customCosts : []).reduce((sum, cost) => {
            const amount = Number(cost?.amount) || 0;
            if (!amount) return sum;
            if (cost?.unit === 'per_day') return sum + (amount * Math.max(1, tripDays || 1));
            return sum + amount;
        }, 0);

        let activityBudget = undefined;
        let activityBudgetStr = 'flexible';
        let budgetRulePrompt = '';
        // Surfaced on the response so the supplier can see exactly how the Control Panel
        // translated into a spending ceiling, instead of inferring it from the result.
        let budgetBreakdown = null;

        if (itinerary.budget) {
            // Uplift is budget tolerance: base budget $1,000 with 15% tolerance = $1,150 max total budget
            const maxAllowedTotalBudget = Math.floor((Number(itinerary.budget) || 0) * (1 + upliftPct));
            let maxTotalActivitiesCost = maxAllowedTotalBudget - hotelCost - customCostsTotal;
            maxTotalActivitiesCost = Math.max(0, Math.floor(maxTotalActivitiesCost));
            
            activityBudget = maxTotalActivitiesCost;
            activityBudgetStr = String(maxTotalActivitiesCost);

            budgetBreakdown = {
                travelerBudget: Number(itinerary.budget) || 0,
                upliftPercent: Math.round(upliftPct * 100),
                maxAllowedTotalBudget,
                hotelCost,
                customCostsTotal,
                activityCeiling: maxTotalActivitiesCost,
                // A ceiling of zero means accommodation and fixed costs have already
                // consumed the whole budget. Generation will legitimately return no
                // activities, so say so rather than handing back a blank plan.
                exhaustedByFixedCosts: maxTotalActivitiesCost === 0,
            };

            budgetRulePrompt = `\nCRITICAL BUDGET TOLERANCE RULE: Customer budget is $${itinerary.budget}. With a ${Math.round(upliftPct * 100)}% budget tolerance allowance, the maximum allowed total trip budget ceiling is $${maxAllowedTotalBudget}. After accounting for hotel accommodation ($${hotelCost}) and custom costs ($${customCostsTotal}), the activity budget guideline is $${maxTotalActivitiesCost}. Prefer options that keep the total near that figure, but filling every day of the trip takes priority over the guideline.`;
        }

        const mode = req.body.mode || 'ai';
        // Generation is a preview by default — the supplier decides whether it becomes a
        // draft ("Save to Draft") or is sent to the traveler ("Send to Traveler").
        const persist = req.body?.persist === true;

        if (mode === 'template') {
            const existingQuery = {
                aiGenerated: true,
                _id: { $ne: itinerary._id },
                // `days` being non-empty is not enough: an itinerary can hold day stubs
                // with no activities at all. Requiring an actual activity is what stops
                // "Generate" from cloning an empty plan and returning a blank itinerary.
                'days.activities.0': { $exists: true },
            };
            if (country && city) {
                existingQuery.country = new RegExp(`^${escapeRegExp(country)}$`, 'i');
                existingQuery.city = new RegExp(`^${escapeRegExp(city)}$`, 'i');
            } else if (country) {
                existingQuery.country = new RegExp(`^${escapeRegExp(country)}$`, 'i');
            }

            const existing = await Itinerary.findOne(existingQuery).sort({ aiGeneratedAt: -1 }).lean();

            // Adapting can trim days off the end, so re-check that the result still holds
            // activities before returning it — otherwise fall through to building a fresh
            // plan from the catalogue.
            // Hydrate from the catalogue so cloned entries regain the coordinates the
            // geographic validation layer needs. The budget is advisory, so nothing is
            // trimmed here — filling the trip takes priority over the ceiling.
            const adaptedDays = existing?.days?.length
                ? hydrateDayActivities(adaptDaysToItinerary(existing.days, itinerary), activities)
                : null;

            if (adaptedDays && countActivities(adaptedDays) > 0) {
                return res.json(await saveGeneratedDays(itinerary, adaptedDays, 'database', { persist, hotelCoords, budget: budgetBreakdown, catalogue: activities }));
            } else {
                const templateDays = buildDefaultDays(
                    itinerary,
                    bookingActivities.length > 0 ? bookingActivities : activities,
                    bookingActivities.length > 0,
                    activityBudget,
                    { hotelCoords }
                );
                return res.json(await saveGeneratedDays(itinerary, templateDays, 'template', { persist, hotelCoords, budget: budgetBreakdown, catalogue: activities }));
            }
        }

        // ── Level 2: call OpenAI (or template fallback) ───────────────────────
        const openai = getOpenAIClient();
        if (!openai) {
            const templateDays = buildDefaultDays(
                itinerary,
                bookingActivities.length > 0 ? bookingActivities : activities,
                bookingActivities.length > 0,
                activityBudget,
                { hotelCoords }
            );
            return res.json({
                ...(await saveGeneratedDays(itinerary, templateDays, 'template', { persist, hotelCoords, budget: budgetBreakdown, catalogue: activities })),
                warning: 'OPENAI_API_KEY not configured. Generated a starter template — add OPENAI_API_KEY to enable full AI itineraries.',
            });
        }

        // ── Shortlist + compact prompt ─────────────────────────────────────────
        // Only the fields that survive are asked for. Everything the model used to emit
        // for a catalogue activity (title, description, price, category, times) is
        // overwritten from the database or recomputed by applyDaySchedule, so paying for
        // it in completion tokens was pure waste.
        const shortlist = selectCatalogueForPrompt(activities, {
            activityBudget,
            required: bookingActivities,
        });
        const { text: catalogueText, indexToActivity } = buildCataloguePrompt(shortlist, {
            destination: city || country,
        });

        const requiredHandles = bookingActivities
            .map((a) => {
                for (const [handle, act] of indexToActivity) {
                    if (String(act._id) === String(a._id)) return handle;
                }
                return null;
            })
            .filter(Boolean);

        const systemPrompt = 'You plan travel itineraries. Reply with raw JSON only — no markdown, no commentary.';

        const lunch = resolveLunchWindow(cp);
        const overridesPrompt = Array.isArray(cp.perDayOverrides) && cp.perDayOverrides.length > 0
            ? '\n- Per-day hour overrides: ' + cp.perDayOverrides
                .filter((o) => o.startTime || o.endTime)
                .map((o) => `${o.date} ${o.startTime || '-'}..${o.endTime || '-'}`)
                .join('; ')
            : '';
        const activeDayRule = cp.startOnArrival
            ? 'Day 1 is the arrival day and MAY hold activities.'
            : 'Day 1 is the arrival day and MUST be empty (transfer only).';
        const lastDayRule = cp.endOnDeparture !== false
            ? `Day ${tripDays} is the departure day and MAY hold activities.`
            : `Day ${tripDays} is the departure day and MUST be empty.`;

        const userPrompt = `Plan a ${tripDays}-day trip to ${city || country} for ${itinerary.numberOfTravelers || 2} travellers.

Activities available (use the #number to reference one):
${catalogueText}

Rules:
- Same-day activities must be within ~${Math.round(SAME_AREA_RADIUS_KM)}km of each other (use the coordinates). Keep each area on consecutive days; when moving between areas, use one travel day with fewer activities. Legs over ${Math.round(FLIGHT_THRESHOLD_KM)}km imply a flight.
- Include the destination's iconic landmarks where they appear in the list.
- Fill EVERY day that may hold activities — no day may be left empty while unused activities remain.
- Max ${MAX_ACTIVITIES_PER_DAY} activities per day. Do not repeat an activity.
- ${activeDayRule}
- ${lastDayRule}
- Keep ${lunch.lunchStart}-${lunch.lunchEnd} free for lunch (do NOT output a lunch entry — it is added automatically).${activityBudget !== undefined ? `\n- Aim to keep the total price of chosen activities near $${activityBudget}, preferring cheaper options — but filling every day matters more than the budget.` : ''}${requiredHandles.length ? `\n- You MUST include these: ${requiredHandles.map((h) => `#${h}`).join(', ')}.` : ''}${overridesPrompt}

Return a JSON object with a "days" array holding exactly ${tripDays} entries, in order.
"ids" are #numbers from the list above. Add "custom" only for something genuinely missing from it.
{"days":[{"day":1,"ids":[]},{"day":2,"ids":[3,7]},{"day":3,"ids":[12],"custom":[{"title":"Evening food walk","description":"Street-food tour","price":25,"category":"dining"}]}]}`;

        let aiDays;
        try {
            const completion = await openai.chat.completions.create({
                model: 'gpt-4o',
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt },
                ],
                temperature: 0.4,
                // The reply is now a list of day -> activity numbers, a few hundred tokens
                // at most. The old 4000 ceiling existed because the model was asked to
                // echo back every field of every activity.
                max_tokens: Number(process.env.ITINERARY_AI_MAX_TOKENS) || 1200,
                response_format: { type: 'json_object' },
            });

            if (completion.usage) {
                console.log(`[itinerary ${itinerary._id}] AI tokens in=${completion.usage.prompt_tokens} out=${completion.usage.completion_tokens} total=${completion.usage.total_tokens} (catalogue rows=${shortlist.length})`);
            }

            aiDays = parseAiItineraryReply(completion.choices[0].message.content, {
                indexToActivity,
                tripDays,
            });
        } catch (aiErr) {
            console.error('OpenAI generate failed, using template fallback:', aiErr?.message);
            const templateDays = buildDefaultDays(
                itinerary,
                bookingActivities.length > 0 ? bookingActivities : activities,
                bookingActivities.length > 0,
                activityBudget,
                { hotelCoords }
            );
            return res.json({
                ...(await saveGeneratedDays(itinerary, templateDays, 'template', { persist, hotelCoords, budget: budgetBreakdown, catalogue: activities })),
                warning: aiErr?.message || 'AI generation failed. A starter template was created instead.',
            });
        }

        // Attach real activity images and details from DB where we have matches
        const actMap = {};
        activities.forEach(a => { actMap[String(a._id)] = a; });
        shortlist.forEach(a => { actMap[String(a._id)] = a; });

        const bookingActMap = {};
        bookingActivities.forEach(a => {
            if (a._id) bookingActMap[String(a._id)] = a;
        });

        const enrichedDays = aiDays.map((d, idx) => ({
            ...d,
            day: idx + 1,
            dayName: getDayName(d.date) || d.dayName || '',
            activities: (d.activities || []).map(act => {
                // Models frequently return the string "null" rather than a real id, so
                // normalise before using it as a lookup key or as a "is this bookable" test.
                const rawActivityId = resolveActivityId(act.activityId);
                let dbAct = rawActivityId ? (actMap[rawActivityId] || bookingActMap[rawActivityId]) : null;
                
                // Title fallback matching
                if (!dbAct && act.title) {
                    const cleanTitle = act.title.trim().toLowerCase();
                    dbAct = activities.find(a => a.title.trim().toLowerCase() === cleanTitle) ||
                            bookingActivities.find(a => a.title.trim().toLowerCase() === cleanTitle);
                }

                // A break placeholder is not a bookable activity: it never carries a
                // price, never links to the catalogue, and is excluded from every count.
                const isBreak = isBreakEntry({ ...act, activityId: dbAct ? String(dbAct._id) : rawActivityId });

                if (isBreak) {
                    return buildBreakEntry({
                        title: act.title || 'Break',
                        description: act.description || '',
                        startTime: act.startTime || '',
                        endTime: act.endTime || '',
                    });
                }

                return {
                    activityId: dbAct ? String(dbAct._id) : rawActivityId,
                    title: dbAct ? dbAct.title : (act.title || ''),
                    description: dbAct ? dbAct.description : (act.description || ''),
                    location: dbAct?.location || dbAct?.city || act.location || '',
                    // Carried through so the validation layer below can measure real
                    // distances instead of trusting the model's grouping.
                    coordinates: getCoordinates(dbAct) || getCoordinates(act) || undefined,
                    duration: dbAct?.duration || act.duration || undefined,
                    startTime: act.startTime || '',
                    endTime: act.endTime || '',
                    price: dbAct ? (Number(dbAct.price) || 0) : (Number(act.price) || 0),
                    category: dbAct ? dbAct.category : (act.category || 'general'),
                    image: dbAct ? activityImageUrl(dbAct._id) : (act.image || ''),
                    isBreak: false,
                    isSupplierOnly: true,
                };
            }),
        }));

        const finalDays = hydrateDayActivities(enrichedDays, [...activities, ...bookingActivities]);
        return res.json(await saveGeneratedDays(itinerary, finalDays, 'ai', { persist, hotelCoords, budget: budgetBreakdown, catalogue: activities }));
    } catch (err) {
        console.error('generateItinerary error:', err?.message, err?.stack);
        res.status(500).json({ msg: 'Server error', error: err?.message });
    }
};


/**
 * Normalize a control panel before it is stored.
 *
 * Lunch is configured as a duration; the concrete window is derived by centring it in the
 * day's activity hours. Persisting the derived start/end keeps every existing reader
 * (traveller itinerary view, payment totals, older records) working unchanged.
 */
function normalizeControlPanel(cp = {}) {
    const next = { ...cp };
    const { lunchStart, lunchEnd, durationMinutes } = resolveLunchWindow(next);
    next.lunchDurationMinutes = durationMinutes;
    next.lunchStart = lunchStart;
    next.lunchEnd = lunchEnd;
    return next;
}

// ─── SAVE control panel ──────────────────────────────────────────────────────

exports.saveControlPanel = async (req, res) => {
    try {
        // The Control Panel belongs to the Supplier Panel: only the supplier who owns
        // this itinerary (or an admin) may change its configuration.
        const existing = await loadItineraryFor(req, res, 'edit');
        if (!existing) return;

        const { startDate, endDate, ...cpFields } = req.body || {};
        const base = existing.controlPanel?.toObject ? existing.controlPanel.toObject() : (existing.controlPanel || {});
        const updateFields = {
            updatedAt: new Date(),
            controlPanel: normalizeControlPanel({ ...base, ...cpFields })
        };
        if (startDate !== undefined) updateFields.startDate = startDate;
        if (endDate !== undefined) updateFields.endDate = endDate;

        const itinerary = await Itinerary.findByIdAndUpdate(
            req.params.id,
            { $set: updateFields },
            { new: true }
        ).populate('controlPanel.hotelId');

        res.json(itinerary);
    } catch (err) {
        console.error('saveControlPanel error:', err?.message);
        res.status(500).json({ msg: 'Server error', error: err?.message });
    }
};

/**
 * Build the `$set` fragment for the trip-level fields the itinerary builder owns
 * (dates, control panel, AI provenance). Every field is optional so existing
 * callers that only send `days` keep working exactly as before.
 */
function buildBuilderStateUpdate(body, existingControlPanel) {
    const update = {};

    if (body.startDate !== undefined) update.startDate = body.startDate || null;
    if (body.endDate !== undefined) update.endDate = body.endDate || null;

    if (body.controlPanel && typeof body.controlPanel === 'object') {
        const { startDate, endDate, ...cpFields } = body.controlPanel;
        if (Object.prototype.hasOwnProperty.call(cpFields, 'hotelId')) {
            cpFields.hotelId = cpFields.hotelId && mongoose.Types.ObjectId.isValid(cpFields.hotelId)
                ? cpFields.hotelId
                : null;
        }
        const base = existingControlPanel
            ? (existingControlPanel.toObject ? existingControlPanel.toObject() : existingControlPanel)
            : {};
        update.controlPanel = normalizeControlPanel({ ...base, ...cpFields });

        // The control panel is the source of truth for trip dates when the caller
        // did not send them at the top level.
        if (update.startDate === undefined && startDate !== undefined) update.startDate = startDate || null;
        if (update.endDate === undefined && endDate !== undefined) update.endDate = endDate || null;
    }

    if (body.aiGenerated === true) {
        update.aiGenerated = true;
        if (!update.aiGeneratedAt) update.aiGeneratedAt = new Date();
    }
    if (body.generationSource === 'ai' || body.generationSource === 'template') {
        update.generationSource = body.generationSource;
    }

    return update;
}

// ─── SAVE days (manual edits after AI generation) ────────────────────────────

exports.saveDays = async (req, res) => {
    try {
        if (!Array.isArray(req.body.days)) {
            return res.status(400).json({ msg: 'days must be an array' });
        }

        const existing = await loadItineraryFor(req, res, 'edit');
        if (!existing) return;

        const updateFields = {
            days: normalizeTripDays(req.body.days, req.body.startDate ?? existing.startDate),
            updatedAt: new Date(),
            ...buildBuilderStateUpdate(req.body, existing.controlPanel)
        };
        if (Array.isArray(req.body.extraFields)) {
            updateFields.extraFields = req.body.extraFields;
        }

        const itinerary = await Itinerary.findByIdAndUpdate(
            req.params.id,
            { $set: updateFields },
            { new: true }
        ).populate('controlPanel.hotelId');

        if (!itinerary) return res.status(404).json({ msg: 'Itinerary not found' });

        res.json(itinerary);
    } catch (err) {
        console.error('saveDays error:', err?.message);
        res.status(500).json({ msg: 'Server error', error: err?.message });
    }
};

async function sendItineraryReadyEmail(itinerary) {
    try {
        const travelerUser = await User.findById(itinerary.userId).lean();
        const recipientEmail = travelerUser?.email;
        const travelerName = travelerUser?.name || 'Traveler';
        const destination = itinerary.destination || itinerary.title || 'your destination';

        if (!recipientEmail) return;

        await sendEmail({
            to: recipientEmail,
            subject: 'Your Itinerary Is Ready!',
            templateKey: 'itineraryReply',
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e1e1e1; border-radius: 10px;">
                    <h2 style="color: #a26e35;">Your itinerary is ready, ${travelerName}!</h2>
                    <p>Your personalized itinerary for <strong>${destination}</strong> has been prepared by your supplier and is now available to view.</p>
                    <p>Log in to your dashboard to review the full day-by-day plan and proceed with booking.</p>
                    <div style="margin-top: 30px; text-align: center;">
                        <a href="${process.env.FRONTEND_URL || 'http://localhost:5173'}" style="background-color: #a26e35; color: white; padding: 12px 25px; text-decoration: none; border-radius: 5px; font-weight: bold;">View My Itinerary</a>
                    </div>
                    <p style="margin-top: 30px; font-size: 12px; color: #777;">Thank you for choosing Kufi Travel.</p>
                </div>
            `
        });
    } catch (emailErr) {
        console.error('Error sending itinerary ready email:', emailErr);
    }
}

// ─── SUBMIT itinerary to traveler ────────────────────────────────────────────

exports.submitItinerary = async (req, res) => {
    try {
        const itinerary = await loadItineraryFor(req, res, 'edit');
        if (!itinerary) return;

        if (Array.isArray(req.body.days)) {
            itinerary.days = normalizeTripDays(req.body.days, req.body.startDate ?? itinerary.startDate);
        }
        if (Array.isArray(req.body.extraFields)) {
            itinerary.extraFields = req.body.extraFields;
        }

        // Persist the builder state (dates / control panel / AI provenance) that the
        // supplier had on screen, so "Send to Traveler" never loses unsaved edits.
        const builderState = buildBuilderStateUpdate(req.body, itinerary.controlPanel);
        Object.entries(builderState).forEach(([key, value]) => {
            itinerary[key] = value;
        });

        // Clean out empty/blank extra fields automatically before validating
        itinerary.extraFields = (itinerary.extraFields || []).filter(
            (f) => String(f.label || '').trim() && String(f.value || '').trim()
        );

        const errors = [];
        if (!toDateString(itinerary.startDate)) errors.push('Start date is required');
        if (!toDateString(itinerary.endDate)) errors.push('End date is required');
        if (!Array.isArray(itinerary.days) || itinerary.days.length === 0) {
            errors.push('At least one itinerary day is required');
        }
        if (!itinerary.userId) errors.push('Traveler account is missing on this itinerary');

        if (errors.length) {
            return res.status(400).json({ msg: 'Validation failed', errors });
        }

        const wasDraft = ['Pending', 'Pending Review'].includes(itinerary.status);
        itinerary.status = 'Supplier Replied Back';
        itinerary.updatedAt = new Date();
        await itinerary.save();
        await itinerary.populate('controlPanel.hotelId');

        if (wasDraft || req.body.forceNotify) {
            await sendItineraryReadyEmail(itinerary);
        }

        try {
            if (itinerary.userId) {
                const destination = itinerary.destination || itinerary.title || 'your destination';
                if (wasDraft) {
                    await notifyPreset('itinerary_generated', {
                        userId: itinerary.userId,
                        bookingId: itinerary.bookingId,
                        itineraryId: itinerary._id,
                        destination,
                        message: `Your itinerary for ${destination} is ready to view.`,
                    });
                    await notifyPreset('approved', {
                        userId: itinerary.userId,
                        bookingId: itinerary.bookingId,
                        itineraryId: itinerary._id,
                        destination,
                        message: `Your itinerary for ${destination} has been approved and is ready for review.`,
                    });
                } else {
                    await notifyPreset('itinerary_updated', {
                        userId: itinerary.userId,
                        bookingId: itinerary.bookingId,
                        itineraryId: itinerary._id,
                        destination,
                        message: `Your itinerary for ${destination} has been updated.`,
                    });
                }
            }
        } catch (notifErr) {
            console.error('Error creating itinerary submit notification:', notifErr?.message || notifErr);
        }

        res.json(itinerary);
    } catch (err) {
        console.error('submitItinerary error:', err?.message);
        res.status(500).json({ msg: 'Server error', error: err?.message });
    }
};

// ─── CLEAR all activities from itinerary days (admin) ────────────────────────

exports.clearActivities = async (req, res) => {
    try {
        if (req.user?.role !== 'admin') {
            return res.status(403).json({ msg: 'Admin only' });
        }
        const itinerary = await Itinerary.findById(req.params.id);
        if (!itinerary) return res.status(404).json({ msg: 'Itinerary not found' });

        itinerary.days = normalizeTripDays(
            (itinerary.days || []).map((d) => {
                const item = d.toObject ? d.toObject() : d;
                return { ...item, activities: [] };
            }),
            itinerary.startDate
        );
        itinerary.updatedAt = new Date();
        await itinerary.save();
        await itinerary.populate('controlPanel.hotelId');
        res.json(itinerary);
    } catch (err) {
        console.error('clearActivities error:', err?.message);
        res.status(500).json({ msg: 'Server error', error: err?.message });
    }
};
