import { useState } from "react";
import { useApp } from "../../context/AppState.js";
import { api } from "../../api.js";
import { CATEGORY_COLOR, Pill } from "../../components/Pill.js";

const CATEGORIES = Object.keys(CATEGORY_COLOR);
const PRIORITIES = ["Low", "Medium", "High"];

const DRAFT_DEFAULT = {
  input_id: "",
  title: "",
  category: "Functional",
  steps: "",
  expected_result: "",
  priority: "Medium",
};

function stepsFromText(text: string): string[] {
  return text
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

// FR-8.7: fully human-authored test cases -- the backend (POST /test-cases) and
// authorship_type distinction have existed since the last gap-analysis pass, but
// no client screen ever called it. This is that UI: author one by hand (useful
// for scenarios AI generation doesn't cover, or as a ground-truth baseline), and
// manage the ones already authored. Purely manual by nature -- it plays no part
// in Run's Ultrafast chain, which never pauses for a human to write a test case;
// it's Fast Mode's full-control counterpart, always available here in Library.
export default function ManualTestCases() {
  const { inputs, testCases, withBusy, busy } = useApp();
  const [showForm, setShowForm] = useState(false);
  const [draft, setDraft] = useState({ ...DRAFT_DEFAULT, input_id: inputs[0]?.id ?? "" });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const humanCases = testCases
    .filter((tc) => tc.authorship_type === "human")
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  function startEdit(tc: (typeof testCases)[number]) {
    setEditingId(tc.id);
    setDraft({
      input_id: tc.input_id,
      title: tc.title,
      category: tc.category,
      steps: tc.steps.join("\n"),
      expected_result: tc.expected_result,
      priority: tc.priority ?? "Medium",
    });
    setShowForm(true);
    setFormError(null);
  }

  function resetForm() {
    setDraft({ ...DRAFT_DEFAULT, input_id: inputs[0]?.id ?? "" });
    setEditingId(null);
    setFormError(null);
  }

  async function submit() {
    const steps = stepsFromText(draft.steps);
    if (!draft.input_id || !draft.title.trim() || steps.length === 0 || !draft.expected_result.trim()) {
      setFormError("Input, title, at least one step, and an expected result are all required.");
      return;
    }
    setFormError(null);
    await withBusy(editingId ? "edit-human-tc" : "create-human-tc", async () => {
      if (editingId) {
        await api.reviewTestCase(editingId, "edit", {
          title: draft.title.trim(),
          category: draft.category,
          steps,
          expected_result: draft.expected_result.trim(),
          priority: draft.priority,
        } as any);
      } else {
        await api.createHumanTestCase({
          input_id: draft.input_id,
          title: draft.title.trim(),
          category: draft.category,
          steps,
          expected_result: draft.expected_result.trim(),
          priority: draft.priority,
        });
      }
      resetForm();
      setShowForm(false);
    });
  }

  async function remove(id: string) {
    await withBusy(`delete-human-tc-${id}`, () => api.deleteTestCase(id));
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-display text-xl tracking-tight">Manual test cases</h2>
        <p className="text-sm text-ink/60">
          Author test cases by hand — for scenarios AI generation misses, or as a baseline you fully control (FR-8.7).
        </p>
      </div>

      {inputs.length === 0 ? (
        <div className="rounded-lg border border-line bg-white/60 shadow-panel p-4 text-sm text-ink/60">
          Add an input first (from the Run page) — a manual test case is still attached to one, the same as an AI-generated case.
        </div>
      ) : (
        <>
          <div className="flex justify-end">
            <button
              className="rounded-md bg-ink text-paper px-3 py-1.5 text-xs font-medium"
              onClick={() => {
                if (showForm) {
                  setShowForm(false);
                } else {
                  resetForm();
                  setShowForm(true);
                }
              }}
            >
              {showForm ? "Close" : "Add manual test case"}
            </button>
          </div>

          {showForm && (
            <div className="rounded-lg border border-line bg-white/60 shadow-panel p-4 space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-ink/60">{editingId ? "Edit test case" : "New test case"}</p>
              {formError && <div className="rounded-md border border-alert bg-alert/5 p-2 text-xs text-alert">{formError}</div>}
              <select
                className="w-full rounded-md border border-line bg-white/60 p-2 text-sm"
                value={draft.input_id}
                onChange={(e) => setDraft((d) => ({ ...d, input_id: e.target.value }))}
                disabled={Boolean(editingId)}
              >
                {inputs.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.type} — {i.content.slice(0, 60)}
                  </option>
                ))}
              </select>
              <input
                className="w-full rounded-md border border-line bg-white/60 p-2 text-sm"
                placeholder="Title"
                value={draft.title}
                onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
              />
              <div className="grid gap-2 sm:grid-cols-2">
                <select
                  className="rounded-md border border-line bg-white/60 p-2 text-sm"
                  value={draft.category}
                  onChange={(e) => setDraft((d) => ({ ...d, category: e.target.value }))}
                >
                  {CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
                <select
                  className="rounded-md border border-line bg-white/60 p-2 text-sm"
                  value={draft.priority}
                  onChange={(e) => setDraft((d) => ({ ...d, priority: e.target.value }))}
                >
                  {PRIORITIES.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </div>
              <textarea
                className="w-full rounded-md border border-line bg-white/60 p-2 text-sm"
                rows={4}
                placeholder={"Steps — one per line\ne.g.\nEnter a valid username\nEnter a valid password\nClick Log in"}
                value={draft.steps}
                onChange={(e) => setDraft((d) => ({ ...d, steps: e.target.value }))}
              />
              <textarea
                className="w-full rounded-md border border-line bg-white/60 p-2 text-sm"
                rows={2}
                placeholder="Expected result"
                value={draft.expected_result}
                onChange={(e) => setDraft((d) => ({ ...d, expected_result: e.target.value }))}
              />
              <div className="flex gap-2">
                <button
                  className="rounded-md bg-ink text-paper px-3 py-1.5 text-xs font-medium disabled:opacity-50"
                  disabled={busy === "create-human-tc" || busy === "edit-human-tc"}
                  onClick={submit}
                >
                  {editingId ? "Save changes" : "Create test case"}
                </button>
                {editingId && (
                  <button
                    className="rounded-md border border-line px-3 py-1.5 text-xs font-medium"
                    onClick={() => {
                      resetForm();
                      setShowForm(false);
                    }}
                  >
                    Cancel
                  </button>
                )}
              </div>
            </div>
          )}
        </>
      )}

      <div className="rounded-lg border border-line bg-white/60 shadow-panel p-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-ink/60 mb-2">
          Human-authored test cases ({humanCases.length})
        </p>
        {humanCases.length === 0 ? (
          <p className="text-sm text-ink/50">None yet — every test case so far was AI-generated.</p>
        ) : (
          <div className="space-y-2">
            {humanCases.map((tc) => (
              <div key={tc.id} className="rounded-md border border-line bg-white/50 p-3 text-sm space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{tc.title}</span>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <span className={`text-[10px] rounded-full border px-2 py-0.5 ${CATEGORY_COLOR[tc.category] ?? "bg-ink/5"}`}>{tc.category}</span>
                    <Pill tone="good">{tc.priority ?? "Medium"}</Pill>
                    <Pill>{tc.status}</Pill>
                  </div>
                </div>
                <ul className="list-disc pl-5 text-xs text-ink/60">
                  {tc.steps.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ul>
                <p className="text-xs text-ink/60">Expected: {tc.expected_result}</p>
                <div className="flex gap-2 pt-1">
                  <button className="rounded border border-ink/20 text-ink/70 px-2 py-1 text-xs" onClick={() => startEdit(tc)}>
                    Edit
                  </button>
                  <button
                    className="rounded border border-alert text-alert px-2 py-1 text-xs disabled:opacity-50"
                    disabled={busy === `delete-human-tc-${tc.id}`}
                    onClick={() => remove(tc.id)}
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
