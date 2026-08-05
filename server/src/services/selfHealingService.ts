import { nanoid } from "nanoid";
import { db } from "../db.js";
import { logAudit, type CurrentUser } from "./adminService.js";

// FR-5.4: previously a hardcoded constant. Now a QA-Lead-editable org setting (persisted
// in org_settings, same pattern as FR-1.8's PII-redaction toggle) so a QA Lead can view/edit
// the self-heal high-confidence threshold without a code change. DEFAULT_HIGH_CONFIDENCE_THRESHOLD
// is only the seed/fallback value.
const DEFAULT_HIGH_CONFIDENCE_THRESHOLD = 0.8;

export function getSelfHealConfidenceThreshold(): number {
  const row = db.prepare("SELECT self_heal_confidence_threshold FROM org_settings WHERE id = 1").get() as
    | { self_heal_confidence_threshold: number }
    | undefined;
  return typeof row?.self_heal_confidence_threshold === "number" ? row.self_heal_confidence_threshold : DEFAULT_HIGH_CONFIDENCE_THRESHOLD;
}

export function setSelfHealConfidenceThreshold(threshold: number, updatedBy: CurrentUser | undefined) {
  if (typeof threshold !== "number" || Number.isNaN(threshold) || threshold < 0 || threshold > 1) {
    throw new Error("threshold must be a number between 0 and 1");
  }
  db.prepare("UPDATE org_settings SET self_heal_confidence_threshold = ? WHERE id = 1").run(threshold);
  logAudit(updatedBy, "self_heal_confidence_threshold_changed", "org_settings", "1", { threshold });
  return { selfHealConfidenceThreshold: getSelfHealConfidenceThreshold() };
}

