# AI-Powered Test Automation Platform — Software Requirements Specification (SRS)

**Consolidated Functional Baseline — Pricing & Billing Model Pending**
**Version 4.5 | August 2026**

## 1. Introduction

### 1.1 Purpose
Consolidates all functional and non-functional requirements identified across the platform's draft specifications (v1.0, v2.0, v3.1) into a single reference document for the engineering team. Supersedes those earlier drafts for functional scope. Pricing and billing mechanics (drafts v3.1 §13 and v3.2) are intentionally excluded and finalized separately.

### 1.2 Scope
Ingests screenshots, videos, Swagger/OpenAPI specs, Postman collections, and Jira/Azure DevOps tickets; uses AI to generate manual test cases and executable Playwright automation scripts. Executes tests under user-configurable execution options, detects target-application changes, and keeps manual/automated test assets in sync. Reports back into Jira, Azure DevOps, Slack/Teams. Makes AI generation auditable, collaborative with human testers, safe against real customer data, and flexible in how/when tests run.

### 1.3 Definitions & Acronyms
| Term | Definition |
|---|---|
| SRS | Software Requirements Specification |
| FR | Functional Requirement |
| NFR | Non-Functional Requirement |
| POM | Page Object Model |
| Self-healing | Automatic repair of broken test locators/scripts after a UI change |
| MTok | Million tokens (LLM API billing unit) |
| HITL | Human-in-the-Loop |
| Confidence score | AI-reported certainty attached to a generated test case, locator heal, or change classification |
| Prompt injection | Attack where malicious input content manipulates LLM output |
| PII | Personally Identifiable Information |
| Execution Profile | Named, reusable combination of test-selection mode, browser set, concurrency, artifact capture mode, retry strategy |
| Screen | Distinct, catalogued UI state/page/module discovered from any input |
| Environment | Named target (Dev/Staging/Prod) with its own URL, credentials, default Execution Profile |

### 1.4 References
- PRD — AI-Powered Test Automation Platform, v1.0
- SRS v1.0, v2.0, v3.1 (superseded)
- Kickoff Deck v1.0
- Draft pricing/billing material — v3.1 §13, v3.2 (reference only)

## 2. Overall Description

### 2.1 Product Perspective
New, standalone internal platform. Integrates with Jira, Azure DevOps, Git, Slack/Teams; calls an external LLM API (Claude/GPT) for generation.

### 2.2 User Classes
| User Class | Description |
|---|---|
| QA Lead | Full access; approves test cases; manages integrations, governance, domain-rule config |
| Tester | Reviews/edits AI-generated test cases; triggers/monitors runs; configures execution profiles; rationale on edits/rejections |
| Developer | Views results; links failures to code; consumes reports; triggers CI/CD runs |
| Manager/Stakeholder | Read-only dashboards and release reports |

### 2.3 Operating Environment
- Web-based, modern browsers (Chrome, Edge, Firefox)
- Backend on cloud infra (containerized), or self-hosted
- Execution engine requires a browser automation grid (Docker-based Playwright runners), auto-scaling

### 2.4 Design and Implementation Constraints
- Must integrate with Jira Cloud/Server and Azure DevOps REST APIs
- Automation output valid/runnable Playwright in at least JS/TS and Python
- LLM API usage must support prompt caching and batch processing to control spend
- All LLM inputs must pass through the FR-9.2 sanitization layer before submission

### 2.5 Assumptions and Dependencies
- Users have existing Jira/Azure DevOps/Git accounts with API token access
- Target apps are web-based (mobile/native is later phase)
- An LLM API is available and budgeted
- Final pricing/billing determined separately, doesn't block functional build-out

### 2.6 Out-of-Scope for MVP (Summary)
Mobile/native testing, non-English UI testing, automated Selenium/Cypress migration, DR/SLA guarantees, finalized pricing/billing — see Section 10.

## 3. System Features (Functional Requirements by Module)

