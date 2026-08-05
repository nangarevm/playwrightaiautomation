import { nanoid } from "nanoid";
import { db } from "../db.js";
import { llm } from "../llm/index.js";
import { GeneratedTestCase } from "../llm/types.js";
import { deriveTraceabilityContext, buildDiffSummary } from "./testCaseFeatures.js";
import { sanitizeForLlm } from "./safetyService.js";
import { generateTestCasesWithDegradedMode } from "./llmResilienceService.js";
import { withLlmGateway } from "./llmGatewayService.js";
import { tagTestCasesToScreen } from "./screensService.js";

export async function generateTestCasesForInput(inputId: string, inputText: string, businessRules?: string) {
  const traceability = deriveTraceabilityContext(inputText, { business_rules: businessRules });
  const rawPrompt = [inputText, businessRules ? `Business rules: ${businessRules}` : "", traceability.ticketIds.length || traceability.screenshots.length || traceability.endpoints.length ? `Traceability hints: tickets=${traceability.ticketIds.join(",") || "n/a"}; screenshots=${traceability.screenshots.join(",") || "n/a"}; endpoints=${traceability.endpoints.join(",") || "n/a"}` : ""].filter(Boolean).join("\n\n");

  // FR-9.2: sanitize before submission to any LLM provider, regardless of which one is configured
  const { sanitized: prompt, flagged } = sanitizeForLlm(rawPrompt);
  if (flagged) {
    db.prepare("UPDATE inputs SET generation_last_error = ? WHERE id = ?").run(
      "Prompt-injection patterns were detected and redacted from this input before submission.",
      inputId
    );
  }

  // FR-9.5/9.6/9.7: route through the LLM gateway for semantic caching, prompt
  // compression, and cost-aware model routing; FR-9.3/9.4 retry+failover happen
  // inside generateTestCasesWithDegradedMode, which the gateway's `run` wraps.
  // FR-9.6: capture whether prompt compression was applied to this generation call,
  // so every resulting test case can be tagged with its compressed/uncompressed origin.
  let wasCompressed = false;
  const cases = await withLlmGateway<GeneratedTestCase[]>(
    "test_case_generation",
    { inputId, provider: llm.name, prompt, onCompressionResolved: (v) => { wasCompressed = v; } },
    async (compressedPrompt) => {
      const { cases: result } = await generateTestCasesWithDegradedMode(inputId, compressedPrompt);
      return { result, outputText: JSON.stringify(result) };
    }
  );
  const now = new Date().toISOString();

  const insert = db.prepare(`
    INSERT INTO test_cases
      (id, input_id, title, category, steps, expected_result, confidence_score, source_rationale, status, authorship_type, version, priority, traceability_context, explanation, generated_with_compression, created_at, updated_at)
    VALUES (@id, @input_id, @title, @category, @steps, @expected_result, @confidence_score, @source_rationale, 'draft', 'ai', 1, @priority, @traceability_context, @explanation, @generated_with_compression, @created_at, @updated_at)
  `);

  const created = cases.map((c) => {
    const row = {
      id: nanoid(10),
      input_id: inputId,
      title: c.title,
      category: c.category,
      steps: JSON.stringify(c.steps),
      expected_result: c.expected_result,
      confidence_score: c.confidence_score,
      source_rationale: c.source_rationale,
      priority: c.priority ?? "Medium",
      traceability_context: JSON.stringify(traceability),
      explanation: `This ${c.category?.toLowerCase() ?? "test"} case focuses on the core behavior described in the input and aligns with the supplied business rules.`,
      generated_with_compression: wasCompressed ? 1 : 0,
      created_at: now,
      updated_at: now,
    };
    insert.run(row);
    return row;
  });

  // FR-2.14: tag every generated test case with the Screen its source input belongs
  // to, so both manual cases and (once generated) their scripts can be grouped/browsed by screen
  const linkedScreen = db.prepare("SELECT id FROM screens WHERE source_input_id = ? ORDER BY created_at ASC LIMIT 1").get(inputId) as any;
  if (linkedScreen) {
    tagTestCasesToScreen(created.map((c) => c.id), linkedScreen.id);
    // tagTestCasesToScreen only updates the DB row -- these in-memory objects were
    // built (and already returned to callers, pre-fix) before that UPDATE ran, so
    // without this the immediate generate-response looked untagged even though the
    // persisted row was correct. Keep the response honest.
    for (const row of created) (row as any).screen_id = linkedScreen.id;
  }

  return created;
}

