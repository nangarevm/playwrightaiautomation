import { execFile } from "child_process";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { nanoid } from "nanoid";
import { db } from "../db.js";
import { decryptSecret, encryptSecret, maskSecret } from "./secretsService.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GENERATED_DIR = path.join(__dirname, "..", "..", "generated");

export type IntegrationType = "jira" | "azure" | "git" | "slack" | "teams";

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

function recordSyncPush(integrationId: string, testCaseId: string, provider: string, externalId: string | undefined, payload: any) {
  const id = nanoid(10);
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO sync_records (id, test_case_id, provider, external_id, status, payload, created_at)
    VALUES (@id, @test_case_id, @provider, @external_id, 'pushed', @payload, @created_at)
  `).run({ id, test_case_id: testCaseId, provider, external_id: externalId ?? null, payload: JSON.stringify({ integrationId, ...payload }), created_at: now });
  return { id, externalId, provider };
}

// FR-7.3: send run notifications to Slack/Teams
export async function sendRunNotification(integrationId: string, message: string) {
  const integration = getRawIntegration(integrationId);
  if (integration.type !== "slack" && integration.type !== "teams") {
    throw new Error(`Integration ${integrationId} is not a Slack/Teams integration`);
  }
  if (!integration.webhook_url) throw new Error("Integration is missing a webhook URL");

  const body = integration.type === "slack" ? { text: message } : { text: message, type: "MessageCard" };
  const res = await fetch(integration.webhook_url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${integration.type} notification failed: ${res.status}`);
  return { ok: true, type: integration.type };
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
