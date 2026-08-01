// Shared encryption-at-rest helper for third-party credentials (FR-8.4), used by the
// Integrations Hub (Module 7) when saving Jira/Azure tokens and webhook secrets.
// AES-256-GCM: authenticated encryption so a tampered ciphertext fails to decrypt rather
// than silently producing garbage.

import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEV_KEY_PATH = path.join(__dirname, "..", "..", ".dev-encryption-key");

function loadOrCreateDevKey(): Buffer {
  if (fs.existsSync(DEV_KEY_PATH)) {
    return Buffer.from(fs.readFileSync(DEV_KEY_PATH, "utf-8").trim(), "hex");
  }
  const key = crypto.randomBytes(32);
  fs.writeFileSync(DEV_KEY_PATH, key.toString("hex"), "utf-8");
  console.warn(
    "[secretsService] INTEGRATION_ENCRYPTION_KEY not set -- generated a dev-only key at " +
      DEV_KEY_PATH +
      ". Set INTEGRATION_ENCRYPTION_KEY (32-byte hex) in production; do not rely on this file outside local dev."
  );
  return key;
}

function getKey(): Buffer {
  const envKey = process.env.INTEGRATION_ENCRYPTION_KEY;
  if (envKey) {
    const buf = Buffer.from(envKey, "hex");
    if (buf.length !== 32) throw new Error("INTEGRATION_ENCRYPTION_KEY must be a 32-byte (64 hex char) key");
    return buf;
  }
  return loadOrCreateDevKey();
}

export interface EncryptedSecret {
  encrypted: string;
  iv: string;
  tag: string;
}

export function encryptSecret(plaintext: string): EncryptedSecret {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { encrypted: encrypted.toString("hex"), iv: iv.toString("hex"), tag: tag.toString("hex") };
}

export function decryptSecret(payload: EncryptedSecret): string {
  const key = getKey();
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(payload.iv, "hex"));
  decipher.setAuthTag(Buffer.from(payload.tag, "hex"));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(payload.encrypted, "hex")), decipher.final()]);
  return decrypted.toString("utf-8");
}

export function maskSecret(plaintext: string | null | undefined): string {
  if (!plaintext) return "";
  if (plaintext.length <= 4) return "****";
  return `${"*".repeat(plaintext.length - 4)}${plaintext.slice(-4)}`;
}
