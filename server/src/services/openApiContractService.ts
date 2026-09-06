// Master-prompt #5 -- API Contract Intelligence, live-traffic-vs-published-
// contract half. apiSchemaService.ts already does the self-inferred
// baseline-vs-drift half (learn a shape from traffic, flag deviation from
// it); this module adds the other explicitly-requested piece: "if OpenAPI/
// Swagger is available, discover it, import it, compare actual responses
// against the contract." A violation found here is a STRONGER signal than
// self-inferred drift -- it means the site is violating its OWN published
// contract, not just behaving differently from what this scan has observed
// before -- so findings are evidence-tagged `contractSource: 'openapi'` to
// keep the two distinct in a report.
//
// Deliberately a lightweight, bounded JSON-Schema/OpenAPI-subset converter,
// not a full spec-compliant parser -- consistent with this codebase's
// existing house style (apiSchemaService's own hand-rolled shape inference
// instead of a JSON-Schema validation library). Unsupported constructs
// (oneOf/anyOf/allOf, remote $refs, deeply recursive schemas) are skipped
// silently rather than guessed at -- an endpoint this can't confidently
// model just isn't contract-checked, which is safer than a wrong model
// producing false-positive "violations."
//
// FALSE-POSITIVE RISK: a spec that's stale relative to the deployed API
// (a very common real-world situation -- specs drift from implementations)
// will read as the API "violating its contract" when actually the contract
// itself is out of date. There is no per-endpoint suppression list for this
// (unlike other checks) because the fix is almost always to update the spec
// or re-run discovery after a deploy, not to suppress a specific field --
// deleteOpenApiSpec(baseUrl) clears the cached spec so the next scan
// re-discovers/re-parses it.

import { nanoid } from "nanoid";
import { parse as parseYaml } from "yaml";
import { db } from "../db.js";
import { inferShape, diffShape, type ShapeNode, type SchemaDiffIssue } from "./apiSchemaService.js";
import { recordBugFinding, type BugFindingRow } from "./bugDetectionService.js";

export const OPENAPI_CONTRACT_CONFIG = {
  // Well-known paths probed, in order, the first time an origin is seen.
  // Covers the conventional Swagger/OpenAPI publishing locations across
  // Express/NestJS/Spring/.NET/FastAPI-style backends.
  wellKnownSpecPaths: [
    "/openapi.json",
    "/openapi.yaml",
    "/swagger.json",
    "/swagger.yaml",
    "/v3/api-docs",
    "/v2/api-docs",
    "/api-docs",
    "/api/openapi.json",
    "/api/swagger.json",
    "/swagger/v1/swagger.json",
  ],
  probeTimeoutMs: 5000,
  maxRefDepth: 6, // guards against a cyclic/deeply-nested $ref chain
  maxDiffIssuesPerResponse: 25,
};

