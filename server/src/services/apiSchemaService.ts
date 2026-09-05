// Deeper Bug Detection #2 -- API Response Schema Validation. Captures a sample
// JSON response the first time a distinct "METHOD path" endpoint is seen (the
// baseline), then diffs every later response against it: missing fields, type
// mismatches, unexpected nulls, and unexpected new fields. Also independently
// flags a "2xx with an error-shaped body" status anomaly, regardless of mode.
//
// Schemas are stored (not just inferred transiently) in api_schemas so they're
// reviewable/editable -- list/get/update-mode/reset-baseline/delete below --
// and each endpoint runs in 'baseline' mode (silently accept the current shape,
// never flag drift) or 'strict' mode (flag any drift) independently.
//
// Deliberately a hand-rolled shape inference/diff, not a JSON-Schema library
// (ajv etc.) -- consistent with this codebase's existing hand-rolled analysis
// services (consoleErrorService.ts, visualDetectionService.ts have no
// validation-library dependency either).

import { nanoid } from "nanoid";
import { db } from "../db.js";
import { recordBugFinding, type BugFindingRow, type BugSeverity } from "./bugDetectionService.js";
import { getApiSchemaDefaultMode } from "./adminService.js";

export type SchemaMode = "baseline" | "strict";

export type ShapeNode =
  | { kind: "primitive"; type: "string" | "number" | "boolean"; nullable: boolean }
  | { kind: "null" }
  | { kind: "array"; item: ShapeNode | null } // null item = empty array sample, shape unknown
  | { kind: "object"; fields: Record<string, ShapeNode> };

export interface ApiSchemaRow {
  id: string;
  endpoint_key: string;
  method: string;
  path: string;
  mode: SchemaMode;
  schema_json: string;
  sample_response_json: string | null;
  sample_status: number | null;
  site_id: string | null;
  seen_count: number;
  created_at: string;
  updated_at: string;
}

export interface SchemaDiffIssue {
  path: string; // dot/bracket path into the body, e.g. "items[].price"
  kind: "missing_field" | "type_mismatch" | "unexpected_null" | "unexpected_field";
  message: string;
  severity: BugSeverity;
}

/** Infer a structural shape from a parsed JSON value. Pure, no I/O. */
export function inferShape(value: unknown): ShapeNode {
  if (value === null) return { kind: "null" };
  if (Array.isArray(value)) {
    return { kind: "array", item: value.length > 0 ? inferShape(value[0]) : null };
  }
  if (typeof value === "object") {
    const fields: Record<string, ShapeNode> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) fields[key] = inferShape(v);
    return { kind: "object", fields };
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return { kind: "primitive", type: typeof value as "string" | "number" | "boolean", nullable: false };
  }
  // undefined or an unsupported type (function/symbol/bigint) -- treat as an
  // opaque primitive so a diff against it never crashes, just reads oddly.
  return { kind: "primitive", type: "string", nullable: false };
}

function shapeKindLabel(shape: ShapeNode | undefined): string {
  if (!shape) return "absent";
  if (shape.kind === "primitive") return shape.type;
  return shape.kind;
}

/** Merge an actual-value's nullability into a stored primitive shape (baseline mode uses this to widen in place, see recordApiSchemaSighting). */
function widenNullable(shape: ShapeNode): ShapeNode {
  if (shape.kind === "primitive") return { ...shape, nullable: true };
  return shape;
}

/**
 * Diff an actual shape against a stored baseline shape. Recurses into nested
 * objects/arrays. Capped depth/breadth (MAX_ISSUES) so a wildly different
 * payload can't produce an unbounded finding list.
 */
