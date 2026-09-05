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

// Phase 2 config: the one tunable this check has, kept alongside the type
// definitions rather than buried inline in diffShape.
export const API_SCHEMA_CONFIG = {
  // Caps the finding list for one comparison so a wildly different payload
  // can't produce an unbounded number of bug_findings rows in one pass.
  maxDiffIssuesPerResponse: 25,
};

// `types`/`optionalFields` (plural) rather than a single value is what makes
// baseline mode genuinely mean "accept the current shape as correct" instead
// of "freeze on whichever sample happened to arrive first": mergeShape below
// widens both across every sample seen while an endpoint is in baseline mode,
// so a field that's legitimately sometimes-a-different-type (an id that's a
// number in one record, a string in another) or sometimes-absent (present
// only when a promo/flag applies) is recorded as such -- and diffShape then
// only flags a *genuinely new* type or a field that was *always* present
// before, not variation baseline mode already observed and accepted.
export type ShapeNode =
  | { kind: "primitive"; types: Array<"string" | "number" | "boolean">; nullable: boolean }
  | { kind: "null" }
  | { kind: "array"; item: ShapeNode | null } // null item = empty array sample, shape unknown
  | { kind: "object"; fields: Record<string, ShapeNode>; optionalFields: string[] }; // optionalFields: keys not present in every sample merged so far

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

/** Infer a structural shape from a single parsed JSON value/sample. Pure, no I/O. */
export function inferShape(value: unknown): ShapeNode {
  if (value === null) return { kind: "null" };
  if (Array.isArray(value)) {
    return { kind: "array", item: value.length > 0 ? inferShape(value[0]) : null };
  }
  if (typeof value === "object") {
    const fields: Record<string, ShapeNode> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) fields[key] = inferShape(v);
    return { kind: "object", fields, optionalFields: [] };
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return { kind: "primitive", types: [typeof value as "string" | "number" | "boolean"], nullable: false };
  }
  // undefined or an unsupported type (function/symbol/bigint) -- treat as an
  // opaque primitive so a diff against it never crashes, just reads oddly.
  return { kind: "primitive", types: ["string"], nullable: false };
}

function shapeKindLabel(shape: ShapeNode | undefined): string {
  if (!shape) return "absent";
  if (shape.kind === "primitive") return shape.types.join("|");
  return shape.kind;
}

/**
 * Widen an accumulated (stored) shape with one more observed sample's shape.
 * Called on every sighting while an endpoint is in 'baseline' mode, so the
 * stored schema reflects everything actually seen (every type a field has
 * taken, whether it's ever been absent) rather than just the first sample --
 * see the ShapeNode doc comment above for why this matters.
 */
export function mergeShape(accumulated: ShapeNode, sample: ShapeNode): ShapeNode {
  if (sample.kind === "null") {
    return accumulated.kind === "primitive" ? { ...accumulated, nullable: true } : accumulated;
  }
  if (accumulated.kind === "null") {
    return sample.kind === "primitive" ? { ...sample, nullable: true } : sample;
  }
  if (accumulated.kind === "primitive" && sample.kind === "primitive") {
    return {
      kind: "primitive",
      types: Array.from(new Set([...accumulated.types, ...sample.types])),
      nullable: accumulated.nullable || sample.nullable,
    };
  }
  if (accumulated.kind === "object" && sample.kind === "object") {
    const fields: Record<string, ShapeNode> = { ...accumulated.fields };
    const optional = new Set(accumulated.optionalFields);
    for (const key of Object.keys(sample.fields)) {
      fields[key] = key in fields ? mergeShape(fields[key], sample.fields[key]) : sample.fields[key];
      if (!(key in accumulated.fields)) optional.add(key); // wasn't in earlier samples -- optional
    }
    for (const key of Object.keys(accumulated.fields)) {
      if (!(key in sample.fields)) optional.add(key); // was in earlier samples but missing from this one -- optional
    }
    return { kind: "object", fields, optionalFields: Array.from(optional) };
  }
  if (accumulated.kind === "array" && sample.kind === "array") {
    if (!accumulated.item) return sample.item ? sample : accumulated;
    if (!sample.item) return accumulated;
    return { kind: "array", item: mergeShape(accumulated.item, sample.item) };
  }
  // A genuine kind mismatch (object vs array, etc.) while still in baseline
  // mode -- there's no sensible way to merge these into one shape. Keep the
  // accumulated shape; if this endpoint's responses are genuinely this
  // unstable, switching it to strict mode will honestly surface that.
  return accumulated;
}

