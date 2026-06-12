const mongoose = require('mongoose');
const OpenAI = require('openai');
const Itinerary = require('../models/Itinerary');
const Activity = require('../models/Activity');
const Hotel = require('../models/Hotel');
const Booking = require('../models/Booking');
const { parseBudget, applyBudgetToDocument } = require('../utils/parseBudget');

// ─── helpers ────────────────────────────────────────────────────────────────

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

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

function getActivityTimeSlot(index, startStr, endStr, lunchStartStr, lunchEndStr) {
    const toMin = (t) => {
        if (!t) return 0;
        const [h, m] = t.split(':').map(Number);
        return h * 60 + (m || 0);
    };
    const toTimeStr = (m) => {
        const h = Math.floor(m / 60);
        const mins = m % 60;
        return `${String(h).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
    };

    const dayStart = toMin(startStr || '09:00');
    const dayEnd = toMin(endStr || '19:00');
    const lunchStart = toMin(lunchStartStr || '13:00');
    const lunchEnd = toMin(lunchEndStr || '14:00');

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
    if (maxActivityBudget === undefined || maxActivityBudget === null) {
        return days;
    }

    let total = 0;
    return days.map(d => {
        const keptActivities = [];
        for (const act of (d.activities || [])) {
            const price = Number(act.price) || 0;
            if (total + price <= maxActivityBudget) {
                keptActivities.push(act);
                total += price;
            } else {
                console.log(`Enforcing budget: removing activity "${act.title}" with price $${price} (total would be $${total + price} vs max $${maxActivityBudget})`);
            }
        }
        return {
            ...d,
            activities: keptActivities
        };
    });
}

function buildDefaultDays(itinerary, activities = [], isBookingSpecific = false, activityBudget = undefined) {
    const cp = itinerary.controlPanel || {};
    const startDate = itinerary.startDate
        ? new Date(itinerary.startDate).toISOString().split('T')[0]
        : null;
    const endDate = itinerary.endDate
        ? new Date(itinerary.endDate).toISOString().split('T')[0]
        : null;
    const tripDays = (startDate && endDate) ? daysBetween(startDate, endDate) : 3;
    
    // Respect the budget constraint
    const usableActs = getActivitiesForBudget(
        isBookingSpecific ? activities : [],
        activities,
        activityBudget !== undefined ? activityBudget : itinerary.budget
    );

    const days = [];
    const activeDayIndices = [];
    for (let idx = 0; idx < tripDays; idx++) {
        const newDate = startDate ? addDays(startDate, idx) : '';
        const isArrival = idx === 0;
        const isDeparture = idx === tripDays - 1;

        // Respect cp.startOnArrival / cp.endOnDeparture settings
        let isActive = true;
        if (isArrival && !cp.startOnArrival) {
            isActive = false;
        }
        if (isDeparture && !cp.endOnDeparture) {
            isActive = false;
        }

        days.push({
            day: idx + 1,
            date: newDate,
            dayName: getDayName(newDate),
            isArrivalDay: isArrival,
            isDepartureDay: isDeparture,
            arrivalNote: isArrival && !cp.startOnArrival ? 'Arrival Day — Free Day. Airport to Hotel transfer provided.' : undefined,
            departureNote: isDeparture && !cp.endOnDeparture ? 'Departure Day — Free Day. Hotel to Airport transfer provided.' : undefined,
            activities: [],
        });

        if (isActive) {
            activeDayIndices.push(idx);
        }
    }

    // Fallback if no days are active
    if (activeDayIndices.length === 0) {
        for (let idx = 0; idx < tripDays; idx++) {
            activeDayIndices.push(idx);
        }
    }

    let actsToUse = [];
    if (isBookingSpecific) {
        actsToUse = usableActs;
    } else {
        actsToUse = usableActs.slice(0, activeDayIndices.length * 2);
    }

    actsToUse.forEach((act, actIdx) => {
        const targetDayIdx = activeDayIndices[actIdx % activeDayIndices.length];
        const targetDate = days[targetDayIdx].date;
        const existingCount = days[targetDayIdx].activities.length;
        
        // Find overrides or default values
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

        days[targetDayIdx].activities.push({
            activityId: act._id ? String(act._id) : null,
            title: act.title || '',
            description: act.description || '',
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

function getDayName(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    return isNaN(d.getTime()) ? '' : DAY_NAMES[d.getDay()];
}

function addDays(dateStr, n) {
    const d = new Date(dateStr);
    d.setDate(d.getDate() + n);
    return d.toISOString().split('T')[0];
}

function daysBetween(start, end) {
    const a = new Date(start);
    const b = new Date(end);
    const diff = Math.round((b - a) / (1000 * 60 * 60 * 24));
    return Math.max(1, diff + 1);
}

// Shift template days to new itinerary's dates, keep activity structure intact
function adaptDaysToItinerary(templateDays, itinerary) {
    const startDate = itinerary.startDate
        ? new Date(itinerary.startDate).toISOString().split('T')[0]
        : null;

    const tripLength = (itinerary.startDate && itinerary.endDate)
        ? daysBetween(itinerary.startDate, itinerary.endDate)
        : templateDays.length;

    // Trim or pad to match trip length
    let days = [...templateDays];
    if (days.length > tripLength) days = days.slice(0, tripLength);
    while (days.length < tripLength) {
        days.push({ day: days.length + 1, activities: [] });
    }

    return days.map((d, idx) => {
        const newDate = startDate ? addDays(startDate, idx) : (d.date || '');
        return {
            ...d,
            day: idx + 1,
            date: newDate,
            dayName: getDayName(newDate),
            isArrivalDay: idx === 0,
            isDepartureDay: idx === days.length - 1,
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
                .sort({ createdAt: -1 }).limit(50).lean().maxTimeMS(8000);
        } else {
            itineraries = await Itinerary.find({ userId }, projection)
                .sort({ createdAt: -1 }).limit(50).lean().maxTimeMS(8000);
        }

        res.json(itineraries);
    } catch (err) {
        console.error('getUserItineraries error:', err?.message);
        res.status(500).json({ msg: 'Server error', error: err?.message });
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
        if (!userId && bookingIdValEarly && mongoose.Types.ObjectId.isValid(bookingIdValEarly)) {
            const booking = await Booking.findById(bookingIdValEarly).select('user').lean();
            userId = booking?.user;
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
        .select('_id title description duration price category location')
        .lean();
}

async function saveGeneratedDays(itinerary, days, source) {
    applyBudgetToDocument(itinerary);
    itinerary.days = days;
    itinerary.aiGenerated = true;
    itinerary.aiGeneratedAt = new Date();
    itinerary.generationSource = source === 'database' || source === 'template' ? 'template' : 'ai';
    itinerary.updatedAt = new Date();
    await itinerary.save();
    await itinerary.populate('controlPanel.hotelId');
    return resPayload(itinerary, source);
}

function resPayload(itinerary, source) {
    const doc = itinerary.toObject ? itinerary.toObject() : itinerary;
    return { itinerary: doc, source };
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
        const startDate = itinerary.startDate
            ? new Date(itinerary.startDate).toISOString().split('T')[0]
            : null;
        const endDate = itinerary.endDate
            ? new Date(itinerary.endDate).toISOString().split('T')[0]
            : null;
        const tripDays = (startDate && endDate) ? daysBetween(startDate, endDate) : 3;

        // Calculate available budget for activities by accounting for hotel and uplift
        let upliftRaw = cp.budgetUplift ?? 15;
        let upliftPct = Math.min(Math.max((upliftRaw > 0 && upliftRaw < 1) ? upliftRaw : (Number(upliftRaw) / 100), 0), 1);
        let hotelCost = 0;
        if (hotel) {
            const nights = Math.max(1, tripDays - 1);
            const rooms = cp.numberOfRooms || 1;
            hotelCost = (hotel.pricePerNight || 0) * nights * rooms;
        }

        let activityBudget = undefined;
        let activityBudgetStr = 'flexible';
        let budgetRulePrompt = '';

        if (itinerary.budget) {
            let maxTotalActivitiesCost = (itinerary.budget / (1 + upliftPct)) - hotelCost;
            maxTotalActivitiesCost = Math.floor(maxTotalActivitiesCost);
            if (maxTotalActivitiesCost < 0) maxTotalActivitiesCost = 0; // AI must not schedule paid activities if budget is consumed
            
            activityBudget = maxTotalActivitiesCost;
            activityBudgetStr = maxTotalActivitiesCost;

            budgetRulePrompt = `\nCRITICAL BUDGET RULE: You have EXACTLY $${activityBudgetStr} to spend on activities. The total sum of the prices of all scheduled activities in your response MUST NOT exceed $${activityBudgetStr}. You must select a subset of the available activities (or adjust activity selections) so that the sum of their 'price' fields is strictly less than or equal to $${activityBudgetStr}. Note: DO NOT worry about hotel prices or service fees, they are already accounted for. JUST keep the sum of activity prices under $${activityBudgetStr}.`;
        }

        const mode = req.body.mode || 'ai';

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
                await saveGeneratedDays(itinerary, adaptedDays, 'database');
                return res.json(resPayload(itinerary, 'database'));
            } else {
                const templateDays = buildDefaultDays(
                    itinerary,
                    bookingActivities.length > 0 ? bookingActivities : activities,
                    bookingActivities.length > 0,
                    activityBudget
                );
                await saveGeneratedDays(itinerary, templateDays, 'template');
                return res.json(resPayload(itinerary, 'template'));
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
            await saveGeneratedDays(itinerary, templateDays, 'template');
            return res.json({
                ...resPayload(itinerary, 'template'),
                warning: 'OPENAI_API_KEY not configured. Generated a starter template — add OPENAI_API_KEY to enable full AI itineraries.',
            });
        }

        const systemPrompt = `You are a professional travel itinerary planner. Create a detailed day-by-day itinerary as valid JSON only. No markdown, no explanation — just raw JSON.`;

        const requiredActivitiesPrompt = bookingActivities.length > 0
            ? `\nREQUIRED TRAVELER ACTIVITIES (You MUST schedule these activities into the days):
${bookingActivities.map(a => `- id:${a._id || 'custom'} | "${a.title}" | price:$${a.price || 0} | category:${a.category || 'general'}`).join('\n')}
Note: Make sure to assign the corresponding "activityId" to the activity objects in the JSON response.`
            : '';

        const overridesPrompt = Array.isArray(cp.perDayOverrides) && cp.perDayOverrides.length > 0
            ? `\nSpecific day-by-day scheduling overrides (Use these instead of the default rules for these specific dates):
${cp.perDayOverrides.map(o => `- Date: ${o.date} | Start: ${o.startTime || 'default'} | End: ${o.endTime || 'default'} | Lunch: ${o.lunchStart || 'default'} to ${o.lunchEnd || 'default'}`).join('\n')}`
            : '';

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
        "title": "Welcome Dinner",
        "description": "Relaxing first evening dinner",
        "startTime": "19:00",
        "endTime": "21:00",
        "price": 30,
        "category": "dining",
        "image": "",
        "isSupplierOnly": false
      }
    ]` : '[]'}
  }`;

        const userPrompt = `Create a ${tripDays}-day travel itinerary for ${city || country}.