export interface OpenApiSpecRow {
  id: string;
  base_url: string;
  found: number; // 0 | 1 -- a cached "no spec here" result is itself meaningful, see file doc comment
  spec_url: string | null;
  title: string | null;
  version: string | null;
  schemas_json: string; // Record<"METHOD /path/template", ShapeNode>
  discovered_at: string;
  updated_at: string;
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

export function getOpenApiSpecForOrigin(baseUrl: string): OpenApiSpecRow | undefined {
  return db.prepare("SELECT * FROM openapi_specs WHERE base_url = ?").get(originOf(baseUrl)) as OpenApiSpecRow | undefined;
}

export function deleteOpenApiSpec(baseUrl: string): void {
  db.prepare("DELETE FROM openapi_specs WHERE base_url = ?").run(originOf(baseUrl));
}

function saveOpenApiSpec(params: { origin: string; found: boolean; specUrl: string | null; title: string | null; version: string | null; schemas: Record<string, ShapeNode> }): OpenApiSpecRow {
  const now = new Date().toISOString();
  const row: OpenApiSpecRow = {
    id: nanoid(10),
    base_url: params.origin,
    found: params.found ? 1 : 0,
    spec_url: params.specUrl,
    title: params.title,
    version: params.version,
    schemas_json: JSON.stringify(params.schemas),
    discovered_at: now,
    updated_at: now,
  };
  db.prepare(`
    INSERT INTO openapi_specs (id, base_url, found, spec_url, title, version, schemas_json, discovered_at, updated_at)
    VALUES (@id, @base_url, @found, @spec_url, @title, @version, @schemas_json, @discovered_at, @updated_at)
    ON CONFLICT(base_url) DO UPDATE SET found = @found, spec_url = @spec_url, title = @title, version = @version, schemas_json = @schemas_json, updated_at = @updated_at
  `).run(row);
  return row;
}

function resolveRef(root: any, ref: string): any {
  if (typeof ref !== "string" || !ref.startsWith("#/")) return null;
  const parts = ref.slice(2).split("/");
  let node = root;
  for (const part of parts) {
    if (node == null) return null;
    node = node[part];
  }
  return node ?? null;
}

/** Converts a bounded subset of JSON-Schema/OpenAPI/Swagger schema syntax into apiSchemaService's ShapeNode. Returns null for anything unsupported (oneOf/anyOf/allOf, unresolvable $ref, unrecognized type) rather than guessing. */
function jsonSchemaToShape(root: any, schema: any, depth = 0): ShapeNode | null {
  if (!schema || typeof schema !== "object" || depth > OPENAPI_CONTRACT_CONFIG.maxRefDepth) return null;

  if (typeof schema.$ref === "string") {
    return jsonSchemaToShape(root, resolveRef(root, schema.$ref), depth + 1);
  }

  let type = schema.type;
  let nullable = schema.nullable === true;
  if (Array.isArray(type)) {
    // JSON-Schema/OpenAPI 3.1 style: type: ["string", "null"]
    nullable = nullable || type.includes("null");
    type = type.find((t: string) => t !== "null");
  }

  if (type === "object" || (schema.properties && !type)) {
    const fields: Record<string, ShapeNode> = {};
    const required: string[] = Array.isArray(schema.required) ? schema.required : [];
    for (const [key, propSchema] of Object.entries(schema.properties || {})) {
      const shape = jsonSchemaToShape(root, propSchema, depth + 1);
      if (shape) fields[key] = shape;
    }
    const optionalFields = Object.keys(fields).filter((k) => !required.includes(k));
    return { kind: "object", fields, optionalFields };
  }
  if (type === "array") {
    return { kind: "array", item: jsonSchemaToShape(root, schema.items, depth + 1) };
  }
  if (type === "string" || type === "number" || type === "integer" || type === "boolean") {
    return { kind: "primitive", types: [type === "integer" ? "number" : type], nullable };
  }
  return null; // oneOf/anyOf/allOf/const/unrecognized -- not modeled, skip honestly
}

function extractSuccessResponseSchema(operation: any): any {
  const responses = operation?.responses;
  if (!responses || typeof responses !== "object") return undefined;
  const successKey = Object.keys(responses).find((k) => /^2/.test(k)) ?? (responses.default ? "default" : undefined);
  if (!successKey) return undefined;
  const response = responses[successKey];
  // OpenAPI 3.x
  const oas3Schema = response?.content?.["application/json"]?.schema;
  if (oas3Schema) return oas3Schema;
  // Swagger 2.0
  return response?.schema;
}

export function parseOpenApiContractSchemas(raw: string): { title: string; version: string; schemas: Record<string, ShapeNode> } {
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    try {
      parsed = parseYaml(raw);
    } catch {
      throw new Error("Invalid OpenAPI/Swagger document: expected valid JSON or YAML.");
    }
  }
  if (!parsed || typeof parsed !== "object" || !parsed.paths) {
    throw new Error("Invalid OpenAPI/Swagger document: no paths found.");
  }

  const title = parsed.info?.title || "Unnamed API";
  const version = parsed.info?.version || parsed.openapi || parsed.swagger || "unknown";
  const schemas: Record<string, ShapeNode> = {};

  for (const [pathTemplate, methods] of Object.entries<any>(parsed.paths)) {
    if (!methods || typeof methods !== "object") continue;
    for (const [method, operation] of Object.entries<any>(methods)) {
      if (!["get", "post", "put", "patch", "delete"].includes(method.toLowerCase())) continue;
      const responseSchema = extractSuccessResponseSchema(operation);
      if (!responseSchema) continue;
      const shape = jsonSchemaToShape(parsed, responseSchema);
      if (shape) schemas[`${method.toUpperCase()} ${pathTemplate}`] = shape;
    }
  }

