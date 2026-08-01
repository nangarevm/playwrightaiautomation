import test from "node:test";
import assert from "node:assert/strict";
import { buildDiffSummary, buildExplanation, deriveTraceabilityContext } from "../src/services/testCaseFeatures.js";

test("deriveTraceabilityContext extracts ticket IDs, screenshots, and endpoints", () => {
  const context = deriveTraceabilityContext(
    "Ticket ABC-123 from screenshot login.png hits /api/login",
    { business_rules: "Approve only if the login flow is covered" }
  );

  assert.equal(context.ticketIds.includes("ABC-123"), true);
  assert.equal(context.screenshots.includes("login.png"), true);
  assert.equal(context.endpoints.includes("/api/login"), true);
  assert.equal(context.businessRules, "Approve only if the login flow is covered");
});

test("buildExplanation returns a plain-language rationale", () => {
  const explanation = buildExplanation({
    title: "Successful login with valid credentials",
    category: "Smoke",
    steps: ["Open login", "Enter credentials"],
    expected_result: "Dashboard opens",
  });

  assert.match(explanation, /Smoke/i);
  assert.match(explanation, /Dashboard opens/i);
});

test("buildDiffSummary reports changed fields", () => {
  const diff = buildDiffSummary({
    title: "Old title",
    category: "Smoke",
    steps: ["One"],
    expected_result: "Foo",
    priority: "Medium",
  }, {
    title: "New title",
    category: "Regression",
    steps: ["One", "Two"],
    expected_result: "Bar",
    priority: "High",
  });

  assert.equal(diff.title.changed, true);
  assert.equal(diff.category.changed, true);
  assert.equal(diff.steps.changed, true);
  assert.equal(diff.priority.changed, true);
});
