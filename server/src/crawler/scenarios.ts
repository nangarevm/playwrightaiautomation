// Phase 3: scenario/test-case generation from captured page structure.
//
// Goal: maximum reviewable coverage per input the crawler discovers, not just
// one scenario per form. Every form gets: a positive submission, an empty-form
// negative, one negative PER individually-required field (catches field-
// specific validation bugs a single "leave everything empty" case can't),
// one invalid-format negative PER format-typed field (email/number/tel/url),
// a whitespace-only negative when required text fields exist, a toggle
// scenario per checkbox, and a selection-change scenario per dropdown. Pages
// with no form get a scenario per standalone interactive element (links,
// buttons) instead of a single generic "page loads" placeholder, so nav-heavy
// pages are covered too. Each category is capped to keep a single page's
// scenario count sane rather than combinatorial.
//
// Titles follow the "Verify <outcome> when/that <condition>" convention a
// human QA engineer actually writes (the same pattern already used by the
// hand-written login examples in mockProvider.ts), rather than mechanically
// concatenating flowGroup + field name + a fixed phrase -- so a reviewer
// scanning the list sees test cases that read like a colleague wrote them,
// not a template dump. Steps stay Given/When/Then (that's a real, common
// human BDD convention, not something to strip out), but are phrased as a
// QA engineer would narrate the action, not a mail-merge of the same clause.
//
// Scenarios carry the machine-readable locator list a later codegen step
// consumes, alongside the human-readable title/steps.

import { nanoid } from "nanoid";
import type { ElementRecord, NavEdge, ScenarioRecord } from "./types.js";

const MAX_PER_FIELD_CATEGORY = 6; // cap individual-field scenarios per form (required-empty, invalid-format)
const MAX_STANDALONE_ELEMENTS = 12; // cap per-element scenarios on a no-form page
const MAX_FILE_FIELDS = 3; // cap file-upload fields that get the full per-format scenario set

// Representative formats for each file-upload field discovered on the target
// app -- mirrors the input types this platform's own ingestion layer accepts
// (images, video, PDF, Excel), so a discovered upload control gets tested
// against the same breadth of formats a real user might actually attach.
const FILE_UPLOAD_FORMATS: Array<{ label: string; ext: string }> = [
  { label: "image", ext: "jpg/png" },
  { label: "video", ext: "mp4" },
  { label: "PDF", ext: "pdf" },
  { label: "Excel spreadsheet", ext: "xlsx" },
];

function article(word: string): string {
  return /^[aeiou]/i.test(word) ? "an" : "a";
}

function fillStepFor(field: ElementRecord): string {
  if (field.inputType === "file") return `attaches a valid file to "${field.label}"`;
  if (field.type === "checkbox") return `checks "${field.label}"`;
  if (field.type === "dropdown") return `selects a valid option in "${field.label}"`;
  return `fills in "${field.label}" with a valid value`;
}

function makeScenario(
  title: string,
  type: ScenarioRecord["type"],
  flowGroup: string,
  steps: string[],
  locatorSources: ElementRecord[],
  tier: ScenarioRecord["tier"] = "functional"
): ScenarioRecord {
  return {
    id: nanoid(10),
    title,
    type,
    tier,
    flowGroup,
    steps,
    locators: locatorSources.flatMap((e) => e.locators.slice(0, 1)),
  };
}

