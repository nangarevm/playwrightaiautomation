# AI-Powered Test Automation Platform — Software Requirements Specification (SRS)

**Consolidated Functional Baseline — Pricing & Billing Model Pending**
**Version 4.6 | August 2026**

> This file supersedes SRS_v4.5.md for functional scope. Key addition in v4.6: **Section 12.10 — Execution Speed Modes (Ultrafast vs. Fast, single-user)**, and **FR4.24–FR4.30** in Module 4, plus MVP gate item #14 and acceptance criteria in Section 14.4.

## Definitions added in v4.6

- **Ultrafast Mode**: A single-user execution speed mode requiring no user interaction; auto-selects profile/environment, auto-accepts high-confidence test cases, and delivers the report directly on completion.
- **Fast Mode**: A single-user execution speed mode that retains user checkpoints (profile/environment confirmation, test-case review) before automation executes.

## FR4.24–FR4.30 (Module 4 — Execution Engine)

| ID | Requirement | Priority |
|---|---|---|
| FR4.24 | System shall support two selectable execution speed modes — Ultrafast and Fast — selectable per run or as an Execution Profile default, in addition to existing test-selection/browser/concurrency options | High |
| FR4.25 | In Ultrafast Mode, system shall skip the Execution Settings Panel, auto-select the default/last-used Execution Profile and Environment, and start the run immediately upon trigger, with no user interaction required | High |
| FR4.26 | In Ultrafast Mode, system shall auto-accept generated test cases whose confidence score (FR-2.7) meets or exceeds a configurable threshold, and shall route any case below threshold to a non-blocking "needs review later" queue rather than pausing the run | High |
| FR4.27 | In Ultrafast Mode, system shall generate and deliver the interactive HTML automation report (FR-6.11) directly to the user immediately on run completion, with no intermediate confirmation or publish step | High |
| FR4.28 | In Fast Mode, system shall require the user to confirm or edit the Execution Profile and Environment via the Execution Settings Panel before the run starts | High |
| FR4.29 | In Fast Mode, system shall require explicit accept/edit/reject on generated test cases (per FR-2.4) before automation code is executed | High |
| FR4.30 | System shall log every auto-decision made in Ultrafast Mode (profile/environment selection, auto-accept/reject, confidence threshold used) to the audit log (FR-8.3), preserving the same traceability as manually-reviewed actions | High — MVP gate |

## Data model changes (v4.6)

- `ExecutionRun.speed_mode`: `"ultrafast" | "fast"`
- `ExecutionProfile.default_speed_mode`: `"ultrafast" | "fast"`
- No new entities required.

## Section 12.10 — Execution Speed Modes — Ultrafast vs. Fast (Single-User)

**Purpose:** Give a single user a one-click way to trade off speed vs. control, without touching pricing, multi-user governance, or the underlying generation/execution engines already specified in Modules 2–4.

### Mode Comparison

| Aspect | Ultrafast Mode | Fast Mode |
|---|---|---|
| User interaction required | None — one click starts and ends the flow | Yes — checkpoints before run and before final report |
| Execution Profile | Auto-uses default/last-used profile (FR-4.13) | User confirms/edits profile via Execution Settings Panel |
| Environment | Auto-uses default Environment (FR-4.19) | User selects/confirms Environment |
| Test case review (FR-2.4) | Auto-accept if confidence score ≥ threshold; auto-queue (not block) if below | User reviews accept/edit/reject before automation runs |
| Automation trigger | Immediate, no confirmation dialog | Runs only after user confirms reviewed test cases |
| Output | Interactive HTML report (FR-6.11) pushed directly to user when run finishes | Report generated but held for user review/export step |
| Audit trail | Every auto-decision logged as "Ultrafast: auto-approved (confidence X%)" — FR-8.3 still applies | Standard reviewer-attributed audit entries |
| Best for | Solo user, low-risk/sandbox runs, quick sanity checks | Solo user who still wants a checkpoint before trusting output |

### Assumption

Since Ultrafast/Fast Mode as specified here targets single-user usage, the second-reviewer/critical-path gate (FR-8.6) and multi-tester routing (FR-8.5) are treated as **out of scope** for both modes. If multi-user teams also need Ultrafast/Fast toggles, FR-8.6/FR-8.5 interaction rules should be defined in a follow-up revision. **Do not build this interaction — flag it back, per the build prompt.**

## MVP Acceptance Gate — new item #14

| # | Gate Item | Related FR(s) |
|---|---|---|
| 14 | Ultrafast Mode auto-decisions (profile/environment selection, auto-accept/reject) fully logged and traceable in the audit log | FR-4.30 |

## Section 14.4 — Acceptance Criteria additions (Module 4)

| ID | Acceptance Criteria |
|---|---|
| FR-4.24 | Toggling between Ultrafast and Fast on the run trigger (or in a saved profile) visibly changes the subsequent flow — no dialogs in Ultrafast, checkpoints in Fast — and the selected mode is displayed on the run summary. |
| FR-4.25 | Starting an Ultrafast run produces zero intermediate screens between trigger and "run started" status; the default/last-used Execution Profile and Environment are recorded on the run without any user input. |
| FR-4.26 | A test case generated with confidence below the configured threshold does not stop or delay an Ultrafast run; it appears afterward in a "needs review" list distinct from approved cases. |
| FR-4.27 | The interactive HTML report (FR-6.11) renders and is delivered to the user automatically within the same session an Ultrafast run completes, with no separate "publish/export" click required. |
| FR-4.28 | A Fast Mode run cannot proceed past the Execution Settings Panel without an explicit user confirmation of profile and environment. |
| FR-4.29 | A Fast Mode run cannot execute automation against a test case that has not received an explicit accept/edit/reject action recorded against a named reviewer. |
| FR-4.30 | Every Ultrafast auto-decision (profile/environment selection, auto-accept/reject, threshold used) produces an audit log entry structurally identical to a manual one, differing only in actor type (system vs. user); the entries are retrievable and immutable per FR-8.11. |

---

*Full v4.6 content otherwise identical to SRS_v4.5.md (Modules 1–3, 5–9, NFRs, data model, MVP gate items 1–13, Section 14.1–14.3/14.5–14.9 acceptance criteria) — see that file for the unchanged baseline. This file captures only the v4.6 delta needed to build FR4.24–FR4.30.*
