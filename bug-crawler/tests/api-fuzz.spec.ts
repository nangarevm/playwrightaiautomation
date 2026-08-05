// API fuzz testing (step 5). Targets real endpoints read from
// server/src/index.ts's app.use("/api/...") mounts + each router file's own
// route table (server/src/routes/*.ts) -- not guessed paths. Every id in this
// app is a nanoid string (server/src/db.ts), not a numeric primary key, so
// "negative ID" / "huge number" boundary cases below are the string forms of
// those (a numeric-ID assumption would be testing a data model this app
// doesn't have).
//
// Scope is deliberately GET-heavy: :id lookups are pure reads (safe to fuzz
// freely) and are exactly where an unvalidated id reaching a DB layer most
// often turns into a 500 instead of a clean 404. One POST create endpoint is
// included per the brief's "hit key API endpoints" -- ASSUMPTION (flagged):
// this runs against a local dev SQLite DB (server/data.db) and creating a
// handful of garbage test_cases rows during a fuzz pass is expected/harmless
// there; do not point this project at a shared or production database.
import { test, expect } from "@playwright/test";

const API_BASE_URL = process.env.API_BASE_URL ?? "http://localhost:4100";
const AUTH_HEADER = { "X-User-Id": "user-qa-lead" };

const FUZZ_IDS = [
  { label: "negative id", value: "-1" },
  { label: "huge number id", value: "99999999999999999999999999" },
  { label: "sqli-like id", value: "' OR '1'='1' --" },
  { label: "xss-like id", value: "<script>alert(1)</script>" },
  { label: "path traversal id", value: "../../etc/passwd" },
  { label: "null-byte id", value: "abc%00def" },
];

// GET endpoints that take an :id-shaped path param, sourced directly from
// server/src/routes/*.ts.
const ID_ENDPOINTS = [
  "/api/test-cases/:id",
  "/api/test-cases/:id/explain",
  "/api/test-cases/:id/audit",
  "/api/screens/:id",
  "/api/crawler/sites/:id",
  "/api/crawler/sites/:id/detail",
  "/api/integrations/:id",
  "/api/execution-runs/:runId/evidence",
];

test.describe("API fuzz: GET :id endpoints never 5xx", () => {
  for (const endpointTemplate of ID_ENDPOINTS) {
    for (const fuzz of FUZZ_IDS) {
      test(`${endpointTemplate} with ${fuzz.label}`, async ({ request }) => {
        const url = `${API_BASE_URL}${endpointTemplate.replace(/:\w+/, encodeURIComponent(fuzz.value))}`;
        const res = await request.get(url, { headers: AUTH_HEADER, failOnStatusCode: false });
        expect(res.status(), `${url} returned ${res.status()} — expected a clean 4xx, not a 5xx crash`).toBeLessThan(500);
      });
    }
  }
});

test.describe("API fuzz: POST /api/test-cases with boundary/invalid bodies", () => {
  const FUZZ_BODIES: Array<{ label: string; body: Record<string, unknown> }> = [
    { label: "empty strings", body: { title: "", category: "", steps: [], expected_result: "" } },
    { label: "huge string field", body: { title: "A".repeat(200_000), category: "Smoke", steps: ["step"], expected_result: "ok" } },
    { label: "sqli-like strings", body: { title: "'; DROP TABLE test_cases; --", category: "Smoke", steps: ["step"], expected_result: "ok" } },
    { label: "xss-like strings", body: { title: "<img src=x onerror=alert(1)>", category: "Smoke", steps: ["step"], expected_result: "ok" } },
    { label: "wrong types", body: { title: 12345, category: null, steps: "not-an-array", expected_result: {} } },
    { label: "missing required fields", body: {} },
  ];

  for (const fuzz of FUZZ_BODIES) {
    test(`POST /api/test-cases with ${fuzz.label}`, async ({ request }) => {
      const res = await request.post(`${API_BASE_URL}/api/test-cases`, {
        headers: AUTH_HEADER,
        data: fuzz.body,
        failOnStatusCode: false,
      });
      expect(res.status(), `POST /api/test-cases with ${fuzz.label} returned ${res.status()} — expected a clean 4xx, not a 5xx crash`).toBeLessThan(500);
    });
  }
});
