// FR-4.19: named Environments (Dev/Staging/Prod/custom), each with its own
// target URL, credentials, and default Execution Profile.
// FR-4.20: pre-flight health check before a scheduled/webhook-triggered run.
// FR-1.3c: the same encrypted-credential handling doubles as the storage
// mechanism for FR-1.3a's authenticated-crawl credentials.

import { nanoid } from "nanoid";
import { db } from "../db.js";
import { encryptSecret, decryptSecret, maskSecret } from "./secretsService.js";

function maskEnvironment(row: any) {
  if (!row) return row;
  const { credentials_encrypted, credentials_iv, credentials_tag, ...rest } = row;
  return { ...rest, has_credentials: Boolean(credentials_encrypted) };
}

export function listEnvironments() {
  const rows = db.prepare("SELECT * FROM environments ORDER BY created_at DESC").all() as any[];
  return rows.map(maskEnvironment);
}

export function getEnvironment(id: string) {
  return db.prepare("SELECT * FROM environments WHERE id = ?").get(id);
}

export function createEnvironment(input: { name: string; target_url: string; username?: string; password?: string; default_profile_id?: string }) {
  if (!input.name || !input.target_url) throw new Error("name and target_url are required");
  const id = nanoid(10);
  const now = new Date().toISOString();

  let credentials_encrypted: string | null = null;
  let credentials_iv: string | null = null;
  let credentials_tag: string | null = null;
  // FR-1.3c: credentials encrypted at rest, scoped to this environment/target app only
  if (input.username || input.password) {
    const enc = encryptSecret(JSON.stringify({ username: input.username ?? "", password: input.password ?? "" }));
    credentials_encrypted = enc.encrypted;
    credentials_iv = enc.iv;
    credentials_tag = enc.tag;
  }

  db.prepare(`
    INSERT INTO environments (id, name, target_url, credentials_encrypted, credentials_iv, credentials_tag, default_profile_id, created_at, updated_at)
    VALUES (@id, @name, @target_url, @credentials_encrypted, @credentials_iv, @credentials_tag, @default_profile_id, @now, @now)
  `).run({
    id,
    name: input.name,
    target_url: input.target_url,
    credentials_encrypted,
    credentials_iv,
    credentials_tag,
    default_profile_id: input.default_profile_id ?? null,
    now,
  });

  return maskEnvironment(getEnvironment(id));
}

// FR-1.3c: allow the user to revoke/rotate credentials at any time
export function revokeEnvironmentCredentials(id: string) {
  const env = getEnvironment(id);
  if (!env) throw new Error("Environment not found");
  db.prepare("UPDATE environments SET credentials_encrypted = NULL, credentials_iv = NULL, credentials_tag = NULL, updated_at = ? WHERE id = ?").run(
    new Date().toISOString(),
    id
  );
  return maskEnvironment(getEnvironment(id));
}

export function rotateEnvironmentCredentials(id: string, username: string, password: string) {
  const env = getEnvironment(id);
  if (!env) throw new Error("Environment not found");
  const enc = encryptSecret(JSON.stringify({ username, password }));
  db.prepare(
    "UPDATE environments SET credentials_encrypted = ?, credentials_iv = ?, credentials_tag = ?, updated_at = ? WHERE id = ?"
  ).run(enc.encrypted, enc.iv, enc.tag, new Date().toISOString(), id);
  return maskEnvironment(getEnvironment(id));
}

// Decrypts credentials for internal use only (e.g. the FR-1.3a authenticated
// crawler) -- never returned directly from an API response (see maskEnvironment).
export function getDecryptedCredentials(id: string): { username: string; password: string } | null {
  const env = getEnvironment(id) as any;
  if (!env?.credentials_encrypted) return null;
  try {
    const decrypted = decryptSecret({ encrypted: env.credentials_encrypted, iv: env.credentials_iv, tag: env.credentials_tag });
    return JSON.parse(decrypted);
  } catch {
    // FR-1.3a: revoked/rotated credentials fail cleanly rather than crawling silently
    return null;
  }
}

export function deleteEnvironment(id: string) {
  db.prepare("DELETE FROM environments WHERE id = ?").run(id);
}

// FR-4.20: pre-flight health check -- target URL reachable, auth succeeds --
// before a scheduled/webhook-triggered run starts against this Environment.
export async function preflightHealthCheck(id: string): Promise<{ reachable: boolean; auth_ok: boolean; status?: number; error?: string }> {
  const env = getEnvironment(id) as any;
  if (!env) throw new Error("Environment not found");

  let reachable = false;
  let authOk = true;
  let status: number | undefined;
  let error: string | undefined;

  try {
    const creds = getDecryptedCredentials(id);
    const headers: Record<string, string> = {};
    if (creds) headers.Authorization = `Basic ${Buffer.from(`${creds.username}:${creds.password}`).toString("base64")}`;
    const res = await fetch(env.target_url, { headers });
    status = res.status;
    reachable = res.status < 500;
    authOk = res.status !== 401 && res.status !== 403;
  } catch (err: any) {
    reachable = false;
    error = err.message;
  }

  db.prepare("UPDATE environments SET last_health_check_status = ?, last_health_check_at = ? WHERE id = ?").run(
    reachable && authOk ? "reachable" : "unreachable",
    new Date().toISOString(),
    id
  );

  return { reachable, auth_ok: authOk, status, error };
}
