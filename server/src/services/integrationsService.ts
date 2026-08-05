import { execFile } from "child_process";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { nanoid } from "nanoid";
import { db } from "../db.js";
import { decryptSecret, encryptSecret, maskSecret } from "./secretsService.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GENERATED_DIR = path.join(__dirname, "..", "..", "generated");

export type IntegrationType = "jira" | "azure" | "git" | "slack" | "teams" | "testrail" | "zephyr" | "qtest";

// SR-FR-7.2: closest honest approximation of a message-queue DLQ available in
// this monolith. Outbound Slack/Teams notifications (FR-7.3) and Jira/Azure
// auto-bug-filing (FR-7.6) were previously fire-and-forget with no retry --
// a single failed fetch just silently dropped the delivery. This retries with
// exponential backoff and, once retries are exhausted, logs the delivery to
// `failed_deliveries` so it's visible instead of vanishing.
const MAX_DELIVERY_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = [250, 1000]; // delay before attempt 2 and attempt 3

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry<T>(
  deliveryType: "slack_teams_notification" | "auto_file_bug",
  targetRef: string,
  payload: Record<string, any>,
  attemptFn: () => Promise<T>
): Promise<T> {
  let lastError: any;
  for (let attempt = 1; attempt <= MAX_DELIVERY_ATTEMPTS; attempt++) {
    try {
      return await attemptFn();
    } catch (err: any) {
      lastError = err;
      if (attempt < MAX_DELIVERY_ATTEMPTS) {
        await sleep(RETRY_BACKOFF_MS[attempt - 1] ?? 1000);
      }
    }
  }
  const id = nanoid(10);
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO failed_deliveries (id, delivery_type, target_ref, payload, attempts, last_error, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, deliveryType, targetRef, JSON.stringify(payload), MAX_DELIVERY_ATTEMPTS, lastError?.message ?? "unknown error", now);
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export function listFailedDeliveries(deliveryType?: string) {
  return deliveryType
    ? db.prepare("SELECT * FROM failed_deliveries WHERE delivery_type = ? ORDER BY created_at DESC").all(deliveryType)
    : db.prepare("SELECT * FROM failed_deliveries ORDER BY created_at DESC").all();
}

export interface IntegrationInput {
  type: IntegrationType;
  org_id?: string;
  base_url?: string;
  webhook_url?: string;
  token?: string;
  scopes?: string;
  notify_on_run?: boolean;
}

function serializeIntegration(row: any) {
  const token = row.token_encrypted
    ? decryptSecret({ encrypted: row.token_encrypted, iv: row.token_iv, tag: row.token_tag })
    : null;
  return {
    id: row.id,
    type: row.type,
    org_id: row.org_id,
    base_url: row.base_url,
    webhook_url: row.webhook_url,
    scopes: row.scopes,
    notify_on_run: Boolean(row.notify_on_run),
    token_masked: maskSecret(token),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// FR-8.4: secure storage of third-party API tokens (encrypted at rest, never returned raw)
export function createIntegration(input: IntegrationInput) {
  const id = nanoid(10);
  const now = new Date().toISOString();
  const secret = input.token ? encryptSecret(input.token) : null;

  db.prepare(`
    INSERT INTO integrations (id, type, org_id, base_url, webhook_url, token_encrypted, token_iv, token_tag, scopes, notify_on_run, created_at, updated_at)
    VALUES (@id, @type, @org_id, @base_url, @webhook_url, @token_encrypted, @token_iv, @token_tag, @scopes, @notify_on_run, @created_at, @updated_at)
  `).run({
    id,
    type: input.type,
    org_id: input.org_id ?? null,
    base_url: input.base_url ?? null,
    webhook_url: input.webhook_url ?? null,
    token_encrypted: secret?.encrypted ?? null,
    token_iv: secret?.iv ?? null,
    token_tag: secret?.tag ?? null,
    scopes: input.scopes ?? null,
    notify_on_run: input.notify_on_run ? 1 : 0,
    created_at: now,
    updated_at: now,
  });

  return getIntegration(id);
}

export function listIntegrations(type?: IntegrationType) {
  const rows = type
    ? db.prepare("SELECT * FROM integrations WHERE type = ? ORDER BY created_at DESC").all(type)
    : db.prepare("SELECT * FROM integrations ORDER BY created_at DESC").all();
  return (rows as any[]).map(serializeIntegration);
}

export function getIntegration(id: string) {
  const row = db.prepare("SELECT * FROM integrations WHERE id = ?").get(id) as any;
  if (!row) return null;
  return serializeIntegration(row);
}

function getRawIntegration(id: string) {
  const row = db.prepare("SELECT * FROM integrations WHERE id = ?").get(id) as any;
  if (!row) throw new Error("Integration not found");
  const token = row.token_encrypted
    ? decryptSecret({ encrypted: row.token_encrypted, iv: row.token_iv, tag: row.token_tag })
    : null;
  return { ...row, token };
}

// FR-8.4: token rotation -- replace the stored credential without disrupting the rest of the config
export function rotateIntegrationToken(id: string, newToken: string) {
  const secret = encryptSecret(newToken);
  const now = new Date().toISOString();
  db.prepare("UPDATE integrations SET token_encrypted = ?, token_iv = ?, token_tag = ?, updated_at = ? WHERE id = ?").run(
    secret.encrypted,
    secret.iv,
    secret.tag,
    now,
    id
  );
  return getIntegration(id);
}

export function deleteIntegration(id: string) {
  db.prepare("DELETE FROM integrations WHERE id = ?").run(id);
}

// FR-7.1/FR-7.2: bi-directional sync -- push a test case to Jira/Azure DevOps as a linked work item
export async function pushTestCaseToExternalTracker(integrationId: string, testCase: { id: string; title: string; expected_result: string; steps: string[]; category: string }) {
  const integration = getRawIntegration(integrationId);
  if (integration.type !== "jira" && integration.type !== "azure") {
    throw new Error(`Integration ${integrationId} is not a Jira/Azure integration`);
  }
  if (!integration.base_url || !integration.token) {
    throw new Error("Integration is missing a base URL or token");
  }

  const description = `${testCase.steps.map((s: string, i: number) => `${i + 1}. ${s}`).join("\n")}\n\nExpected: ${testCase.expected_result}`;

  if (integration.type === "jira") {
    const endpoint = `${integration.base_url.replace(/\/$/, "")}/rest/api/2/issue`;
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${integration.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        fields: {
          project: { key: integration.org_id || "TEST" },
          summary: `[${testCase.category}] ${testCase.title}`,
          description,
          issuetype: { name: "Test" },
        },
      }),
    });
    const payload = (await res.json().catch(() => ({}))) as Record<string, any>;
    if (!res.ok) throw new Error(`Jira push failed: ${res.status} ${JSON.stringify(payload)}`);
    return recordSyncPush(integrationId, testCase.id, "jira", payload.key || payload.id, payload);
  }

  const endpoint = `${integration.base_url.replace(/\/$/, "")}/_apis/wit/workitems/$Test%20Case?api-version=7.1`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { Authorization: `Basic ${Buffer.from(`:${integration.token}`).toString("base64")}`, "Content-Type": "application/json-patch+json" },
    body: JSON.stringify([
      { op: "add", path: "/fields/System.Title", value: `[${testCase.category}] ${testCase.title}` },
      { op: "add", path: "/fields/System.Description", value: description },
    ]),
  });
  const payload = (await res.json().catch(() => ({}))) as Record<string, any>;
  if (!res.ok) throw new Error(`Azure DevOps push failed: ${res.status} ${JSON.stringify(payload)}`);
  return recordSyncPush(integrationId, testCase.id, "azure", payload.id?.toString(), payload);
}

