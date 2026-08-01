import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { parse as parseYaml } from "yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.join(__dirname, "..", "..");

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

export function parseOpenApiSpec(raw: string): { summary: string; endpoints: Array<{ method: string; path: string }> } {
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
    Object.entries(methods || {}).filter(([method]) => ["get", "post", "put", "patch", "delete"].includes(method.toLowerCase())).map(([method, value]) => ({ method: method.toUpperCase(), path }))
  );

  if (endpoints.length === 0) {
    throw new Error("Invalid Swagger/OpenAPI spec: no API paths found.");
  }

  return {
    summary: `${title} ${version} — ${endpoints.length} endpoint(s) discovered`,
    endpoints,
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

export async function crawlUrl(url: string, maxPages = 2): Promise<{ summary: string; pages: Array<{ url: string; title: string }> }> {
  const normalizedUrl = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  const fetched: Array<{ url: string; title: string }> = [];
  const seen = new Set<string>();
  const queue = [normalizedUrl];

  while (queue.length > 0 && fetched.length < maxPages) {
    const current = queue.shift()!;
    if (seen.has(current)) continue;
    seen.add(current);

    const res = await fetch(current, { headers: { "User-Agent": "AI-Test-Automation-Platform" } });
    if (!res.ok) continue;
    const html = await res.text();
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : new URL(current).hostname;
    fetched.push({ url: current, title });

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
    summary: `Crawled ${fetched.length} page(s) from ${normalizedUrl}`,
    pages: fetched,
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