/**
 * Diff an actual shape against a stored (possibly baseline-widened) shape.
 * Recurses into nested objects/arrays. Capped (API_SCHEMA_CONFIG.
 * maxDiffIssuesPerResponse) so a wildly different payload can't produce an
 * unbounded finding list.
 */
export function diffShape(baseline: ShapeNode, actual: ShapeNode, path = "$"): SchemaDiffIssue[] {
  const issues: SchemaDiffIssue[] = [];
  const maxIssues = API_SCHEMA_CONFIG.maxDiffIssuesPerResponse;

  function walk(b: ShapeNode, a: ShapeNode, p: string) {
    if (issues.length >= maxIssues) return;

    // Unexpected null: baseline never observed null here (in any merged
    // sample), actual is null.
    if (a.kind === "null" && b.kind !== "null" && !(b.kind === "primitive" && b.nullable)) {
      issues.push({ path: p, kind: "unexpected_null", message: `${p} is null, but the baseline never observed a null value here (expected ${shapeKindLabel(b)})`, severity: "medium" });
      return;
    }
    // Baseline itself was null (or a nullable primitive) -- an actual null here is fine.
    if (b.kind === "null") return;
    if (b.kind === "primitive" && b.nullable && a.kind === "null") return;

    if (b.kind === "object" && a.kind === "object") {
      for (const [key, bShape] of Object.entries(b.fields)) {
        if (issues.length >= maxIssues) break;
        const aShape = a.fields[key];
        if (aShape === undefined) {
          // A field baseline saw only inconsistently (sometimes present,
          // sometimes not) is known-optional, not a defect -- only flag a
          // field that was present in EVERY merged baseline sample.
          if (b.optionalFields.includes(key)) continue;
          issues.push({ path: `${p}.${key}`, kind: "missing_field", message: `${p}.${key} was present in every baseline sample but is missing from this one`, severity: "high" });
          continue;
        }
        walk(bShape, aShape, `${p}.${key}`);
      }
      for (const key of Object.keys(a.fields)) {
        if (issues.length >= maxIssues) break;
        if (!(key in b.fields)) {
          issues.push({ path: `${p}.${key}`, kind: "unexpected_field", message: `${p}.${key} is new -- not present in any baseline sample`, severity: "low" });
        }
      }
      return;
    }

    if (b.kind === "array" && a.kind === "array") {
      if (b.item && a.item) walk(b.item, a.item, `${p}[]`);
      return;
    }

    if (b.kind === "primitive" && a.kind === "primitive") {
      // A type the baseline has ever observed for this field (across every
      // merged sample) is known-good, not drift -- e.g. an id that's a
      // number in one record and a string in another.
      if (!b.types.includes(a.types[0])) {
        issues.push({ path: p, kind: "type_mismatch", message: `${p} was ${shapeKindLabel(b)} in the baseline, but is ${shapeKindLabel(a)} now`, severity: "high" });
      }
      return;
    }

    // Anything else reaching here is a genuine shape mismatch (object vs
    // array, array vs primitive, etc.).
    const bLabel = shapeKindLabel(b);
    const aLabel = shapeKindLabel(a);
    if (bLabel !== aLabel) {
      issues.push({ path: p, kind: "type_mismatch", message: `${p} was ${bLabel} in the baseline response, but is ${aLabel} now`, severity: "high" });
    }
  }

  walk(baseline, actual, path);
  return issues;
}

/**
 * Phase 1 hardening: a 2xx array/object response that's empty where this
 * endpoint's own learned baseline shows data is normally present -- e.g. a
 * list endpoint that has always returned populated arrays suddenly returning
 * `[]`, or an object endpoint whose baseline has fields it has NEVER once
 * seen entirely absent now returning `{}`. False-positive risk: a genuinely
 * empty result set (a search with zero matches, a brand-new account with no
 * orders yet) is legitimate and looks identical at the shape level -- this
 * heuristic can only ever be a hint, not a certainty, which is why it's
 * `medium` severity rather than `high`/`critical` like a real schema-drift
 * finding. Suppress a noisy endpoint by switching it to 'baseline' mode
 * (re-learning also re-widens optionalFields, which lowers this check's
 * sensitivity for that endpoint) or by editing/deleting its stored schema.
 */
