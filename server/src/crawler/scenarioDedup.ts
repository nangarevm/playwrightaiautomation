import type { ScenarioRecord } from "./types.js";

// Stable fingerprint for scenario deduplication across pages, re-crawls, and
// test-case generation. Two scenarios with the same type, flow group, title,
// and step sequence are treated as duplicates even if they were assigned new ids.
export function scenarioFingerprint(scenario: {
  title: string;
  flowGroup: string;
  type: string;
  steps: string[];
}): string {
  const title = scenario.title.toLowerCase().replace(/\s+/g, " ").trim();
  const group = scenario.flowGroup.toLowerCase().replace(/\s+/g, " ").trim();
  const steps = scenario.steps.map((s) => s.toLowerCase().replace(/\s+/g, " ").trim()).join("||");
  return `${scenario.type}::${group}::${title}::${steps}`;
}

export function dedupeScenarios<T extends ScenarioRecord>(scenarios: T[]): T[] {
  const seen = new Set<string>();
  const unique: T[] = [];
  for (const scenario of scenarios) {
    const fp = scenarioFingerprint(scenario);
    if (seen.has(fp)) continue;
    seen.add(fp);
    unique.push(scenario);
  }
  return unique;
}

function tokenSet(text: string): Set<string> {
  return new Set(text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

// Catches near-duplicate generic scenarios like "Verify X loads successfully"
// vs "Verify Y loads successfully" when steps are effectively the same template.
export function isNearDuplicateScenario(a: ScenarioRecord, b: ScenarioRecord, threshold = 0.82): boolean {
  if (scenarioFingerprint(a) === scenarioFingerprint(b)) return true;
  const aTokens = tokenSet(`${a.title} ${a.steps.join(" ")}`);
  const bTokens = tokenSet(`${b.title} ${b.steps.join(" ")}`);
  return jaccard(aTokens, bTokens) >= threshold;
}

export function dedupeScenariosFuzzy<T extends ScenarioRecord>(scenarios: T[]): T[] {
  const unique: T[] = [];
  for (const candidate of scenarios) {
    if (unique.some((existing) => isNearDuplicateScenario(existing, candidate))) continue;
    unique.push(candidate);
  }
  return unique;
}
