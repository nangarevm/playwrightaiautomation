import { nanoid } from "nanoid";
import { db } from "../db.js";

const HIGH_CONFIDENCE_THRESHOLD = 0.8;

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
  const scriptRow = db.prepare("SELECT * FROM automation_scripts WHERE test_case_id = ? ORDER BY created_at DESC LIMIT 1").get(input.testCaseId) as any;
  if (!testCaseRow) {
    throw new Error("Test case not found");
  }

  const beforeState = {
    testCase: {
      automation_sync_state: testCaseRow.automation_sync_state ?? "synced",
      needs_regeneration: Number(testCaseRow.needs_regeneration ?? 0),
    },
    script: {
      code: scriptRow?.code ?? "",
      sync_state: scriptRow?.sync_state ?? "synced",
      needs_regeneration: Number(scriptRow?.needs_regeneration ?? 0),
    },
  };

  const applied = input.confidence >= HIGH_CONFIDENCE_THRESHOLD;
  const now = new Date().toISOString();

  if (applied && scriptRow) {
    const updatedCode = (scriptRow.code ?? "").replaceAll(input.beforeLocator, input.afterLocator);
    db.prepare(`
      UPDATE test_cases
      SET automation_sync_state = @automation_sync_state, needs_regeneration = @needs_regeneration, updated_at = @updated_at
      WHERE id = @id
    `).run({
      id: input.testCaseId,
      automation_sync_state: `healed:${input.afterLocator}`,
      needs_regeneration: 0,
      updated_at: now,
    });

    db.prepare(`
      UPDATE automation_scripts
      SET code = @code, sync_state = @sync_state, needs_regeneration = @needs_regeneration
      WHERE id = @id
    `).run({
      id: scriptRow.id,
      code: updatedCode,
      sync_state: `healed:${input.afterLocator}`,
      needs_regeneration: 0,
    });
  } else {
    db.prepare(`
      UPDATE test_cases
      SET automation_sync_state = @automation_sync_state, needs_regeneration = @needs_regeneration, updated_at = @updated_at
      WHERE id = @id
    `).run({
      id: input.testCaseId,
      automation_sync_state: "needs-regeneration",
      needs_regeneration: 1,
      updated_at: now,
    });

    if (scriptRow) {
      db.prepare(`
        UPDATE automation_scripts
        SET sync_state = @sync_state, needs_regeneration = @needs_regeneration
        WHERE id = @id
      `).run({
        id: scriptRow.id,
        sync_state: "needs-regeneration",
        needs_regeneration: 1,
      });
    }
  }

  const afterState = {
    testCase: {
      automation_sync_state: applied ? `healed:${input.afterLocator}` : "needs-regeneration",
      needs_regeneration: applied ? 0 : 1,
    },
    script: {
      code: applied && scriptRow ? (scriptRow.code ?? "").replaceAll(input.beforeLocator, input.afterLocator) : (scriptRow?.code ?? ""),
      sync_state: applied ? `healed:${input.afterLocator}` : "needs-regeneration",
      needs_regeneration: applied ? 0 : 1,
    },
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
    script?: { code?: string; sync_state?: string; needs_regeneration?: number };
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

  if (beforeState.script) {
    const scriptRow = db.prepare("SELECT * FROM automation_scripts WHERE test_case_id = ? ORDER BY created_at DESC LIMIT 1").get(actionRow.test_case_id) as any;
    if (scriptRow) {
      db.prepare(`
        UPDATE automation_scripts
        SET code = @code, sync_state = @sync_state, needs_regeneration = @needs_regeneration
        WHERE id = @id
      `).run({
        id: scriptRow.id,
        code: beforeState.script.code ?? scriptRow.code,
        sync_state: beforeState.script.sync_state ?? "synced",
        needs_regeneration: beforeState.script.needs_regeneration ?? 0,
      });
    }
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