### 3.1 Module 1 — Input Ingestion Layer
| ID | Requirement | Priority |
|---|---|---|
| FR-1.1 | Accept single/multi-file batch image upload (JPG/PNG) of UI screens/mockups | High |
| FR-1.2 | Accept single/multi-file batch video upload, auto-extract key frames | High |
| FR-1.2a | Mix screenshots and videos in the same batch upload | High |
| FR-1.3 | Accept a live URL and crawl reachable pages | Medium |
| FR-1.3a | Accept target URL + login credentials (user/pass or SSO/session token) to crawl behind login | High |
| FR-1.3b | Autonomously traverse nav/forms/workflows to discover UI states/scenarios once authenticated | High |
| FR-1.3c | Encrypt submitted login credentials at rest, scope to target app, never expose in logs/LLM prompts, allow revoke/rotate | High — MVP gate |
| FR-1.4 | Parse Swagger/OpenAPI (JSON/YAML) into endpoints/methods/params/schemas | High |
| FR-1.5 | Parse Postman collections incl. environments and pre/post-request scripts | High |
| FR-1.6 | Import Jira/Azure DevOps items (stories, epics, acceptance criteria) via authenticated API | High |
| FR-1.7 | Accept free-text scenario descriptions | Medium |
| FR-1.8 | Detect/redact PII in uploaded screenshots/videos before storage/LLM submission, org-level toggle | High — MVP gate |
| FR-1.9 | Reject/quarantine malformed input with clear user-facing error, not silent failure/crash | High — MVP gate |
| FR-1.10 | Catalog every distinct screen/module discovered as a first-class Screen entity | High |

### 3.2 Module 2 — AI Test Case Generation Engine
| ID | Requirement | Priority |
|---|---|---|
| FR-2.1 | Generate test cases categorized Smoke/Regression/Functional/Edge Case/Negative/API-specific | High |
| FR-2.2 | Export generated test cases to Excel/CSV | High |
| FR-2.3 | Sync generated test cases to Jira/Azure DevOps as linked test items | High |
| FR-2.4 | Require human review (accept/edit/reject) before a test case enters approved suite | High |
| FR-2.5 | Maintain traceability from every test case to its source input | High |
| FR-2.6 | Version each test case, display diff on regeneration/edit | Medium |
| FR-2.7 | Display confidence score + source rationale alongside every generated test case | High |
| FR-2.8 | Support inline co-editing of steps/expected results/priority on the draft | High |
| FR-2.9 | 'Explain this test case' plain-language rationale function | Medium |
| FR-2.10 | Capture tester rationale/notes on heavy edit/reject, retain as audit context/tuning signal | High |
| FR-2.11 | QA Leads pre-load domain/business rules generation must account for | Medium |
| FR-2.12 | 'Needs Discussion' status distinct from accept/edit/reject | Medium |
| FR-2.13 | Report aggregate human-reviewer agreement rate per project | High — MVP gate |
| FR-2.14 | Tag every test case + linked script with its Screen/module | High |
| FR-2.15 | Bulk actions (accept/reject/re-tag/priority) across multi-selected test cases | Medium |
| FR-2.16 | Detect/flag likely duplicate/near-duplicate test cases per screen/module | Medium |
| FR-2.17 | Support data-driven/parameterized test cases across multiple data sets | Medium |
| FR-2.18 | Search/filter test case library by keyword/screen/tag/priority/category/authorship | High |

### 3.3 Module 3 — Automation Code Generation
| ID | Requirement | Priority |
|---|---|---|
| FR-3.1 | Generate Playwright scripts in at least JS/TS and Python | High |
| FR-3.2 | Optionally export to Selenium or Cypress format | Low |
| FR-3.3 | Structure generated UI scripts using Page Object Model | High |
| FR-3.4 | Prefer accessibility-first locators (role/label) over brittle CSS/XPath | High |
| FR-3.5 | Generate API test scripts directly from Swagger/Postman input | High |
| FR-3.6 | Static security scan on all AI-generated code before Git commit/CI-CD execution | High — MVP gate |
| FR-3.7 | Generate shared setup/teardown fixtures per screen/module, reference rather than duplicate | High |

