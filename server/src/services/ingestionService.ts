import fs from "fs";
import path from "path";
import crypto from "crypto";
import { execFile } from "child_process";
import { fileURLToPath } from "url";
import { parse as parseYaml } from "yaml";
import { nanoid } from "nanoid";
import { db } from "../db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.join(__dirname, "..", "..");

// FR-1.2: Playwright ships its own ffmpeg binary (used for its video-recording
// feature) which this build reuses for key-frame extraction rather than adding
// a new dependency. Important honest caveat: it's a minimal build with only
// MJPEG and VP8/WebM decoders compiled in (verified via `ffmpeg -decoders`) --
// it can genuinely decode WebM uploads but not H.264 MP4/MOV, which are common
// upload formats. Extraction is attempted for every video; MP4/MOV/AVI uploads
// that fail to decode get a clear `frame_extraction_status` explaining why,
// rather than silently pretending frames were extracted.
function findBundledFfmpeg(): string | null {
  const base = path.join(process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || "", "AppData", "Local"), "ms-playwright");
  if (!fs.existsSync(base)) return null;
  const candidates = fs.readdirSync(base).filter((d) => d.startsWith("ffmpeg-"));
  for (const dir of candidates) {
    const exe = path.join(base, dir, "ffmpeg-win64.exe");
    if (fs.existsSync(exe)) return exe;
    const exeUnix = path.join(base, dir, "ffmpeg-linux");
    if (fs.existsSync(exeUnix)) return exeUnix;
  }
  return null;
}

export interface ExtractedFrame {
  frameIndex: number;
  timestampSeconds: number;
  fileName: string;
  filePath: string;
}

export async function extractVideoFrames(
  videoPath: string,
  outputDir: string,
  frameCount = 5
): Promise<{ status: "extracted" | "unsupported_format" | "unavailable"; frames: ExtractedFrame[]; message: string }> {
  const ffmpeg = findBundledFfmpeg();
  if (!ffmpeg) {
    return { status: "unavailable", frames: [], message: "No ffmpeg binary found (expected Playwright's bundled build under ms-playwright/ffmpeg-*)." };
  }

  const framePrefix = nanoid(8);
  const outputPattern = path.join(outputDir, `${framePrefix}-frame-%02d.png`);

  const result = await new Promise<{ ok: boolean; stderr: string }>((resolve) => {
    execFile(
      ffmpeg,
      // 1 frame/sec, capped at frameCount -- a reasonable sampling rate for
      // short screen-recording demo videos to catch distinct UI states.
      ["-i", videoPath, "-vf", "fps=1", "-frames:v", String(frameCount), "-y", outputPattern],
      { timeout: 15000 },
      (error, _stdout, stderr) => resolve({ ok: !error, stderr: String(stderr).slice(0, 500) })
    );
  });

  if (!result.ok) {
    // ffmpeg always prints its build configuration first; the real error is the
    // last non-empty line that isn't part of that configuration dump.
    const realErrorLine = result.stderr.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("configuration:") && !l.includes("--enable")).pop();
    return {
      status: "unsupported_format",
      frames: [],
      message: `Frame extraction failed -- this ffmpeg build only decodes WebM/VP8 video (verified via ffmpeg -decoders); MP4/MOV/AVI are not supported without a full ffmpeg build. Original error: ${realErrorLine || "unknown"}`,
    };
  }

  const frames: ExtractedFrame[] = [];
  const files = fs.readdirSync(outputDir).filter((f) => f.startsWith(framePrefix)).sort();
  files.forEach((fileName, i) => {
    frames.push({ frameIndex: i, timestampSeconds: i * (1 / frameCount), fileName, filePath: path.join(outputDir, fileName) });
  });

  if (frames.length === 0) {
    return { status: "unsupported_format", frames: [], message: "ffmpeg ran without error but produced no frames -- the video may be empty or in an unrecognized container." };
  }

  return { status: "extracted", frames, message: `Extracted ${frames.length} key frame(s).` };
}

// FR-1.2: catalog extracted frames, each traceable back to its source video.
export function recordVideoFrames(sourceVideoName: string, frames: ExtractedFrame[]) {
  const now = new Date().toISOString();
  const insert = db.prepare(`
    INSERT INTO video_frames (id, source_video_name, frame_index, timestamp_seconds, frame_url, created_at)
    VALUES (@id, @source_video_name, @frame_index, @timestamp_seconds, @frame_url, @created_at)
  `);
  const rows = frames.map((f) => {
    const row = {
      id: nanoid(10),
      source_video_name: sourceVideoName,
      frame_index: f.frameIndex,
      timestamp_seconds: f.timestampSeconds,
      frame_url: `/uploads/${f.fileName}`,
      created_at: now,
    };
    insert.run(row);
    return row;
  });
  return rows;
}

export interface BatchUploadArtifact {
  originalName: string;
  mimeType: string;
  size: number;
  kind: "image" | "video" | "spec" | "unknown";
  savedPath?: string;
  summary: string;
  redacted: boolean;
}