// FR-7.1/FR-7.2: push an execution result back to the linked work item (comment/status update)
export async function pushRunResultToExternalTracker(
  integrationId: string,
  externalId: string,
  run: { id: string; status: string; duration_ms: number | null }
) {
  const integration = getRawIntegration(integrationId);
  if (!integration.base_url || !integration.token) {
    throw new Error("Integration is missing a base URL or token");
  }

  const comment = `Automated run ${run.id}: ${run.status.toUpperCase()} (${run.duration_ms ?? 0}ms)`;

  if (integration.type === "jira") {
    const endpoint = `${integration.base_url.replace(/\/$/, "")}/rest/api/2/issue/${encodeURIComponent(externalId)}/comment`;
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${integration.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ body: comment }),
    });
    if (!res.ok) throw new Error(`Jira result push failed: ${res.status}`);
    return { ok: true, provider: "jira", externalId, comment };
  }

  if (integration.type === "azure") {
    const endpoint = `${integration.base_url.replace(/\/$/, "")}/_apis/wit/workitems/${encodeURIComponent(externalId)}?api-version=7.1`;
    const res = await fetch(endpoint, {
      method: "PATCH",
      headers: { Authorization: `Basic ${Buffer.from(`:${integration.token}`).toString("base64")}`, "Content-Type": "application/json-patch+json" },
      body: JSON.stringify([{ op: "add", path: "/fields/System.History", value: comment }]),
    });
    if (!res.ok) throw new Error(`Azure DevOps result push failed: ${res.status}`);
    return { ok: true, provider: "azure", externalId, comment };
  }

  throw new Error(`Integration ${integrationId} is not a Jira/Azure integration`);
}