Trip details:
- Start date: ${startDate || 'not specified'}
- End date: ${endDate || 'not specified'}
- Travelers: ${itinerary.numberOfTravelers || 2}
- Activity Budget Limit: $${activityBudgetStr} (DO NOT EXCEED)
- Hotel: ${hotel ? hotel.name : 'not specified'}

Scheduling rules:
- Activity start time each day: ${cp.activityStartTime || '09:00'}
- Activity end time each day: ${cp.activityEndTime || '19:00'}
- Lunch break: ${cp.lunchStart || '13:00'} to ${cp.lunchEnd || '14:00'} (no activities during lunch)
- Day 1 is arrival day — ${cp.startOnArrival ? 'you MUST schedule at least one activity today after check-in' : 'keep free (no activities), just airport/hotel transfer'}
- Last day is departure day — ${cp.endOnDeparture ? 'you MUST schedule at least one activity today before check-out' : 'keep free (no activities), just hotel/airport transfer'}${overridesPrompt}
- You MUST schedule all activities listed under "REQUIRED TRAVELER ACTIVITIES" on appropriate days, distributing them evenly.${budgetRulePrompt}
- When creating generic/custom activities, assign accurate estimated prices so the budget can be calculated correctly.

Available activities (use activityId from this list when assigning):
${activities.length > 0
    ? activities.map(a => `- id:${a._id} | "${a.title}" | duration:${a.duration || '2 hours'} | price:$${a.price || 0} | category:${a.category || 'general'}`).join('\n')
    : '(no pre-loaded activities — create generic appropriate activities for the destination)'
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
            await saveGeneratedDays(itinerary, templateDays, 'template');
            return res.json({
                ...resPayload(itinerary, 'template'),
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
        await saveGeneratedDays(itinerary, finalDays, 'ai');
        return res.json(resPayload(itinerary, 'ai'));
    } catch (err) {
        console.error('generateItinerary error:', err?.message, err?.stack);
        res.status(500).json({ msg: 'Server error', error: err?.message });
    }
};

// ─── SAVE control panel ──────────────────────────────────────────────────────

exports.saveControlPanel = async (req, res) => {
    try {
        const itinerary = await Itinerary.findById(req.params.id);
        if (!itinerary) return res.status(404).json({ msg: 'Itinerary not found' });

        if (req.body.startDate !== undefined) {
            itinerary.startDate = req.body.startDate;
        }
        if (req.body.endDate !== undefined) {
            itinerary.endDate = req.body.endDate;
        }

        itinerary.controlPanel = { ...((itinerary.controlPanel || {})), ...req.body };
        itinerary.updatedAt = new Date();
        await itinerary.save();
        await itinerary.populate('controlPanel.hotelId');

        res.json(itinerary);
    } catch (err) {
        console.error('saveControlPanel error:', err?.message);
        res.status(500).json({ msg: 'Server error', error: err?.message });
    }
};

// ─── SAVE days (manual edits after AI generation) ────────────────────────────

exports.saveDays = async (req, res) => {
    try {
        const itinerary = await Itinerary.findById(req.params.id);
        if (!itinerary) return res.status(404).json({ msg: 'Itinerary not found' });

        if (!Array.isArray(req.body.days)) {
            return res.status(400).json({ msg: 'days must be an array' });
        }

        itinerary.days = req.body.days;
        itinerary.updatedAt = new Date();
        await itinerary.save();
        await itinerary.populate('controlPanel.hotelId');

        res.json(itinerary);
    } catch (err) {
        console.error('saveDays error:', err?.message);
        res.status(500).json({ msg: 'Server error', error: err?.message });
    }
};