### 3.4 Module 4 — Execution Engine (with Configurable Execution)
| ID | Requirement | Priority |
|---|---|---|
| FR-4.1 | Execute Playwright suites across Chromium, Firefox, WebKit | High |
| FR-4.2 | Support parallel test execution | High |
| FR-4.3 | Maintain self-hosted Docker-based grid or cloud provider, auto-scaling pool | High |
| FR-4.4 | Integrate with CI/CD (GitHub Actions, Jenkins, Azure Pipelines, GitLab CI) | High |
| FR-4.5 | Queue execution jobs, display visible queue position | High |
| FR-4.6 | Reuse browser instances across tests within a run | Medium |
| FR-4.7 | Configurable artifact capture modes: logs-only/failures-only/all-screenshots/video(failures)/video(all)/full debug | High |
| FR-4.8 | Auto-delete captured video artifacts after configurable retention window | High |
| FR-4.9 | Browser-set selection per run/profile: Chromium-only/+Firefox/all three/headless | High |
| FR-4.10 | Multiple test-selection modes: Smart/Full suite/Custom/Flaky-only/Scheduled regression | High |
| FR-4.11 | Configurable retry strategies: no-retry/retry-flaky/retry-all/smart-retry | Medium |
| FR-4.12 | Create/save/edit/delete/share named Execution Profiles | High |
| FR-4.13 | Designate an Execution Profile as default for team/suite | Medium |
| FR-4.14 | Suggest Execution Profile/setting based on run context and history | Medium |
| FR-4.15 | Custom execution rules conditioned on test attributes/schedule/prior outcome | Medium |
| FR-4.16 | Webhook-triggered runs and time-based scheduled runs, each invoking a specified profile | High |
| FR-4.17 | Enterprise: reserve guaranteed concurrent runners from shared pool | Low |
| FR-4.18 | Select screens/modules from Screen Explorer, run only tagged test cases (incl. Changed-only) | High |
| FR-4.19 | Support multiple named Environments, each own URL/credentials/default profile | High |
| FR-4.20 | Pre-flight health check before scheduled/webhook runs; hold/alert if unreachable | Medium |
| FR-4.21 | Secure storage/runtime injection of secrets/env vars, encrypted at rest, never in plaintext | High — MVP gate |
| FR-4.22 | CI/CD-triggered run can fail pipeline/PR check on test failure | High |
| FR-4.23 | Version every edit to a saved Execution Profile, diff + editor identity | Medium |

### 3.5 Module 5 — Change Detection & Self-Healing
| ID | Requirement | Priority |
|---|---|---|
| FR-5.1 | Detect UI changes via scheduled crawl or DOM diffing | High |
| FR-5.2 | Detect API changes via Swagger/schema diffing | High |
| FR-5.3 | Attempt automatic locator healing where element confidently matched | High |
| FR-5.4 | Flag test cases/scripts needing regeneration when heal confidence low (numeric threshold) | High — MVP gate |
| FR-5.5 | Update manual test case + linked script together, keeping in sync | High |
| FR-5.6 | Log every auto-heal with before/after state, support one-click rollback | High |
| FR-5.7 | Compare each re-crawled/re-uploaded Screen to last version, classify Changed/Unchanged | High |
| FR-5.8 | Display Changed/Unchanged status on every screen in Screen Explorer, with test case counts | High |
| FR-5.9 | Visual regression testing via pixel-level diffing against saved baseline per screen | Medium |
| FR-5.10 | Side-by-side before/after review view (DOM + visual diff) when Screen flagged Changed | High |

