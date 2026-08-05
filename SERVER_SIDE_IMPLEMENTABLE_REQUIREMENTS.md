# Server-Side SRS v1.0 / Dev Technical Design Doc v1.0 — Implementable Requirements Extract

Two companion docs (`Dev-Technical-Design-Doc.pdf`, `Server-Side-SRS.pdf`) describe a full target-state microservices architecture (10 services, Kubernetes, message bus, KMS vault, API gateway, vector store, mTLS). That architecture is **not buildable** in this dev environment (single Node/Express monolith + SQLite + React, no k8s/message-bus/KMS available) and a rewrite was explicitly ruled out.

This file extracts only the requirements that are genuinely **implementable as backend behavior inside the current monolith** — i.e., they describe an observable API/data contract, not an infrastructure topology. Skip anything that is inherently about service separation, container orchestration, or managed infra.

## In scope — implement these

1. **SR-FR-0.4 (Idempotency-Key)** — State-mutating POST endpoints (run trigger, test case creation/review, credential submission, bulk actions) should honor an `Idempotency-Key` header: on a repeated key, return the original response rather than re-executing the mutation. Needs a short-TTL store (an in-process/SQLite table is fine — no Redis available).

2. **Error code catalog (Dev TDD §6.5)** — Standardize error response bodies across the API to include a stable `error_code` field alongside the message, per this table:
   | HTTP | error_code | Meaning |
   |---|---|---|
   | 400 | INVALID_SCHEMA | malformed/invalid input (FR-1.9) |
   | 401 | AUTH_REQUIRED | missing/invalid identity |
   | 403 | FORBIDDEN_ROLE | RBAC denied (FR-8.1) |
   | 409 | CONCURRENT_EDIT_CONFLICT | optimistic-lock conflict, merge payload included (FR-9.1) |
   | 422 | SECURITY_SCAN_FAILED | generated script failed static scan (FR-3.6) |
   | 429 | RATE_LIMITED | rate limit exceeded, `Retry-After` header set |
   | 503 | LLM_PROVIDER_DEGRADED | both LLM providers unavailable, request queued (FR-9.3/9.4) |
   Retrofit existing error responses to use these codes where the situation already exists in the codebase (most of these situations are already handled — this is about adding the stable `error_code` field, not new behavior). Only add net-new behavior (e.g. 429 rate limiting) if nothing like it exists yet — check first.

3. **SR-FR-9.1 (structured merge-conflict payload)** — The existing 409 conflict response (FR-9.1, already implemented per GAP_ANALYSIS.md) should include not just "your version" and "current version" but ideally a `common_ancestor` reference (the version both edits started from) if that's cheaply derivable from the existing version-history data. If not cheaply derivable, skip and say so.

4. **SR-FR-2.5 / SR-FR-8.5 named-reviewer gate** — Already implemented as part of the FR-4.29 fix (reviewer identity required, `reviewer_user_id` recorded). Verify it's consistent with this doc's wording (test case cannot transition to 'approved' without a ReviewAction referencing an authenticated reviewer) — no new work expected, just confirm.

5. **SR-FR-3.4 (locator strategy as structured metadata)** — Check whether `automation_scripts` (or the equivalent table) records locator strategy (`accessibility` vs `css_xpath_fallback`) as a queryable column, not just inline in code comments. If it's only in comments, add a column and populate it at generation time so it's queryable (supports FR-3.4 compliance reporting).

6. **SR-FR-2.7 (bulk ops atomicity + partial-failure reporting)** — Verify the existing bulk test-case action endpoint (FR-2.15) reports per-item success/failure (`{succeeded: [...], failed: [{id, reason}]}`) rather than an all-or-nothing result. If it's already atomic-per-batch with a single audit entry but doesn't report partial failures per item, add that reporting.

7. **SR-FR-7.2 (outbound webhook/notification retry + DLQ-like handling)** — Check whether Slack/Teams notifications and Jira/Azure bug-filing (FR-7.3/7.6) retry on failure or just fire-and-forget. If fire-and-forget with no retry, add a simple retry-with-backoff (e.g. 3 attempts) and log deliveries that exhaust retries to a small "failed_deliveries" table or the audit log, so they're at least visible rather than silently dropped. A full message-queue DLQ isn't buildable here — this is the closest honest approximation.

8. **SR-FR-8.5 (export/import schema versioning)** — Check whether the existing project export/import (FR-8.10) includes a schema version in the exported archive and rejects import of an unrecognized version. If it doesn't, add a `schema_version` field to the export format and a version check on import that rejects (with a clear error) rather than partially importing an incompatible archive.

9. **API path versioning (Dev TDD §1.2, SR-FR-0.3)** — Note whether existing routes are already effectively versioned (e.g. under `/api/`) — if there's no `/v1/`-style prefix at all, this is a bigger change with wide blast radius (every client fetch call). Only do this if it's a cheap additive change (e.g. mounting the existing router additionally under a versioned prefix without removing the old one) — do NOT break existing routes or require a full client rewrite.

## Out of scope — do not attempt

- Splitting into separate services/processes, Kubernetes manifests, Helm charts, node pools, taints
- Message bus / event catalog (Kafka, SQS/SNS, Pub/Sub) — the monolith calls functions directly instead, which is fine
- KMS-backed vault, mTLS, SAML/OIDC real handshake (already flagged as infra-bound in GAP_ANALYSIS.md)
- Vector store / pgvector for semantic caching — the existing semantic cache implementation (FR-9.5) is a simpler in-process approximation and that's fine
- Multi-region DR, read replicas, columnar/analytical store, observability-service/OpenTelemetry stack
- Per-org storage quotas, network segmentation, per-org fair-share scheduling on a runner pool that doesn't exist as a separate infra layer
- Any SCIM/IdP-deprovisioning automation beyond what FR-8.9's existing stub already does

## Process note

For each in-scope item, verify against actual current code first — several of these may already be satisfied by prior gap-analysis fix passes (especially #3, #4, #6 given the recent FR-4.28/4.29 and FR-9.1 work). Don't re-implement something that already exists; just confirm and note it. Only build what's genuinely missing.