export function diffShape(baseline: ShapeNode, actual: ShapeNode, path = "$"): SchemaDiffIssue[] {
  const issues: SchemaDiffIssue[] = [];
  const MAX_ISSUES = 25;

  function walk(b: ShapeNode, a: ShapeNode, p: string) {
    if (issues.length >= MAX_ISSUES) return;

    // Unexpected null: baseline never observed null here, actual is null.
    if (a.kind === "null" && b.kind !== "null") {
      issues.push({ path: p, kind: "unexpected_null", message: `${p} is null, but the baseline never observed a null value here (expected ${shapeKindLabel(b)})`, severity: "medium" });
      return;
    }
    // Baseline itself was null (or a nullable primitive) -- an actual null here is fine.
    if (b.kind === "null") return;
    if (b.kind === "primitive" && b.nullable && a.kind === "null") return;

    if (b.kind === "object" && a.kind === "object") {
      for (const [key, bShape] of Object.entries(b.fields)) {
        if (issues.length >= MAX_ISSUES) break;
        const aShape = a.fields[key];
        if (aShape === undefined) {
          issues.push({ path: `${p}.${key}`, kind: "missing_field", message: `${p}.${key} was present in the baseline response but is missing from this one`, severity: "high" });
          continue;
        }
        walk(bShape, aShape, `${p}.${key}`);
      }
      for (const key of Object.keys(a.fields)) {
        if (issues.length >= MAX_ISSUES) break;
        if (!(key in b.fields)) {
          issues.push({ path: `${p}.${key}`, kind: "unexpected_field", message: `${p}.${key} is new -- not present in the baseline response`, severity: "low" });
        }
      }
      return;
    }

    if (b.kind === "array" && a.kind === "array") {
      if (b.item && a.item) walk(b.item, a.item, `${p}[]`);
      return;
    }

    // Anything else reaching here is a genuine shape mismatch (object vs array,
    // array vs primitive, string vs number, etc.).
    const bLabel = shapeKindLabel(b);
    const aLabel = shapeKindLabel(a);
    if (bLabel !== aLabel) {
      issues.push({ path: p, kind: "type_mismatch", message: `${p} was ${bLabel} in the baseline response, but is ${aLabel} now`, severity: "high" });
    }
  }

  walk(baseline, actual, path);
  return issues;
}

/** Heuristic: a 2xx response whose body reads like an error payload -- the classic "200 OK with an error inside" API bug. */
export function looksLikeErrorBody(body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const obj = body as Record<string, unknown>;
  if (obj.success === false) return true;
  if (typeof obj.error === "string" && obj.error.length > 0) return true;
  if (Array.isArray(obj.errors) && obj.errors.length > 0) return true;
  if (typeof obj.status === "string" && /^(error|fail|failed|failure)$/i.test(obj.status)) return true;
  return false;
}

export function getApiSchemaByKey(endpointKey: string): ApiSchemaRow | undefined {
  return db.prepare("SELECT * FROM api_schemas WHERE endpoint_key = ?").get(endpointKey) as ApiSchemaRow | undefined;
}

export function getApiSchema(id: string): ApiSchemaRow | undefined {
  return db.prepare("SELECT * FROM api_schemas WHERE id = ?").get(id) as ApiSchemaRow | undefined;
}

export function listApiSchemas(siteId?: string): ApiSchemaRow[] {
  if (siteId) return db.prepare("SELECT * FROM api_schemas WHERE site_id = ? ORDER BY endpoint_key ASC").all(siteId) as ApiSchemaRow[];
  return db.prepare("SELECT * FROM api_schemas ORDER BY endpoint_key ASC").all() as ApiSchemaRow[];
}

function truncateSample(body: unknown): string {
  try {
    return JSON.stringify(body).slice(0, 4000);
  } catch {
    return "null";
  }
}

function saveNewApiSchema(params: { endpointKey: string; method: string; path: string; shape: ShapeNode; sampleBody: unknown; sampleStatus: number; siteId: string | null }): ApiSchemaRow {
  const id = nanoid(10);
  const now = new Date().toISOString();
  const row = {
    id,
    endpoint_key: params.endpointKey,
    method: params.method,
    path: params.path,
    mode: getApiSchemaDefaultMode(),
    schema_json: JSON.stringify(params.shape),
    sample_response_json: truncateSample(params.sampleBody),
    sample_status: params.sampleStatus,
    site_id: params.siteId,
    seen_count: 1,
    created_at: now,
    updated_at: now,
  };
  db.prepare(`
    INSERT INTO api_schemas (id, endpoint_key, method, path, mode, schema_json, sample_response_json, sample_status, site_id, seen_count, created_at, updated_at)
    VALUES (@id, @endpoint_key, @method, @path, @mode, @schema_json, @sample_response_json, @sample_status, @site_id, @seen_count, @created_at, @updated_at)
  `).run(row);
  return row as ApiSchemaRow;
}

