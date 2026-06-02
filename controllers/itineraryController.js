const mongoose = require('mongoose');
const OpenAI = require('openai');
const Itinerary = require('../models/Itinerary');
const Activity = require('../models/Activity');
const Hotel = require('../models/Hotel');
const Booking = require('../models/Booking');

// ─── helpers ────────────────────────────────────────────────────────────────

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function escapeRegExp(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseBudget(value) {
    if (value === null || value === undefined) return undefined;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const raw = String(value).trim();
    if (!raw || raw === '—' || raw.toLowerCase() === 'n/a') return undefined;
    const cleaned = raw.replace(/[^0-9.]/g, '');
    const num = Number(cleaned);
    return Number.isFinite(num) ? num : undefined;
}

function getOpenAIClient() {
    const key = process.env.OPENAI_API_KEY;
    if (!key) return null;
    return new OpenAI({ apiKey: key });
}

function buildDefaultDays(itinerary, activities = []) {
    const startDate = itinerary.startDate
        ? new Date(itinerary.startDate).toISOString().split('T')[0]
        : null;
    const endDate = itinerary.endDate
        ? new Date(itinerary.endDate).toISOString().split('T')[0]
        : null;
    const tripDays = (startDate && endDate) ? daysBetween(startDate, endDate) : 3;
    const usableActs = Array.isArray(activities) ? activities : [];

    const days = [];
    for (let idx = 0; idx < tripDays; idx++) {
        const newDate = startDate ? addDays(startDate, idx) : '';
        const isArrival = idx === 0;
        const isDeparture = idx === tripDays - 1;
        const dayActivities = [];

        if (!isArrival && !isDeparture && usableActs.length > 0) {
            const act = usableActs[idx % usableActs.length];
            dayActivities.push({
                activityId: String(act._id),
                title: act.title,
                description: act.description || '',
                startTime: '09:00',
                endTime: '11:00',
                price: Number(act.price) || 0,
                category: act.category || 'general',
                image: act.image || '',
                isSupplierOnly: true,
            });
        }

        days.push({
            day: idx + 1,
            date: newDate,
            dayName: getDayName(newDate),
            isArrivalDay: isArrival,
            isDepartureDay: isDeparture,
            arrivalNote: isArrival ? 'Arrival Day — Free Day. Airport to Hotel transfer provided.' : undefined,
            departureNote: isDeparture ? 'Departure Day — Free Day. Hotel to Airport transfer provided.' : undefined,
            activities: dayActivities,
        });
    }

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
            aiGeneratedAt: 1, createdAt: 1, updatedAt: 1,
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
                return res.json(existingForBooking);
            }
        }

        const country = req.body?.country || tripData?.country || '';
        const city = req.body?.city || tripData?.city || '';
        const resolvedDestination = destination || city || country;

        if (!resolvedDestination) {
            return res.status(400).json({ msg: 'Missing required fields: destination (or country/city)' });
        }

        const itinerary = new Itinerary({
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
            budget: parseBudget(req.body?.budget ?? tripData?.budget),
            tripData: tripData || req.body?.tripData,
            days: Array.isArray(req.body?.days) ? req.body.days : [],
        });

        await itinerary.save();
        res.status(201).json(itinerary);
    } catch (err) {
        console.error('createItinerary error:', err?.message);
        res.status(500).json({ msg: 'Server error', error: err?.message });
    }
};

// ─── GET by ID ───────────────────────────────────────────────────────────────