function buildFormScenarios(pageTitle: string, formElements: ElementRecord[]): ScenarioRecord[] {
  const inputs = formElements.filter((e) => ["input", "textarea", "dropdown", "checkbox"].includes(e.type));
  const submit = formElements.find((e) => e.type === "button");
  if (inputs.length === 0) return [];

  const flowGroup = formElements[0]?.component || pageTitle;
  const scenarios: ScenarioRecord[] = [];
  const submitStep = submit ? `And clicks "${submit.label}"` : "And submits the form";
  const submitLocator = submit ? [submit] : [];

  // 1. Positive: every field filled with a valid value (file fields get a
  // valid attachment, checkboxes get checked, dropdowns get a real selection
  // -- fillStepFor phrases each field appropriately for its actual type
  // rather than a one-size-fits-all "fills X with a valid value").
  scenarios.push(
    makeScenario(
      `Verify ${flowGroup} submits successfully with valid data`,
      "positive",
      flowGroup,
      [`Given the user is on "${pageTitle}"`, ...inputs.map((i) => `When the user ${fillStepFor(i)}`), submitStep, "Then the form is accepted and the expected success state is shown"],
      [...inputs, ...submitLocator],
      "smoke" // the one core "does this form work at all" happy path
    )
  );

  // 2. Negative: the whole form left empty. Always generated (doesn't depend on
  // the `required` attribute being present) so every form gets at least this
  // baseline negative case, even on sites that validate purely via JS.
  scenarios.push(
    makeScenario(
      `Verify ${flowGroup} shows a validation error when submitted empty`,
      "negative",
      flowGroup,
      [`Given the user is on "${pageTitle}"`, "When the user submits the form without entering any values", submitStep, "Then a validation error is shown and the form is not submitted"],
      [...inputs, ...submitLocator]
    )
  );

  // 3. Negative, one per required field: leave just THIS field empty, others
  // valid -- catches field-specific validation bugs a single combined case
  // can't (e.g. a required checkbox whose validation only the "all empty"
  // case happened to also fail for the wrong reason).
  const requiredInputs = inputs.filter((i) => i.required === true);
  for (const field of requiredInputs.slice(0, MAX_PER_FIELD_CATEGORY)) {
    const skipClause = field.inputType === "file" ? `doesn't attach a file to "${field.label}"` : `leaves "${field.label}" empty`;
    scenarios.push(
      makeScenario(
        `Verify ${flowGroup} shows a validation error when "${field.label}" is left empty`,
        "negative",
        flowGroup,
        [
          `Given the user is on "${pageTitle}"`,
          `When the user ${skipClause}, filling in every other field with a valid value`,
          submitStep,
          `Then a validation error is shown for "${field.label}" and the form is not submitted`,
        ],
        [field, ...submitLocator]
      )
    );
  }

  // 3b. Positive, one per genuinely optional field (has an accessible name,
  // not marked required): leaving it blank should still let the form submit
  // successfully. Distinct from the required case above -- same "one field
  // blank" shape, opposite expected outcome -- and it means a field with no
  // native `required` attribute (common on JS-validated forms) still gets
  // individual coverage instead of only ever appearing in "all fields empty".
  const optionalInputs = inputs.filter((i) => i.required !== true && i.type !== "checkbox" && i.type !== "dropdown");
  for (const field of optionalInputs.slice(0, MAX_PER_FIELD_CATEGORY)) {
    const skipClause = field.inputType === "file" ? `doesn't attach a file to "${field.label}"` : `leaves "${field.label}" blank`;
    scenarios.push(
      makeScenario(
        `Verify ${flowGroup} still submits successfully when "${field.label}" is left blank`,
        "positive",
        flowGroup,
        [
          `Given the user is on "${pageTitle}"`,
          `When the user ${skipClause}, filling in every other field with a valid value`,
          submitStep,
          "Then the form is still accepted since that field isn't required",
        ],
        [field, ...submitLocator]
      )
    );
  }

  // 3c. File-upload coverage: for each file-input field, one positive scenario
  // per representative format this platform's own ingestion layer supports
  // (image/video/PDF/Excel) plus one negative for an unsupported extension --
  // a discovered upload control gets tested against real format breadth
  // instead of one generic "valid value" case.
  const fileInputs = inputs.filter((i) => i.inputType === "file");
  for (const field of fileInputs.slice(0, MAX_FILE_FIELDS)) {
    for (const format of FILE_UPLOAD_FORMATS) {
      scenarios.push(
        makeScenario(
          `Verify ${article(format.label)} ${format.label} file can be uploaded to "${field.label}"`,
          "positive",
          flowGroup,
          [
            `Given the user is on "${pageTitle}"`,
            `When the user attaches a valid ${format.label} file (.${format.ext.split("/")[0]}) to "${field.label}"`,
            submitStep,
            "Then the file is accepted and uploads successfully",
          ],
          [field, ...submitLocator]
        )
      );
    }
    scenarios.push(
      makeScenario(
        `Verify ${flowGroup} rejects an unsupported file type in "${field.label}"`,
        "negative",
        flowGroup,
        [
          `Given the user is on "${pageTitle}"`,
          `When the user attaches a file with an unsupported extension (e.g. .exe) to "${field.label}"`,
          submitStep,
          "Then the upload is rejected with a clear file-type error",
        ],
        [field, ...submitLocator]
      )
    );
  }

  // 4. Negative, one per format-typed field: an invalid value in just that
  // field, everything else valid.
  const formatInputs = inputs.filter((i) => i.inputType && ["email", "number", "tel", "url"].includes(i.inputType));
  for (const field of formatInputs.slice(0, MAX_PER_FIELD_CATEGORY)) {
    scenarios.push(
      makeScenario(
        `Verify ${flowGroup} rejects an invalid ${field.inputType} in "${field.label}"`,
        "negative",
        flowGroup,
        [
          `Given the user is on "${pageTitle}"`,
          `When the user enters a value that isn't a valid ${field.inputType} into "${field.label}"`,
          submitStep,
          `Then a format-validation error is shown for "${field.label}" and the form is not submitted`,
        ],
        [field, ...submitLocator]
      )
    );
  }

  // 5. Negative: whitespace-only values in required text-like fields --
  // a common validation gap (native `required` is satisfied by a space).
  const requiredTextInputs = requiredInputs.filter((i) => (i.type === "input" || i.type === "textarea") && i.inputType !== "file");
  if (requiredTextInputs.length > 0) {
    scenarios.push(
      makeScenario(
        `Verify ${flowGroup} rejects whitespace-only input in required fields`,
        "negative",
        flowGroup,
        [
          `Given the user is on "${pageTitle}"`,
          `When the user enters only spaces into ${requiredTextInputs.map((i) => `"${i.label}"`).join(", ")}`,
          submitStep,
          "Then a validation error is shown and the form is not submitted",
        ],
        [...requiredTextInputs, ...submitLocator]
      )
    );
  }

  // 6. Checkbox toggle coverage.
  const checkboxes = inputs.filter((i) => i.type === "checkbox");
  for (const box of checkboxes.slice(0, MAX_PER_FIELD_CATEGORY)) {
    scenarios.push(
      makeScenario(
        `Verify "${box.label}" can be toggled on and off`,
        "positive",
        flowGroup,
        [`Given the user is on "${pageTitle}"`, `When the user toggles "${box.label}"`, "Then its checked state visibly reflects the toggle"],
        [box]
      )
    );
  }

  // 7. Dropdown selection-change coverage.
  const dropdowns = inputs.filter((i) => i.type === "dropdown");
  for (const dd of dropdowns.slice(0, MAX_PER_FIELD_CATEGORY)) {
    scenarios.push(
      makeScenario(
        `Verify a different option can be selected in "${dd.label}"`,
        "positive",
        flowGroup,
        [`Given the user is on "${pageTitle}"`, `When the user selects a different option in "${dd.label}"`, "Then the newly selected option is reflected in the field"],
        [dd]
      )
    );
  }

  return scenarios;
}