export function updateApiSchemaMode(id: string, mode: SchemaMode): ApiSchemaRow {
  if (mode !== "baseline" && mode !== "strict") throw new Error("mode must be 'baseline' or 'strict'");
  const now = new Date().toISOString();
  db.prepare("UPDATE api_schemas SET mode = ?, updated_at = ? WHERE id = ?").run(mode, now, id);
  const row = getApiSchema(id);
  if (!row) throw new Error("API schema not found");
  return row;
}

/** Re-baseline an endpoint from its own last-captured sample -- for after an intentional API change. */
export function resetApiSchemaBaseline(id: string): ApiSchemaRow {
  const existing = getApiSchema(id);
  if (!existing) throw new Error("API schema not found");
  const sample = existing.sample_response_json ? JSON.parse(existing.sample_response_json) : null;
  const now = new Date().toISOString();
  db.prepare("UPDATE api_schemas SET schema_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(inferShape(sample)), now, id);
  const row = getApiSchema(id);
  if (!row) throw new Error("API schema not found");
  return row;
}

export function deleteApiSchema(id: string): void {
  db.prepare("DELETE FROM api_schemas WHERE id = ?").run(id);
}

export interface ApiValidationInput {
  method: string;
  path: string;
  status: number;
  body: unknown; // parsed JSON body, or undefined/null if not JSON / unparseable
  screenId?: string | null;
  runId?: string | null;
  siteId?: string | null;
}

/**
 * The main entry point, called from bugDetectionService.ts for every captured
 * XHR/fetch response that looks like a JSON API call. First sighting of an
 * endpoint establishes its baseline (no findings yet -- nothing to compare
 * against). Every later sighting is diffed (unless the endpoint's mode is
 * 'baseline'); the 2xx-with-error-body check runs regardless of mode, since
 * that's a status anomaly, not a schema-drift question.
 */
export function checkAndRecordApiResponse(input: ApiValidationInput): BugFindingRow[] {
  const endpointKey = `${input.method} ${input.path}`;
  const findings: BugFindingRow[] = [];

  const isErrorShaped = input.status >= 200 && input.status < 300 && looksLikeErrorBody(input.body);
  if (isErrorShaped) {
    findings.push(
      recordBugFinding({
        source: "api_fuzz",
        category: "api-status",
        severity: "high",
        title: `${endpointKey} returns HTTP ${input.status} with an error-shaped body`,
        detail: `The response body looks like an error payload (e.g. success:false / an error/errors field) despite a ${input.status} status -- callers checking only the HTTP status will treat this as success.`,
        screenId: input.screenId ?? null,
        runId: input.runId ?? null,
        evidence: { endpointKey, status: input.status, body: truncateSample(input.body) },
        stepsToReproduce: [
          `Call ${endpointKey}`,
          `Observe: HTTP ${input.status} (looks successful), but the response body itself indicates an error.`,
          "Expected: either a non-2xx status for this error case, or a body that doesn't read as an error when the status is 2xx.",
        ],
      })
    );
  }

  if (input.body === null || input.body === undefined) return findings;

  const existing = getApiSchemaByKey(endpointKey);
  const actualShape = inferShape(input.body);

  if (!existing) {
    saveNewApiSchema({ endpointKey, method: input.method, path: input.path, shape: actualShape, sampleBody: input.body, sampleStatus: input.status, siteId: input.siteId ?? null });
    return findings;
  }

  db.prepare("UPDATE api_schemas SET seen_count = seen_count + 1, updated_at = ? WHERE id = ?").run(new Date().toISOString(), existing.id);
  if (existing.mode === "baseline") return findings;

  let baselineShape: ShapeNode;
  try {
    baselineShape = JSON.parse(existing.schema_json);
  } catch {
    return findings; // corrupted stored schema -- don't crash the scan over it
  }

  const diffs = diffShape(baselineShape, actualShape);
  for (const d of diffs) {
    findings.push(
      recordBugFinding({
        source: "api_fuzz",
        category: "api-schema",
        severity: d.severity,
        title: `API schema drift on ${endpointKey}: ${d.kind.replace(/_/g, " ")} at ${d.path}`,
        detail: d.message,
        screenId: input.screenId ?? null,
        runId: input.runId ?? null,
        evidence: { endpointKey, ...d, status: input.status },
        stepsToReproduce: [
          `Call ${endpointKey}`,
          `Inspect the response body at ${d.path}`,
          `Observe: ${d.message}`,
        ],
      })
    );
  }
  return findings;
}
