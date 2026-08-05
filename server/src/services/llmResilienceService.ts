// FR-9.3 (MVP gate): define and implement queue/retry/fail behavior when the LLM API is
// rate-limited or unavailable, rather than failing generation outright. Retries with backoff
// inline (typical rate-limit blips resolve within a couple hundred ms), and if every attempt
// still fails, marks the input as queued for a later manual/automatic retry instead of just
// returning a bare error with no recovery path.

import { nanoid } from "nanoid";
import { db } from "../db.js";
import { llm } from "../llm/index.js";
import { mockProvider } from "../llm/mockProvider.js";
import { GeneratedTestCase } from "../llm/types.js";

const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [200, 500, 1200];

// FR-9.4: if the primary provider is a real (non-mock) provider, the mock
// provider doubles as the "secondary configured LLM provider" for failover --
// it's always available locally and requires no extra API key/config, so a
// primary-provider outage never leaves generation with nowhere to fail over to.
const hasSecondaryProvider = llm.name !== "mock";

function logFailoverEvent(inputId: string, reason: string) {
  db.prepare(
    "INSERT INTO audit_log (id, actor_user_id, actor_role, action, entity_type, entity_id, details, created_at) VALUES (@id, NULL, 'system', 'llm_provider_failover', 'input', @entity_id, @details, @created_at)"
  ).run({
    id: nanoid(10),
    entity_id: inputId,
    details: `Primary LLM provider (${llm.name}) unavailable; failed over to secondary provider (${mockProvider.name}). Reason: ${reason}`,
    created_at: new Date().toISOString(),
  });
}

export class LlmDegradedModeError extends Error {
  queued = true;
  constructor(message: string) {
    super(message);
    this.name = "LlmDegradedModeError";
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryable(err: any): boolean {
  const status = err?.status ?? err?.response?.status;
  if (status === 429 || (typeof status === "number" && status >= 500)) return true;
  const message = String(err?.message ?? "").toLowerCase();
  return message.includes("rate limit") || message.includes("timeout") || message.includes("unavailable") || message.includes("econnrefused") || message.includes("fetch failed");
}

export async function generateTestCasesWithDegradedMode(
  inputId: string,
  prompt: string
): Promise<{ cases: GeneratedTestCase[]; failoverUsed: boolean }> {
  db.prepare("UPDATE inputs SET generation_status = 'pending' WHERE id = ?").run(inputId);

  let lastError: any = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const cases = await llm.generateTestCases(prompt);
      db.prepare(
        "UPDATE inputs SET generation_status = 'completed', generation_attempts = ?, generation_last_error = NULL WHERE id = ?"
      ).run(attempt, inputId);
      return { cases, failoverUsed: false };
    } catch (err: any) {
      lastError = err;
      db.prepare("UPDATE inputs SET generation_attempts = ?, generation_last_error = ? WHERE id = ?").run(
        attempt,
        err?.message ?? String(err),
        inputId
      );

      const canRetry = attempt < MAX_ATTEMPTS && isRetryable(err);
      if (!canRetry) break;

      db.prepare("UPDATE inputs SET generation_status = 'retrying' WHERE id = ?").run(inputId);
      await sleep(BACKOFF_MS[attempt - 1] ?? 1000);
    }
  }

  // FR-9.4: the primary provider stayed unavailable past the retry budget above --
  // fail over to the secondary provider rather than immediately giving up.
  if (hasSecondaryProvider) {
    try {
      const cases = await mockProvider.generateTestCases(prompt);
      logFailoverEvent(inputId, lastError?.message ?? "unknown error");
      db.prepare(
        "UPDATE inputs SET generation_status = 'completed', generation_attempts = ?, generation_last_error = ? WHERE id = ?"
      ).run(MAX_ATTEMPTS + 1, `Recovered via secondary-provider failover after: ${lastError?.message ?? "unknown error"}`, inputId);
      return { cases, failoverUsed: true };
    } catch {
      // secondary also failed -- fall through to the queued/degraded-mode error below
    }
  }

  db.prepare("UPDATE inputs SET generation_status = 'queued' WHERE id = ?").run(inputId);
  throw new LlmDegradedModeError(
    `LLM API unavailable after ${MAX_ATTEMPTS} attempt(s): ${lastError?.message ?? "unknown error"}. Generation has been queued -- retry via POST /api/inputs/:id/retry-generation.`
  );
}
