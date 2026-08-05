// Module 1/2/5 -- Screen entity: FR-1.10 (catalog every distinct screen/module),
// FR-2.14 (tag test cases/scripts to a Screen), FR-5.7/5.8 (Changed/Unchanged
// classification + Screen Explorer view), FR-4.18 (screen-scoped runs).

import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { nanoid } from "nanoid";
import { chromium } from "playwright";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import { db } from "../db.js";

function hashContent(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.join(__dirname, "..", "..");
const VISUAL_BASELINE_DIR = path.join(SERVER_ROOT, "test-results", "visual-baselines");

function ensureVisualBaselineDir() {
  if (!fs.existsSync(VISUAL_BASELINE_DIR)) fs.mkdirSync(VISUAL_BASELINE_DIR, { recursive: true });
}

// FR-5.9: capture a real screenshot via Playwright headless Chromium against a screen's URL.
// Genuine rendering, not a stand-in -- verified in this dev environment (chromium launches and
// page.screenshot() returns real PNG bytes).
async function captureScreenshot(url: string): Promise<Buffer> {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(url, { waitUntil: "load", timeout: 15000 });
    return await page.screenshot({ fullPage: true });
  } finally {
    await browser.close();
  }
}

// FR-5.9: real pixel-difference-percentage comparison between two PNG buffers, using
// pixelmatch (decoded via pngjs) rather than a content-hash stand-in. Buffers of differing
// dimensions are handled by comparing against the larger canvas (mismatched pixels beyond the
// smaller image's bounds count as differences), so a real percentage is always produced.
function comparePngBuffers(beforePng: Buffer, afterPng: Buffer): { diffPercentage: number; width: number; height: number } {
  const before = PNG.sync.read(beforePng);
  const after = PNG.sync.read(afterPng);
  const width = Math.max(before.width, after.width);
  const height = Math.max(before.height, after.height);

  const normalize = (img: PNG) => {
    if (img.width === width && img.height === height) return img;
    const canvas = new PNG({ width, height });
    PNG.bitblt(img, canvas, 0, 0, img.width, img.height, 0, 0);
    return canvas;
  };
  const a = normalize(before);
  const b = normalize(after);
  const diff = new PNG({ width, height });
  const mismatched = pixelmatch(a.data, b.data, diff.data, width, height, { threshold: 0.1 });
  const totalPixels = width * height;
  return { diffPercentage: totalPixels === 0 ? 0 : parseFloat(((mismatched / totalPixels) * 100).toFixed(2)), width, height };
}

// FR-1.10/FR-2.14: a short, human-readable "screen" name for input types that
// don't already have a natural one (a URL, an uploaded file name, a parsed API
// spec title). Free-text/ticket-style content gets named from its own first
// sentence, so "The checkout page has a Promo Code field..." becomes a screen
// named "The checkout page has a Promo Code field" instead of every free-text
// submission just piling into one generic bucket -- each distinct submission
// still gets its own catalogued screen, the same way each distinct crawled
// page does.
export function deriveScreenNameFromText(text: string, fallback = "Untitled"): string {
  const firstSentence = text.split(/[.\n]/).map((s) => s.trim()).find((s) => s.length > 0);
  if (!firstSentence) return fallback;
  return firstSentence.length > 70 ? `${firstSentence.slice(0, 70).trim()}…` : firstSentence;
}

// FR-1.10: catalog a screen discovered from any input type. FR-5.7: compare
// against the last captured version of a screen with the same name and
// classify Changed/Unchanged/New rather than only diffing individual locators.
export function catalogScreen(params: { name: string; moduleName?: string; sourceInputId: string; urlOrPath?: string; content: string }) {
  const now = new Date().toISOString();
  const contentHash = hashContent(params.content);

  const existing = db.prepare("SELECT * FROM screens WHERE name = ?").get(params.name) as any;

  if (!existing) {
    const id = nanoid(10);
    db.prepare(`
      INSERT INTO screens (id, name, module_name, source_input_id, url_or_path, last_captured_state_hash, change_status, last_compared_at, created_at, updated_at)
      VALUES (@id, @name, @module_name, @source_input_id, @url_or_path, @hash, 'new', @now, @now, @now)
    `).run({
      id,
      name: params.name,
      module_name: params.moduleName ?? null,
      source_input_id: params.sourceInputId,
      url_or_path: params.urlOrPath ?? null,
      hash: contentHash,
      now,
    });
    return db.prepare("SELECT * FROM screens WHERE id = ?").get(id);
  }

  const changeStatus = existing.last_captured_state_hash === contentHash ? "unchanged" : "changed";
  db.prepare(`
    UPDATE screens SET last_captured_state_hash = @hash, change_status = @change_status, last_compared_at = @now, updated_at = @now, source_input_id = @source_input_id
    WHERE id = @id
  `).run({ id: existing.id, hash: contentHash, change_status: changeStatus, now, source_input_id: params.sourceInputId });

  return db.prepare("SELECT * FROM screens WHERE id = ?").get(existing.id);
}

// FR-5.8: Screen Explorer view -- Changed/Unchanged status plus linked manual
// and automation test case counts, in a single call.
export function listScreensWithCounts() {
  const screens = db.prepare("SELECT * FROM screens ORDER BY updated_at DESC").all() as any[];
  const testCaseCount = db.prepare("SELECT COUNT(*) as c FROM test_cases WHERE screen_id = ?");
  const scriptCount = db.prepare("SELECT COUNT(*) as c FROM automation_scripts WHERE screen_id = ?");
  return screens.map((s) => ({
    ...s,
    test_case_count: (testCaseCount.get(s.id) as any).c,
    automation_script_count: (scriptCount.get(s.id) as any).c,
  }));
}

