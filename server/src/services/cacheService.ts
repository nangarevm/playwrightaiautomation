import crypto from "crypto";
import { db } from "../db.js";

export interface CacheEntry {
  key: string;
  value: string;
  ttl: number;
  createdAt: number;
  expiresAt: number;
  hits: number;
}

export interface PageFingerprint {
  hash: string;
  contentLength: number;
  elementCount: number;
  interactiveCount: number;
}

export interface CacheStats {
  totalEntries: number;
  hitRate: number;
  missRate: number;
  estimatedSavings: number;
  hitsByType: Record<string, number>;
}

let cacheStore = new Map<string, CacheEntry>();
let cacheStats = {
  hits: 0,
  misses: 0,
  byType: new Map<string, number>(),
};

function ensureCacheTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cache_entries (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      key TEXT NOT NULL UNIQUE,
      value TEXT NOT NULL,
      ttl INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      hits INTEGER DEFAULT 0,
      UNIQUE(type, key)
    );
    CREATE INDEX IF NOT EXISTS idx_cache_expires ON cache_entries(expires_at);
    CREATE INDEX IF NOT EXISTS idx_cache_type ON cache_entries(type);
  `);
}

export function computePageFingerprint(pageContent: string): PageFingerprint {
  const hash = crypto.createHash("sha256").update(pageContent).digest("hex");
  
  const elementCount = (pageContent.match(/<[^>]+>/g) || []).length;
  const interactiveCount = (pageContent.match(/<(button|input|select|textarea|a|form)/gi) || []).length;

  return {
    hash,
    contentLength: pageContent.length,
    elementCount,
    interactiveCount,
  };
}

export function cacheTestCase(
  fingerprint: string,
  testCases: any[],
  ttl: number = 86400
): boolean {
  try {
    ensureCacheTable();
    const key = `test_${fingerprint}`;
    const expiresAt = Date.now() + ttl * 1000;

    const entry: CacheEntry = {
      key,
      value: JSON.stringify(testCases),
      ttl,
      createdAt: Date.now(),
      expiresAt,
      hits: 0,
    };

    cacheStore.set(key, entry);

    db.prepare(`
      INSERT OR REPLACE INTO cache_entries 
      (id, type, key, value, ttl, created_at, expires_at, hits)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0)
    `).run(key, "test", key, entry.value, ttl, entry.createdAt, expiresAt);

    return true;
  } catch (error) {
    console.error("[cacheService] Error caching test case:", error);
    return false;
  }
}

export function getTestCaseFromCache(fingerprint: string): any[] | null {
  try {
    const key = `test_${fingerprint}`;
    const now = Date.now();

    let entry = cacheStore.get(key);

    if (!entry) {
      entry = db.prepare(`
        SELECT * FROM cache_entries 
        WHERE key = ? AND expires_at > ? AND type = 'test'
      `).get(key, now) as any;
    }

    if (!entry || entry.expiresAt < now) {
      cacheStore.delete(key);
      cacheStats.misses++;
      return null;
    }

    entry.hits++;
    cacheStats.hits++;
    cacheStats.byType.set("test", (cacheStats.byType.get("test") || 0) + 1);

    db.prepare("UPDATE cache_entries SET hits = hits + 1 WHERE key = ?").run(key);

    return JSON.parse(entry.value);
  } catch (error) {
    console.error("[cacheService] Error retrieving test cache:", error);
    return null;
  }
}

export function cachePromptResponse(
  prompt: string,
  response: string,
  ttl: number = 604800
): boolean {
  try {
    ensureCacheTable();
    const promptHash = crypto.createHash("sha256").update(prompt).digest("hex");
    const key = `prompt_${promptHash}`;
    const expiresAt = Date.now() + ttl * 1000;

    const entry: CacheEntry = {
      key,
      value: response,
      ttl,
      createdAt: Date.now(),
      expiresAt,
      hits: 0,
    };

    cacheStore.set(key, entry);

    db.prepare(`
      INSERT OR REPLACE INTO cache_entries 
      (id, type, key, value, ttl, created_at, expires_at, hits)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0)
    `).run(key, "prompt", key, response, ttl, entry.createdAt, expiresAt);

    return true;
  } catch (error) {
    console.error("[cacheService] Error caching prompt response:", error);
    return false;
  }
}

export function getPromptResponse(prompt: string): string | null {
  try {
    const promptHash = crypto.createHash("sha256").update(prompt).digest("hex");
    const key = `prompt_${promptHash}`;
    const now = Date.now();

    let entry = cacheStore.get(key);

    if (!entry) {
      entry = db.prepare(`
        SELECT * FROM cache_entries 
        WHERE key = ? AND expires_at > ? AND type = 'prompt'
      `).get(key, now) as any;
    }

    if (!entry || entry.expiresAt < now) {
      cacheStore.delete(key);
      cacheStats.misses++;
      return null;
    }

    entry.hits++;
    cacheStats.hits++;
    cacheStats.byType.set("prompt", (cacheStats.byType.get("prompt") || 0) + 1);

    db.prepare("UPDATE cache_entries SET hits = hits + 1 WHERE key = ?").run(key);

    return entry.value;
  } catch (error) {
    console.error("[cacheService] Error retrieving prompt cache:", error);
    return null;
  }
}

export function invalidatePageCache(fingerprint: string): boolean {
  try {
    const key = `test_${fingerprint}`;
    cacheStore.delete(key);
    db.prepare("DELETE FROM cache_entries WHERE key = ? AND type = 'test'").run(key);
    return true;
  } catch (error) {
    console.error("[cacheService] Error invalidating cache:", error);
    return false;
  }
}

export function invalidateAllCache(): boolean {
  try {
    cacheStore.clear();
    db.prepare("DELETE FROM cache_entries").run();
    cacheStats = { hits: 0, misses: 0, byType: new Map() };
    return true;
  } catch (error) {
    console.error("[cacheService] Error clearing all cache:", error);
    return false;
  }
}

export function cleanupExpiredCache(): number {
  try {
    const now = Date.now();
    
    for (const [key, entry] of cacheStore.entries()) {
      if (entry.expiresAt < now) {
        cacheStore.delete(key);
      }
    }

    const result = db.prepare("DELETE FROM cache_entries WHERE expires_at < ?").run(now) as any;
    return result.changes;
  } catch (error) {
    console.error("[cacheService] Error cleaning up expired cache:", error);
    return 0;
  }
}

export function getCacheStats(): CacheStats {
  cleanupExpiredCache();
  
  const total = cacheStats.hits + cacheStats.misses;
  const hitRate = total > 0 ? cacheStats.hits / total : 0;

  return {
    totalEntries: cacheStore.size,
    hitRate,
    missRate: 1 - hitRate,
    estimatedSavings: cacheStats.hits * 0.1,
    hitsByType: Object.fromEntries(cacheStats.byType),
  };
}

export function setCacheFeatureFlag(enabled: boolean): void {
  process.env.CACHE_SERVICE_ENABLED = String(enabled);
}

export function isCacheEnabled(): boolean {
  return process.env.CACHE_SERVICE_ENABLED !== "false";
}
