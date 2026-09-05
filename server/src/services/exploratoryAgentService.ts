// Phase 4c -- Exploratory AI agent (master prompt #16). The one component in
// this whole plan that takes autonomous actions beyond the existing
// deterministic crawl -- per the master prompt's own risk framing (and
// IMPLEMENTATION_PLAN.md's explicit sign-off note), it will click things no
// one explicitly asked it to click, even with a hard budget.
//
// Design, per the plan:
//   - Consumes a bounded budget (max_actions/max_depth, defaulted from
//     org_settings.exploration_default_* -- conservative: 20 actions, depth 3).
//   - One LLM call per decision point ("given this state and history, what's
//     the highest-value next action?"), routed through the existing
//     llmGatewayService.ts (semantic cache + cost-aware tiering already built).
//   - HARD budget/validity enforcement wraps every LLM decision: the actions-
//     taken counter and visited-state count are checked BEFORE consulting the
//     LLM, and the LLM's chosen actionId is validated against the actual
//     candidate list AFTER -- an invalid or "stop" answer, or a hallucinated
//     id, is always treated as "stop". The LLM is consulted, never trusted.
//   - Calls into EXISTING primitives rather than reimplementing browser
//     automation: crawler/interaction.ts's discoverPageInteractions() finds
//     candidate clickable elements (reusing its own DESTRUCTIVE_ACTION_PATTERN
//     filtering), and bugDetectionService.scanScreenForUiBugs() does the
//     actual bug detection at each new state reached.
//   - Read-only-by-default action selection (master prompt's own risk note):
//     only "button"/"link" elements are ever candidates -- no form-fill/
//     checkbox/dropdown interaction, so this cannot submit a form or mutate
//     data itself. Destructive-looking labels (delete/remove/logout/confirm-
//     payment/...) are excluded via the same pattern the crawler already uses.
//
// FALSE-POSITIVE / RISK NOTE: an autonomous agent clicking through a real app
// can trigger real side effects (a "like" button, a counter, a non-idempotent
// GET) that a human didn't explicitly ask for -- this is the accepted,
// documented cost of exploratory testing, not a bug in this service. Start
// with a conservative budget (the defaults) against a specifically
// designated test environment before relying on this against anything else.

import { chromium, type Page, type Locator } from "playwright";
import { nanoid } from "nanoid";
import { db } from "../db.js";
import { discoverPageInteractions } from "../crawler/interaction.js";
import { DESTRUCTIVE_ACTION_PATTERN, type ElementRecord } from "../crawler/types.js";
import { scanScreenForUiBugs, type BugFindingRow } from "./bugDetectionService.js";
import { withLlmGateway } from "./llmGatewayService.js";
import { llm } from "../llm/index.js";
import type { ExploratoryDecision } from "../llm/types.js";
import { getExplorationDefaultMaxActions, getExplorationDefaultMaxDepth } from "./adminService.js";

export const EXPLORATION_CONFIG = {
  maxCandidateActionsPerStep: 15,
  clickTimeoutMs: 8000,
  navigationSettleTimeoutMs: 8000,
};

export interface ExplorationSessionRow {
  id: string;
  site_id: string | null;
  start_url: string;
  status: "running" | "completed" | "budget_exhausted" | "stopped";
  actions_taken: number;
  max_actions: number;
  max_depth: number;
  visited_states_json: string;
  action_history_json: string;
  created_at: string;
  updated_at: string;
}

export function getExplorationSession(id: string): ExplorationSessionRow | undefined {
  return db.prepare("SELECT * FROM exploration_sessions WHERE id = ?").get(id) as ExplorationSessionRow | undefined;
}

export function listExplorationSessions(siteId?: string): ExplorationSessionRow[] {
  if (siteId) return db.prepare("SELECT * FROM exploration_sessions WHERE site_id = ? ORDER BY created_at DESC").all(siteId) as ExplorationSessionRow[];
  return db.prepare("SELECT * FROM exploration_sessions ORDER BY created_at DESC").all() as ExplorationSessionRow[];
}

function normalizeStateKey(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url;
  }
}