### 3.6 Module 6 — Reporting & Analytics
| ID | Requirement | Priority |
|---|---|---|
| FR-6.1 | Pass/fail dashboards with execution time trends | High |
| FR-6.2 | Detect and flag flaky tests | Medium |
| FR-6.3 | Show requirement coverage mapped to user stories | Medium |
| FR-6.4 | Export release-ready reports as PDF/Excel | Medium |
| FR-6.5 | Capture screenshot/video/log evidence per failed step | High |
| FR-6.6 | Display hours-saved estimate per sprint | Medium |
| FR-6.7 | Show actual-vs-estimated time breakdown and time saved after each run | Medium |
| FR-6.8 | Flag screens with zero/stale test cases as coverage gaps | Medium |
| FR-6.9 | Scheduled digest notifications (daily/weekly) to Slack/Teams/email | Medium |
| FR-6.10 | Display LLM API usage and estimated cost per project (tokens, MTok), **including savings attributable to caching and model routing (FR-9.5–FR-9.7)**, distinct from platform pricing | Medium |
| FR-6.11 | Generate polished self-contained interactive HTML run report (Playwright-style) | High |
| FR-6.12 | Per-user notification channel/frequency config, overriding org default | Medium |

### 3.7 Module 7 — Integrations Hub
| ID | Requirement | Priority |
|---|---|---|
| FR-7.1 | Bi-directional sync of test cases/results with Jira | High |
| FR-7.2 | Bi-directional sync with Azure DevOps work items/test plans | High |
| FR-7.3 | Send run notifications to Slack/Teams | Medium |
| FR-7.4 | Store generated automation scripts in a connected Git repo, versioned with app code | High |
| FR-7.5 | Optionally sync with TestRail, Zephyr, qTest | Low |
| FR-7.6 | Auto-file defect ticket with evidence when a previously-passing test fails | Medium |

### 3.8 Module 8 — Admin & Governance
| ID | Requirement | Priority |
|---|---|---|
| FR-8.1 | RBAC (QA Lead, Tester, Developer, Manager) | High |
| FR-8.2 | Require approval before AI-generated test cases become active | High |
| FR-8.3 | Maintain audit log of all AI-generated changes and approvals | High |
| FR-8.4 | Secure storage/rotation of third-party API tokens | High |
| FR-8.5 | Route generated test cases to owning tester/team, not generic queue | Medium |
| FR-8.6 | Optional second-reviewer sign-off for critical-path test cases | Medium |
| FR-8.7 | Visually distinguish AI-generated/human-edited/human-authored test cases | Medium |
| FR-8.8 | Periodically re-surface approved test cases for re-review (AI drift) | Low |
| FR-8.9 | Support enterprise SSO/SAML login | High |
| FR-8.10 | Full export/import of a project for backup/migration | Medium |
| FR-8.11 | Retain audit log for configurable minimum period; immutable for all roles | High |
| FR-8.12 | Same run-trigger permission required for screen-scoped runs as any run type | High |

### 3.9 Module 9 — Input Safety & Platform Resilience
| ID | Requirement | Priority |
|---|---|---|
| FR-9.1 | Detect/resolve concurrent edits to Test Case + linked Automation Script via merge/conflict view | High — MVP gate |
| FR-9.2 | Sanitize/validate all ticket/spec/free-text content before LLM submission (prompt-injection defense) | High — MVP gate |
| FR-9.3 | Define/implement queue/retry/fail behavior when LLM API rate-limited/unavailable | High — MVP gate |
| FR-9.4 | Auto fail over generation requests to secondary LLM provider beyond a defined threshold, log failover | Medium |
| FR-9.5 | Semantic caching layer (e.g. GPTCache) detecting near-duplicate requests, serving cached response | Medium |
| FR-9.6 | Prompt-compression step (e.g. LLMLingua) reducing token count of large inputs before submission, validated not to materially reduce accuracy vs FR-2.13 benchmark | Medium |
| FR-9.7 | Unified open-source LLM gateway (e.g. LiteLLM) with cost-aware per-request model selection and FR-9.4 failover | Medium |

