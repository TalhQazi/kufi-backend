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
| `activity-reorder` | The admin up/down arrows: admin-only, input validation, `/reorder` is not shadowed by `/:id`, rows swap, orders come out sequential, the public listing reflects the change. Snapshots and restores the real ordering |
| `uplift-effect` | Changing the budget uplift actually changes the generated plan, on both the template and AI paths. Use `PROBE_BUDGET=100` for a budget tight enough that the ceiling binds |
| `uplift-zero-budget` | What `uplift = 0` does to the activity ceiling, including the case where hotel and custom costs consume the whole budget and the ceiling collapses to $0 |
| `lunch-break-live-audit` | Applies the classifier to real itinerary data and reports what changes, guarding against over-matching |
| `activities-sort-parity` | The database-side sort and pagination return exactly the order the previous in-JS sort produced |

Probes print `PASS` / `FAIL` per assertion and exit non-zero on error.