  return { title, version, schemas };
}

function pathTemplateToRegex(template: string): RegExp {
  const escaped = template.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\{[^}]+\\\}/g, "[^/]+");
  return new RegExp(`^${escaped}$`);
}

function matchEndpointToSpec(schemas: Record<string, ShapeNode>, method: string, actualPath: string): { specKey: string; shape: ShapeNode } | null {
  for (const [key, shape] of Object.entries(schemas)) {
    const spaceIndex = key.indexOf(" ");
    const specMethod = key.slice(0, spaceIndex);
    const specPathTemplate = key.slice(spaceIndex + 1);
    if (specMethod !== method) continue;
    if (pathTemplateToRegex(specPathTemplate).test(actualPath)) return { specKey: key, shape };
  }
  return null;
}

/**
 * Probes the well-known spec paths for `baseUrl`'s origin, ONCE per origin
 * (cached in openapi_specs, including a cached "not found" result) rather
 * than on every captured API response. Never throws -- a failed probe/parse
 * is cached as found=false, same as a genuinely spec-less origin.
 */
export async function discoverAndCacheOpenApiSpec(baseUrl: string): Promise<OpenApiSpecRow> {
  const origin = originOf(baseUrl);
  const existing = getOpenApiSpecForOrigin(origin);
  if (existing) return existing;

  for (const path of OPENAPI_CONTRACT_CONFIG.wellKnownSpecPaths) {
    const specUrl = `${origin}${path}`;
    try {
      const res = await fetch(specUrl, { signal: AbortSignal.timeout(OPENAPI_CONTRACT_CONFIG.probeTimeoutMs) });
      if (!res.ok) continue;
      const raw = await res.text();
      const { title, version, schemas } = parseOpenApiContractSchemas(raw);
      if (Object.keys(schemas).length === 0) continue; // parsed but nothing usable -- keep probing
      return saveOpenApiSpec({ origin, found: true, specUrl, title, version, schemas });
    } catch {
      continue; // this candidate path failed/wasn't a valid spec -- try the next one
    }
  }
  return saveOpenApiSpec({ origin, found: false, specUrl: null, title: null, version: null, schemas: {} });
}

/**
 * Diffs a captured response body against the cached OpenAPI contract for
 * `baseUrl`'s origin, if one was discovered and it covers this method+path.
 * Returns [] (no findings) when there's no spec, no matching operation, or
 * no modelable response schema for it -- this is a supplementary check, not
 * a replacement for apiSchemaService's self-inferred baseline diff.
 */
export function checkAgainstOpenApiContract(input: { baseUrl: string; method: string; path: string; body: unknown; screenId?: string | null; runId?: string | null }): BugFindingRow[] {
  const specRow = getOpenApiSpecForOrigin(input.baseUrl);
  if (!specRow?.found) return [];
  if (input.body === null || input.body === undefined) return [];

  let schemas: Record<string, ShapeNode>;
  try {
    schemas = JSON.parse(specRow.schemas_json);
  } catch {
    return [];
  }
  const match = matchEndpointToSpec(schemas, input.method, input.path);
  if (!match) return [];

  const actualShape = inferShape(input.body);
  const issues: SchemaDiffIssue[] = diffShape(match.shape, actualShape).slice(0, OPENAPI_CONTRACT_CONFIG.maxDiffIssuesPerResponse);

  const endpointKey = `${input.method} ${input.path}`;
  return issues.map((issue) =>
    recordBugFinding({
      source: "api_fuzz",
      category: "api-schema",
      severity: issue.severity,
      title: `OpenAPI contract violation on ${endpointKey}: ${issue.kind.replace(/_/g, " ")} at ${issue.path}`,
      detail: `${issue.message} (checked against the published OpenAPI/Swagger contract at ${specRow.spec_url}, matched operation ${match.specKey})`,
      screenId: input.screenId ?? null,
      runId: input.runId ?? null,
      evidence: { endpointKey, contractSource: "openapi", specUrl: specRow.spec_url, matchedOperation: match.specKey, ...issue },
      stepsToReproduce: [
        `Call ${endpointKey}`,
        `Inspect the response body at ${issue.path}`,
        `Compare against the published contract at ${specRow.spec_url} (operation ${match.specKey})`,
        `Observe: ${issue.message}`,
      ],
    })
  );
}