## 4. External Interface Requirements

### 4.1 User Interfaces
- Web dashboard for review, approval, execution monitoring, reporting
- Upload interface: drag-and-drop + multi-select batch upload (screenshots + videos), file picker for Swagger/Postman
- Execution Settings Panel: profile, Environment, browsers, concurrency, artifact/retry modes
- Post-run report: actual-vs-estimated, evidence, downloadable interactive HTML report (FR-6.11), save-as-new-profile option
- Screen Explorer: visual catalog of discovered screens, Changed/Unchanged status, linked test cases, scoped run trigger

### 4.2 API Interfaces
- REST API for triggering generation, execution, retrieving results (CI/CD)
- Webhook receivers for deploy-pipeline triggered change detection and profile-driven execution

### 4.3 Third-Party Integrations
Jira Cloud/Server, Azure DevOps REST API, Git provider APIs (GitHub/GitLab/Bitbucket), Slack/Teams webhook APIs, LLM provider API (Claude/GPT)

## 5. Non-Functional Requirements
| Category | Requirement |
|---|---|
| Performance | Test case generation returns within ~30s for typical single-input requests |
| Scalability | Concurrent generation/execution across teams, auto-scaling runner pool |
| Security | Credentials/secrets encrypted at rest (AES-256+), least-privilege scopes; media scanned for PII pre-LLM |
| Reliability | Execution engine targets 99.5%+ uptime if cloud-hosted |
| Data Retention | Configurable per org data policy; visual baselines follow same policy |
| Usability | Non-technical testers review/approve without writing code |
| Configurability | Execution behavior adjustable per run/profile without code changes |
| Maintainability | Codebase modular by service (per module) |
| Resource Efficiency | LLM usage leverages prompt caching and batch processing to minimize spend |
| Resilience | Graceful degradation (queued/deferred generation) rather than hard failure on LLM outage |
| API Governance | Rate limiting per org/API-key, semantic versioning, deprecation notice |
| Report Performance | Interactive HTML report completes within ~10s for a 500-test run, scaling sub-linearly |

## 6. High-Level Data Model
| Entity | Key Attributes |
|---|---|
| TestCase | id, title, category, steps, expected_result, source_ref, status, version, confidence_score, authorship_type, reviewer_notes |
| AutomationScript | id, test_case_id, language, framework, code, locator_strategy, last_run_status, security_scan_status, secrets_ref |
| Input | id, type, file_ref/api_ref, uploaded_by, created_at, pii_redaction_status |
| ExecutionRun | id, script_id, profile_id, environment_id, browser_set, status, duration, evidence_refs, triggered_by |
| ExecutionProfile | id, name, test_mode, browser_set, concurrency_level, artifact_mode, retry_strategy, owner_team, is_shared, created_at |
| ChangeEvent | id, target, diff_summary, affected_test_case_ids, resolution_status, heal_confidence, rollback_available |
| User | id, name, role, org_id, connected_integrations, owned_modules |
| Integration | id, type, org_id, token_ref, scopes |
| ReviewAction | id, test_case_id, reviewer_id, action, rationale_note, timestamp |
| Screen | id, name, module_name, source_input_id, url_or_path, last_captured_state_hash, change_status, last_compared_at, visual_baseline_ref, linked_test_case_ids, linked_script_ids |
| Environment | id, name, target_url, credentials_ref, default_profile_id, org_id |
| Organization | id, name, sso_provider_ref, plan_tier, created_at |