// Groups a page's flat element list into per-form buckets using the component
// name assigned during locator extraction (locators.ts's guessComponentName).
function groupByComponent(elements: ElementRecord[]): Map<string, ElementRecord[]> {
  const groups = new Map<string, ElementRecord[]>();
  for (const el of elements) {
    const key = el.component;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(el);
  }
  return groups;
}

export function buildScenariosForPage(pageTitle: string, elements: ElementRecord[], formCount: number): ScenarioRecord[] {
  const scenarios: ScenarioRecord[] = [];

  if (formCount > 0) {
    const groups = groupByComponent(elements);
    for (const [, groupElements] of groups) {
      const hasInput = groupElements.some((e) => ["input", "textarea", "dropdown"].includes(e.type));
      if (hasInput) scenarios.push(...buildFormScenarios(pageTitle, groupElements));
    }
  }

  if (scenarios.length === 0) {
    // No form on this page -- cover it by standalone interactive element
    // (links, buttons) instead of one placeholder "page loads" scenario, so
    // nav-heavy/link-only pages still get real, reviewable coverage.
    const standalone = elements.filter((e) => ["link", "button"].includes(e.type) && e.label);
    if (standalone.length > 0) {
      for (const el of standalone.slice(0, MAX_STANDALONE_ELEMENTS)) {
        scenarios.push(
          makeScenario(
            `Verify clicking "${el.label}" behaves as expected`,
            "positive",
            pageTitle,
            [`Given the user is on "${pageTitle}"`, `When the user clicks "${el.label}"`, "Then the expected navigation or response occurs"],
            [el],
            "smoke" // core navigation/key-action coverage on a form-less page
          )
        );
      }
    } else {
      scenarios.push(
        makeScenario(
          `Verify ${pageTitle} loads successfully`,
          "positive",
          pageTitle,
          [`Given the user navigates to "${pageTitle}"`, "Then the page loads and its key elements render"],
          elements.slice(0, 5),
          "smoke"
        )
      );
    }
  }

  return scenarios;
}

