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

// ─── helpers ────────────────────────────────────────────────────────────────

function escapeRegExp(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getOpenAIClient() {
    const key = process.env.OPENAI_API_KEY;
    if (!key) return null;
    return new OpenAI({ apiKey: key });
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

function enforceActivityBudget(days, maxActivityBudget) {
    if (maxActivityBudget === undefined || maxActivityBudget === null || typeof maxActivityBudget !== 'number') {
        return days;
    }
    let cumulative = 0;
    return (days || []).map(d => {
        const activities = (d.activities || []).filter(act => {
            const price = Number(act.price) || 0;
            if (cumulative + price <= maxActivityBudget) {
                cumulative += price;
                return true;
            }
            return false;
        });
        return { ...d, activities };
    });
}

function buildDefaultDays(itinerary, activities = [], isBookingSpecific = false, activityBudget = undefined) {
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

    // Group activities geographically by location/city
    const geoGroups = {};
    sortedActs.forEach(act => {
        const locKey = (act.city || act.location || itinerary.city || 'default').trim().toLowerCase();
        if (!geoGroups[locKey]) geoGroups[locKey] = [];
        geoGroups[locKey].push(act);
    });

    const groupedActsOrdered = Object.values(geoGroups).flat();
    let actsToUse = isBookingSpecific ? groupedActsOrdered : groupedActsOrdered.slice(0, activeDayIndices.length * 3);

    // Distribute grouped activities sequentially across days to maintain geographic clustering
    let currentDayPointer = 0;
    actsToUse.forEach((act) => {
        const targetDayIdx = activeDayIndices[currentDayPointer % activeDayIndices.length];
        const dayActs = days[targetDayIdx].activities;

        // Advance to next day if current day reaches 3 activities to avoid overcrowding single days
        if (dayActs.length >= 3 && activeDayIndices.length > 1 && currentDayPointer < activeDayIndices.length - 1) {
            currentDayPointer++;
        }

        const effectiveDayIdx = activeDayIndices[currentDayPointer % activeDayIndices.length];
        const targetDate = days[effectiveDayIdx].date;
        const existingCount = days[effectiveDayIdx].activities.length;
        
        const dayOverride = (cp.perDayOverrides || []).find(o => o.date === targetDate) || {};
        
        const activityStartTime = dayOverride.startTime || cp.activityStartTime || '09:00';
        const activityEndTime = dayOverride.endTime || cp.activityEndTime || '19:00';
        const lunchStart = dayOverride.lunchStart || cp.lunchStart || '13:00';
        const lunchEnd = dayOverride.lunchEnd || cp.lunchEnd || '14:00';

        const { startTime, endTime } = getActivityTimeSlot(
            existingCount,
            activityStartTime,
            activityEndTime,
            lunchStart,
            lunchEnd
        );

        days[effectiveDayIdx].activities.push({
            activityId: act._id ? String(act._id) : null,
            title: act.title || '',
            description: act.description || '',
            location: act.location || act.city || itinerary.city || '',
            startTime,
            endTime,
            price: Number(act.price) || 0,
            category: act.category || 'general',
            image: act.image || '',
            isSupplierOnly: true,
        });
    });

    return days;
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
                userId = userId || bookingDoc.user;
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
        const supplierIdVal = role === 'supplier' ? authUserId : req.body?.supplierId;

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
        const itinerary = await Itinerary.findById(req.params.id).populate('controlPanel.hotelId').lean();
        if (!itinerary) return res.status(404).json({ msg: 'Itinerary not found' });
        res.json(itinerary);
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
        .select('_id title description duration price category location country city image images rating reviews highlights')
        .lean();
}

/** Normalize day metadata without dropping empty departure/arrival days. */
function normalizeTripDays(days) {
    if (!Array.isArray(days) || days.length === 0) return days;

    return days.map((d, idx) => {
        const item = d.toObject ? d.toObject() : d;
        const isArrival = idx === 0;
        const isDeparture = idx === days.length - 1;
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
async function saveGeneratedDays(itinerary, days, source, { persist = false } = {}) {
    applyBudgetToDocument(itinerary);
    itinerary.days = normalizeTripDays(days);
    itinerary.aiGenerated = true;
    itinerary.aiGeneratedAt = new Date();
    itinerary.generationSource = source === 'database' || source === 'template' ? 'template' : 'ai';
    itinerary.updatedAt = new Date();
    if (persist) {
        await itinerary.save();
    }
    await itinerary.populate('controlPanel.hotelId');
    return resPayload(itinerary, source, persist);
}

function resPayload(itinerary, source, persisted = false) {
    const doc = itinerary.toObject ? itinerary.toObject() : itinerary;
    return { itinerary: doc, source, persisted };
}

// ─── GENERATE itinerary with AI ──────────────────────────────────────────────

exports.generateItinerary = async (req, res) => {
    try {
        const itinerary = await Itinerary.findById(req.params.id);
        if (!itinerary) return res.status(404).json({ msg: 'Itinerary not found' });

        applyBudgetToDocument(itinerary);

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
        const startDate = toDateString(itinerary.startDate);
        const endDate = toDateString(itinerary.endDate);
        const tripDays = (startDate && endDate) ? daysBetween(startDate, endDate) : 3;

        // Calculate available budget for activities using uplift as TOLERANCE (not surcharge reduction)
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

        if (itinerary.budget) {
            // Uplift is budget tolerance: base budget $1,000 with 15% tolerance = $1,150 max total budget
            const maxAllowedTotalBudget = Math.floor((Number(itinerary.budget) || 0) * (1 + upliftPct));
            let maxTotalActivitiesCost = maxAllowedTotalBudget - hotelCost - customCostsTotal;
            maxTotalActivitiesCost = Math.max(0, Math.floor(maxTotalActivitiesCost));
            
            activityBudget = maxTotalActivitiesCost;
            activityBudgetStr = String(maxTotalActivitiesCost);

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
                days: { $exists: true, $not: { $size: 0 } },
            };
            if (country && city) {
                existingQuery.country = new RegExp(`^${escapeRegExp(country)}$`, 'i');
                existingQuery.city = new RegExp(`^${escapeRegExp(city)}$`, 'i');
            } else if (country) {
                existingQuery.country = new RegExp(`^${escapeRegExp(country)}$`, 'i');
            }

            const existing = await Itinerary.findOne(existingQuery).sort({ aiGeneratedAt: -1 }).lean();

            if (existing && Array.isArray(existing.days) && existing.days.length > 0) {
                const adaptedDays = adaptDaysToItinerary(existing.days, itinerary);
                return res.json(await saveGeneratedDays(itinerary, adaptedDays, 'database', { persist }));
            } else {
                const templateDays = buildDefaultDays(
                    itinerary,
                    bookingActivities.length > 0 ? bookingActivities : activities,
                    bookingActivities.length > 0,
                    activityBudget
                );
                return res.json(await saveGeneratedDays(itinerary, templateDays, 'template', { persist }));
            }
        }

        // ── Level 2: call OpenAI (or template fallback) ───────────────────────
        const openai = getOpenAIClient();
        if (!openai) {
            const templateDays = buildDefaultDays(
                itinerary,
                bookingActivities.length > 0 ? bookingActivities : activities,
                bookingActivities.length > 0,
                activityBudget
            );
            return res.json({
                ...(await saveGeneratedDays(itinerary, templateDays, 'template', { persist })),
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
        "activityId": "null",
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
1. GEOGRAPHICAL CLUSTERING RULE: Activities scheduled on the same day MUST be located in the same city or local district. DO NOT mix activities from distant cities (e.g., Cairo and Luxor, or Dubai and Abu Dhabi) on the same day. Dedicate separate consecutive days to separate cities (e.g. Cairo Days 1-2, Luxor Days 3-4).
2. MANDATORY ICONIC LANDMARKS RULE: You MUST unconditionally include famous landmark attractions of the destination (e.g. Pyramids of Giza, Great Sphinx, Egyptian Museum for Cairo/Egypt; Karnak Temple, Valley of the Kings for Luxor; Burj Khalifa for Dubai; etc.) in the itinerary.
3. Activity start time each day: ${cp.activityStartTime || '09:00'}
4. Activity end time each day: ${cp.activityEndTime || '19:00'}
5. Lunch break: ${cp.lunchStart || '13:00'} to ${cp.lunchEnd || '14:00'} (no activities scheduled during lunch)
6. Day 1 is arrival day — ${cp.startOnArrival ? 'you MUST schedule at least one activity today after check-in' : 'keep free (no activities), just airport/hotel transfer'}
7. Last day (Day ${tripDays}) is departure day — always include departureNote.${overridesPrompt}
8. You MUST schedule all activities listed under "REQUIRED TRAVELER ACTIVITIES" on appropriate days.${budgetRulePrompt}

Available activities (prefer these pre-loaded activities and match activityId when assigning):
${activities.length > 0
    ? activities.map(a => `- id:${a._id} | "${a.title}" | location:${a.location || a.city || city || 'local'} | duration:${a.duration || '2 hours'} | price:$${a.price || 0} | category:${a.category || 'general'}`).join('\n')
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
        "activityId": "id from list or null if custom",
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
                activityBudget
            );
            return res.json({
                ...(await saveGeneratedDays(itinerary, templateDays, 'template', { persist })),
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
                let dbAct = act.activityId ? (actMap[act.activityId] || bookingActMap[act.activityId]) : null;
                
                // Title fallback matching
                if (!dbAct && act.title) {
                    const cleanTitle = act.title.trim().toLowerCase();
                    dbAct = activities.find(a => a.title.trim().toLowerCase() === cleanTitle) ||
                            bookingActivities.find(a => a.title.trim().toLowerCase() === cleanTitle);
                }

                return {
                    activityId: dbAct ? String(dbAct._id) : (act.activityId || null),
                    title: dbAct ? dbAct.title : (act.title || ''),
                    description: dbAct ? dbAct.description : (act.description || ''),
                    startTime: act.startTime || '',
                    endTime: act.endTime || '',
                    price: dbAct ? (Number(dbAct.price) || 0) : (Number(act.price) || 0),
                    category: dbAct ? dbAct.category : (act.category || 'general'),
                    image: act.image || dbAct?.image || '',
                    isSupplierOnly: true,
                };
            }),
        }));

        const finalDays = enforceActivityBudget(enrichedDays, activityBudget);
        return res.json(await saveGeneratedDays(itinerary, finalDays, 'ai', { persist }));
    } catch (err) {
        console.error('generateItinerary error:', err?.message, err?.stack);
        res.status(500).json({ msg: 'Server error', error: err?.message });
    }
};

// ─── SAVE control panel ──────────────────────────────────────────────────────

exports.saveControlPanel = async (req, res) => {
    try {
        const existing = await Itinerary.findById(req.params.id);
        if (!existing) return res.status(404).json({ msg: 'Itinerary not found' });

        const { startDate, endDate, ...cpFields } = req.body || {};
        const updateFields = {
            updatedAt: new Date(),
            controlPanel: { ...((existing.controlPanel || {})), ...cpFields }
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
        update.controlPanel = { ...base, ...cpFields };

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

        const existing = await Itinerary.findById(req.params.id).select('controlPanel').lean();
        if (!existing) return res.status(404).json({ msg: 'Itinerary not found' });

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
        const itinerary = await Itinerary.findById(req.params.id);
        if (!itinerary) return res.status(404).json({ msg: 'Itinerary not found' });

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
