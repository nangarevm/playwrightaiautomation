// Phase 6: Allure reporting fix.
//
// allure-playwright (wired in playwright.config.ts) writes raw JSON result
// files to allure-results/ -- those are NOT a viewable report by themselves.
// This module runs the real Allure commandline against that folder to produce
// the actual static allure-report/ site, then zips it (with index.html at the
// zip's root, not nested under a parent folder -- a common bug this avoids)
// so it can be offered as a download or served directly for the in-app viewer.

import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import JSZip from "jszip";
import { getNpxCommand } from "./executionService.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.join(__dirname, "..", "..");
const ALLURE_RESULTS_DIR = path.join(SERVER_ROOT, "allure-results");
const ALLURE_REPORT_DIR = path.join(SERVER_ROOT, "allure-report");

export interface AllureGenerateResult {
  ok: boolean;
  fileCount: number;
  indexExists: boolean;
  message: string;
}

function countFilesRecursive(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let count = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    count += entry.isDirectory() ? countFilesRecursive(full) : 1;
  }
  return count;
}

// The Allure commandline tool is a Java CLI (npx spin-up + JVM start + report
// build genuinely takes ~10-15s on this machine, confirmed by timing it directly)
// -- not a hang, but slow enough with no progress feedback that a second click
// while one is still in flight is a real scenario, not a hypothetical one. Since
// the underlying command runs with --clean (wipes allure-report/ before rebuilding),
// two overlapping runs would race on that same directory: one call's --clean can
// delete files a concurrent call is mid-read on. This in-memory lock serializes
// calls within this process so a second click reuses the first call's result
// instead of racing it.
let inFlightGeneration: Promise<AllureGenerateResult> | null = null;

// Ensure the Allure commandline tool is actually installed (either as this
// project's devDependency, via `npx --package=allure-commandline`, or a global
// `npm install -g allure-commandline`) -- previously a missing commandline
// tool silently produced incomplete/non-openable output with no clear signal.
//
// `sinceMs`: allure-results/ accumulates a raw JSON file per test EVERY run,
// forever (nothing ever clears it) -- so an unscoped generate always builds
// from the platform's ENTIRE history, not just the runs a caller cares about.
// The Crawler tab's panel is explicitly labeled "from this crawl's runs" but
// was actually showing that same aggregate (e.g. hundreds of stale results
// from unrelated past sessions instead of the dozen tests just run). Passing
// a `sinceMs` timestamp here restricts generation to result files whose
// recorded start time is at or after it.
export async function generateAllureReport(sinceMs?: number): Promise<AllureGenerateResult> {
  if (inFlightGeneration) return inFlightGeneration;
  inFlightGeneration = runAllureGenerate(sinceMs).finally(() => {
    inFlightGeneration = null;
  });
  return inFlightGeneration;
}

// Each allure-playwright *-result.json carries a `start` epoch-ms field for the
// test attempt it records. Container/attachment/env files have no such field
// (and no natural "which run" association) -- they're always kept; an orphan
// container referencing a filtered-out result is harmless, Allure just ignores it.
function resultFileQualifies(fileName: string, dir: string, sinceMs: number): boolean {
  if (!fileName.endsWith("-result.json")) return true;
  try {
    const data = JSON.parse(fs.readFileSync(path.join(dir, fileName), "utf8"));
    const start = Number(data.start ?? data.stop ?? 0);
    return start >= sinceMs;
  } catch {
    return false;
  }
}