// FR-CRUD flow detection: a page whose elements look like list/create/edit/delete
// controls (heuristic on labels) gets an extra end-to-end CRUD flow scenario tying
// them together, per the brief's "detected CRUD patterns -> generate flow templates".
export function buildCrudFlowScenario(pageTitle: string, elements: ElementRecord[]): ScenarioRecord | null {
  const createEl = elements.find((e) => /\b(add|create|new)\b/i.test(e.label));
  const editEl = elements.find((e) => /\b(edit|update)\b/i.test(e.label));
  const deleteEl = elements.find((e) => /\b(delete|remove)\b/i.test(e.label));
  if (!createEl && !editEl && !deleteEl) return null;

  const steps: string[] = [`Given the user is on "${pageTitle}"`];
  const locators: string[] = [];
  if (createEl) {
    steps.push(`When the user clicks "${createEl.label}" to create a new item`);
    locators.push(...createEl.locators.slice(0, 1));
  }
  if (editEl) {
    steps.push(`And the user clicks "${editEl.label}" to edit the item`);
    locators.push(...editEl.locators.slice(0, 1));
  }
  if (deleteEl) {
    steps.push(`And the user clicks "${deleteEl.label}" to remove the item`);
    locators.push(...deleteEl.locators.slice(0, 1));
  }
  steps.push("Then each lifecycle action completes and the list view reflects the change");

  return {
    id: nanoid(10),
    title: `Verify the create/edit/delete lifecycle works on ${pageTitle}`,
    type: "flow",
    tier: "functional", // multi-step cross-component flow, not a single core happy path
    flowGroup: pageTitle,
    steps,
    locators,
  };
}

// Full-application-flow discovery: buildFormScenarios/buildCrudFlowScenario
// above both only ever look at ONE page's elements, so the crawler previously
// had no way to represent "login, then browse to a product, then checkout" --
// a journey spanning several distinct screens. This walks the navigation
// graph captured during discovery (discovery.ts's edges) and turns each
// meaningful entry->goal path into one multi-page flow scenario, which flows
// through the existing generateTestsFromScenarios pipeline into both a manual
// test case (its Given/When/And/Then steps) and an automation script, same as
// any other scenario -- no separate manual/automation logic needed.

const MAX_FLOW_SCENARIOS = 6; // cap so a large site doesn't flood review with journeys
const MAX_FLOW_DEPTH = 6; // longest journey (in pages) worth generating a single scenario for
const MIN_FLOW_DEPTH = 2; // a "flow" needs at least 2 hops to mean anything beyond a single page

// Pages whose title/URL suggests they're a journey's natural destination --
// a completed purchase, a submitted form, a finished signup. Journeys ending
// here are prioritized over journeys that just dead-end on an arbitrary leaf,
// since these are the ones that actually represent business value delivered.
const GOAL_PAGE_PATTERN = /\b(confirm(ation)?|success|complete(d)?|thank[- ]?you|receipt|order[- ]?placed|checkout[- ]?complete|done|finish(ed)?|summary)\b/i;

interface FlowPage {
  url: string;
  title: string;
  elements: ElementRecord[];
}

function verbFor(via: string): string {
  if (via === "navigation") return "navigates";
  return `clicks "${via}"`;
}

// Best-effort: find the element on `page` whose label matches the edge's `via`
// text, so the flow step carries a real locator a codegen step can click --
// falls back to the page's first button/link if no exact match (e.g. the edge
// came from an SPA route change with via = "navigation").
function locatorForHop(page: FlowPage, via: string): ElementRecord | null {
  const exact = page.elements.find((e) => e.label.trim().toLowerCase() === via.trim().toLowerCase());
  if (exact) return exact;
  return page.elements.find((e) => ["link", "button"].includes(e.type)) ?? null;
}

