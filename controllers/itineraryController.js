const mongoose = require('mongoose');
const OpenAI = require('openai');
const Itinerary = require('../models/Itinerary');
const Activity = require('../models/Activity');
const Hotel = require('../models/Hotel');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ─── helpers ────────────────────────────────────────────────────────────────

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

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
        const userId = role === 'supplier' ? requestedUserId : authUserId;

        if (!userId) return res.status(401).json({ msg: 'User not authenticated' });
        if (!mongoose.Types.ObjectId.isValid(userId)) return res.status(400).json({ msg: 'Invalid userId format' });

        const tripData = req.body?.tripData;
        const title = req.body?.title || tripData?.title;
        const destination = req.body?.destination || tripData?.destination || tripData?.location;

        if (!title || !destination) return res.status(400).json({ msg: 'Missing required fields: title, destination' });

        const bookingIdVal = req.body?.bookingId || req.body?.requestId;
        const supplierIdVal = role === 'supplier' ? authUserId : req.body?.supplierId;

        if (bookingIdVal && !mongoose.Types.ObjectId.isValid(bookingIdVal)) return res.status(400).json({ msg: 'Invalid bookingId format' });
        if (supplierIdVal && !mongoose.Types.ObjectId.isValid(supplierIdVal)) return res.status(400).json({ msg: 'Invalid supplierId format' });

        const itinerary = new Itinerary({
            ...req.body,
            userId,
            supplierId: supplierIdVal,
            bookingId: bookingIdVal,
            title,
            destination,
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
        const itinerary = await Itinerary.findById(req.params.id)
            .populate('controlPanel.hotelId', 'name city country pricePerNight rooms');
        if (!itinerary) return res.status(404).json({ msg: 'Itinerary not found' });
        res.json(itinerary);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server error');
    }
};

// ─── GENERATE itinerary with AI ──────────────────────────────────────────────

exports.generateItinerary = async (req, res) => {
    try {
        const itinerary = await Itinerary.findById(req.params.id);
        if (!itinerary) return res.status(404).json({ msg: 'Itinerary not found' });

        const country = (itinerary.country || itinerary.tripData?.country || itinerary.destination || '').trim();
        const city = (itinerary.city || itinerary.tripData?.city || itinerary.destination || '').trim();

        if (!country && !city) {
            return res.status(400).json({ msg: 'Itinerary must have country or city to generate' });
        }

        // ── Level 1: same country + city already generated in DB ─────────────
        const existing = await Itinerary.findOne({
            $or: [
                { country: new RegExp(`^${country}$`, 'i'), city: new RegExp(`^${city}$`, 'i') },
                { country: new RegExp(`^${country}$`, 'i') },
            ],
            aiGenerated: true,
            _id: { $ne: itinerary._id },
            days: { $exists: true, $not: { $size: 0 } },
        }).sort({ aiGeneratedAt: -1 }).lean();

        if (existing && Array.isArray(existing.days) && existing.days.length > 0) {
            const adaptedDays = adaptDaysToItinerary(existing.days, itinerary);
            itinerary.days = adaptedDays;
            itinerary.aiGenerated = true;
            itinerary.aiGeneratedAt = new Date();
            itinerary.updatedAt = new Date();
            await itinerary.save();
            return res.json({ itinerary, source: 'database' });
        }

        // ── Level 2: call OpenAI ──────────────────────────────────────────────
        if (!process.env.OPENAI_API_KEY) {
            return res.status(500).json({ msg: 'OPENAI_API_KEY not configured' });
        }

        const activities = await Activity.find({
            $or: [
                { country: new RegExp(`^${country}$`, 'i') },
                { location: new RegExp(city, 'i') },
            ],
            status: 'approved',
        }).select('_id title description duration price category image location').lean();

        const hotel = itinerary.controlPanel?.hotelId
            ? await Hotel.findById(itinerary.controlPanel.hotelId).lean()
            : null;

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

        const completion = await openai.chat.completions.create({
            model: 'gpt-4o',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
            ],
            temperature: 0.4,
            max_tokens: 4000,
        });

        let aiDays;
        try {
            const raw = completion.choices[0].message.content.trim();
            const jsonStr = raw.startsWith('[') ? raw : raw.replace(/```json\n?/, '').replace(/```\n?$/, '').trim();
            aiDays = JSON.parse(jsonStr);
        } catch (parseErr) {
            console.error('Failed to parse AI response:', parseErr.message);
            return res.status(500).json({ msg: 'AI returned invalid JSON', error: parseErr.message });
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

        itinerary.days = enrichedDays;
        itinerary.aiGenerated = true;
        itinerary.aiGeneratedAt = new Date();
        itinerary.updatedAt = new Date();
        await itinerary.save();

        return res.json({ itinerary, source: 'ai' });
    } catch (err) {
        console.error('generateItinerary error:', err?.message);
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
