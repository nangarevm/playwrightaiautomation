// FR-4.21: named secrets/env-vars that generated automation scripts reference
// at runtime (API keys, test-account passwords). CRUD over platform_secrets;
// values are encrypted at rest and never returned in plaintext from any of
// these functions -- only executionService's runExecution decrypts them, and
// only into the child-process env for the run.

import { nanoid } from "nanoid";
import { db } from "../db.js";
import { encryptSecret, maskSecret, decryptSecret } from "./secretsService.js";

export function listPlatformSecrets() {
  const rows = db.prepare("SELECT id, name, value_encrypted, value_iv, value_tag, created_at, updated_at FROM platform_secrets ORDER BY name ASC").all() as any[];
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    masked_value: (() => {
      try {
        return maskSecret(decryptSecret({ encrypted: r.value_encrypted, iv: r.value_iv, tag: r.value_tag }));
      } catch {
        return "****";
      }
    })(),
    created_at: r.created_at,
    updated_at: r.updated_at,
  }));
}

export function createPlatformSecret(name: string, value: string) {
  if (!name || !value) throw new Error("name and value are required");
  const enc = encryptSecret(value);
  const id = nanoid(10);
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO platform_secrets (id, name, value_encrypted, value_iv, value_tag, created_at, updated_at)
    VALUES (@id, @name, @encrypted, @iv, @tag, @now, @now)
    ON CONFLICT(name) DO UPDATE SET value_encrypted = @encrypted, value_iv = @iv, value_tag = @tag, updated_at = @now
  `).run({ id, name, encrypted: enc.encrypted, iv: enc.iv, tag: enc.tag, now });
  return { id, name, created_at: now, updated_at: now };
}

export function deletePlatformSecret(name: string) {
  db.prepare("DELETE FROM platform_secrets WHERE name = ?").run(name);
}