// Enumerates simple paths (no repeated pages) from `startUrl` through the
// graph, depth-first, stopping each branch either at MAX_FLOW_DEPTH or at a
// page with no further unvisited outgoing edges. Cycles (a nav bar link back
// to a page already in the current path) are pruned by the `visited` set
// rather than followed, so a journey never loops back on itself.
function enumeratePaths(startUrl: string, adjacency: Map<string, NavEdge[]>): Array<{ path: string[]; vias: string[] }> {
  const results: Array<{ path: string[]; vias: string[] }> = [];

  function dfs(current: string, path: string[], vias: string[], visited: Set<string>) {
    const outgoing = adjacency.get(current) ?? [];
    const unvisited = outgoing.filter((e) => !visited.has(e.to));

    if (path.length >= MIN_FLOW_DEPTH) {
      results.push({ path: [...path], vias: [...vias] });
    }
    if (path.length >= MAX_FLOW_DEPTH || unvisited.length === 0) return;

    for (const edge of unvisited) {
      visited.add(edge.to);
      dfs(edge.to, [...path, edge.to], [...vias, edge.via], visited);
      visited.delete(edge.to);
    }
  }

  dfs(startUrl, [startUrl], [], new Set([startUrl]));
  return results;
}

export function buildFlowScenariosForSite(
  startUrl: string,
  pages: FlowPage[],
  edges: NavEdge[]
): Array<{ scenario: ScenarioRecord; entryUrl: string }> {
  const pageByUrl = new Map(pages.map((p) => [p.url, p]));
  if (!pageByUrl.has(startUrl) || edges.length === 0) return [];

  const adjacency = new Map<string, NavEdge[]>();
  for (const edge of edges) {
    if (!pageByUrl.has(edge.to) || edge.to === edge.from) continue;
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, []);
    // One edge per distinct destination per source page -- a page can have many
    // links to the same URL (nav + footer + CTA); the first one found is as
    // good a step description as any of the others.
    const existing = adjacency.get(edge.from)!;
    if (!existing.some((e) => e.to === edge.to)) existing.push(edge);
  }

  const allPaths = enumeratePaths(startUrl, adjacency);
  if (allPaths.length === 0) return [];

  // Prefer longer journeys that end on a goal-shaped page, then longer
  // journeys generally, then dedupe destination pages so near-identical
  // "reaches X" paths of different lengths don't all get generated.
  const seenDestinations = new Set<string>();
  const ranked = allPaths
    .map((p) => {
      const destPage = pageByUrl.get(p.path[p.path.length - 1])!;
      const isGoal = GOAL_PAGE_PATTERN.test(destPage.title) || GOAL_PAGE_PATTERN.test(destPage.url);
      return { ...p, isGoal, destPage };
    })
    .sort((a, b) => (Number(b.isGoal) - Number(a.isGoal)) || (b.path.length - a.path.length));

  const selected: typeof ranked = [];
  for (const candidate of ranked) {
    if (selected.length >= MAX_FLOW_SCENARIOS) break;
    if (seenDestinations.has(candidate.destPage.url)) continue;
    seenDestinations.add(candidate.destPage.url);
    selected.push(candidate);
  }

  return selected.map(({ path, vias, destPage }) => {
    const pagesInPath = path.map((url) => pageByUrl.get(url)!);
    const titles = pagesInPath.map((p) => p.title);

    const steps: string[] = [`Given the user starts on "${titles[0]}"`];
    const locators: string[] = [];
    for (let i = 1; i < pagesInPath.length; i++) {
      const fromPage = pagesInPath[i - 1];
      const via = vias[i - 1];
      const hopLocator = locatorForHop(fromPage, via);
      if (hopLocator) locators.push(...hopLocator.locators.slice(0, 1));
      const connector = i === 1 ? "When" : "And";
      steps.push(`${connector} the user ${verbFor(via)} to reach "${titles[i]}"`);
    }
    steps.push(`Then the user successfully reaches "${titles[titles.length - 1]}" and the end-to-end flow completes`);

    const scenario: ScenarioRecord = {
      id: nanoid(10),
      title: `Verify the end-to-end flow from "${titles[0]}" to "${titles[titles.length - 1]}"`,
      type: "flow",
      tier: "functional", // multi-page journey, matches "multi-step flows... cross-page interactions"
      flowGroup: `Journey: ${titles.join(" → ")}`,
      steps,
      locators,
      entryUrl: startUrl,
    };
    return { scenario, entryUrl: startUrl };
  });
}
