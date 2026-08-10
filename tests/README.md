# Tests

## Unit tests

Pure functions — no database, no network, no server required.

```bash
node --test "tests/**/*.test.js"
```

Covers the logic behind issues 3 and 6:

- `geo-and-activities.test.js`
  - activity vs. schedule-break classification (lunch breaks must not count)
  - haversine distance, duration parsing, travel time and transport mode
  - geographic clustering, route ordering, daily-capacity budgeting
  - post-generation validation and repair of infeasible days

## Integration probes

These run against a **live server and database**. They create their own throwaway
records and delete them again, but they do write to whatever `MONGO_URI` points at —
run them against a development database, not production.

```bash
# terminal 1
node server.js

# terminal 2
node tests/integration/supplier-auth-security.probe.js
node tests/integration/itinerary-controlpanel-geography.probe.js
node tests/integration/adjustment-request.probe.js
node tests/integration/control-panel-dynamic.probe.js    # add --ai to test the AI path
node tests/integration/ai-generation-live.probe.js       # makes ONE real OpenAI call
node tests/integration/ai-token-usage.probe.js           # add --live for exact usage
node tests/integration/overview-controlpanel.probe.js
node tests/integration/day-boundaries.probe.js
node tests/integration/lunch-duration.probe.js
node tests/integration/activity-reorder.probe.js
node tests/integration/uplift-effect.probe.js            # add --ai for real OpenAI calls
node tests/integration/uplift-zero-budget.probe.js
node tests/integration/lunch-break-live-audit.probe.js   # read-only
node tests/integration/activities-sort-parity.probe.js   # read-only
```

| Probe | What it pins down |
| --- | --- |
| `supplier-auth-security` | Supplier can submit/edit/delete only their own experiences; identity comes from the token; unauthenticated, invalid-token, wrong-role, duplicate and missing-field cases; booking and itinerary IDOR; change-password rules and session invalidation; reset-token hashing, expiry and single use; case-insensitive email; rate limiting |
| `itinerary-controlpanel-geography` | Every Control Panel value survives generation (including `uplift = 0`); an unsaved control panel drives generation without being persisted; lunch breaks are marked and excluded from counts; generated days are geographically feasible |
| `adjustment-request` | "Request Adjustment" reaches the supplier: accepted from both the booking id and the itinerary id, stored on the booking, the supplier is notified and the dashboard counts it; plus authorization and empty-card rejection |
| `control-panel-dynamic` | Every Control Panel field, one at a time: proves the setting changes the generated itinerary rather than being ignored. The stored panel is deliberately seeded with different values, so a pass can only mean the in-flight panel won. Exits non-zero if any field is static |
| `ai-generation-live` | One real AI generation: reports token usage and latency, and checks the plan is still correct (geography, arrival day, no duplicates, catalogue linkage, budget) |
| `ai-token-usage` | Breaks the prompt down section by section so prompt growth is visible; `--live` reports exact usage and cost from the API |
| `overview-controlpanel` | Settings made on the "Proceed to create itinerary" screen drive generation even when the request already has an itinerary record, and generation stays a preview (the stored copy is not overwritten) |
| `day-boundaries` | `startOnArrival` / `endOnDeparture` actually change the plan on every generation path, and Save-as-Draft persists and lands the request in the Drafts tab |
| `lunch-duration` | The lunch break is duration-driven, centred in the activity window, identical on every day, and absent when the duration is 0 |
| `activity-reorder` | The admin up/down arrows: admin-only, input validation, `/reorder` is not shadowed by `/:id`, rows swap, orders come out sequential, the public listing reflects the change. Snapshots and restores the real ordering |
| `uplift-effect` | Changing the budget uplift actually changes the generated plan, on both the template and AI paths. Use `PROBE_BUDGET=100` for a budget tight enough that the ceiling binds |
| `uplift-zero-budget` | What `uplift = 0` does to the activity ceiling, including the case where hotel and custom costs consume the whole budget and the ceiling collapses to $0 |
| `lunch-break-live-audit` | Applies the classifier to real itinerary data and reports what changes, guarding against over-matching |
| `activities-sort-parity` | The database-side sort and pagination return exactly the order the previous in-JS sort produced |

Probes print `PASS` / `FAIL` per assertion and exit non-zero on error.
