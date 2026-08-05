import { useEffect, useState } from "react";
import { useApp } from "../context/AppState.js";
import { api, getCurrentUserId } from "../api.js";
import { Pill } from "../components/Pill.js";

export default function Settings() {
  const {
    mode,
    integrations,
    integrationDraft,
    setIntegrationDraft,
    businessRules,
    setBusinessRules,
    scripts,
    testCases,
    gitHistory,
    setGitHistory,
    users,
    auditLog,
    flaggedForReReview,
    withBusy,
  } = useApp();

  // FR-6.12: per-user notification channel/frequency, overriding the org default
  const [notifPref, setNotifPref] = useState<{ channel: string; frequency: string }>({ channel: "org-default", frequency: "per-run" });
  // FR-1.8: org-level PII redaction toggle
  const [redactionDisabled, setRedactionDisabled] = useState(false);
  // Single-QA cost-saving mode: routes more generation calls to the cheap model tier
  const [costSaving, setCostSaving] = useState<{ cost_saving_mode: number; economy_tier_length_threshold: number } | null>(null);
  const [llmUsage, setLlmUsage] = useState<any>(null);
  // FR-5.4: QA-Lead-editable self-heal high-confidence threshold
  const [selfHealThreshold, setSelfHealThreshold] = useState(0.8);
  // FR-4.26: QA-Lead-editable Ultrafast Mode auto-accept confidence threshold
  const [ultrafastThreshold, setUltrafastThreshold] = useState(0.85);
  // FR-2.11: persisted business rules
  const [savedRules, setSavedRules] = useState<any[]>([]);
  const [newRuleName, setNewRuleName] = useState("");
  const [newRuleDescription, setNewRuleDescription] = useState("");
  // FR-8.9: SSO config status + disable/revoke demonstration
  const [ssoConfig, setSsoConfig] = useState<any>(null);
  // FR-8.10: project export/import
  const [importSummary, setImportSummary] = useState<Record<string, number> | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);

  useEffect(() => {
    api.getNotificationPref(getCurrentUserId()).then(setNotifPref).catch(() => undefined);
    api.getRedactionSetting().then((s) => setRedactionDisabled(Boolean(s.pii_redaction_disabled))).catch(() => undefined);
    api.getSelfHealThreshold().then((s) => setSelfHealThreshold(s.threshold)).catch(() => undefined);
    api.getUltrafastThreshold().then((s) => setUltrafastThreshold(s.threshold)).catch(() => undefined);
    api.listBusinessRules().then(setSavedRules).catch(() => undefined);
    api.getSsoConfig().then(setSsoConfig).catch(() => undefined);
    api.getCostSavingSetting().then(setCostSaving).catch(() => undefined);
    api.getLlmUsage().then(setLlmUsage).catch(() => undefined);
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-display text-xl tracking-tight">Settings</h2>
        <p className="text-sm text-ink/60">Integrations, business rules{mode === "enterprise" ? ", and governance" : ""}</p>
      </div>

      {/* Integrations */}
      <div className="rounded-lg border border-line bg-white/60 shadow-panel p-4 space-y-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-ink/60">Integrations</p>
        <div className="grid gap-2 sm:grid-cols-3">
          <select className="rounded-md border border-line bg-white/60 p-2 text-sm" value={integrationDraft.type} onChange={(e) => setIntegrationDraft((prev: any) => ({ ...prev, type: e.target.value }))}>
            <option value="jira">Jira</option>
            <option value="azure">Azure DevOps</option>
            <option value="slack">Slack</option>
            <option value="teams">Teams</option>
          </select>
          {(integrationDraft.type === "jira" || integrationDraft.type === "azure") && (
            <>
              <input className="rounded-md border border-line bg-white/60 p-2 text-sm" placeholder="Base URL" value={integrationDraft.base_url} onChange={(e) => setIntegrationDraft((prev: any) => ({ ...prev, base_url: e.target.value }))} />
              <input className="rounded-md border border-line bg-white/60 p-2 text-sm" placeholder="Project key / org" value={integrationDraft.org_id} onChange={(e) => setIntegrationDraft((prev: any) => ({ ...prev, org_id: e.target.value }))} />
            </>
          )}
          {(integrationDraft.type === "slack" || integrationDraft.type === "teams") && (
            <input className="rounded-md border border-line bg-white/60 p-2 text-sm sm:col-span-2" placeholder="Webhook URL" value={integrationDraft.webhook_url} onChange={(e) => setIntegrationDraft((prev: any) => ({ ...prev, webhook_url: e.target.value }))} />
          )}
        </div>
        <div className="grid gap-2 sm:grid-cols-3 items-center">
          {(integrationDraft.type === "jira" || integrationDraft.type === "azure") && (
            <input className="rounded-md border border-line bg-white/60 p-2 text-sm" placeholder="API token" value={integrationDraft.token} onChange={(e) => setIntegrationDraft((prev: any) => ({ ...prev, token: e.target.value }))} />
          )}
          {(integrationDraft.type === "slack" || integrationDraft.type === "teams") && (
            <label className="flex items-center gap-2 text-sm text-ink/70">
              <input type="checkbox" checked={integrationDraft.notify_on_run} onChange={(e) => setIntegrationDraft((prev: any) => ({ ...prev, notify_on_run: e.target.checked }))} />
              Notify on every run
            </label>
          )}
          <button
            className="rounded-md bg-ink text-paper px-3 py-1.5 text-xs font-medium hover:bg-ink/90"
            onClick={() =>
              withBusy("create-integration", async () => {
                await api.createIntegration(integrationDraft);
                setIntegrationDraft({ type: "jira", base_url: "", webhook_url: "", token: "", org_id: "", notify_on_run: false });
              })
            }
          >
            Save integration
          </button>
        </div>

        {integrations.length === 0 ? (
          <p className="text-sm text-ink/50">No integrations configured yet.</p>
        ) : (
          <div className="space-y-1">
            {integrations.map((i) => (
              <div key={i.id} className="flex items-center justify-between gap-2 rounded-md border border-line bg-white/50 p-2 text-xs">
                <span className="flex items-center gap-2">
                  <span className="font-medium uppercase">{i.type}</span>
                  {i.base_url || i.webhook_url}
                  {i.token_masked && <span className="text-ink/40 font-mono">token {i.token_masked}</span>}
                  <Pill tone="good">Connected</Pill>
                  {i.notify_on_run ? <Pill tone="good">notify on run</Pill> : null}
                </span>
                <div className="flex gap-2">
                  {(i.type === "slack" || i.type === "teams") && (
                    <button className="rounded border border-line px-2 py-1" onClick={() => withBusy(`test-notify-${i.id}`, () => api.notifyIntegration(i.id, "Test notification"))}>
                      Send test notification
                    </button>
                  )}
                  {(i.type === "jira" || i.type === "azure") && (
                    <button
                      className="rounded border border-line px-2 py-1"
                      onClick={() => {
                        const token = prompt("New token value");
                        if (token) withBusy(`rotate-${i.id}`, () => api.rotateIntegrationToken(i.id, token));
                      }}
                    >
                      Rotate token
                    </button>
                  )}
                  <button className="rounded border border-alert text-alert px-2 py-1" onClick={() => withBusy(`delete-integration-${i.id}`, () => api.deleteIntegration(i.id))}>
                    Remove
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {scripts.length > 0 && (
          <div className="pt-2 space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-ink/60">Per-script sync & version history</p>
            {scripts.map((s) => {
              const tc = testCases.find((t) => t.id === s.test_case_id);
              const fileName = s.file_path.split(/[\\/]/).slice(-1)[0];
              return (
                <div key={s.id} className="rounded-md border border-line bg-white/50 p-3 text-xs flex flex-wrap items-center gap-2 justify-between">
                  <span className="flex items-center gap-1.5">
                    <span className="font-medium">{tc?.title ?? s.test_case_id}</span>
                    <span className="rounded border border-line px-1 text-[10px] font-mono uppercase text-ink/50">{s.language}</span>
                    <span className="text-ink/40 font-mono">{fileName}</span>
                  </span>
                  <div className="flex flex-wrap gap-2">
                    {integrations
                      .filter((i) => i.type === "jira" || i.type === "azure")
                      .map((i) => (
                        <button
                          key={i.id}
                          className="rounded border border-signal text-signal px-2 py-1"
                          onClick={() => withBusy(`push-${i.id}-${s.test_case_id}`, () => api.pushTestCaseToIntegration(i.id, s.test_case_id))}
                        >
                          Push to {i.type}
                        </button>
                      ))}
                    <button
                      className="rounded border border-ink/20 text-ink/70 px-2 py-1"
                      onClick={() =>
                        withBusy(`git-history-${s.id}`, async () => {
                          const history = await api.gitHistoryForScript(fileName);
                          setGitHistory((prev) => ({ ...prev, [s.id]: history }));
                        })
                      }
                    >
                      View git history
                    </button>
                  </div>
                  {gitHistory[s.id] && (
                    <div className="w-full mt-1 space-y-0.5 text-ink/50">
                      {gitHistory[s.id].length === 0 ? (
                        <p>No commits found for {fileName}.</p>
                      ) : (
                        gitHistory[s.id].map((c: any) => (
                          <div key={c.hash} className="font-mono">
                            {c.hash.slice(0, 7)} • {c.date} • {c.message}
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Business rules */}
      <div className="rounded-lg border border-line bg-white/60 shadow-panel p-4 space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-ink/60">Business rules remembered</p>
        <textarea
          className="w-full rounded-md border border-line bg-white/60 p-2 text-sm"
          rows={3}
          placeholder="Business rules / approval thresholds"
          value={businessRules}
          onChange={(e) => setBusinessRules(e.target.value)}
        />
        <p className="text-xs text-ink/50">These rules are applied whenever a new input is submitted from Projects.</p>
      </div>

      {mode === "enterprise" && (
        <GovernancePanel
          users={users}
          auditLog={auditLog}
          flaggedForReReview={flaggedForReReview}
          withBusy={withBusy}
          ssoConfig={ssoConfig}
          setSsoConfig={setSsoConfig}
          importSummary={importSummary}
          setImportSummary={setImportSummary}
          importError={importError}
          setImportError={setImportError}
          importBusy={importBusy}
          setImportBusy={setImportBusy}
          exportBusy={exportBusy}
          setExportBusy={setExportBusy}
        />
      )}

      {/* FR-6.12: per-user notification channel/frequency override */}
      <div className="rounded-lg border border-line bg-white/60 shadow-panel p-4 space-y-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-ink/60">My notification preferences (FR-6.12)</p>
        <div className="flex flex-wrap gap-3 items-center text-sm">
          <label className="flex items-center gap-2">
            Channel
            <select
              className="rounded-md border border-line bg-white/60 p-1.5 text-sm"
              value={notifPref.channel}
              onChange={(e) => setNotifPref((p) => ({ ...p, channel: e.target.value }))}
            >
              <option value="org-default">Org default</option>
              <option value="slack">Slack</option>
              <option value="teams">Teams</option>
              <option value="email">Email</option>
            </select>
          </label>
          <label className="flex items-center gap-2">
            Frequency
            <select
              className="rounded-md border border-line bg-white/60 p-1.5 text-sm"
              value={notifPref.frequency}
              onChange={(e) => setNotifPref((p) => ({ ...p, frequency: e.target.value }))}
            >
              <option value="per-run">Per-run</option>
              <option value="digest">Digest</option>
            </select>
          </label>
          <button
            className="rounded-md bg-ink text-paper px-3 py-1.5 text-xs font-medium"
            onClick={() => withBusy("save-notif-pref", () => api.setNotificationPref(getCurrentUserId(), notifPref.channel, notifPref.frequency))}
          >
            Save
          </button>
        </div>
      </div>

      {/* FR-1.8: org-level PII redaction toggle, auditable */}
      <div className="rounded-lg border border-line bg-white/60 shadow-panel p-4 space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-ink/60">PII redaction (FR-1.8)</p>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={redactionDisabled}
            onChange={(e) =>
              withBusy("toggle-redaction", async () => {
                const updated = await api.setRedactionSetting(e.target.checked);
                setRedactionDisabled(Boolean(updated.pii_redaction_disabled));
              })
            }
          />
          Disable PII redaction org-wide (for sandboxed/test data only — this change is audited)
        </label>
        <Pill tone={redactionDisabled ? "warn" : "good"}>{redactionDisabled ? "Redaction disabled" : "Redaction active"}</Pill>
      </div>

      {/* Single-QA cost-saving mode: routes more generation calls to the cheap model tier */}
      <div className="rounded-lg border border-line bg-white/60 shadow-panel p-4 space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-ink/60">Cost-saving mode</p>
        <p className="text-xs text-ink/50">
          Routes more AI generation calls to the cheaper "economy" model tier (raises the routing threshold from 400 to{" "}
          {costSaving?.economy_tier_length_threshold ?? 1200} characters). Recommended for solo/day-to-day use — turn it off if you want
          the higher-quality tier on every call.
        </p>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={Boolean(costSaving?.cost_saving_mode)}
            onChange={(e) =>
              withBusy("toggle-cost-saving", async () => {
                const updated = await api.setCostSavingMode(e.target.checked);
                setCostSaving(updated);
              })
            }
          />
          Enable cost-saving mode
        </label>
        <Pill tone={costSaving?.cost_saving_mode ? "good" : "neutral"}>{costSaving?.cost_saving_mode ? "Enabled" : "Disabled"}</Pill>
        {llmUsage && (
          <p className="text-xs text-ink/50 pt-1">
            So far: {llmUsage.total_calls} generation call(s), {llmUsage.cache_hit_rate_pct}% served from cache, $
            {llmUsage.total_cost_usd} spent (${llmUsage.savings_usd} saved vs. no optimization — {llmUsage.savings_pct}%).
          </p>
        )}
      </div>

      {/* FR-5.4: QA-Lead-editable self-heal high-confidence threshold, replacing the
          previously hardcoded 0.8 constant. */}
      <div className="rounded-lg border border-line bg-white/60 shadow-panel p-4 space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-ink/60">Self-heal confidence threshold (FR-5.4)</p>
        <p className="text-xs text-ink/50">
          A locator change is auto-applied only when its confidence score is at or above this threshold; below it, the test case is flagged for regeneration instead.
        </p>
        <div className="flex items-center gap-2 text-sm">
          <input
            type="number"
            min={0}
            max={1}
            step={0.01}
            className="w-24 rounded-md border border-line bg-white/60 p-2"
            value={selfHealThreshold}
            onChange={(e) => setSelfHealThreshold(Number(e.target.value))}
          />
          <button
            className="rounded-md border border-signal text-signal px-3 py-1.5 text-xs font-medium"
            onClick={() =>
              withBusy("save-self-heal-threshold", async () => {
                const updated = await api.setSelfHealThreshold(selfHealThreshold);
                setSelfHealThreshold(updated.threshold);
              })
            }
          >
            Save
          </button>
        </div>
      </div>

      {/* FR-4.26: QA-Lead-editable Ultrafast Mode auto-accept confidence threshold, mirroring
          the self-heal threshold control above for consistency. */}
      <div className="rounded-lg border border-line bg-white/60 shadow-panel p-4 space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-ink/60">Ultrafast Mode auto-accept threshold (FR-4.26)</p>
        <p className="text-xs text-ink/50">
          In Ultrafast Mode, a generated test case is auto-accepted only when its confidence score is at or above this threshold; below it, the case is routed to "needs review later" without blocking the run.
        </p>
        <div className="flex items-center gap-2 text-sm">
          <input
            type="number"
            min={0}
            max={1}
            step={0.01}
            className="w-24 rounded-md border border-line bg-white/60 p-2"
            value={ultrafastThreshold}
            onChange={(e) => setUltrafastThreshold(Number(e.target.value))}
          />
          <button
            className="rounded-md border border-signal text-signal px-3 py-1.5 text-xs font-medium"
            onClick={() =>
              withBusy("save-ultrafast-threshold", async () => {
                const updated = await api.setUltrafastThreshold(ultrafastThreshold);
                setUltrafastThreshold(updated.ultrafast_confidence_threshold);
              })
            }
          >
            Save
          </button>
        </div>
      </div>

      {/* FR-2.11: QA-Lead-managed domain/business rules, persisted (not re-typed per call) */}
      <div className="rounded-lg border border-line bg-white/60 shadow-panel p-4 space-y-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-ink/60">Saved business rules (FR-2.11)</p>
        <p className="text-xs text-ink/50">Active rules are automatically included in every free-text generation request.</p>
        <div className="grid gap-2 sm:grid-cols-3">
          <input
            className="rounded-md border border-line bg-white/60 p-2 text-sm"
            placeholder="Rule name (e.g. Approval threshold)"
            value={newRuleName}
            onChange={(e) => setNewRuleName(e.target.value)}
          />
          <input
            className="rounded-md border border-line bg-white/60 p-2 text-sm sm:col-span-2"
            placeholder="Description (e.g. Payments over $500 require manager approval)"
            value={newRuleDescription}
            onChange={(e) => setNewRuleDescription(e.target.value)}
          />
        </div>
        <button
          className="rounded-md border border-signal text-signal px-3 py-1.5 text-xs font-medium"
          onClick={() =>
            withBusy("save-business-rule", async () => {
              if (!newRuleName.trim() || !newRuleDescription.trim()) return;
              await api.createBusinessRule(newRuleName.trim(), newRuleDescription.trim());
              setNewRuleName("");
              setNewRuleDescription("");
              setSavedRules(await api.listBusinessRules());
            })
          }
        >
          Add rule
        </button>
        {savedRules.length > 0 && (
          <ul className="space-y-1 text-sm">
            {savedRules.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-2 rounded-md border border-line bg-white/50 p-2">
                <span className="font-medium">{r.name}</span>
                <span className="text-ink/60 flex-1 truncate">{r.description}</span>
                <Pill tone={r.active ? "good" : "neutral"}>{r.active ? "active" : "inactive"}</Pill>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function GovernancePanel({
  users,
  auditLog,
  flaggedForReReview,
  withBusy,
  ssoConfig,
  setSsoConfig,
  importSummary,
  setImportSummary,
  importError,
  setImportError,
  importBusy,
  setImportBusy,
  exportBusy,
  setExportBusy,
}: any) {
  const [expanded, setExpanded] = useState(true);
  return (
    <div className="rounded-lg border border-line bg-white/60 shadow-panel p-4 space-y-4">
      <button className="text-sm font-medium text-signal" onClick={() => setExpanded((v) => !v)}>
        {expanded ? "▾" : "▸"} Governance (Enterprise Mode)
      </button>
      {expanded && (
        <>
          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded-md border border-line bg-white/50 p-3">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold uppercase tracking-wide text-ink/60">Re-review sampling</p>
                <button
                  className="rounded-md border border-ink/20 text-ink/70 px-2 py-1 text-xs font-medium hover:bg-ink/5"
                  onClick={() => withBusy("sample-re-review", () => api.sampleForReReview(3))}
                >
                  Sample 3 for re-review
                </button>
              </div>
              {flaggedForReReview.length === 0 ? (
                <p className="mt-2 text-sm text-ink/50">Nothing currently flagged.</p>
              ) : (
                <div className="mt-2 space-y-1 text-xs text-ink/70">
                  {flaggedForReReview.map((tc: any) => (
                    <div key={tc.id} className="flex items-center justify-between">
                      <span>{tc.title}</span>
                      <Pill tone="warn">flagged</Pill>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="rounded-md border border-line bg-white/50 p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-ink/60">Users</p>
              <div className="mt-2 space-y-1 text-xs text-ink/70">
                {users.map((u: any) => (
                  <div key={u.id} className="flex items-center justify-between gap-2">
                    <span className="truncate">{u.name}</span>
                    <Pill>{u.role}</Pill>
                    {u.sso_subject_id && (
                      <Pill tone={u.sso_disabled_at ? "bad" : "good"}>{u.sso_disabled_at ? "SSO disabled" : "SSO linked"}</Pill>
                    )}
                    {u.sso_subject_id && !u.sso_disabled_at && (
                      <button
                        className="rounded border border-alert text-alert px-2 py-0.5 text-[10px]"
                        onClick={() => withBusy(`disable-sso-${u.id}`, () => api.disableSsoUser(u.id))}
                      >
                        Disable
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* FR-8.9: platform SSO config status + disable/revoke demonstration (stub linkage model, not a real IdP handshake) */}
          <div className="rounded-md border border-line bg-white/50 p-3 space-y-1">
            <p className="text-xs font-semibold uppercase tracking-wide text-ink/60">SSO (FR-8.9)</p>
            {ssoConfig ? (
              <div className="flex items-center gap-2 text-xs text-ink/70">
                <Pill tone={ssoConfig.enabled ? "good" : "neutral"}>{ssoConfig.enabled ? `enabled (${ssoConfig.provider})` : "not configured"}</Pill>
                <span className="text-ink/40">
                  This is a stub IdP-linkage/revocation model, not a real SAML handshake. Users log in via a real IdP redirect to {ssoConfig.loginUrl ?? "/api/admin/sso/callback"} in production; disabling a user's SSO access above revokes it here.
                </span>
              </div>
            ) : (
              <p className="text-xs text-ink/50">Loading…</p>
            )}
          </div>

          {/* FR-8.10: full project export/import */}
          <div className="rounded-md border border-line bg-white/50 p-3 space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-ink/60">Project export/import (FR-8.10)</p>
            <div className="flex flex-wrap items-center gap-2">
              <button
                className="rounded-md border border-ink/20 text-ink/70 px-3 py-1.5 text-xs font-medium hover:bg-ink/5 disabled:opacity-50"
                disabled={exportBusy}
                onClick={async () => {
                  setExportBusy(true);
                  try {
                    await api.exportProject();
                  } catch (e: any) {
                    setImportError(e.message);
                  } finally {
                    setExportBusy(false);
                  }
                }}
              >
                {exportBusy ? "Exporting…" : "Export project"}
              </button>
              <label className="rounded-md border border-ink/20 text-ink/70 px-3 py-1.5 text-xs font-medium hover:bg-ink/5 cursor-pointer">
                {importBusy ? "Importing…" : "Import project"}
                <input
                  type="file"
                  accept="application/json"
                  className="hidden"
                  disabled={importBusy}
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    e.target.value = "";
                    if (!file) return;
                    setImportBusy(true);
                    setImportError(null);
                    setImportSummary(null);
                    try {
                      const text = await file.text();
                      const payload = JSON.parse(text);
                      const result = await api.importProject(payload);
                      setImportSummary(result);
                    } catch (err: any) {
                      setImportError(err.message);
                    } finally {
                      setImportBusy(false);
                    }
                  }}
                />
              </label>
            </div>
            {importError && <p className="text-xs text-alert">{importError}</p>}
            {importSummary && (
              <div className="text-xs text-ink/70">
                <p className="text-ink/50 mb-1">Imported record counts:</p>
                <ul className="space-y-0.5">
                  {Object.entries(importSummary).map(([table, count]) => (
                    <li key={table} className="flex justify-between gap-4">
                      <span className="font-mono">{table}</span>
                      <span>{String(count)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          <div className="rounded-md border border-line bg-white/50 p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-ink/60">Audit log</p>
            {auditLog.length === 0 ? (
              <p className="mt-2 text-sm text-ink/50">No governance events recorded yet.</p>
            ) : (
              <div className="mt-2 space-y-1 text-xs text-ink/70 max-h-64 overflow-y-auto">
                {auditLog.map((entry: any) => (
                  <div key={entry.id} className="flex items-center justify-between gap-2 border-b border-line/50 pb-1">
                    <span className="font-mono">{entry.action}</span>
                    <span className="text-ink/40">
                      {entry.entity_type}
                      {entry.entity_id ? `:${entry.entity_id}` : ""}
                    </span>
                    <span className="text-ink/40">{entry.actor_role ?? "system"}</span>
                    <span className="text-ink/30">{new Date(entry.created_at).toLocaleTimeString()}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
