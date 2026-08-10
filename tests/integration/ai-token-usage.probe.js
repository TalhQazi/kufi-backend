/**
 * Where do the tokens go when generating an itinerary with AI?
 *
 * Rebuilds the exact prompt the controller sends, breaks it down section by section, and
 * (with --live) makes one real call so the numbers come from the API's own usage report
 * rather than an estimate.
 */
require('dotenv').config({ path: __dirname + '/../../.env' });
const mongoose = require('mongoose');
const OpenAI = require('openai');

const LIVE = process.argv.includes('--live');

const {
    getCoordinates, resolveLunchWindow, SAME_AREA_RADIUS_KM, FLIGHT_THRESHOLD_KM,
} = require('../../utils/geo');

// ~4 characters per token for English + JSON. Used only for the section breakdown; the
// totals below come from the API when --live is passed.
const est = (s) => Math.ceil(String(s).length / 4);
const pad = (s, n) => String(s).padEnd(n);

(async () => {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 20000 });
    const Activity = require('../../models/Activity');

    const country = 'Egypt';
    const city = '';
    const activities = await Activity.find({
        status: 'approved',
        $or: [{ country: new RegExp('^Egypt$', 'i') }],
    }).select('_id title description duration price category location country city image coordinates rating reviews highlights').lean();

    console.log(`catalogue rows sent to the model: ${activities.length}\n`);

    const cp = { activityStartTime: '09:00', activityEndTime: '19:00', lunchDurationMinutes: 60, startOnArrival: false, endOnDeparture: true };
    const tripDays = 7;
    const startDate = '2026-09-01';
    const endDate = '2026-09-07';

    // ── the exact sections the controller builds ────────────────────────────────
    const systemPrompt = `You are an expert travel itinerary planner and geographic strategist. Create a realistic, highly engaging day-by-day travel itinerary strictly formatted as raw JSON array only. No markdown formatting outside json block, no conversational text.`;

    const activityLines = activities.map((a) => {
        const c = getCoordinates(a);
        return `- id:${a._id} | "${a.title}" | location:${a.location || a.city || city || 'local'}${c ? ` | coords:${c.lat.toFixed(4)},${c.lng.toFixed(4)}` : ''} | duration:${a.duration || '2 hours'} | price:$${a.price || 0} | category:${a.category || 'general'}`;
    }).join('\n');

    const header = `Create a complete ${tripDays}-day travel itinerary for ${city || country}.

Trip details:
- Destination: ${city || country}
- Start date: ${startDate}
- End date: ${endDate}
- Travelers: 2
- Activity Budget Ceiling: $4720 (DO NOT EXCEED)
- STARTING POINT / ORIGIN (0,0 ANCHOR): Downtown / City Center of ${country}. The trip begins from this starting location.
`;

    const rules = `
Mandatory Constraints:
1. GEOGRAPHICAL CLUSTERING RULE: Activities scheduled on the same day MUST be within about ${Math.round(SAME_AREA_RADIUS_KM)}km of each other — use the coordinates given for each activity below. Never mix activities from distant bases on the same day. Group each base into consecutive days, and when the trip moves from one base to another put the move on a single travel day with fewer activities, allowing realistic travel time (road at ~70km/h, or a flight for legs over ${Math.round(FLIGHT_THRESHOLD_KM)}km).
2. MANDATORY ICONIC LANDMARKS RULE: You MUST unconditionally include famous landmark attractions of the destination (e.g. Pyramids of Giza, Great Sphinx, Egyptian Museum for Cairo/Egypt; Karnak Temple, Valley of the Kings for Luxor; Burj Khalifa for Dubai; etc.) in the itinerary.
3. Activity start time each day: ${cp.activityStartTime}
4. Activity end time each day: ${cp.activityEndTime}
5. Lunch break: ${resolveLunchWindow(cp).lunchStart} to ${resolveLunchWindow(cp).lunchEnd} on EVERY day. Leave this window free. If you include a lunch/rest placeholder it MUST be marked "isBreak": true and "category": "break" — it is not an activity and must never be given a price or an activityId.
6. Day 1 is arrival day — keep free (no activities), just airport/hotel transfer
7. Last day (Day ${tripDays}) is departure day — always include departureNote.
8. You MUST schedule all activities listed under "REQUIRED TRAVELER ACTIVITIES" on appropriate days.
CRITICAL BUDGET TOLERANCE RULE: Customer budget is $4000. With a 15% budget tolerance allowance, the maximum allowed total trip budget ceiling is $4600. After accounting for hotel accommodation ($0) and custom costs ($0), the sum of prices of all scheduled activities MUST NOT exceed $4600. Select high-value, iconic activities strictly under $4600.
`;

    const schema = `
Return ONLY a JSON array with this exact structure:
[
  { "day": 1, "date": "${startDate}", "dayName": "Monday", "isArrivalDay": true, "isDepartureDay": false, "arrivalNote": "Arrival Day — Free Day. Airport to Hotel transfer provided.", "activities": [] },
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

    const catalogueBlock = `\nAvailable activities (prefer these pre-loaded activities and match activityId when assigning):\n${activityLines}\n`;
    const userPrompt = header + rules + catalogueBlock + schema;

    const sections = [
        ['system prompt', systemPrompt],
        ['trip header', header],
        ['rules + budget', rules],
        ['ACTIVITY CATALOGUE', catalogueBlock],
        ['output schema example', schema],
    ];

    const total = est(systemPrompt) + est(userPrompt);
    console.log(pad('section', 26), pad('chars', 10), pad('~tokens', 10), 'share');
    console.log('-'.repeat(62));
    sections.forEach(([name, text]) => {
        const t = est(text);
        console.log(pad(name, 26), pad(String(text.length), 10), pad(String(t), 10), `${((t / total) * 100).toFixed(1)}%`);
    });
    console.log('-'.repeat(62));
    console.log(pad('TOTAL INPUT (estimate)', 26), pad(String(systemPrompt.length + userPrompt.length), 10), pad(String(total), 10), '100%');

    // What one catalogue row costs, and what trimming it would save.
    const oneRow = activityLines.split('\n')[0];
    console.log(`\naverage catalogue row: ${Math.round(activityLines.length / activities.length)} chars (~${Math.ceil(activityLines.length / activities.length / 4)} tokens)`);
    console.log(`example: ${oneRow}`);

    if (!LIVE) {
        console.log('\n(estimates only — re-run with --live for exact usage from the API)');
        await mongoose.disconnect();
        return;
    }

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const t0 = Date.now();
    const completion = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
        ],
        temperature: 0.4,
        max_tokens: 4000,
    });
    const ms = Date.now() - t0;
    const u = completion.usage;
    console.log('\n=== EXACT usage reported by the API ===');
    console.log(`  prompt_tokens      ${u.prompt_tokens}`);
    console.log(`  completion_tokens  ${u.completion_tokens}`);
    console.log(`  total_tokens       ${u.total_tokens}`);
    console.log(`  latency            ${(ms / 1000).toFixed(1)}s`);
    // gpt-4o list pricing at time of writing: $2.50 / 1M input, $10.00 / 1M output.
    const cost = (u.prompt_tokens / 1e6) * 2.5 + (u.completion_tokens / 1e6) * 10;
    console.log(`  cost per generation ~$${cost.toFixed(4)}  (gpt-4o @ $2.50/$10.00 per 1M)`);
    console.log(`  estimate accuracy: predicted ${total}, actual ${u.prompt_tokens} (${((total / u.prompt_tokens) * 100).toFixed(0)}%)`);

    await mongoose.disconnect();
})().catch(async (e) => { console.error('ERR', e.message); try { await mongoose.disconnect(); } catch { } process.exit(1); });