## 7. Module-Wise Technical Structure
| Module | Suggested Service Name | Core Tech |
|---|---|---|
| 1. Input Ingestion | ingestion-service | Node.js/FastAPI, S3-compatible storage, Swagger/Postman parsers, PII redaction filter |
| 2. Test Case Generation | generation-service | LLM API via open-source gateway (LiteLLM) for cost-aware routing/failover (FR-9.7), semantic caching (GPTCache, FR-9.5), prompt compression (LLMLingua, FR-9.6); prompt templates per input type, confidence scoring |
| 3. Automation Codegen | codegen-service | LLM API + code templates via same gateway/caching layer, Playwright POM generator, static security scanner |
| 4. Execution Engine | execution-service | Playwright runner, Docker grid, queue workers, profile manager, configurable artifact capture |
| 5. Change Detection | change-detection-service | Scheduled crawler, DOM/schema diff engine, heal-confidence engine |
| 6. Reporting & Analytics | reporting-service | PostgreSQL, dashboard API, PDF/Excel export, time-saved calculator |
| 7. Integrations Hub | integrations-service | Jira/Azure/Git/Slack API clients, webhook handlers |
| 8. Admin & Governance | admin-service | RBAC, audit log, token vault, reviewer routing |
| 9. Input Safety & Resilience | safety-service | Prompt sanitization, rate-limit/retry queue, conflict-resolution engine, LLM gateway/failover orchestration (FR-9.7) |
| Shared | web-frontend | React + Tailwind dashboard consumed by all modules |

## 8. Module Dependency Overview
- Ingestion → Generation (raw input → structured test cases), through Safety sanitization first
- Generation → Codegen (approved test case → automation script)
- Codegen → Execution (script → run results), gated by Safety security scan
- Execution reads Execution Profiles before starting a run
- Execution + Change Detection both feed Reporting
- Change Detection feeds back into Generation + Codegen for updates
- Integrations consumed by Ingestion (pull tickets), Generation (push test cases), Reporting (push results)
- Admin/Governance underlies all modules
- Safety sits between Ingestion/Generation and the external LLM API for all requests

## 9. MVP Acceptance Gate
| # | Gate Item | Related FR(s) |
|---|---|---|
| 1 | Accuracy benchmark / human-reviewer agreement rate established and reported | FR-2.13 |
| 2 | PII redaction on uploaded screenshots/video functioning before LLM submission | FR-1.8 |
| 3 | Prompt-injection sanitization applied to all LLM-bound input | FR-9.2 |
| 4 | Static security scan on all AI-generated automation code before CI/CD execution | FR-3.6 |
| 5 | Defined error handling for malformed/corrupted input | FR-1.9 |
| 6 | Acceptance criteria documented and testable for every FR in this document | All FRs |
| 7 | Self-heal confidence threshold defined numerically, with rollback capability | FR-5.4, FR-5.6 |
| 8 | Concurrent edit conflict handling implemented | FR-9.1 |
| 9 | LLM API outage/rate-limit degraded-mode behavior defined and tested | FR-9.3 |
| 10 | Out-of-scope statement published to sales/support | N/A |
| 11 | Secure handling of user-submitted application login credentials for authenticated URL crawling | FR-1.3c |
| 12 | Secure storage/runtime injection of automation-script secrets, never in plaintext | FR-4.21 |
| 13 | Audit log retention and immutability enforced for all roles | FR-8.11 |

## 10. Out of Scope (MVP)
Mobile/native app testing; non-English UI testing/localization; automated Selenium/Cypress migration tooling; formal SLA tiers and DR/backup guarantees; platform's own UI accessibility (WCAG) audit; full data residency/regional compliance certifications; finalized pricing/billing/subscription tiers/volume discounts.

## 11. Roadmap — Post-MVP Enhancements
Mobile/native app testing; accessibility (WCAG) auditing of the AUT; synthetic test data generation; compliance mode packaging (SOC2/HIPAA/FDA); existing-suite migration assistant; full DR/SLA tiers; finalize pricing/billing.