export function detectUnexpectedEmpty(baseline: ShapeNode, actual: unknown): "array" | "object" | null {
  if (Array.isArray(actual) && actual.length === 0 && baseline.kind === "array" && baseline.item !== null) {
    return "array";
  }
  if (
    actual &&
    typeof actual === "object" &&
    !Array.isArray(actual) &&
    Object.keys(actual as Record<string, unknown>).length === 0 &&
    baseline.kind === "object" &&
    Object.keys(baseline.fields).length > 0 &&
    baseline.optionalFields.length < Object.keys(baseline.fields).length
  ) {
    return "object";
  }
  return null;
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
  /** Phase 1 hardening: the response's own content-type header, set when jsonParseFailed is true so the malformed-JSON check can tell "claims JSON, isn't" from "never claimed to be JSON". */
  contentType?: string;
  /** Phase 1 hardening: true when the caller tried response.json() and it threw -- body is always undefined in this case. */
  jsonParseFailed?: boolean;
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

  if (input.jsonParseFailed) {
    // Only flag it when the response actually claims to be JSON -- a
    // non-JSON content-type failing to parse as JSON is expected (e.g. a 204
    // No Content, or a redirect the fetch layer already resolved), not a bug.
    if (/application\/json/i.test(input.contentType || "")) {
      findings.push(
        recordBugFinding({
          source: "api_fuzz",
          category: "api-status",
          severity: "high",
          title: `${endpointKey} returned malformed JSON`,
          detail: `The response declares "Content-Type: ${input.contentType}" but the body could not be parsed as JSON -- any caller doing response.json() will crash instead of getting a usable error.`,
          screenId: input.screenId ?? null,
          runId: input.runId ?? null,
          evidence: { endpointKey, status: input.status, contentType: input.contentType },
          stepsToReproduce: [
            `Call ${endpointKey}`,
            `Observe: the response Content-Type header is "${input.contentType}", but the body fails to parse as JSON.`,
            "Expected: either valid JSON, or a content-type that doesn't promise JSON.",
          ],
        })
      );
    }
    return findings; // no parsed body -- nothing else to validate
  }

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

  let baselineShape: ShapeNode;
  try {
    baselineShape = JSON.parse(existing.schema_json);
  } catch {
    db.prepare("UPDATE api_schemas SET seen_count = seen_count + 1, updated_at = ? WHERE id = ?").run(new Date().toISOString(), existing.id);
    return findings; // corrupted stored schema -- don't crash the scan over it
  }

  // Phase 1 hardening: a 2xx response that's empty where this endpoint's own
  // learned baseline shows data is normally present -- a status anomaly, not
  // schema drift, so (like the error-shaped-body check above) it runs
  // regardless of mode rather than being gated behind 'strict'.
  if (input.status >= 200 && input.status < 300) {
    const emptyKind = detectUnexpectedEmpty(baselineShape, input.body);
    if (emptyKind) {
      findings.push(
        recordBugFinding({
          source: "api_fuzz",
          category: "api-status",
          severity: "medium",
          title: `${endpointKey} returned an empty ${emptyKind} where data was expected`,
          detail: `This endpoint's learned baseline has always returned a populated ${emptyKind === "array" ? "array" : "object (with fields present)"}, but this response is empty. This may be a legitimate zero-result case (e.g. an empty search) rather than a defect -- verify before treating as a confirmed bug.`,
          screenId: input.screenId ?? null,
          runId: input.runId ?? null,
          evidence: { endpointKey, status: input.status, emptyKind },
          stepsToReproduce: [
            `Call ${endpointKey}`,
            `Observe: HTTP ${input.status} with an empty ${emptyKind}, where the baseline for this endpoint has always seen data.`,
            "Confirm whether this specific request should legitimately have zero results.",
          ],
        })
      );
    }
  }

  if (existing.mode === "baseline") {
    // Widen the stored shape with this sample rather than freezing on
    // whichever sample happened to arrive first -- see mergeShape's doc
    // comment. This is what makes "baseline: accept the current shape as
    // correct" actually mean the shape observed across every sample, not
    // just sample #1, so switching to strict mode later doesn't immediately
    // false-positive on variation baseline mode already saw and accepted.
    const widened = mergeShape(baselineShape, actualShape);
    db.prepare("UPDATE api_schemas SET schema_json = ?, seen_count = seen_count + 1, updated_at = ? WHERE id = ?").run(
      JSON.stringify(widened),
      new Date().toISOString(),
      existing.id
    );
    return findings;
  }

  db.prepare("UPDATE api_schemas SET seen_count = seen_count + 1, updated_at = ? WHERE id = ?").run(new Date().toISOString(), existing.id);
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