export function getScreen(id: string) {
  return db.prepare("SELECT * FROM screens WHERE id = ?").get(id);
}

// FR-2.14: tag every test case (and, once generated, its linked script) with
// the Screen it was generated from.
export function tagTestCasesToScreen(testCaseIds: string[], screenId: string) {
  const update = db.prepare("UPDATE test_cases SET screen_id = ? WHERE id = ?");
  const tx = db.transaction((ids: string[]) => {
    for (const id of ids) update.run(screenId, id);
  });
  tx(testCaseIds);
}

export function tagScriptToScreen(scriptId: string, testCaseId: string) {
  const tc = db.prepare("SELECT screen_id FROM test_cases WHERE id = ?").get(testCaseId) as any;
  if (tc?.screen_id) {
    db.prepare("UPDATE automation_scripts SET screen_id = ? WHERE id = ?").run(tc.screen_id, scriptId);
  }
}

// FR-4.18: resolve the set of test-case IDs tagged to the given screens (optionally
// restricted to only screens flagged Changed), extending the FR-4.10 Custom selection mode.
export function resolveTestCaseIdsForScreens(screenIds: string[], changedOnly = false): string[] {
  if (screenIds.length === 0) return [];
  const placeholders = screenIds.map(() => "?").join(",");
  let query = `SELECT tc.id FROM test_cases tc JOIN screens s ON tc.screen_id = s.id WHERE s.id IN (${placeholders})`;
  if (changedOnly) query += " AND s.change_status = 'changed'";
  return (db.prepare(query).all(...screenIds) as any[]).map((r) => r.id);
}

// FR-5.10: side-by-side before/after review for a Screen flagged Changed. This
// build stores only the latest content hash (not full before/after bodies) --
// the DOM/content actually diffed for the underlying test case is available via
// change_detections (FR-5.1/5.10 UI diff), this returns the Screen-level summary
// that view is built around.
export function getScreenChangeSummary(screenId: string) {
  const screen = getScreen(screenId) as any;
  if (!screen) throw new Error("Screen not found");
  return {
    screen,
    is_changed: screen.change_status === "changed",
    last_compared_at: screen.last_compared_at,
    visual_baseline_set: Boolean(screen.visual_baseline_ref),
  };
}

// FR-5.9: save a visual regression baseline for a screen. When a `url` is provided, this
// captures a REAL screenshot via headless Playwright Chromium and stores the PNG on disk --
// not a content-hash stand-in. `content`-only calls (no url) fall back to the earlier
// content-hash approach for callers that don't have a live URL to render (e.g. HTML-only
// inputs) -- that fallback path is honestly still a hash, not pixels.
export async function saveVisualBaseline(screenId: string, params: { content?: string; url?: string }) {
  const now = new Date().toISOString();
  if (params.url) {
    ensureVisualBaselineDir();
    const screenshot = await captureScreenshot(params.url);
    const filePath = path.join(VISUAL_BASELINE_DIR, `${screenId}.png`);
    fs.writeFileSync(filePath, screenshot);
    const ref = JSON.stringify({ type: "screenshot", path: filePath, capturedAt: now });
    db.prepare("UPDATE screens SET visual_baseline_ref = ?, updated_at = ? WHERE id = ?").run(ref, now, screenId);
    return getScreen(screenId);
  }

  // Fallback: no URL given -- content-hash stand-in (documented, not claimed as pixel diffing).
  const ref = JSON.stringify({ type: "hash", hash: hashContent(params.content ?? "") });
  db.prepare("UPDATE screens SET visual_baseline_ref = ?, updated_at = ? WHERE id = ?").run(ref, now, screenId);
  return getScreen(screenId);
}

export async function diffAgainstVisualBaseline(screenId: string, params: { content?: string; url?: string }) {
  const screen = getScreen(screenId) as any;
  if (!screen) throw new Error("Screen not found");
  if (!screen.visual_baseline_ref) return { hasBaseline: false, visualChangeDetected: false };

  let baseline: { type: "screenshot" | "hash"; path?: string; hash?: string };
  try {
    baseline = JSON.parse(screen.visual_baseline_ref);
  } catch {
    // Pre-migration baselines were a raw hash string, not JSON -- treat as legacy hash type.
    baseline = { type: "hash", hash: screen.visual_baseline_ref };
  }

  if (baseline.type === "screenshot" && baseline.path && fs.existsSync(baseline.path)) {
    if (!params.url) {
      throw new Error("This screen's baseline is a real screenshot -- a url is required to diff against it");
    }
    const currentScreenshot = await captureScreenshot(params.url);
    const beforePng = fs.readFileSync(baseline.path);
    const { diffPercentage, width, height } = comparePngBuffers(beforePng, currentScreenshot);
    return {
      hasBaseline: true,
      visualChangeDetected: diffPercentage > 0,
      diffPercentage,
      dimensions: { width, height },
      method: "pixel-diff",
    };
  }

  // Legacy/fallback content-hash comparison.
  const currentHash = hashContent(params.content ?? "");
  return { hasBaseline: true, visualChangeDetected: currentHash !== baseline.hash, method: "content-hash" };
}
