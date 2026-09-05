// Phase 3b -- State-transition testing (master prompt #10, entirely net-new).
// A declarative flow is an ordered action list plus "invariants" -- assertions
// that must hold true at specific points in that sequence (e.g. "after
// delete + refresh, this record must no longer be visible"). Kept as data
// (state_transition_flows/state_transition_runs, see db.ts), the same
// reasoning as uiApiConsistencyService's declarative rules: reliably auto-
// inferring which button "deletes a record" vs. "opens a form" on an
// arbitrary crawled site is not a solvable heuristic in general, so a human
// or an integration that already has the concrete selectors names the flow
// once via defineFlow() or one of the named template builders below, then
// runFlow() re-executes and re-checks it automatically on demand.
//
// Findings are recorded with category 'functional' (a state-transition bug
// is a *kind* of functional/regression defect, not a new top-level category,
// per IMPLEMENTATION_PLAN.md), evidence: { violatedInvariant, stepIndex }.
//
// FALSE-POSITIVE RISK: a flow's steps/invariants are only as good as the
// selectors a human/integration provided -- a stale selector (the app's
// markup changed) will make a step fail or an invariant read the wrong
// element, which reads as "the app broke" when actually the flow definition
// is stale. There's no way to auto-detect that distinction from inside this
// service; a flow that starts failing after an unrelated UI change should be
// reviewed (edit via defineFlow, or deleteFlow) before its failures are
// trusted, the same way a human would re-check a suddenly-failing automation
// script's own locators before assuming the product regressed.

import { chromium, type Page } from "playwright";
import { nanoid } from "nanoid";
import { db } from "../db.js";
import { recordBugFinding, type BugFindingRow } from "./bugDetectionService.js";

export type StateTransitionStep =
  | { action: "navigate"; url: string }
  | { action: "click"; selector: string }
  | { action: "fill"; selector: string; value: string }
  | { action: "press"; key: string }
  | { action: "refresh" }
  | { action: "back" }
  | { action: "forward" }
  | { action: "clear_cookies" }
  | { action: "wait"; ms: number };

export type StateTransitionInvariant =
  | { afterStep: number; type: "not_visible"; selector: string; message: string }
  | { afterStep: number; type: "visible"; selector: string; message: string }
  | { afterStep: number; type: "count_equals"; selector: string; count: number; message: string }
  | { afterStep: number; type: "text_contains"; selector: string; text: string; message: string }
  | { afterStep: number; type: "text_not_contains"; selector: string; text: string; message: string }
  | { afterStep: number; type: "text_equals"; selector: string; text: string; message: string };

export interface StateTransitionFlowRow {
  id: string;
  screen_id: string | null;
  name: string;
  steps_json: string;
  invariants_json: string;
  created_at: string;
}

export interface StateTransitionRunRow {
  id: string;
  flow_id: string;
  status: "passed" | "failed";
  violated_invariants_json: string | null;
  created_at: string;
}

export function defineFlow(input: { name: string; steps: StateTransitionStep[]; invariants: StateTransitionInvariant[]; screenId?: string | null }): StateTransitionFlowRow {
  if (!input.steps.length) throw new Error("A flow needs at least one step.");
  if (!input.invariants.length) throw new Error("A flow needs at least one invariant, or there's nothing to check.");
  for (const inv of input.invariants) {
    if (inv.afterStep < 0 || inv.afterStep >= input.steps.length) {
      throw new Error(`Invariant afterStep (${inv.afterStep}) must be a valid index into steps (0-${input.steps.length - 1}).`);
    }
  }
  const row: StateTransitionFlowRow = {
    id: nanoid(10),
    screen_id: input.screenId ?? null,
    name: input.name,
    steps_json: JSON.stringify(input.steps),
    invariants_json: JSON.stringify(input.invariants),
    created_at: new Date().toISOString(),
  };
  db.prepare(
    "INSERT INTO state_transition_flows (id, screen_id, name, steps_json, invariants_json, created_at) VALUES (@id, @screen_id, @name, @steps_json, @invariants_json, @created_at)"
  ).run(row);
  return row;
}

export function getFlow(id: string): StateTransitionFlowRow | undefined {
  return db.prepare("SELECT * FROM state_transition_flows WHERE id = ?").get(id) as StateTransitionFlowRow | undefined;
}

export function listFlows(screenId?: string): StateTransitionFlowRow[] {
  if (screenId) return db.prepare("SELECT * FROM state_transition_flows WHERE screen_id = ? ORDER BY created_at DESC").all(screenId) as StateTransitionFlowRow[];
  return db.prepare("SELECT * FROM state_transition_flows ORDER BY created_at DESC").all() as StateTransitionFlowRow[];
}

export function deleteFlow(id: string): void {
  db.prepare("DELETE FROM state_transition_runs WHERE flow_id = ?").run(id);
  db.prepare("DELETE FROM state_transition_flows WHERE id = ?").run(id);
}

export function listRunsForFlow(flowId: string): StateTransitionRunRow[] {
  return db.prepare("SELECT * FROM state_transition_runs WHERE flow_id = ? ORDER BY created_at DESC").all(flowId) as StateTransitionRunRow[];
}