// A stable id for a candidate element within one session -- not persisted
// across sessions/crawls, just needs to round-trip through one LLM call.
function actionIdFor(el: ElementRecord): string {
  let hash = 0x811c9dc5;
  const input = `${el.type}:${el.label}:${el.locators[0] ?? ""}`;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

// ElementRecord.locators[] entries are full Playwright-expression strings
// built by crawler/locators.ts (e.g. `page.getByRole('link', { name: "Go to
// page B" })` or `page.locator("#foo")`) -- the SAME trusted, internally-
// generated strings codegenService.ts splices directly into real generated
// .spec.ts test files, never raw CSS selectors. Treating one as a literal
// CSS selector (i.e. `page.locator(theWholeExpressionString)`) silently
// fails to match anything; this evaluates the expression against the real
// `page` to get the actual Locator it describes, the same trust boundary
// codegen already relies on (these strings are built entirely by our own
// code with JSON.stringify-escaped arguments, not raw page content).
function resolveLocator(page: Page, locatorExpr: string): Locator {
  // eslint-disable-next-line no-new-func
  return new Function("page", `return (${locatorExpr});`)(page);
}

async function discoverCandidateActions(page: Page): Promise<ElementRecord[]> {
  const { elements } = await discoverPageInteractions(page, undefined, { shallow: true }).catch(() => ({ elements: [] as ElementRecord[], formCount: 0 }));
  return elements
    .filter((el) => (el.type === "button" || el.type === "link") && el.locators.length > 0 && !DESTRUCTIVE_ACTION_PATTERN.test(el.label))
    .slice(0, EXPLORATION_CONFIG.maxCandidateActionsPerStep);
}

/**
 * Runs one exploration session to completion (a bounded loop, not a single
 * step) against a real browser, persisting progress after every action so a
 * crash mid-session still leaves an inspectable partial record. Never trusts
 * the LLM's decision alone -- see the file-level doc comment for the exact
 * enforcement points.
 */
export async function runExplorationSession(params: {
  siteId?: string | null;
  startUrl: string;
  maxActions?: number;
  maxDepth?: number;
}): Promise<{ session: ExplorationSessionRow; findings: BugFindingRow[] }> {
  const maxActions = params.maxActions ?? getExplorationDefaultMaxActions();
  const maxDepth = params.maxDepth ?? getExplorationDefaultMaxDepth();
  if (!Number.isInteger(maxActions) || maxActions < 1) throw new Error("maxActions must be a positive integer");
  if (!Number.isInteger(maxDepth) || maxDepth < 1) throw new Error("maxDepth must be a positive integer");

  const sessionId = nanoid(10);
  const now = new Date().toISOString();
  const startStateKey = normalizeStateKey(params.startUrl);
  const visitedStates = new Set<string>([startStateKey]);
  const actionHistory: Array<{ actionId: string; description: string; url: string }> = [];
  const priorBugsSummary: string[] = [];
  const allFindings: BugFindingRow[] = [];

  db.prepare(`
    INSERT INTO exploration_sessions (id, site_id, start_url, status, actions_taken, max_actions, max_depth, visited_states_json, action_history_json, created_at, updated_at)
    VALUES (@id, @site_id, @start_url, 'running', 0, @max_actions, @max_depth, @visited_states_json, '[]', @created_at, @updated_at)
  `).run({
    id: sessionId,
    site_id: params.siteId ?? null,
    start_url: params.startUrl,
    max_actions: maxActions,
    max_depth: maxDepth,
    visited_states_json: JSON.stringify([startStateKey]),
    created_at: now,
    updated_at: now,
  });

  let status: ExplorationSessionRow["status"] = "running";
  const browser = await chromium.launch({ headless: true, executablePath: process.env.SCAN_CHROMIUM_PATH || undefined });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto(params.startUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => undefined);

    // eslint-disable-next-line no-constant-condition
    while (true) {
      // --- Hard budget checks, BEFORE consulting the LLM -- these decide
      // termination regardless of anything the LLM might suggest. ---
      if (actionHistory.length >= maxActions) {
        status = "budget_exhausted";
        break;
      }
      if (visitedStates.size >= maxDepth && !visitedStates.has(normalizeStateKey(page.url()))) {
        // Already at the state-count budget and this would be a new state --
        // stop rather than exceed it. (Landing back on an already-visited
        // state doesn't consume more depth budget.)
        status = "budget_exhausted";
        break;
      }

      const candidates = await discoverCandidateActions(page);
      if (candidates.length === 0) {
        status = "completed"; // nothing left to explore from here
        break;
      }
      const availableActions = candidates.map((el) => ({ id: actionIdFor(el), description: `click "${el.label}" (${el.type})` }));
      const alreadyTriedActionIds = actionHistory.map((a) => a.actionId);
      const actionsRemaining = maxActions - actionHistory.length;

      const decision = await withLlmGateway<ExploratoryDecision>(
        "exploratory_decision",
        {
          provider: llm.name,
          prompt: JSON.stringify({ url: page.url(), availableActions, alreadyTriedActionIds, priorBugsSummary, actionsRemaining }),
        },
        async (_preparedPrompt, tier) => {
          const result = await llm.decideNextExploratoryAction(
            { currentUrl: page.url(), availableActions, alreadyTriedActionIds, priorBugsSummary, actionsRemaining },
            { tier }
          );
          return { result, outputText: JSON.stringify(result) };
        }
      );

      // --- Validate the LLM's answer -- an invalid/hallucinated/"stop"
      // answer always means stop, regardless of the model's own confidence. ---
      const chosenAction = availableActions.find((a) => a.id === decision.actionId);
      if (!chosenAction || decision.actionId === "stop") {
        status = "completed";
        break;
      }
      const chosenElement = candidates.find((el) => actionIdFor(el) === chosenAction.id);
      if (!chosenElement) {
        status = "completed"; // shouldn't happen given the check above, but never trust it blindly
        break;
      }

      try {
        await resolveLocator(page, chosenElement.locators[0]).first().click({ timeout: EXPLORATION_CONFIG.clickTimeoutMs });
        await page.waitForLoadState("domcontentloaded", { timeout: EXPLORATION_CONFIG.navigationSettleTimeoutMs }).catch(() => undefined);
      } catch {
        // The action itself failed to execute (stale locator, timeout) --
        // still record it as tried so the agent doesn't retry the same
        // broken action next step, and continue exploring.
      }

      actionHistory.push({ actionId: chosenAction.id, description: chosenAction.description, url: page.url() });
      visitedStates.add(normalizeStateKey(page.url()));

      // Reuse the existing, already-tested bug-detection pipeline rather
      // than re-implementing console/network/DOM capture inside this loop.
      const stepFindings = await scanScreenForUiBugs(
        { id: `explore-${sessionId}`, name: `Exploration: ${page.url()}`, url_or_path: page.url() },
        undefined,
        null
      ).catch(() => [] as BugFindingRow[]);
      allFindings.push(...stepFindings);
      priorBugsSummary.push(...stepFindings.map((f) => f.title));

      db.prepare("UPDATE exploration_sessions SET actions_taken = ?, visited_states_json = ?, action_history_json = ?, updated_at = ? WHERE id = ?").run(
        actionHistory.length,
        JSON.stringify(Array.from(visitedStates)),
        JSON.stringify(actionHistory),
        new Date().toISOString(),
        sessionId
      );
    }
  } finally {
    await context.close();
    await browser.close();
  }

  db.prepare("UPDATE exploration_sessions SET status = ?, updated_at = ? WHERE id = ?").run(status, new Date().toISOString(), sessionId);
  const session = getExplorationSession(sessionId);
  if (!session) throw new Error("Exploration session vanished unexpectedly.");
  return { session, findings: allFindings };
}

export function stopExplorationSession(id: string): ExplorationSessionRow | undefined {
  db.prepare("UPDATE exploration_sessions SET status = 'stopped', updated_at = ? WHERE id = ? AND status = 'running'").run(new Date().toISOString(), id);
  return getExplorationSession(id);
}