export interface BatchUploadSummary {
  content: string;
  artifacts: BatchUploadArtifact[];
}

export function classifyFile(fileName: string, mimeType: string): BatchUploadArtifact["kind"] {
  const lower = `${fileName}`.toLowerCase();
  if (mimeType.startsWith("image/") || lower.match(/\.(png|jpg|jpeg|gif|webp)$/)) return "image";
  if (mimeType.startsWith("video/") || lower.match(/\.(mp4|mov|webm|avi)$/)) return "video";
  if (lower.match(/\.(json|yaml|yml)$/) || mimeType.includes("json") || mimeType.includes("yaml")) return "spec";
  return "unknown";
}

export function redactLikelyPii(input: string, disableRedaction = false): string {
  if (disableRedaction || !input) return input;

  const replacements: Array<[RegExp, string]> = [
    [/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]"],
    [/\b(?:\+?\d[\s.-]?){8,15}\d\b/g, "[REDACTED_PHONE]"],
    [/\b(?:\d[ -]?){12,19}\d\b/g, "[REDACTED_CARD]"],
    [/\b(?:ssn|card|account|token)\s*[:=]\s*([^,\s;]+)/gi, "$1"],
  ];

  let result = input;
  for (const [pattern, replacement] of replacements) {
    result = result.replace(pattern, replacement);
  }

  return result;
}

export function buildBatchUploadSummary(files: Array<{ originalName: string; mimeType: string; size: number; savedPath?: string; content?: string; disableRedaction?: boolean }>): BatchUploadSummary {
  const artifacts: BatchUploadArtifact[] = [];
  const parts: string[] = [];

  for (const file of files) {
    const kind = classifyFile(file.originalName, file.mimeType);
    const redacted = Boolean(file.disableRedaction);
    const summary = kind === "spec"
      ? `Imported ${file.originalName} as ${kind} specification`
      : `Imported ${file.originalName} (${kind}, ${(file.size / 1024).toFixed(1)} KB)`;

    artifacts.push({
      originalName: file.originalName,
      mimeType: file.mimeType,
      size: file.size,
      kind,
      savedPath: file.savedPath,
      summary: redacted ? redactLikelyPii(summary, true) : summary,
      redacted: redacted,
    });
    parts.push(summary);
  }

  return {
    content: `Batch import (${artifacts.length} files): ${parts.join(" | ")}`,
    artifacts,
  };
}

// FR-5.2: structural hash of a parsed spec's shape (title + version + sorted
// method/path/param-count per endpoint) -- used to diff one import against the
// next so incidental key-order/whitespace differences in the raw text don't
// register as a false-positive "API change".
export function hashApiSpecStructure(title: string, version: string, endpoints: Array<{ method: string; path: string; paramCount?: number }>): string {
  const sorted = [...endpoints]
    .map((e) => `${e.method} ${e.path} params=${e.paramCount ?? 0}`)
    .sort();
  return crypto.createHash("sha256").update(JSON.stringify({ title, version, endpoints: sorted })).digest("hex");
}

export function parseOpenApiSpec(raw: string): { summary: string; title: string; version: string; endpoints: Array<{ method: string; path: string }>; structureHash: string } {
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    try {
      parsed = parseYaml(raw);
    } catch {
      throw new Error("Invalid Swagger/OpenAPI spec: expected valid JSON or YAML.");
    }
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Invalid Swagger/OpenAPI spec: expected an object.");
  }

  const title = parsed.info?.title || parsed.swagger || parsed.openapi || "Unnamed API";
  const version = parsed.info?.version || parsed.openapi || parsed.swagger || "unknown";
  const entries = Object.entries(parsed.paths || {});
  const endpoints = entries.flatMap(([path, methods]: [string, any]) =>
    Object.entries(methods || {}).filter(([method]) => ["get", "post", "put", "patch", "delete"].includes(method.toLowerCase())).map(([method, value]: [string, any]) => ({
      method: method.toUpperCase(),
      path,
      paramCount: Array.isArray(value?.parameters) ? value.parameters.length : 0,
    }))
  );

  if (endpoints.length === 0) {
    throw new Error("Invalid Swagger/OpenAPI spec: no API paths found.");
  }

  const structureHash = hashApiSpecStructure(title, version, endpoints);

  return {
    summary: `${title} ${version} — ${endpoints.length} endpoint(s) discovered`,
    title,
    version,
    endpoints: endpoints.map(({ method, path }) => ({ method, path })),
    structureHash,
  };
}

export function parsePostmanCollection(raw: string): { summary: string; requestCount: number; variableCount: number; scriptCount: number } {
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Invalid Postman collection: expected valid JSON.");
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Invalid Postman collection: expected an object.");
  }

  const items = Array.isArray(parsed.item) ? parsed.item : [];
  const requests = items.filter((item: any) => item?.request).length;
  const variables = Array.isArray(parsed.variable) ? parsed.variable.length : 0;
  const scripts = items.filter((item: any) => item?.event?.some((event: any) => event?.script?.exec?.length)).length;

  return {
    summary: `${parsed.info?.name || "Postman Collection"} — ${requests} request(s), ${variables} variable(s), ${scripts} script-enabled item(s)`,
    requestCount: requests,
    variableCount: variables,
    scriptCount: scripts,
  };
}