function describeStep(step: StateTransitionStep, index: number): string {
  switch (step.action) {
    case "navigate":
      return `Step ${index + 1}: navigate to ${step.url}`;
    case "click":
      return `Step ${index + 1}: click "${step.selector}"`;
    case "fill":
      return `Step ${index + 1}: enter "${step.value}" into "${step.selector}"`;
    case "press":
      return `Step ${index + 1}: press "${step.key}"`;
    case "refresh":
      return `Step ${index + 1}: refresh the page`;
    case "back":
      return `Step ${index + 1}: navigate back`;
    case "forward":
      return `Step ${index + 1}: navigate forward`;
    case "clear_cookies":
      return `Step ${index + 1}: clear cookies (simulate session expiry)`;
    case "wait":
      return `Step ${index + 1}: wait ${step.ms}ms`;
  }
}

async function executeStep(page: Page, step: StateTransitionStep): Promise<void> {
  switch (step.action) {
    case "navigate":
      await page.goto(step.url, { waitUntil: "domcontentloaded", timeout: 30000 });
      return;
    case "click":
      await page.locator(step.selector).first().click({ timeout: 10000 });
      return;
    case "fill":
      await page.locator(step.selector).first().fill(step.value, { timeout: 10000 });
      return;
    case "press":
      await page.keyboard.press(step.key);
      return;
    case "refresh":
      await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
      return;
    case "back":
      await page.goBack({ waitUntil: "domcontentloaded", timeout: 30000 });
      return;
    case "forward":
      await page.goForward({ waitUntil: "domcontentloaded", timeout: 30000 });
      return;
    case "clear_cookies":
      await page.context().clearCookies();
      return;
    case "wait":
      await page.waitForTimeout(step.ms);
      return;
  }
}

async function checkInvariant(page: Page, invariant: StateTransitionInvariant): Promise<boolean> {
  switch (invariant.type) {
    case "not_visible":
      return !(await page.locator(invariant.selector).first().isVisible().catch(() => false));
    case "visible":
      return await page.locator(invariant.selector).first().isVisible().catch(() => false);
    case "count_equals": {
      const count = await page.locator(invariant.selector).count().catch(() => -1);
      return count === invariant.count;
    }
    case "text_contains": {
      const text = await page.locator(invariant.selector).first().textContent().catch(() => null);
      return !!text && text.includes(invariant.text);
    }
    case "text_not_contains": {
      const text = await page.locator(invariant.selector).first().textContent().catch(() => null);
      return !text || !text.includes(invariant.text);
    }
    case "text_equals": {
      const text = await page.locator(invariant.selector).first().textContent().catch(() => null);
      return (text ?? "").trim() === invariant.text;
    }
  }
}

/**
 * Executes a defined flow's steps in order against a real browser, checking
 * every invariant due at its step, and recording a bug_findings row
 * (category 'functional') for each one that fails. Never throws on a step
 * execution failure (a stale selector, a timeout) -- that's recorded as the
 * run's own failed status with a synthetic violation entry, same as a real
 * invariant failure, since either way the flow didn't complete as expected.
 */
export async function runFlow(flowId: string, runId?: string): Promise<{ run: StateTransitionRunRow; findings: BugFindingRow[] }> {
  const flow = getFlow(flowId);
  if (!flow) throw new Error("State-transition flow not found.");
  const steps: StateTransitionStep[] = JSON.parse(flow.steps_json);
  const invariants: StateTransitionInvariant[] = JSON.parse(flow.invariants_json);

  const violated: Array<{ invariant: StateTransitionInvariant; reason: string }> = [];
  const browser = await chromium.launch({ headless: true, executablePath: process.env.SCAN_CHROMIUM_PATH || undefined });
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    for (let i = 0; i < steps.length; i++) {
      try {
        await executeStep(page, steps[i]);
      } catch (err: any) {
        // A step that can't execute at all means the flow can't continue
        // meaningfully -- report it as a violation of every invariant that
        // would have been checked at or after this step, then stop.
        for (const inv of invariants.filter((inv) => inv.afterStep >= i)) {
          violated.push({ invariant: inv, reason: `Step ${i + 1} (${steps[i].action}) failed to execute: ${err.message}` });
        }
        break;
      }
      for (const inv of invariants.filter((inv) => inv.afterStep === i)) {
        const ok = await checkInvariant(page, inv);
        if (!ok) violated.push({ invariant: inv, reason: inv.message });
      }
    }
  } finally {
    await context.close();
    await browser.close();
  }

  const now = new Date().toISOString();
  const runRow: StateTransitionRunRow = {
    id: nanoid(10),
    flow_id: flowId,
    status: violated.length > 0 ? "failed" : "passed",
    violated_invariants_json: JSON.stringify(violated),
    created_at: now,
  };
  db.prepare(
    "INSERT INTO state_transition_runs (id, flow_id, status, violated_invariants_json, created_at) VALUES (@id, @flow_id, @status, @violated_invariants_json, @created_at)"
  ).run(runRow);

  const stepDescriptions = steps.map(describeStep);
  const findings: BugFindingRow[] = [];
  for (const v of violated) {
    findings.push(
      recordBugFinding({
        source: "ui_exploratory",
        category: "functional",
        severity: "high",
        title: `State-transition invariant violated: ${flow.name}`,
        detail: v.reason,
        screenId: flow.screen_id,
        runId,
        evidence: { violatedInvariant: v.invariant, stepIndex: v.invariant.afterStep },
        stepsToReproduce: [...stepDescriptions, `Observe: ${v.reason}`],
      })
    );
  }

  return { run: runRow, findings };
}

