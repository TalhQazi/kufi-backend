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
    validateItineraryGeography,
    parseDurationMinutes,
    SAME_AREA_RADIUS_KM,
    FLIGHT_THRESHOLD_KM,
    resolveLunchWindow,
    parseTimeToMinutes,
    minutesToTime,
} = require('../utils/geo');
const {
    planActivitiesAcrossDays,
    repairItineraryGeography,
    describeTransfer,
    enforceDayBoundaries,
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
 * Drop activities once the cumulative spend would exceed the ceiling.
 *
 * Schedule breaks are always kept and never charged against the ceiling: a lunch
 * placeholder is not something the traveler buys, and a nominal price left on a legacy
 * break must not push real activities out of the plan.
 */
function enforceActivityBudget(days, maxActivityBudget) {
    if (maxActivityBudget === undefined || maxActivityBudget === null || typeof maxActivityBudget !== 'number') {
        return days;
    }
    let cumulative = 0;
    return (days || []).map(d => {
        const item = d?.toObject ? d.toObject() : d;
        const activities = (item.activities || []).filter(act => {
            if (isBreakEntry(act)) return true;
            const price = Number(act.price) || 0;
            if (cumulative + price <= maxActivityBudget) {
                cumulative += price;
                return true;
            }
            return false;
        });
        return { ...item, activities };
    });
}

/** Upper bound on real activities in a single day, before time budgeting narrows it further. */
const MAX_ACTIVITIES_PER_DAY = Number(process.env.ITINERARY_MAX_ACTIVITIES_PER_DAY) || 3;

function buildDefaultDays(itinerary, activities = [], isBookingSpecific = false, activityBudget = undefined, { hotelCoords = null } = {}) {
    const cp = itinerary.controlPanel || {};
    const startDate = toDateString(itinerary.startDate);
    const endDate = toDateString(itinerary.endDate);
    const tripDays = (startDate && endDate) ? daysBetween(startDate, endDate) : 3;
    
    // Respect the budget constraint
    const usableActs = getActivitiesForBudget(
        isBookingSpecific ? activities : [],
        activities,
        activityBudget !== undefined ? activityBudget : itinerary.budget
    );

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
                image: act.image || '',
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
        // `coordinates` drives geographic grouping. `images` is dropped: it was never
        // read here and is a base64 array, so selecting it pulled megabytes per request.
        .select('_id title description duration price category location country city image coordinates rating reviews highlights')
        .lean();
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
function applyDaySchedule(days, controlPanel = {}) {
    const cp = controlPanel?.toObject ? controlPanel.toObject() : (controlPanel || {});

    return (Array.isArray(days) ? days : []).map((day) => {
        const item = day?.toObject ? day.toObject() : day;
        const entries = Array.isArray(item?.activities) ? item.activities : [];
        const real = entries.filter((a) => !isBreakEntry(a));

        if (real.length === 0) return { ...item, activities: [] };

        const override = (cp.perDayOverrides || []).find((o) => o.date === item.date) || {};
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
        const scheduled = real.map((act) => {
            const length = Math.max(15, parseDurationMinutes(act.durationMinutes ?? act.duration));

            // Never start inside the break, and never straddle it.
            if (hasBreak && cursor < breakEnd && cursor + length > breakStart) {
                cursor = breakEnd;
            }

            const startMinutes = cursor;
            const endMinutes = startMinutes + length;
            cursor = endMinutes;

            return {
                ...act,
                startTime: minutesToTime(startMinutes),
                // Clamp the visible end to the configured day end so a long final
                // activity does not render as finishing after hours.
                endTime: minutesToTime(Math.min(endMinutes, Math.max(dayEnd, startMinutes + 15))),
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

        return { ...item, activities: [...scheduled, ...breaks] };
    });
}

/** Normalize day metadata without dropping empty departure/arrival days. */
function normalizeTripDays(days) {
    if (!Array.isArray(days) || days.length === 0) return days;

    // Stamp the canonical break marker so persisted data is self-describing and the
    // legacy title-matching fallback stops being needed for anything written from here on.
    const marked = markBreakEntries(days);

    return marked.map((d, idx) => {
        const item = d.toObject ? d.toObject() : d;
        const isArrival = idx === 0;
        const isDeparture = idx === marked.length - 1;
        return {
            ...item,
            day: idx + 1,
            date: toDateString(item.date) || item.date || '',
            dayName: item.dayName || getDayName(item.date),
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
async function saveGeneratedDays(itinerary, days, source, { persist = false, hotelCoords = null, budget = null } = {}) {
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

    const { days: safeDays, validation, repaired, repairedValidation } = repairItineraryGeography(boundedDays, {
        controlPanel,
        origin: hotelCoords,
        maxPerDay: MAX_ACTIVITIES_PER_DAY,
    });

    const finalValidation = repaired ? repairedValidation : validation;

    // Impose the Control Panel's activity hours and lunch break, whichever generator
    // produced these days.
    itinerary.days = normalizeTripDays(applyDaySchedule(safeDays, controlPanel));
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
        geographyIssues: finalValidation.issues,
        dayReports: finalValidation.dayReports,
    }, budget);
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

            budgetRulePrompt = `\nCRITICAL BUDGET TOLERANCE RULE: Customer budget is $${itinerary.budget}. With a ${Math.round(upliftPct * 100)}% budget tolerance allowance, the maximum allowed total trip budget ceiling is $${maxAllowedTotalBudget}. After accounting for hotel accommodation ($${hotelCost}) and custom costs ($${customCostsTotal}), the sum of prices of all scheduled activities MUST NOT exceed $${maxTotalActivitiesCost}. Select high-value, iconic activities strictly under $${maxTotalActivitiesCost}.`;
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
            const adaptedDays = existing?.days?.length
                // Hydrate from the catalogue so cloned entries regain the coordinates the
                // geographic validation layer needs, then apply the same budget ceiling
                // every other generation path honours. Cloning a template used to bypass
                // the ceiling entirely, which is why the Control Panel's budget uplift had
                // no effect whatsoever on this path.
                ? enforceActivityBudget(
                    hydrateDayActivities(adaptDaysToItinerary(existing.days, itinerary), activities),
                    activityBudget
                )
                : null;

            if (adaptedDays && countActivities(adaptedDays) > 0) {
                return res.json(await saveGeneratedDays(itinerary, adaptedDays, 'database', { persist, hotelCoords, budget: budgetBreakdown }));
            } else {
                const templateDays = buildDefaultDays(
                    itinerary,
                    bookingActivities.length > 0 ? bookingActivities : activities,
                    bookingActivities.length > 0,
                    activityBudget,
                    { hotelCoords }
                );
                return res.json(await saveGeneratedDays(itinerary, templateDays, 'template', { persist, hotelCoords, budget: budgetBreakdown }));
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
                ...(await saveGeneratedDays(itinerary, templateDays, 'template', { persist, hotelCoords, budget: budgetBreakdown })),
                warning: 'OPENAI_API_KEY not configured. Generated a starter template — add OPENAI_API_KEY to enable full AI itineraries.',
            });
        }

        const systemPrompt = `You are an expert travel itinerary planner and geographic strategist. Create a realistic, highly engaging day-by-day travel itinerary strictly formatted as raw JSON array only. No markdown formatting outside json block, no conversational text.`;

        const requiredActivitiesPrompt = bookingActivities.length > 0
            ? `\nREQUIRED TRAVELER ACTIVITIES (You MUST schedule these activities into the days):
${bookingActivities.map(a => `- id:${a._id || 'custom'} | "${a.title}" | price:$${a.price || 0} | location:${a.location || a.city || city || 'local'}`).join('\n')}
Note: Make sure to assign the corresponding "activityId" to the activity objects in the JSON response.`
            : '';

        const overridesPrompt = Array.isArray(cp.perDayOverrides) && cp.perDayOverrides.length > 0
            ? `\nSpecific day-by-day scheduling overrides (Use these instead of default rules for these specific dates):
${cp.perDayOverrides.map(o => `- Date: ${o.date} | Start: ${o.startTime || 'default'} | End: ${o.endTime || 'default'} | Lunch: ${o.lunchStart || 'default'} to ${o.lunchEnd || 'default'}`).join('\n')}`
            : '';

        const startingPointAnchor = hotel
            ? `Hotel: ${hotel.name} (${hotel.city || city || 'City Center'}, ${hotel.country || country || ''})`
            : `Downtown / City Center of ${city || country || 'destination'}`;

        let day1Example = `  {
    "day": 1,
    "date": "${startDate || 'YYYY-MM-DD'}",
    "dayName": "Monday",
    "isArrivalDay": true,
    "isDepartureDay": false,
    "arrivalNote": "${cp.startOnArrival ? 'Arrival Day — Checked in and ready for activities.' : 'Arrival Day — Free Day. Airport to Hotel transfer provided.'}",
    "activities": ${cp.startOnArrival ? `[
      {
        "activityId": null,
        "title": "Welcome Dinner & Evening Walk",
        "description": "Relaxing first evening dinner and orientation",
        "startTime": "19:00",
        "endTime": "21:00",
        "price": 30,
        "category": "dining",
        "image": "",
        "isSupplierOnly": false
      }
    ]` : '[]'}
  }`;

        const userPrompt = `Create a complete ${tripDays}-day travel itinerary for ${city || country}.

Trip details:
- Destination: ${city || country}
- Start date: ${startDate || 'not specified'}
- End date: ${endDate || 'not specified'}
- Travelers: ${itinerary.numberOfTravelers || 2}
- Activity Budget Ceiling: $${activityBudgetStr} (DO NOT EXCEED)
- STARTING POINT / ORIGIN (0,0 ANCHOR): ${startingPointAnchor}. The trip begins from this starting location.

Mandatory Constraints:
1. GEOGRAPHICAL CLUSTERING RULE: Activities scheduled on the same day MUST be within about ${Math.round(SAME_AREA_RADIUS_KM)}km of each other — use the coordinates given for each activity below. Never mix activities from distant bases on the same day. Group each base into consecutive days, and when the trip moves from one base to another put the move on a single travel day with fewer activities, allowing realistic travel time (road at ~70km/h, or a flight for legs over ${Math.round(FLIGHT_THRESHOLD_KM)}km).
2. MANDATORY ICONIC LANDMARKS RULE: You MUST unconditionally include famous landmark attractions of the destination (e.g. Pyramids of Giza, Great Sphinx, Egyptian Museum for Cairo/Egypt; Karnak Temple, Valley of the Kings for Luxor; Burj Khalifa for Dubai; etc.) in the itinerary.
3. Activity start time each day: ${cp.activityStartTime || '09:00'}
4. Activity end time each day: ${cp.activityEndTime || '19:00'}
5. Lunch break: ${resolveLunchWindow(cp).lunchStart} to ${resolveLunchWindow(cp).lunchEnd} on EVERY day. Leave this window free. If you include a lunch/rest placeholder it MUST be marked "isBreak": true and "category": "break" — it is not an activity and must never be given a price or an activityId.
6. Day 1 is arrival day — ${cp.startOnArrival ? 'you MUST schedule at least one activity today after check-in' : 'keep free (no activities), just airport/hotel transfer'}
7. Last day (Day ${tripDays}) is departure day — always include departureNote.${overridesPrompt}
8. You MUST schedule all activities listed under "REQUIRED TRAVELER ACTIVITIES" on appropriate days.${budgetRulePrompt}

Available activities (prefer these pre-loaded activities and match activityId when assigning):
${activities.length > 0
    ? activities.map(a => {
        const c = getCoordinates(a);
        return `- id:${a._id} | "${a.title}" | location:${a.location || a.city || city || 'local'}${c ? ` | coords:${c.lat.toFixed(4)},${c.lng.toFixed(4)}` : ''} | duration:${a.duration || '2 hours'} | price:$${a.price || 0} | category:${a.category || 'general'}`;
    }).join('\n')
    : '(no pre-loaded activities — create realistic iconic activities with location and pricing for the destination)'
}
${requiredActivitiesPrompt}

Return ONLY a JSON array with this exact structure:
[
${day1Example},
  {
    "day": 2,
    "date": "YYYY-MM-DD",
    "dayName": "Tuesday",
    "isArrivalDay": false,
    "isDepartureDay": false,
    "activities": [
      {
        "activityId": "<id from the list above, or null (unquoted) for a custom activity>",
        "title": "Activity title",
        "description": "Short description",
        "startTime": "09:00",
        "endTime": "11:00",
        "price": 45,
        "category": "culture",
        "image": "",
        "isSupplierOnly": true
      }
    ]
  }
]`;

        let aiDays;
        try {
            const completion = await openai.chat.completions.create({
                model: 'gpt-4o',
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt },
                ],
                temperature: 0.4,
                max_tokens: 4000,
            });

            const raw = completion.choices[0].message.content.trim();
            const jsonStr = raw.startsWith('[') ? raw : raw.replace(/```json\n?/, '').replace(/```\n?$/, '').trim();
            aiDays = JSON.parse(jsonStr);
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
                ...(await saveGeneratedDays(itinerary, templateDays, 'template', { persist, hotelCoords, budget: budgetBreakdown })),
                warning: aiErr?.message || 'AI generation failed. A starter template was created instead.',
            });
        }

        // Attach real activity images and details from DB where we have matches
        const actMap = {};
        activities.forEach(a => { actMap[String(a._id)] = a; });

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
                    image: act.image || dbAct?.image || '',
                    isBreak: false,
                    isSupplierOnly: true,
                };
            }),
        }));

        const finalDays = hydrateDayActivities(
            enforceActivityBudget(enrichedDays, activityBudget),
            [...activities, ...bookingActivities]
        );
        return res.json(await saveGeneratedDays(itinerary, finalDays, 'ai', { persist, hotelCoords, budget: budgetBreakdown }));
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
            days: normalizeTripDays(req.body.days),
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
            itinerary.days = normalizeTripDays(req.body.days);
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
            })
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