## 12. Execution Configuration & User Choice
Full detail on: 12.1 Test Selection Modes, 12.2 Browser Choice, 12.3 Concurrency Levels, 12.4 Artifact Capture Options, 12.5 Retry & Flakiness Handling, 12.6 Execution Profiles (Save & Reuse), 12.7 Advanced Options (custom rules, webhook triggers/scheduling, Enterprise resource reservations), 12.8 Dashboard & UX for User Control, 12.9 Backward Compatibility — see the source PDF for the full worked tables; summarized in FR-4.9–FR-4.23 above.

## 13. Appendix

### 13.1 Priority Legend
High = required for MVP · High — MVP gate = required and blocking (Section 9) · Medium = required by V2 · Low = nice-to-have, V3+

### 13.4 Note on Pricing & Billing
Pricing, subscription tiers, execution-minute billing, discounts explored in draft form (v3.1 §13, v3.2) but excluded from this consolidated SRS; no FR above depends on a specific pricing model.

### 13.5 Illustrative Token-Cost Optimization Example (Non-Binding)
500 test case e-commerce project, Claude Sonnet 5 pricing ($2/$10 per MTok in/out), 1,250 total LLM calls (incl. 25% regeneration), ~35% near-duplicate screens:

| Scenario | Total Cost (500 test cases) | Savings vs. A |
|---|---|---|
| A. No optimization | $30.00 | — |
| B. + Anthropic native prompt caching | $21.01 | 30% |
| C. + FR-9.5/9.6/9.7 (semantic cache, compression, cost-aware routing) on top of B | $11.27 | 62% (46% further beyond B) |

The B→C gap is the specific value FR-9.5–FR-9.7 add beyond provider-native caching: semantic caching avoids the call entirely for near-duplicate screens, prompt compression shrinks remaining unique content, cost-aware routing sends simpler tasks to a cheaper model. Re-run against current pricing and actual screen-duplication rate before budget planning.

## 14. Acceptance Criteria (MVP Gate Item #6)

Full per-FR acceptance criteria for Modules 1–9 are maintained in the source SRS PDF (`AI-Test-Automation-Platform-SRS-v4.5-1.pdf`, Section 14) and cross-checked FR-by-FR in [`GAP_ANALYSIS.md`](GAP_ANALYSIS.md), which is the living, continuously-reverified status document — check there for current pass/fail status per FR rather than duplicating the full criteria text here.

## 13.3 Change Log (summary)
| Version | Date | Summary |
|---|---|---|
| 1.0 | July 2026 | Initial SRS: core 8 modules |
| 2.0 | July 2026 | Module 9, HITL requirements, MVP Gate, Out-of-Scope, Roadmap |
| 3.1 (concepts) | July 2026 | Flexible user-configurable execution introduced |
| 4.0 | July 2026 | Consolidated baseline, pricing deferred |
| 4.1 | August 2026 | FR-1.3a/b/c authenticated crawling + credential security, MVP gate #11 |
| 4.2 | August 2026 | FR-1.10, FR-2.14, FR-5.7/5.8, FR-4.18, Screen Explorer, Screen entity |
| 4.3 | August 2026 | Bulk actions/dedup/data-driven/search (FR-2.15–2.18); multi-env, health checks, secrets (FR-4.19–21, gate #12); visual regression (FR-5.9/10); coverage gaps/digests/cost/HTML report (FR-6.8–11); TestRail/Zephyr/qTest (FR-7.5); SSO/export-import (FR-8.9/10); Environment entity |
| 4.4 | August 2026 | Fixture reuse (FR-3.7), CI/CD gating + profile versioning (FR-4.22/23), notification prefs (FR-6.12), auto bug filing (FR-7.6), audit immutability + screen RBAC (FR-8.11/12, gate #13), LLM failover (FR-9.4); NFRs; Section 14 acceptance criteria (gate #6) |
| **4.5 (this doc)** | **August 2026** | **FR-9.5/9.6/9.7: LLM cost-optimization layer (semantic caching, prompt compression, cost-aware model routing/failover); amended FR-6.10 to surface caching/routing savings; Section 13.5 worked cost example (62% reduction)** |