// ---- Named template builders (master prompt #10's own worked list) ----
// Each takes concrete, caller-supplied selectors/values (the flow's own
// content is still data, per the doc comment above) and returns a ready
// {steps, invariants} pair, so a caller doesn't have to hand-assemble the
// step/invariant arrays for these five common patterns from scratch.

export function buildCreateEditDeleteRefreshTemplate(params: {
  url: string;
  createSelector: string;
  fillSelector: string;
  value: string;
  saveSelector: string;
  recordSelector: string;
  deleteSelector: string;
  confirmDeleteSelector?: string;
}): { steps: StateTransitionStep[]; invariants: StateTransitionInvariant[] } {
  const steps: StateTransitionStep[] = [
    { action: "navigate", url: params.url },
    { action: "click", selector: params.createSelector },
    { action: "fill", selector: params.fillSelector, value: params.value },
    { action: "click", selector: params.saveSelector },
    { action: "click", selector: params.deleteSelector },
    ...(params.confirmDeleteSelector ? ([{ action: "click", selector: params.confirmDeleteSelector }] as StateTransitionStep[]) : []),
    { action: "refresh" },
  ];
  const lastStep = steps.length - 1;
  return {
    steps,
    invariants: [
      {
        afterStep: lastStep,
        type: "not_visible",
        selector: params.recordSelector,
        message: `"${params.recordSelector}" is still visible after delete + refresh -- the delete didn't actually persist`,
      },
    ],
  };
}

export function buildDuplicateSubmitTemplate(params: {
  url: string;
  fillSelector: string;
  value: string;
  saveSelector: string;
  recordSelector: string;
}): { steps: StateTransitionStep[]; invariants: StateTransitionInvariant[] } {
  const steps: StateTransitionStep[] = [
    { action: "navigate", url: params.url },
    { action: "fill", selector: params.fillSelector, value: params.value },
    { action: "click", selector: params.saveSelector },
    { action: "click", selector: params.saveSelector }, // rapid duplicate submit
  ];
  return {
    steps,
    invariants: [
      {
        afterStep: 3,
        type: "count_equals",
        selector: params.recordSelector,
        count: 1,
        message: `Duplicate-submit created more than one "${params.recordSelector}" -- expected exactly 1 record from one logical submission`,
      },
    ],
  };
}

export function buildRapidClickTemplate(params: {
  url: string;
  clickSelector: string;
  counterSelector: string;
  expectedText: string;
  clicks?: number;
}): { steps: StateTransitionStep[]; invariants: StateTransitionInvariant[] } {
  const clicks = params.clicks ?? 5;
  const steps: StateTransitionStep[] = [
    { action: "navigate", url: params.url },
    ...Array.from({ length: clicks }, () => ({ action: "click", selector: params.clickSelector }) as StateTransitionStep),
  ];
  return {
    steps,
    invariants: [
      {
        afterStep: steps.length - 1,
        type: "text_equals",
        selector: params.counterSelector,
        text: params.expectedText,
        message: `After ${clicks} rapid clicks on "${params.clickSelector}", "${params.counterSelector}" reads something other than "${params.expectedText}" -- a debounce/idempotency bug likely double-counted the action`,
      },
    ],
  };
}

export function buildBackForwardAfterMutationTemplate(params: {
  url: string;
  deleteSelector: string;
  recordSelector: string;
}): { steps: StateTransitionStep[]; invariants: StateTransitionInvariant[] } {
  const steps: StateTransitionStep[] = [
    { action: "navigate", url: params.url },
    { action: "click", selector: params.deleteSelector },
    { action: "back" },
    { action: "forward" },
  ];
  return {
    steps,
    invariants: [
      {
        afterStep: 3,
        type: "not_visible",
        selector: params.recordSelector,
        message: `"${params.recordSelector}" reappears after back/forward navigation following a delete -- likely a stale cached/client-state bug`,
      },
    ],
  };
}

export function buildSessionExpiryMidFlowTemplate(params: {
  url: string;
  triggerSelector: string;
  loginIndicatorSelector: string;
}): { steps: StateTransitionStep[]; invariants: StateTransitionInvariant[] } {
  const steps: StateTransitionStep[] = [
    { action: "navigate", url: params.url },
    { action: "clear_cookies" },
    { action: "click", selector: params.triggerSelector },
  ];
  return {
    steps,
    invariants: [
      {
        afterStep: 2,
        type: "visible",
        selector: params.loginIndicatorSelector,
        message: `Expected a re-authentication prompt after session expiry, but "${params.loginIndicatorSelector}" is not visible -- the action may have silently succeeded or failed without redirecting to login`,
      },
    ],
  };
}