async function runAllureGenerate(sinceMs?: number): Promise<AllureGenerateResult> {
  if (!fs.existsSync(ALLURE_RESULTS_DIR) || countFilesRecursive(ALLURE_RESULTS_DIR) === 0) {
    return { ok: false, fileCount: 0, indexExists: false, message: "No allure-results found -- run at least one test first (allure-playwright writes results there)." };
  }

  // Scoped generation: copy only the qualifying result files into a throwaway
  // directory and point the CLI at that instead of the full accumulated folder.
  let resultsSourceDir = ALLURE_RESULTS_DIR;
  let scopedDir: string | null = null;
  if (sinceMs) {
    const allFiles = fs.readdirSync(ALLURE_RESULTS_DIR).filter((f) => f.endsWith(".json") || f.endsWith(".properties") || f.endsWith(".txt"));
    const qualifying = allFiles.filter((f) => resultFileQualifies(f, ALLURE_RESULTS_DIR, sinceMs));
    if (qualifying.length === 0) {
      return { ok: false, fileCount: 0, indexExists: false, message: "No test runs found since this crawl started -- run the generated scripts first, then generate the report." };
    }
    scopedDir = path.join(SERVER_ROOT, `allure-results-scoped-${Date.now()}`);
    fs.mkdirSync(scopedDir, { recursive: true });
    for (const f of qualifying) fs.copyFileSync(path.join(ALLURE_RESULTS_DIR, f), path.join(scopedDir, f));
    resultsSourceDir = scopedDir;
  }

  const resultsArg = path.relative(SERVER_ROOT, resultsSourceDir).replace(/\\/g, "/");
  const generated = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
    execFile(
      getNpxCommand(),
      ["--yes", "allure-commandline", "generate", resultsArg, "--clean", "-o", "allure-report"],
      { cwd: SERVER_ROOT, maxBuffer: 20 * 1024 * 1024, shell: process.platform === "win32", timeout: 60000 },
      (error, _stdout, stderr) => resolve({ ok: !error, error: error ? String(stderr || error.message).slice(0, 1000) : undefined })
    );
  });

  if (scopedDir) {
    fs.rmSync(scopedDir, { recursive: true, force: true });
  }

  const indexPath = path.join(ALLURE_REPORT_DIR, "index.html");
  const indexExists = fs.existsSync(indexPath);
  const fileCount = countFilesRecursive(ALLURE_REPORT_DIR);

  if (!generated.ok || !indexExists) {
    return {
      ok: false,
      fileCount,
      indexExists,
      message: `Allure report generation failed -- confirm the Allure commandline tool is installed (allure-commandline). ${generated.error ?? ""}`.trim(),
    };
  }

  return { ok: true, fileCount, indexExists: true, message: `Allure report generated: ${fileCount} file(s), index.html confirmed present.` };
}

export function getAllureReportStatus(): { exists: boolean; fileCount: number; generatedAt: string | null } {
  const indexPath = path.join(ALLURE_REPORT_DIR, "index.html");
  if (!fs.existsSync(indexPath)) return { exists: false, fileCount: 0, generatedAt: null };
  return {
    exists: true,
    fileCount: countFilesRecursive(ALLURE_REPORT_DIR),
    generatedAt: fs.statSync(indexPath).mtime.toISOString(),
  };
}

// Zips allure-report/'s CONTENTS at the zip root (not the parent folder itself,
// which is the common bug that breaks relative asset paths on unzip) and
// confirms index.html ends up at that root before returning the path.
export async function zipAllureReport(): Promise<{ zipPath: string; hasRootIndex: boolean }> {
  if (!fs.existsSync(path.join(ALLURE_REPORT_DIR, "index.html"))) {
    throw new Error("allure-report/index.html not found -- generate the report before downloading it.");
  }

  const zip = new JSZip();
  const addDir = (dir: string, zipFolder: JSZip) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        addDir(full, zipFolder.folder(entry.name)!);
      } else {
        zipFolder.file(entry.name, fs.readFileSync(full));
      }
    }
  };
  addDir(ALLURE_REPORT_DIR, zip);

  const zipPath = path.join(SERVER_ROOT, "allure-report.zip");
  const buffer = await zip.generateAsync({ type: "nodebuffer" });
  fs.writeFileSync(zipPath, buffer);

  // Verify index.html really landed at the zip's root, not nested.
  const verify = await JSZip.loadAsync(buffer);
  const hasRootIndex = Boolean(verify.file("index.html"));

  return { zipPath, hasRootIndex };
}