// FR-7.5: optionally sync test cases/results with TestRail, Zephyr, or qTest,
// beyond the core Jira/Azure DevOps integrations -- each has its own REST shape,
// implemented the same way as the Jira/Azure push above (real HTTP call, real
// auth header for that provider, error surfaced on non-2xx).
export async function pushTestCaseToAdditionalTracker(integrationId: string, testCase: { id: string; title: string; expected_result: string; steps: string[]; category: string }) {
  const integration = getRawIntegration(integrationId);
  if (!["testrail", "zephyr", "qtest"].includes(integration.type)) {
    throw new Error(`Integration ${integrationId} is not a TestRail/Zephyr/qTest integration`);
  }
  if (!integration.base_url || !integration.token) {
    throw new Error("Integration is missing a base URL or token");
  }

  const description = `${testCase.steps.map((s: string, i: number) => `${i + 1}. ${s}`).join("\n")}\n\nExpected: ${testCase.expected_result}`;

  if (integration.type === "testrail") {
    const endpoint = `${integration.base_url.replace(/\/$/, "")}/index.php?/api/v2/add_case/${integration.org_id || "1"}`;
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Basic ${Buffer.from(`:${integration.token}`).toString("base64")}`, "Content-Type": "application/json" },
      body: JSON.stringify({ title: `[${testCase.category}] ${testCase.title}`, custom_steps: description }),
    });
    const payload = (await res.json().catch(() => ({}))) as Record<string, any>;
    if (!res.ok) throw new Error(`TestRail push failed: ${res.status} ${JSON.stringify(payload)}`);
    return recordSyncPush(integrationId, testCase.id, "testrail", payload.id?.toString(), payload);
  }

  if (integration.type === "zephyr") {
    const endpoint = `${integration.base_url.replace(/\/$/, "")}/v2/testcases`;
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${integration.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: `[${testCase.category}] ${testCase.title}`, objective: description, projectKey: integration.org_id || "TEST" }),
    });
    const payload = (await res.json().catch(() => ({}))) as Record<string, any>;
    if (!res.ok) throw new Error(`Zephyr push failed: ${res.status} ${JSON.stringify(payload)}`);
    return recordSyncPush(integrationId, testCase.id, "zephyr", payload.key || payload.id, payload);
  }

  // qtest
  const endpoint = `${integration.base_url.replace(/\/$/, "")}/api/v3/projects/${integration.org_id || "1"}/test-cases`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${integration.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: `[${testCase.category}] ${testCase.title}`, description }),
  });
  const payload = (await res.json().catch(() => ({}))) as Record<string, any>;
  if (!res.ok) throw new Error(`qTest push failed: ${res.status} ${JSON.stringify(payload)}`);
  return recordSyncPush(integrationId, testCase.id, "qtest", payload.id?.toString(), payload);
}

// FR-7.6: automatically file a defect/bug ticket in the connected Jira/Azure
// DevOps project, with failure evidence attached, when a previously-passing
// test fails. Best-effort -- never throws, called fire-and-forget right after
// a run completes (mirrors the notifyAllOnRunComplete pattern for FR-7.3).
// SR-FR-7.2: retried with backoff before being logged as a failed delivery.
export async function autoFileBugOnRegression(testCase: { id: string; title: string; category: string }, run: { id: string; status: string; evidence_path?: string | null }, previousStatus: string | null) {
  if (run.status !== "failed" && run.status !== "error") return { filed: false, reason: "run did not fail" };
  if (previousStatus !== "passed") return { filed: false, reason: "test was not previously passing" };

  const trackers = listIntegrations().filter((i: any) => i.type === "jira" || i.type === "azure");
  if (trackers.length === 0) return { filed: false, reason: "no Jira/Azure integration configured" };

  const target = trackers[0] as any;
  const integration = getRawIntegration(target.id);
  const description = `Automated test "${testCase.title}" (${testCase.category}) was previously passing and is now failing as of run ${run.id}.${run.evidence_path ? `\n\nEvidence: ${run.evidence_path}` : ""}`;

  try {
    return await withRetry(
      "auto_file_bug",
      target.id,
      { integrationId: target.id, provider: integration.type, testCaseId: testCase.id, runId: run.id },
      async () => {
        if (integration.type === "jira") {
          const endpoint = `${integration.base_url!.replace(/\/$/, "")}/rest/api/2/issue`;
          const res = await fetch(endpoint, {
            method: "POST",
            headers: { Authorization: `Bearer ${integration.token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ fields: { project: { key: integration.org_id || "TEST" }, summary: `[Auto-filed] Regression: ${testCase.title}`, description, issuetype: { name: "Bug" } } }),
          });
          const payload = (await res.json().catch(() => ({}))) as Record<string, any>;
          if (!res.ok) throw new Error(`Jira bug filing failed: ${res.status}`);
          return { filed: true, provider: "jira", externalId: payload.key || payload.id };
        }

        const endpoint = `${integration.base_url!.replace(/\/$/, "")}/_apis/wit/workitems/$Bug?api-version=7.1`;
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { Authorization: `Basic ${Buffer.from(`:${integration.token}`).toString("base64")}`, "Content-Type": "application/json-patch+json" },
          body: JSON.stringify([
            { op: "add", path: "/fields/System.Title", value: `[Auto-filed] Regression: ${testCase.title}` },
            { op: "add", path: "/fields/System.Description", value: description },
          ]),
        });
        const payload = (await res.json().catch(() => ({}))) as Record<string, any>;
        if (!res.ok) throw new Error(`Azure DevOps bug filing failed: ${res.status}`);
        return { filed: true, provider: "azure", externalId: payload.id?.toString() };
      }
    );
  } catch (err: any) {
    return { filed: false, reason: err.message };
  }
}