export interface CrawlAuth {
  username?: string;
  password?: string;
  sessionToken?: string;
}

// FR-1.3/FR-1.3a/FR-1.3b: crawl reachable pages, optionally authenticating first
// via HTTP Basic credentials or an SSO/session token/cookie so pages behind a
// login wall are reachable too; while crawling, also count forms as a proxy
// for "workflows discovered" (FR-1.3b) since this build has no headless
// browser driving real form submission -- it discovers the presence and shape
// of workflows via static HTML, not by executing them end to end.
export async function crawlUrl(
  url: string,
  maxPages = 2,
  auth?: CrawlAuth
): Promise<{ summary: string; pages: Array<{ url: string; title: string; formCount: number }>; authenticated: boolean }> {
  const normalizedUrl = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  const fetched: Array<{ url: string; title: string; formCount: number }> = [];
  const seen = new Set<string>();
  const queue = [normalizedUrl];

  const headers: Record<string, string> = { "User-Agent": "AI-Test-Automation-Platform" };
  let authenticated = false;
  if (auth?.username || auth?.password) {
    headers.Authorization = `Basic ${Buffer.from(`${auth.username ?? ""}:${auth.password ?? ""}`).toString("base64")}`;
    authenticated = true;
  } else if (auth?.sessionToken) {
    headers.Cookie = auth.sessionToken;
    headers.Authorization = `Bearer ${auth.sessionToken}`;
    authenticated = true;
  }

  // FR-1.3a: invalid credentials must fail cleanly rather than silently crawling as anonymous
  if (authenticated) {
    const probe = await fetch(normalizedUrl, { headers });
    if (probe.status === 401 || probe.status === 403) {
      throw new Error(`Authentication failed (HTTP ${probe.status}) -- check the supplied credentials/session token.`);
    }
  }

  while (queue.length > 0 && fetched.length < maxPages) {
    const current = queue.shift()!;
    if (seen.has(current)) continue;
    seen.add(current);

    const res = await fetch(current, { headers });
    if (!res.ok) continue;
    const html = await res.text();
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : new URL(current).hostname;
    const formCount = (html.match(/<form[\s>]/gi) || []).length;
    fetched.push({ url: current, title, formCount });

    const links = Array.from(html.matchAll(/<a[^>]+href=["']([^"']+)["']/gi)).map((m) => m[1]);
    for (const link of links) {
      try {
        const resolved = new URL(link, current).toString();
        if (resolved.startsWith(normalizedUrl) && !seen.has(resolved)) queue.push(resolved);
      } catch {
        // ignore malformed links
      }
    }
  }

  return {
    summary: `Crawled ${fetched.length} page(s) from ${normalizedUrl}${authenticated ? " (authenticated)" : ""}`,
    pages: fetched,
    authenticated,
  };
}

export async function importExternalWorkItems(provider: "jira" | "azure", options: { baseUrl: string; token: string; issueIds: string[] | string; project?: string }): Promise<{ summary: string; items: Array<{ id: string; title: string }> }> {
  if (!options.baseUrl || !options.token) {
    throw new Error("External import requires a base URL and an authentication token.");
  }

  const ids = Array.isArray(options.issueIds) ? options.issueIds : options.issueIds.split(/[,\s]+/).filter(Boolean);
  if (ids.length === 0) {
    throw new Error("External import requires at least one issue ID.");
  }

  const items: Array<{ id: string; title: string }> = [];

  const headers: Record<string, string> = {
    Accept: "application/json",
  };

  for (const id of ids) {
    const endpoint = provider === "jira"
      ? `${options.baseUrl.replace(/\/$/, "")}/rest/api/2/issue/${encodeURIComponent(id)}`
      : `${options.baseUrl.replace(/\/$/, "")}/_apis/wit/workitems/${encodeURIComponent(id)}?api-version=7.1`;

    if (provider === "jira") {
      headers.Authorization = `Bearer ${options.token}`;
    } else {
      headers.Authorization = `Basic ${Buffer.from(`:${options.token}`).toString("base64")}`;
    }

    const res = await fetch(endpoint, { headers });
    if (!res.ok) {
      throw new Error(`External import failed for ${id}: ${res.status} ${res.statusText}`);
    }

    const payload = (await res.json().catch(() => ({}))) as Record<string, any>;
    const title = provider === "jira"
      ? payload.fields?.summary || payload.key || id
      : payload.fields?.["System.Title"] || payload.id?.toString() || id;

    items.push({ id, title });
  }

  return {
    summary: `Imported ${items.length} ${provider} item(s) via authenticated API`,
    items,
  };
}