function normalizeText(value: string | null | undefined) {
  return (value ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

function computeConfidenceScore(changeTypes: string[], uiBeforeHtml: string, uiAfterHtml: string, apiBeforeSpec: string, apiAfterSpec: string) {
  let score = 0.65;
  if (changeTypes.includes("ui")) score += 0.1;
  if (changeTypes.includes("api")) score += 0.1;

  const uiDiffRatio = diffRatio(uiBeforeHtml, uiAfterHtml);
  const apiDiffRatio = diffRatio(apiBeforeSpec, apiAfterSpec);
  score += Math.min(0.15, uiDiffRatio * 0.1);
  score += Math.min(0.15, apiDiffRatio * 0.1);

  return parseFloat(Math.min(0.99, score).toFixed(2));
}

function diffRatio(before: string, after: string) {
  if (!before && !after) return 0;
  if (!before || !after) return 1;
  const beforeTokens = new Set(normalizeText(before).split(/[^a-z0-9]+/).filter(Boolean));
  const afterTokens = new Set(normalizeText(after).split(/[^a-z0-9]+/).filter(Boolean));
  if (beforeTokens.size === 0 && afterTokens.size === 0) return 0;
  const overlap = [...beforeTokens].filter((token) => afterTokens.has(token)).length;
  return overlap / Math.max(beforeTokens.size, afterTokens.size, 1);
}

export function detectChangesForTestCase(input: {
  testCaseId: string;
  uiBeforeHtml: string;
  uiAfterHtml: string;
  apiBeforeSpec: string;
  apiAfterSpec: string;
  source?: string;
}) {
  const changeTypes: string[] = [];
  const uiChanged = normalizeText(input.uiBeforeHtml) !== normalizeText(input.uiAfterHtml);
  const apiChanged = normalizeText(input.apiBeforeSpec) !== normalizeText(input.apiAfterSpec);
  if (uiChanged) changeTypes.push("ui");
  if (apiChanged) changeTypes.push("api");

  const confidenceScore = computeConfidenceScore(changeTypes, input.uiBeforeHtml, input.uiAfterHtml, input.apiBeforeSpec, input.apiAfterSpec);
  const id = nanoid(10);
  const createdAt = new Date().toISOString();

  db.prepare(`
    INSERT INTO change_detections (id, test_case_id, change_types, confidence_score, detected_at, source, ui_before_html, ui_after_html, api_before_spec, api_after_spec)
    VALUES (@id, @test_case_id, @change_types, @confidence_score, @detected_at, @source, @ui_before_html, @ui_after_html, @api_before_spec, @api_after_spec)
  `).run({
    id,
    test_case_id: input.testCaseId,
    change_types: changeTypes.join(","),
    confidence_score: confidenceScore,
    detected_at: createdAt,
    source: input.source ?? "scheduled-crawl",
    ui_before_html: input.uiBeforeHtml,
    ui_after_html: input.uiAfterHtml,
    api_before_spec: input.apiBeforeSpec,
    api_after_spec: input.apiAfterSpec,
  });

  return {
    id,
    testCaseId: input.testCaseId,
    detected: changeTypes.length > 0,
    changeTypes,
    confidenceScore,
    detectedAt: createdAt,
  };
}

export function applySelfHealingForTestCase(input: {
  testCaseId: string;
  detectionId: string;
  beforeLocator: string;
  afterLocator: string;
  confidence: number;
  reason: string;
}) {
  const testCaseRow = db.prepare("SELECT * FROM test_cases WHERE id = ?").get(input.testCaseId) as any;
  if (!testCaseRow) {
    throw new Error("Test case not found");
  }

  // A test case generated via the default (no explicit framework) codegen path has
  // THREE automation_scripts rows -- TypeScript, JavaScript, Python -- all sharing
  // the same test_case_id. The previous implementation picked exactly one
  // (`ORDER BY created_at DESC LIMIT 1`), which on ties/insertion order could heal
  // an arbitrary sibling instead of (or in addition to) the one actually referenced
  // by the caller's before/after locator strings, silently leaving the other
  // scripts pointing at a now-broken locator while still reporting `applied: true`.
  // Fix: consider every script tied to this test case, and only ever mark a script
  // "healed" if beforeLocator was literally found and replaced in ITS code --
  // different language artifacts use different locator syntax (TS/JS:
  // getByLabel('X'), Python: get_by_label("X")), so not every sibling will match
  // the same literal string, and that's expected, not a bug to paper over.
  const scriptRows = db.prepare("SELECT * FROM automation_scripts WHERE test_case_id = ? ORDER BY created_at ASC").all(input.testCaseId) as any[];
  const matchingScripts = scriptRows.filter((s) => typeof s.code === "string" && s.code.includes(input.beforeLocator));

  const confidenceOk = input.confidence >= getSelfHealConfidenceThreshold();
  // "Applied" now means confidence cleared the bar AND at least one real script
  // actually got the locator swap -- previously this was true purely from the
  // confidence check, even when zero scripts contained the locator at all.
  const applied = confidenceOk && matchingScripts.length > 0;
  const now = new Date().toISOString();

  const beforeState = {
    testCase: {
      automation_sync_state: testCaseRow.automation_sync_state ?? "synced",
      needs_regeneration: Number(testCaseRow.needs_regeneration ?? 0),
    },
    scripts: scriptRows.map((s) => ({
      id: s.id,
      language: s.language,
      code: s.code ?? "",
      sync_state: s.sync_state ?? "synced",
      needs_regeneration: Number(s.needs_regeneration ?? 0),
    })),
  };

  db.prepare(`
    UPDATE test_cases
    SET automation_sync_state = @automation_sync_state, needs_regeneration = @needs_regeneration, updated_at = @updated_at
    WHERE id = @id
  `).run({
    id: input.testCaseId,
    automation_sync_state: applied ? `healed:${input.afterLocator}` : "needs-regeneration",
    needs_regeneration: applied ? 0 : 1,
    updated_at: now,
  });

  for (const script of scriptRows) {
    const isMatch = matchingScripts.some((m) => m.id === script.id);
    if (applied && isMatch) {
      // This script actually contained the stale locator and got fixed.
      db.prepare(`
        UPDATE automation_scripts
        SET code = @code, sync_state = @sync_state, needs_regeneration = 0
        WHERE id = @id
      `).run({
        id: script.id,
        code: (script.code ?? "").replaceAll(input.beforeLocator, input.afterLocator),
        sync_state: `healed:${input.afterLocator}`,
      });
    } else {
      // Either confidence was too low to auto-apply anything, or this specific
      // script (e.g. the Python artifact) never contained the literal locator
      // that changed -- either way it still needs a human/regeneration pass
      // rather than being left silently marked "original-state" as if fine.
      db.prepare(`
        UPDATE automation_scripts
        SET sync_state = @sync_state, needs_regeneration = 1
        WHERE id = @id
      `).run({
        id: script.id,
        sync_state: "needs-regeneration",
      });
    }
  }

  const afterState = {
    testCase: {
      automation_sync_state: applied ? `healed:${input.afterLocator}` : "needs-regeneration",
      needs_regeneration: applied ? 0 : 1,
    },
    scripts: scriptRows.map((s) => {
      const isMatch = matchingScripts.some((m) => m.id === s.id);
      return {
        id: s.id,
        language: s.language,
        code: applied && isMatch ? (s.code ?? "").replaceAll(input.beforeLocator, input.afterLocator) : (s.code ?? ""),
        sync_state: applied && isMatch ? `healed:${input.afterLocator}` : "needs-regeneration",
        needs_regeneration: applied && isMatch ? 0 : 1,
      };
    }),
  };

  const id = nanoid(10);
  db.prepare(`
    INSERT INTO auto_heal_actions (id, test_case_id, detection_id, before_state, after_state, confidence_score, applied, reason, created_at)
    VALUES (@id, @test_case_id, @detection_id, @before_state, @after_state, @confidence_score, @applied, @reason, @created_at)
  `).run({
    id,
    test_case_id: input.testCaseId,
    detection_id: input.detectionId,
    before_state: JSON.stringify(beforeState),
    after_state: JSON.stringify(afterState),
    confidence_score: input.confidence,
    applied: applied ? 1 : 0,
    reason: input.reason,
    created_at: now,
  });

  return {
    applied,
    regenerationRequired: !applied,
    healActionId: id,
    confidenceScore: input.confidence,
    scriptsHealed: applied ? matchingScripts.map((s) => s.id) : [],
    scriptsFlaggedForRegeneration: scriptRows.filter((s) => !(applied && matchingScripts.some((m) => m.id === s.id))).map((s) => s.id),
    beforeState,
    afterState,
  };
}

export function rollbackAutoHealAction(healActionId: string) {
  const actionRow = db.prepare("SELECT * FROM auto_heal_actions WHERE id = ?").get(healActionId) as any;
  if (!actionRow) {
    return { rolledBack: false, reason: "heal action not found" };
  }

  const beforeState = JSON.parse(actionRow.before_state ?? "{}") as {
    testCase?: { automation_sync_state?: string; needs_regeneration?: number };
    // Legacy shape (pre-fix records): a single script. Current shape: `scripts` array.
    script?: { code?: string; sync_state?: string; needs_regeneration?: number };
    scripts?: Array<{ id?: string; code?: string; sync_state?: string; needs_regeneration?: number }>;
  };

  const now = new Date().toISOString();
  db.prepare(`
    UPDATE test_cases
    SET automation_sync_state = @automation_sync_state, needs_regeneration = @needs_regeneration, updated_at = @updated_at
    WHERE id = @id
  `).run({
    id: actionRow.test_case_id,
    automation_sync_state: beforeState.testCase?.automation_sync_state ?? "synced",
    needs_regeneration: beforeState.testCase?.needs_regeneration ?? 0,
    updated_at: now,
  });

  // Restore every script this heal action touched, by id -- not just whichever
  // script currently sorts last by created_at (the same "picks an arbitrary
  // sibling" bug applySelfHealingForTestCase had). Older auto_heal_actions rows
  // recorded before this fix used a single `script` object instead of a
  // `scripts` array; normalize both shapes here so historical rows still roll
  // back correctly.
  const scriptsToRestore: Array<{ id?: string; code?: string; sync_state?: string; needs_regeneration?: number }> = beforeState.scripts ?? (beforeState.script ? [beforeState.script] : []);
  for (const scriptState of scriptsToRestore) {
    const scriptRow = scriptState.id
      ? (db.prepare("SELECT * FROM automation_scripts WHERE id = ?").get(scriptState.id) as any)
      // Prefer the runnable Playwright JS/TS artifact over a same-test-case
      // Python/Selenium/Cypress variant that happens to be more recently
      // inserted (see ultrafastService.ts's identical fix for why "most
      // recent" alone picks the wrong one).
      : (db
          .prepare(
            `SELECT * FROM automation_scripts WHERE test_case_id = ?
             ORDER BY (CASE WHEN framework = 'playwright' AND language IN ('typescript', 'javascript') THEN 0 ELSE 1 END), created_at DESC
             LIMIT 1`
          )
          .get(actionRow.test_case_id) as any);
    if (!scriptRow) continue;
    db.prepare(`
      UPDATE automation_scripts
      SET code = @code, sync_state = @sync_state, needs_regeneration = @needs_regeneration
      WHERE id = @id
    `).run({
      id: scriptRow.id,
      code: scriptState.code ?? scriptRow.code,
      sync_state: scriptState.sync_state ?? "synced",
      needs_regeneration: scriptState.needs_regeneration ?? 0,
    });
  }

  db.prepare(`
    UPDATE auto_heal_actions
    SET rolled_back = 1, rollback_at = @rollback_at
    WHERE id = @id
  `).run({ id: healActionId, rollback_at: now });

  return { rolledBack: true, healActionId };
}

export function listAutoHealActions(testCaseId: string) {
  return db.prepare("SELECT * FROM auto_heal_actions WHERE test_case_id = ? ORDER BY created_at DESC").all(testCaseId);
}