// Bug Detection Engine: same Jira/Azure filing mechanics as autoFileBugOnRegression
// above, generalized to any proactively-discovered finding (exploratory UI scan,
// API fuzz) rather than only a test-case regression. Best-effort/never throws --
// the caller (bugDetectionService) fires this fire-and-forget right after
// recording a finding, same pattern as notifyAllOnRunComplete.
export async function fileGenericBug(finding: {
  id: string;
  title: string;
  detail: string;
  severity: string;
  steps_to_reproduce?: string | null;
  screenshot_url?: string | null;
  video_url?: string | null;
}) {
  const trackers = listIntegrations().filter((i: any) => i.type === "jira" || i.type === "azure");
  if (trackers.length === 0) return { filed: false, reason: "no Jira/Azure integration configured" };

  const target = trackers[0] as any;
  const integration = getRawIntegration(target.id);

  const publicBaseUrl = process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 4100}`;
  let steps: string[] = [];
  try {
    steps = finding.steps_to_reproduce ? JSON.parse(finding.steps_to_reproduce) : [];
  } catch {
    steps = [];
  }
  const stepsBlock = steps.length ? `\n\nSteps to reproduce:\n${steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}` : "";
  const evidenceLines = [
    finding.screenshot_url ? `Screenshot: ${publicBaseUrl}${finding.screenshot_url}` : null,
    finding.video_url ? `Screen recording: ${publicBaseUrl}${finding.video_url}` : null,
  ].filter(Boolean);
  const evidenceBlock = evidenceLines.length ? `\n\n${evidenceLines.join("\n")}` : "";
  const description = `${finding.detail}${stepsBlock}${evidenceBlock}\n\nSeverity: ${finding.severity}\nFinding ID: ${finding.id}`;

  try {
    return await withRetry(
      "auto_file_bug",
      target.id,
      { integrationId: target.id, provider: integration.type, findingId: finding.id },
      async () => {
        if (integration.type === "jira") {
          const endpoint = `${integration.base_url!.replace(/\/$/, "")}/rest/api/2/issue`;
          const res = await fetch(endpoint, {
            method: "POST",
            headers: { Authorization: `Bearer ${integration.token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ fields: { project: { key: integration.org_id || "TEST" }, summary: `[Auto-filed] ${finding.title}`, description, issuetype: { name: "Bug" } } }),
          });
          const payload = (await res.json().catch(() => ({}))) as Record<string, any>;
          if (!res.ok) throw new Error(`Jira bug filing failed: ${res.status}`);
          return { filed: true, provider: "jira", externalId: payload.key || payload.id };
        }

        const endpoint = `${integration.base_url!.replace(/\/$/, "")}/_apis/wit/workitems/$Bug?api-version=7.1`;
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { Authorization: `Basic ${Buffer.from(`:${integration.token}`).toString("base64")}`, "Content-Type": "application/json-patch+json" },
          body: JSON.stringify([
            { op: "add", path: "/fields/System.Title", value: `[Auto-filed] ${finding.title}` },
            { op: "add", path: "/fields/System.Description", value: description },
          ]),
        });
        const payload = (await res.json().catch(() => ({}))) as Record<string, any>;
        if (!res.ok) throw new Error(`Azure DevOps bug filing failed: ${res.status}`);
        return { filed: true, provider: "azure", externalId: payload.id?.toString() };
      }
    );
  } catch (err: any) {
    return { filed: false, reason: err.message };
  }
}