exports.getItineraryById = async (req, res) => {
    try {
        const itinerary = await Itinerary.findById(req.params.id).lean();
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

        const itinerary = await Itinerary.findOne({ bookingId }).lean();

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
        .select('_id title description duration price category image location')
        .lean();
}

async function saveGeneratedDays(itinerary, days, source) {
    itinerary.days = days;
    itinerary.aiGenerated = true;
    itinerary.aiGeneratedAt = new Date();
    itinerary.updatedAt = new Date();
    await itinerary.save();
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

        const country = (itinerary.country || itinerary.tripData?.country || itinerary.destination || '').trim();
        const city = (itinerary.city || itinerary.tripData?.city || itinerary.tripData?.destination || '').trim();

        if (!country && !city) {
            return res.status(400).json({ msg: 'Itinerary must have country or city to generate' });
        }

        const activities = await fetchActivitiesForDestination(country, city);

        // ── Level 1: same country + city already generated in DB ─────────────
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
        }

        // ── Level 2: call OpenAI (or template fallback) ───────────────────────
        const openai = getOpenAIClient();
        if (!openai) {
            const templateDays = buildDefaultDays(itinerary, activities);
            await saveGeneratedDays(itinerary, templateDays, 'template');
            return res.json({
                ...resPayload(itinerary, 'template'),
                warning: 'OPENAI_API_KEY not configured. Generated a starter template — add OPENAI_API_KEY to enable full AI itineraries.',
            });
        }

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

        const systemPrompt = `You are a professional travel itinerary planner. Create a detailed day-by-day itinerary as valid JSON only. No markdown, no explanation — just raw JSON.`;

        const userPrompt = `Create a ${tripDays}-day travel itinerary for ${city || country}.

Trip details:
- Start date: ${startDate || 'not specified'}
- End date: ${endDate || 'not specified'}
- Travelers: ${itinerary.numberOfTravelers || 2}
- Budget: $${itinerary.budget || 'flexible'}
- Hotel: ${hotel ? hotel.name : 'not specified'}

Scheduling rules:
- Activity start time each day: ${cp.activityStartTime || '09:00'}
- Activity end time each day: ${cp.activityEndTime || '19:00'}
- Lunch break: ${cp.lunchStart || '13:00'} to ${cp.lunchEnd || '14:00'} (no activities during lunch)
- Day 1 is arrival day — keep free (no activities), just airport/hotel transfer
- Last day is departure day — keep free (no activities), just hotel/airport transfer
- Start activities on arrival day: ${cp.startOnArrival ? 'yes' : 'no'}
- End activities on departure day: ${cp.endOnDeparture ? 'yes' : 'no'}

Available activities (use activityId from this list when assigning):
${activities.length > 0
    ? activities.map(a => `- id:${a._id} | "${a.title}" | duration:${a.duration || '2 hours'} | price:$${a.price || 0} | category:${a.category || 'general'}`).join('\n')
    : '(no pre-loaded activities — create generic appropriate activities for the destination)'
}

Return ONLY a JSON array with this exact structure:
[
  {
    "day": 1,
    "date": "${startDate || 'YYYY-MM-DD'}",
    "dayName": "Monday",
    "isArrivalDay": true,
    "isDepartureDay": false,
    "arrivalNote": "Arrival Day — Free Day. Airport to Hotel transfer provided.",
    "activities": []
  },
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
            const templateDays = buildDefaultDays(itinerary, activities);
            await saveGeneratedDays(itinerary, templateDays, 'template');
            return res.json({
                ...resPayload(itinerary, 'template'),
                warning: aiErr?.message || 'AI generation failed. A starter template was created instead.',
            });
        }

        // Attach real activity images from DB where we have an activityId
        const actMap = {};
        activities.forEach(a => { actMap[String(a._id)] = a; });

        const enrichedDays = aiDays.map((d, idx) => ({
            ...d,
            day: idx + 1,
            dayName: getDayName(d.date) || d.dayName || '',
            activities: (d.activities || []).map(act => {
                const dbAct = act.activityId ? actMap[act.activityId] : null;
                return {
                    ...act,
                    image: act.image || dbAct?.image || '',
                    isSupplierOnly: true,
                };
            }),
        }));

        await saveGeneratedDays(itinerary, enrichedDays, 'ai');
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

        itinerary.controlPanel = { ...((itinerary.controlPanel || {})), ...req.body };
        itinerary.updatedAt = new Date();
        await itinerary.save();

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

        res.json(itinerary);
    } catch (err) {
        console.error('saveDays error:', err?.message);
        res.status(500).json({ msg: 'Server error', error: err?.message });
    }
};
