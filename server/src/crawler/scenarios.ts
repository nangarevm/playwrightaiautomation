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
import { representativeInvalidValue, generateFieldCombinationMatrix } from "../services/fieldTypeInferenceService.js";

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
      "regression" // primary happy path -- regression suite (smoke is page-load only)
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
        "edge",
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
  // field, everything else valid. Phase 3a (fieldTypeInferenceService):
  // the step names a concrete, deterministic value to type -- "enters
  // 'not-an-email' into 'Email'" -- instead of the vague "a value that
  // isn't a valid email" this used to say, so the scenario is directly
  // reproducible without a human/automation having to invent a value.
  const formatInputs = inputs.filter((i) => i.inputType && ["email", "number", "tel", "url"].includes(i.inputType));
  for (const field of formatInputs.slice(0, MAX_PER_FIELD_CATEGORY)) {
    const invalidValue = representativeInvalidValue(field);
    scenarios.push(
      makeScenario(
        `Verify ${flowGroup} rejects an invalid ${field.inputType} in "${field.label}"`,
        "negative",
        flowGroup,
        [
          `Given the user is on "${pageTitle}"`,
          `When the user enters "${invalidValue}" into "${field.label}"`,
          submitStep,
          `Then a format-validation error is shown for "${field.label}" and the form is not submitted`,
        ],
        [field, ...submitLocator]
      )
    );
  }

  // 4b. Phase 3b (fieldTypeInferenceService): field-combination-matrix
  // edge cases -- TWO fields simultaneously wrong (one invalid, one empty),
  // everything else valid. Catches a validation bug the one-field-at-a-time
  // negatives above can't: a form that short-circuits on the first error and
  // never reports/handles the second (e.g. a submit handler that returns
  // early after the first failed field-level check).
  const combinations = generateFieldCombinationMatrix(inputs);
  for (const combo of combinations) {
    const invalidField = combo.states.find((s) => s.state === "invalid")!.field;
    const emptyField = combo.states.find((s) => s.state === "empty")!.field;
    const invalidValue = representativeInvalidValue(invalidField);
    scenarios.push(
      makeScenario(
        `Verify ${flowGroup} handles ${combo.label} (multi-field validation)`,
        "edge",
        flowGroup,
        [
          `Given the user is on "${pageTitle}"`,
          `When the user enters "${invalidValue}" into "${invalidField.label}"`,
          `And leaves "${emptyField.label}" empty`,
          submitStep,
          `Then validation errors are shown for both "${invalidField.label}" and "${emptyField.label}", and the form is not submitted`,
        ],
        [invalidField, emptyField, ...submitLocator]
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

  // 6. Checkbox toggle coverage (edge: state boundary).
  const checkboxes = inputs.filter((i) => i.type === "checkbox");
  for (const box of checkboxes.slice(0, MAX_PER_FIELD_CATEGORY)) {
    scenarios.push(
      makeScenario(
        `Verify "${box.label}" can be toggled on and off`,
        "edge",
        flowGroup,
        [`Given the user is on "${pageTitle}"`, `When the user toggles "${box.label}"`, "Then its checked state visibly reflects the toggle"],
        [box]
      )
    );
  }

  // 7. Dropdown selection-change coverage (edge: alternate option).
  const dropdowns = inputs.filter((i) => i.type === "dropdown");
  for (const dd of dropdowns.slice(0, MAX_PER_FIELD_CATEGORY)) {
    scenarios.push(
      makeScenario(
        `Verify a different option can be selected in "${dd.label}"`,
        "edge",
        flowGroup,
        [`Given the user is on "${pageTitle}"`, `When the user selects a different option in "${dd.label}"`, "Then the newly selected option is reflected in the field"],
        [dd]
      )
    );
  }

  // 8. Edge: oversized input in the first text-like field (boundary length).
  const textField = inputs.find((i) => (i.type === "input" || i.type === "textarea") && i.inputType !== "file");
  if (textField) {
    scenarios.push(
      makeScenario(
        `Verify ${flowGroup} handles an extremely long value in "${textField.label}"`,
        "edge",
        flowGroup,
        [
          `Given the user is on "${pageTitle}"`,
          `When the user pastes an extremely long string (1000+ characters) into "${textField.label}"`,
          submitStep,
          "Then the page remains stable (validation error or truncated input, not a crash)",
        ],
        [textField, ...submitLocator]
      )
    );
  }

  // 9. Edge: double-submit / rapid resubmit of the form.
  if (submit) {
    scenarios.push(
      makeScenario(
        `Verify ${flowGroup} handles a rapid double submit safely`,
        "edge",
        flowGroup,
        [
          `Given the user is on "${pageTitle}"`,
          ...inputs.slice(0, 3).map((i) => `When the user ${fillStepFor(i)}`),
          `And the user clicks "${submit.label}" twice in quick succession`,
          "Then the form does not create duplicate submissions or crash",
        ],
        [...inputs.slice(0, 3), submit]
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

function pageDisplayName(pageTitle: string, pageUrl?: string): string {
  if (!pageUrl) return pageTitle;
  try {
    const path = new URL(pageUrl).pathname.replace(/\/+$/, "") || "/";
    if (path !== "/" && !pageTitle.includes(path)) return `${pageTitle} (${path})`;
  } catch {
    /* keep title */
  }
  return pageTitle;
}

/** Every discovered page always gets smoke (load) + regression (still works) baselines. */
export function buildBaselineCoverageScenarios(pageTitle: string, elements: ElementRecord[], pageUrl?: string): ScenarioRecord[] {
  const label = pageDisplayName(pageTitle, pageUrl);
  return [
    makeScenario(
      `Verify ${label} loads successfully`,
      "positive",
      label,
      [`Given the user navigates to "${label}"`, "Then the page loads and its key elements render"],
      elements.slice(0, 5),
      "smoke"
    ),
    makeScenario(
      `Regression: verify ${label} still loads and renders key content`,
      "positive",
      label,
      [
        `Given the user navigates to "${label}"`,
        "When the page finishes loading",
        "Then key content is visible and the page is not blank or errored",
      ],
      elements.slice(0, 5),
      "regression"
    ),
  ];
}

/** Intra-page multi-step journey when the site has no cross-page nav edges yet. */
export function buildIntraPageFlowScenario(pageTitle: string, elements: ElementRecord[]): ScenarioRecord | null {
  const interactive = elements.filter((e) => ["link", "button", "input", "dropdown"].includes(e.type) && e.label);
  if (interactive.length < 2) return null;
  const steps = interactive.slice(0, 4);
  const narrated: string[] = [`Given the user starts on "${pageTitle}"`];
  steps.forEach((el, i) => {
    const connector = i === 0 ? "When" : "And";
    if (el.type === "input" || el.type === "dropdown") {
      narrated.push(`${connector} the user interacts with "${el.label}"`);
    } else {
      narrated.push(`${connector} the user clicks "${el.label}"`);
    }
  });
  narrated.push(`Then the user completes the in-page flow on "${pageTitle}" without errors`);
  return {
    id: nanoid(10),
    title: `Verify the in-page flow on "${pageTitle}"`,
    type: "flow",
    tier: "regression",
    flowGroup: `Flow: ${pageTitle}`,
    steps: narrated,
    locators: steps.flatMap((e) => e.locators.slice(0, 1)),
  };
}

/** Guaranteed negative + edge baselines for every discovered page (with or without forms). */
export function buildNegativeAndEdgeBaselines(pageTitle: string, elements: ElementRecord[], pageUrl?: string): ScenarioRecord[] {
  const scenarios: ScenarioRecord[] = [];
  const label = pageDisplayName(pageTitle, pageUrl);
  const inputs = elements.filter((e) => ["input", "textarea", "dropdown", "checkbox"].includes(e.type) && e.label);
  const buttons = elements.filter((e) => e.type === "button" && e.label);
  const links = elements.filter((e) => e.type === "link" && e.label);
  const textInputs = inputs.filter((i) => (i.type === "input" || i.type === "textarea") && i.inputType !== "file");

  // Negative: bad query string must not crash the page.
  scenarios.push(
    makeScenario(
      `Verify ${label} handles an invalid query parameter without crashing`,
      "negative",
      label,
      [
        `Given the user opens "${label}" with an invalid query parameter (e.g. ?id=<<<invalid>>>)`,
        "Then the page shows a controlled error or ignores the parameter — it does not white-screen or throw an uncaught exception",
      ],
      elements.slice(0, 3)
    )
  );

  // Edge: long hash / fragment should still render.
  scenarios.push(
    makeScenario(
      `Verify ${label} still renders with a long URL hash fragment`,
      "edge",
      label,
      [
        `Given the user navigates to "${label}" with a very long hash fragment`,
        "Then the page body still renders and key content remains visible",
      ],
      elements.slice(0, 3)
    )
  );

  // Negative: empty submit when a button exists but no form scenarios ran for this page
  // (form pages already get empty-submit negatives from buildFormScenarios).
  if (buttons.length > 0 && textInputs.length === 0) {
    scenarios.push(
      makeScenario(
        `Verify clicking "${buttons[0].label}" without prior input does not crash ${label}`,
        "negative",
        label,
        [
          `Given the user is on "${label}"`,
          `When the user clicks "${buttons[0].label}" without filling any fields`,
          "Then the page remains stable (validation, no-op, or safe navigation — not a crash)",
        ],
        [buttons[0]]
      )
    );
  }

  // Edge: oversized text in first text field even when not in a detected form group.
  if (textInputs.length > 0) {
    scenarios.push(
      makeScenario(
        `Verify ${label} remains stable with oversized input in "${textInputs[0].label}"`,
        "edge",
        label,
        [
          `Given the user is on "${label}"`,
          `When the user enters an extremely long string into "${textInputs[0].label}"`,
          "Then the UI stays responsive and does not crash",
        ],
        [textInputs[0]]
      )
    );
  }

  // Negative: special/script-like characters in first text field (XSS-ish input).
  if (textInputs.length > 0) {
    scenarios.push(
      makeScenario(
        `Verify ${label} safely handles script-like input in "${textInputs[0].label}"`,
        "negative",
        label,
        [
          `Given the user is on "${label}"`,
          `When the user enters script-like characters (<script>alert(1)</script>) into "${textInputs[0].label}"`,
          "Then the input is treated as plain text and no script executes",
        ],
        [textInputs[0]]
      )
    );
  }

  // Edge: browser back after following a link.
  if (links.length > 0) {
    scenarios.push(
      makeScenario(
        `Verify browser back works after clicking "${links[0].label}" on ${label}`,
        "edge",
        label,
        [
          `Given the user is on "${label}"`,
          `When the user clicks "${links[0].label}" and then uses the browser Back button`,
          `Then the user returns to "${label}" without errors`,
        ],
        [links[0]]
      )
    );
  }

  return scenarios;
}

export function buildScenariosForPage(pageTitle: string, elements: ElementRecord[], formCount: number, pageUrl?: string): ScenarioRecord[] {
  // Smoke page-load + regression health are required for every discovered page --
  // never skip them just because the page also has forms or clickable elements.
  const label = pageDisplayName(pageTitle, pageUrl);
  const scenarios: ScenarioRecord[] = [
    ...buildBaselineCoverageScenarios(pageTitle, elements, pageUrl),
    ...buildNegativeAndEdgeBaselines(pageTitle, elements, pageUrl),
  ];

  if (formCount > 0) {
    const groups = groupByComponent(elements);
    for (const [, groupElements] of groups) {
      const hasInput = groupElements.some((e) => ["input", "textarea", "dropdown"].includes(e.type));
      if (hasInput) scenarios.push(...buildFormScenarios(pageTitle, groupElements));
    }
  }

  // Nav/link coverage on every page (in addition to smoke/regression baselines).
  const standalone = elements.filter((e) => ["link", "button"].includes(e.type) && e.label);
  for (const el of standalone.slice(0, MAX_STANDALONE_ELEMENTS)) {
    scenarios.push(
      makeScenario(
        `Verify clicking "${el.label}" behaves as expected on ${label}`,
        "positive",
        label,
        [`Given the user is on "${label}"`, `When the user clicks "${el.label}"`, "Then the expected navigation or response occurs"],
        [el],
        "functional"
      )
    );
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

const MAX_FLOW_SCENARIOS = 20; // enough journeys so multi-page sites don't leave the flow slot thin
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
      tier: "regression", // core user journey -- part of the regression baseline
      flowGroup: `Journey: ${titles.join(" → ")}`,
      steps,
      locators,
      entryUrl: startUrl,
    };
    return { scenario, entryUrl: startUrl };
  });
}