function recordSyncPush(integrationId: string, testCaseId: string, provider: string, externalId: string | undefined, payload: any) {
  const id = nanoid(10);
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO sync_records (id, test_case_id, provider, external_id, status, payload, created_at)
    VALUES (@id, @test_case_id, @provider, @external_id, 'pushed', @payload, @created_at)
  `).run({ id, test_case_id: testCaseId, provider, external_id: externalId ?? null, payload: JSON.stringify({ integrationId, ...payload }), created_at: now });
  return { id, externalId, provider };
}

// FR-7.3: send run notifications to Slack/Teams. SR-FR-7.2: retried with
// backoff (see withRetry) -- a transient webhook failure no longer silently
// drops the notification on the first attempt.
export async function sendRunNotification(integrationId: string, message: string) {
  const integration = getRawIntegration(integrationId);
  if (integration.type !== "slack" && integration.type !== "teams") {
    throw new Error(`Integration ${integrationId} is not a Slack/Teams integration`);
  }
  if (!integration.webhook_url) throw new Error("Integration is missing a webhook URL");

  return withRetry("slack_teams_notification", integrationId, { integrationId, type: integration.type, message }, async () => {
    const body = integration.type === "slack" ? { text: message } : { text: message, type: "MessageCard" };
    const res = await fetch(integration.webhook_url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${integration.type} notification failed: ${res.status}`);
    return { ok: true, type: integration.type };
  });
}

// Best-effort fan-out used by executionService right after a run completes (FR-7.3). Never
// throws -- a broken webhook must not break test execution.
export async function notifyAllOnRunComplete(message: string) {
  const targets = listIntegrations().filter((i) => (i.type === "slack" || i.type === "teams") && i.notify_on_run);
  const results = await Promise.allSettled(targets.map((t) => sendRunNotification(t.id, message)));
  return results.map((r, i) => ({ integrationId: targets[i].id, ok: r.status === "fulfilled" }));
}

// FR-7.4: store generated automation scripts in a connected Git repository, versioned
// alongside the app code. Local dev equivalent: a dedicated git repo under generated/,
// auto-initialized on first use, committed to after every codegen run.
function git(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd: GENERATED_DIR, env: process.env },
      (error, stdout, stderr) => (error ? reject(new Error(stderr || error.message)) : resolve({ stdout, stderr }))
    );
  });
}

async function ensureGitRepo() {
  if (!fs.existsSync(path.join(GENERATED_DIR, ".git"))) {
    await git(["init"]);
    await git(["config", "user.email", "ai-test-platform@local"]);
    await git(["config", "user.name", "AI Test Automation Platform"]);
  }
}

export async function commitGeneratedScriptToGit(fileName: string, testCaseId: string, testCaseTitle: string) {
  await ensureGitRepo();
  await git(["add", fileName]);
  try {
    await git(["commit", "-m", `codegen: ${testCaseTitle} (test case ${testCaseId})`, "--", fileName]);
  } catch (err: any) {
    // "nothing to commit" is not an error worth surfacing (e.g. regenerating identical code)
    if (!/nothing to commit|nothing added/i.test(err.message)) throw err;
    return { committed: false, reason: "no changes" };
  }
  const { stdout } = await git(["log", "-1", "--format=%H"]);
  return { committed: true, commitHash: stdout.trim() };
}

export async function listGitHistoryForScript(fileName: string) {
  await ensureGitRepo();
  try {
    const { stdout } = await git(["log", "--follow", "--format=%H|%ad|%s", "--date=iso", "--", fileName]);
    return stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [hash, date, ...messageParts] = line.split("|");
        return { hash, date, message: messageParts.join("|") };
      });
  } catch {
    return [];
  }
}