// FR-2.6: regenerate an existing test case from its source input, versioning the result and
// returning a diff against the prior draft rather than silently replacing it.
export async function regenerateTestCase(testCaseId: string) {
  const existing = db.prepare("SELECT * FROM test_cases WHERE id = ?").get(testCaseId) as any;
  if (!existing) throw new Error("Test case not found");

  const input = db.prepare("SELECT * FROM inputs WHERE id = ?").get(existing.input_id) as any;
  if (!input) throw new Error("Source input not found");

  const traceabilityContext = existing.traceability_context ? JSON.parse(existing.traceability_context) : {};
  const rawPrompt = [
    input.content,
    traceabilityContext.businessRules ? `Business rules: ${traceabilityContext.businessRules}` : "",
    `Regenerate specifically the "${existing.title}" (${existing.category}) test case with a fresh take on its steps and expected result.`,
  ].filter(Boolean).join("\n\n");

  const { sanitized: prompt } = sanitizeForLlm(rawPrompt);
  let wasCompressed = false;
  const candidates = await withLlmGateway<GeneratedTestCase[]>(
    "test_case_generation",
    { inputId: existing.input_id, provider: llm.name, prompt, category: existing.category, onCompressionResolved: (v) => { wasCompressed = v; } },
    async (compressedPrompt) => {
      const { cases: result } = await generateTestCasesWithDegradedMode(existing.input_id, compressedPrompt);
      return { result, outputText: JSON.stringify(result) };
    }
  );
  const bestMatch = candidates.find((c) => c.category === existing.category) ?? candidates[0];
  if (!bestMatch) throw new Error("Regeneration produced no candidates");

  const before = {
    title: existing.title,
    category: existing.category,
    steps: JSON.parse(existing.steps),
    expected_result: existing.expected_result,
    priority: existing.priority ?? "Medium",
  };
  const after = {
    title: bestMatch.title,
    category: bestMatch.category,
    steps: bestMatch.steps,
    expected_result: bestMatch.expected_result,
    priority: bestMatch.priority ?? existing.priority ?? "Medium",
  };
  const diff = buildDiffSummary(before, after);

  const now = new Date().toISOString();
  db.prepare(`
    UPDATE test_cases SET
      title = @title, category = @category, steps = @steps, expected_result = @expected_result,
      confidence_score = @confidence_score, source_rationale = @source_rationale, priority = @priority,
      status = 'draft', authorship_type = 'ai', version = @version, explanation = @explanation,
      generated_with_compression = @generated_with_compression, updated_at = @updated_at
    WHERE id = @id
  `).run({
    id: testCaseId,
    title: after.title,
    category: after.category,
    steps: JSON.stringify(after.steps),
    expected_result: after.expected_result,
    confidence_score: bestMatch.confidence_score,
    source_rationale: bestMatch.source_rationale,
    priority: after.priority,
    version: existing.version + 1,
    explanation: `Regenerated: this ${after.category?.toLowerCase()} case focuses on the core behavior described in the input.`,
    generated_with_compression: wasCompressed ? 1 : 0,
    updated_at: now,
  });

  const updated = db.prepare("SELECT * FROM test_cases WHERE id = ?").get(testCaseId) as any;
  return { ...updated, steps: JSON.parse(updated.steps), diff };
}
