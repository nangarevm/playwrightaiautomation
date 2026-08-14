import { useState, DragEvent } from "react";
import { useApp } from "../context/AppState.js";
import { api } from "../api.js";
import { Pill } from "../components/Pill.js";
import { Spinner, CheckIcon } from "../components/StatusIcon.js";

// IA note: the six input mechanisms this page originally exposed as six equal-weight
// top-level tabs collapse into four groups by user intent, not by removing anything:
//  - "Upload Files" merges the old "PDF/Word/Excel Docs" and "Screenshots & Video" tabs.
//    Both were the same action ("drag/pick files, they upload"); they only differed in
//    which of two upload endpoints handles a given file, which the UI can dispatch on
//    file extension instead of asking the user to pick the right tab first.
//  - "Integrations" merges "Swagger/Postman" and "Jira/Azure DevOps". Both are lower-
//    frequency "pull structured data from another system" actions with credential/paste
//    fields, distinct from the primary create-an-input flows -- grouped as a sub-choice
//    rather than given equal top billing.
//  - "Live URL Crawl" and "Free-text Scenario" stay top-level: each has a genuinely
//    different shape (URL + auth fields vs. a plain textarea) and is a primary, frequent
//    entry point, so merging either into another tab would just relocate the clutter.
// Every underlying capability (both upload endpoints, both integrations, crawl auth,
// free text) remains fully reachable -- nothing was hidden or removed.
type Tab = "upload" | "crawl" | "integrations" | "freetext";
type IntegrationTab = "api" | "external";

// FR-9.3: render the same generation_status lifecycle (none/pending/queued/
// retrying/completed/failed) that already lives on every `inputs` row, as a
// pill matching the tone conventions used everywhere else in this page.
function GenerationStatusPill({ status }: { status?: string }) {
  switch (status) {
    case "pending":
      return (
        <Pill tone="warn">
          <Spinner /> Generating…
        </Pill>
      );
    case "queued":
      return (
        <Pill tone="warn">
          <Spinner /> Generation queued
        </Pill>
      );
    case "retrying":
      return (
        <Pill tone="warn">
          <Spinner /> Retrying…
        </Pill>
      );
    case "completed":
      return (
        <Pill tone="good">
          <CheckIcon /> Test cases generated
        </Pill>
      );
    case "failed":
      return <Pill tone="bad">Generation failed</Pill>;
    default:
      return null;
  }
}

const TABS: { key: Tab; label: string }[] = [
  { key: "crawl", label: "Website" },
  { key: "upload", label: "Upload files" },
  { key: "freetext", label: "Describe" },
  { key: "integrations", label: "Integrations" },
];

const btnPrimary =
  "inline-flex items-center gap-1.5 rounded-md bg-ink text-paper px-4 py-2 text-sm font-medium transition-all duration-150 hover:bg-ink/90 active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100";
const btnOutline =
  "inline-flex items-center gap-1.5 rounded-md border border-signal text-signal px-3 py-1.5 text-xs font-medium transition-all duration-150 hover:bg-signal-soft active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100";
const btnGhost =
  "inline-flex items-center gap-1.5 rounded-md border border-ink/20 text-ink/70 px-3 py-1.5 text-xs font-medium transition-all duration-150 hover:bg-ink/5 hover:border-ink/40 active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100";
const fieldClass =
  "rounded-md border border-line bg-white/60 p-2 text-sm transition-colors duration-150 focus:outline-none focus:ring-2 focus:ring-signal focus:border-signal";

// Lightweight drag-and-drop zone, additive to (never replacing) the classic
// "Choose Files" picker -- both paths funnel into the same onFiles callback.
function DropZone({
  accept,
  multiple = true,
  onFiles,
  hint,
}: {
  accept: string;
  multiple?: boolean;
  onFiles: (files: File[]) => void;
  hint: string;
}) {
  const [dragOver, setDragOver] = useState(false);

  const stop = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div
      onDragOver={(e) => {
        stop(e);
        setDragOver(true);
      }}
      onDragEnter={(e) => {
        stop(e);
        setDragOver(true);
      }}
      onDragLeave={(e) => {
        stop(e);
        setDragOver(false);
      }}
      onDrop={(e) => {
        stop(e);
        setDragOver(false);
        const files = Array.from(e.dataTransfer.files ?? []);
        if (files.length > 0) onFiles(files);
      }}
      className={`mt-3 rounded-md border-2 border-dashed p-5 text-center transition-colors duration-150 ${
        dragOver ? "border-signal bg-signal/5" : "border-line/70 bg-white/30"
      }`}
    >
      <p className="text-xs text-ink/50">{dragOver ? "Drop to add files" : hint}</p>
      <label
        className={`mt-3 inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-line bg-white px-3 py-1.5 text-xs font-medium text-ink/80 transition-colors duration-150 hover:border-ink/40 hover:bg-ink/5`}
      >
        Choose Files
        <input
          className="hidden"
          type="file"
          accept={accept}
          multiple={multiple}
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            if (files.length > 0) onFiles(files);
            e.target.value = "";
          }}
        />
      </label>
    </div>
  );
}

function EmptyState({ icon, text }: { icon: string; text: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-md border border-dashed border-line/70 bg-white/20 py-10 text-center">
      <span className="text-2xl leading-none opacity-70">{icon}</span>
      <p className="max-w-xs text-sm text-ink/50">{text}</p>
    </div>
  );
}

const UPLOAD_ACCEPT =
  "image/png,image/jpeg,image/jpg,video/mp4,video/webm,video/avi,video/mov,.pdf,.docx,.xlsx,.xls,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel";

export default function Projects({ compact = false }: { compact?: boolean }) {
  const {
    inputs,
    draftInput,
    setDraftInput,
    batchUrl,
    setBatchUrl,
    crawlUsername,
    setCrawlUsername,
    crawlPassword,
    setCrawlPassword,
    crawlSessionToken,
    setCrawlSessionToken,
    screenshots,
    setScreenshots,
    videos,
    setVideos,
    uploadedFiles,
    setUploadedFiles,
    documents,
    setDocuments,
    documentResults,
    setDocumentResults,
    openApiText,
    setOpenApiText,
    postmanText,
    setPostmanText,
    businessRules,
    setBusinessRules,
    externalProvider,
    setExternalProvider,
    externalBaseUrl,
    setExternalBaseUrl,
    externalToken,
    setExternalToken,
    externalIssueIds,
    setExternalIssueIds,
    busy,
    withBusy,
    setError,
  } = useApp();

  const [tab, setTab] = useState<Tab>("crawl");
  const [integrationTab, setIntegrationTab] = useState<IntegrationTab>("api");
  const [showCrawlAuth, setShowCrawlAuth] = useState(false);

  // Classify a mixed drop/pick of files across the two upload endpoints this
  // tab now fronts: images/video -> /inputs/upload, everything else (pdf/
  // word/excel) -> /inputs/upload-documents. Mirrors the original per-tab
  // onChange filters exactly, just applied to one combined selection.
  function handleUploadFiles(files: File[]) {
    const images = files.filter((f) => f.type.startsWith("image/"));
    const vids = files.filter((f) => f.type.startsWith("video/"));
    const docs = files.filter((f) => !f.type.startsWith("image/") && !f.type.startsWith("video/"));
    setScreenshots(images);
    setVideos(vids);
    setDocuments(docs);
  }

  const pendingUploadCount = screenshots.length + videos.length + documents.length;

  return (
    <div className={compact ? "space-y-3" : "space-y-6"}>
      {!compact && (
        <>
          <div>
            <h2 className="font-display text-xl tracking-tight">Projects</h2>
            <p className="text-sm text-ink/60">Bring in requirements, docs, and scenarios to analyze</p>
          </div>
          <div className="rounded-lg border border-line bg-white/60 shadow-panel p-3">
            <div className="flex flex-wrap items-center gap-2 text-xs text-ink/60">
              <Pill tone="good">1 · Analyze</Pill>
              <span className="text-ink/30">→</span>
              <Pill>2 · Generate</Pill>
              <span className="text-ink/30">→</span>
              <Pill>3 · Execute</Pill>
              <span className="ml-auto text-ink/50">Business rules carry across every input type</span>
            </div>
          </div>
        </>
      )}

      <div className={compact ? "space-y-3" : "grid grid-cols-[220px_1fr] gap-4"}>
        {compact ? (
          <div className="flex flex-wrap gap-1.5">
            {TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                className={`rounded-full px-3 py-1.5 text-xs font-medium transition ${
                  tab === t.key ? "bg-ink text-paper" : "border border-line text-ink/60 hover:border-ink/40"
                }`}
                onClick={() => setTab(t.key)}
              >
                {t.label}
              </button>
            ))}
          </div>
        ) : (
          <ul className="space-y-1.5">
            {TABS.map((t) => (
              <li key={t.key}>
                <button
                  className={`w-full flex items-center gap-2.5 rounded-md border px-3 py-2.5 text-left text-sm font-medium transition-all duration-150 ${
                    tab === t.key
                      ? "border-ink bg-ink text-paper shadow-sm"
                      : "border-line bg-white/50 text-ink/70 hover:border-ink/30 hover:bg-ink/5 hover:text-ink"
                  }`}
                  onClick={() => setTab(t.key)}
                >
                  <span>{t.label}</span>
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className={`rounded-lg border border-line bg-white/60 shadow-panel ${compact ? "p-4 space-y-3" : "min-h-[440px] p-4"}`}>
          {tab === "freetext" && (
            <div className="space-y-3">
              <label className="block space-y-1">
                <span className="text-xs font-medium text-ink/70">What should be tested?</span>
                <textarea
                  className={`w-full ${fieldClass} p-3`}
                  rows={compact ? 3 : 5}
                  placeholder="e.g. Login page with username, password, and a Log in button…"
                  value={draftInput}
                  onChange={(e) => setDraftInput(e.target.value)}
                />
              </label>
              {!compact && (
                <textarea
                  className={`w-full ${fieldClass}`}
                  rows={2}
                  placeholder="Business rules / approval thresholds"
                  value={businessRules}
                  onChange={(e) => setBusinessRules(e.target.value)}
                />
              )}
              <button
                className={btnPrimary}
                disabled={busy === "ingest" || !draftInput.trim()}
                onClick={() =>
                  withBusy("ingest", async () => {
                    const text = draftInput.trim();
                    const input = await api.createInput(text, "free_text", businessRules.trim() || undefined);
                    if (screenshots.length > 0 || videos.length > 0) {
                      await api.uploadFiles(screenshots, videos);
                    }
                    await api.generateTestCases(input.id);
                  })
                }
              >
                {busy === "ingest" && <Spinner className="h-3.5 w-3.5" />}
                {busy === "ingest" ? "Generating…" : "Generate test cases"}
              </button>
            </div>
          )}

          {tab === "upload" && (
            <div className="space-y-3">
              <div className="rounded-md border border-line bg-white/50 p-3">
                {!compact && (
                  <>
                    <p className="text-sm font-medium">Upload files</p>
                    <p className="mt-1 text-xs text-ink/60">
                      Drop screenshots, videos, or documents (PDF, Word, Excel) — routed automatically.
                    </p>
                  </>
                )}
                <DropZone
                  accept={UPLOAD_ACCEPT}
                  onFiles={handleUploadFiles}
                  hint={compact ? "Drop files here or choose" : "Drag files here, or"}
                />

                {pendingUploadCount > 0 && (
                  <p className="mt-2 text-xs text-ink/60">
                    Selected: {[...screenshots, ...videos, ...documents].map((f) => f.name).join(", ")}
                  </p>
                )}

                <button
                  className={`mt-3 ${btnOutline}`}
                  disabled={busy === "files-upload"}
                  onClick={() =>
                    withBusy("files-upload", async () => {
                      if (pendingUploadCount === 0) {
                        setError("No files selected. Choose or drop one or more files first.");
                        return;
                      }

                      if (screenshots.length > 0 || videos.length > 0) {
                        const result = await api.uploadFiles(screenshots, videos);
                        setUploadedFiles([...uploadedFiles, ...(result.uploaded ?? [])]);
                      }

                      if (documents.length > 0) {
                        const selected = documents;
                        // Uploading: show every selected doc immediately so the queue
                        // reflects "in flight" before the network round trip resolves.
                        setDocumentResults((prev) => [
                          ...prev,
                          ...selected.map((f) => ({ originalName: f.name, size: f.size, status: "uploading" as any })),
                        ]);

                        const result = await api.uploadDocuments(selected);
                        const parsed = result.documents ?? [];

                        // Uploaded/Parsed: replace the placeholder "uploading" rows with the
                        // real per-file outcome from the server (parsed vs. failed).
                        setDocumentResults((prev) => {
                          const withoutUploading = prev.filter(
                            (p) => !(p.status === ("uploading" as any) && selected.some((f) => f.name === p.originalName))
                          );
                          return [...withoutUploading, ...parsed.map((d) => ({ ...d, generation: d.status === "parsed" ? ("queued" as const) : undefined }))];
                        });

                        // Generating/generated: mirror the free-text tab's "submit & generate"
                        // flow by triggering generation right after ingestion for every
                        // successfully parsed document, and track the result per file.
                        for (const doc of parsed) {
                          if (doc.status !== "parsed" || !doc.inputId) continue;
                          setDocumentResults((prev) => prev.map((p) => (p.inputId === doc.inputId ? { ...p, generation: "generating" } : p)));
                          try {
                            await api.generateTestCases(doc.inputId);
                            setDocumentResults((prev) => prev.map((p) => (p.inputId === doc.inputId ? { ...p, generation: "generated" } : p)));
                          } catch (err: any) {
                            setDocumentResults((prev) =>
                              prev.map((p) => (p.inputId === doc.inputId ? { ...p, generation: err?.queued ? "queued" : "failed" } : p))
                            );
                          }
                        }
                      }

                      setScreenshots([]);
                      setVideos([]);
                      setDocuments([]);
                    })
                  }
                >
                  {busy === "files-upload" && <Spinner />}
                  {busy === "files-upload" ? "Uploading…" : "Upload"}
                </button>
              </div>

              {uploadedFiles.length === 0 && documentResults.length === 0 ? (
                <EmptyState icon="📥" text="No files uploaded yet. Drag screenshots, videos, or documents into the drop zone above to get started." />
              ) : (
                <>
                  {uploadedFiles.length > 0 && (
                    <div className="rounded-md border border-line bg-white/50 p-3">
                      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink/60">Screenshots &amp; videos</p>
                      <ul className="grid grid-cols-4 gap-3">
                        {uploadedFiles.map((f, i) => (
                          <li
                            key={`${f.url}-${i}`}
                            className="animate-fade-slide-in rounded-md border border-line bg-white p-2 text-center"
                          >
                            {f.kind === "screenshot" ? (
                              <img src={f.url} alt={f.originalName} className="h-16 w-full rounded object-cover" />
                            ) : (
                              <div className="flex h-16 w-full items-center justify-center rounded bg-ink/5 text-xs text-ink/40">video</div>
                            )}
                            <p className="mt-1 flex items-center justify-center gap-1 truncate text-[10px] text-ink/60" title={f.originalName}>
                              <CheckIcon className="h-2.5 w-2.5 shrink-0 text-signal" />
                              {f.originalName}
                            </p>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {documentResults.length > 0 && (
                    <div className="rounded-md border border-line bg-white/50 p-3">
                      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink/60">Documents</p>
                      <ul className="space-y-1">
                        {documentResults.map((d, i) => (
                          <li
                            key={`${d.originalName}-${i}`}
                            className="animate-fade-slide-in flex flex-wrap items-center gap-2 rounded-md border border-line bg-white p-2 text-xs"
                          >
                            <span className="min-w-[8rem] flex-1 truncate" title={d.originalName}>{d.originalName}</span>
                            {(d.status as any) === "uploading" && (
                              <Pill>
                                <Spinner /> Uploading…
                              </Pill>
                            )}
                            {d.status === "parsed" && (
                              <Pill tone="good">
                                <CheckIcon /> Uploaded
                              </Pill>
                            )}
                            {d.status === "parsed" && (
                              <Pill tone="good">
                                <CheckIcon /> Parsed
                              </Pill>
                            )}
                            {d.status === "failed" && <Pill tone="bad">{d.error || "Could not parse this file"}</Pill>}
                            {d.generation === "queued" && (
                              <Pill tone="warn">
                                <Spinner /> Generation queued
                              </Pill>
                            )}
                            {d.generation === "generating" && (
                              <Pill tone="warn">
                                <Spinner /> Generating…
                              </Pill>
                            )}
                            {d.generation === "generated" && (
                              <Pill tone="good">
                                <CheckIcon /> Test cases generated
                              </Pill>
                            )}
                            {d.generation === "failed" && <Pill tone="bad">Generation failed</Pill>}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {tab === "crawl" && (
            <div className="space-y-3">
              <label className="block space-y-1">
                <span className="text-xs font-medium text-ink/70">Website URL</span>
                <input
                  className={`w-full ${fieldClass}`}
                  placeholder="https://your-site.com"
                  value={batchUrl}
                  onChange={(e) => setBatchUrl(e.target.value)}
                />
              </label>
              {compact ? (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      className={btnPrimary}
                      disabled={busy === "crawl" || !batchUrl.trim()}
                      onClick={() =>
                        withBusy("crawl", async () => {
                          await api.crawlUrl(batchUrl.trim(), 2, {
                            username: crawlUsername.trim() || undefined,
                            password: crawlPassword.trim() || undefined,
                            sessionToken: crawlSessionToken.trim() || undefined,
                          });
                        })
                      }
                    >
                      {busy === "crawl" && <Spinner className="h-3.5 w-3.5" />}
                      {busy === "crawl" ? "Crawling…" : "Crawl website"}
                    </button>
                    <button type="button" className="text-xs text-ink/50 underline-offset-2 hover:underline" onClick={() => setShowCrawlAuth((v) => !v)}>
                      {showCrawlAuth ? "Hide login" : "Login required?"}
                    </button>
                  </div>
                  {showCrawlAuth && (
                    <div className="grid gap-2 sm:grid-cols-2">
                      <input className={fieldClass} placeholder="Username" value={crawlUsername} onChange={(e) => setCrawlUsername(e.target.value)} />
                      <input className={fieldClass} type="password" placeholder="Password" value={crawlPassword} onChange={(e) => setCrawlPassword(e.target.value)} />
                    </div>
                  )}
                </>
              ) : (
                <>
                  <div className="space-y-2 rounded-md border border-line bg-white/50 p-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-ink/60">Optional authentication</p>
                    <div className="grid gap-2 sm:grid-cols-2">
                      <input className={fieldClass} placeholder="Username" value={crawlUsername} onChange={(e) => setCrawlUsername(e.target.value)} />
                      <input className={fieldClass} type="password" placeholder="Password" value={crawlPassword} onChange={(e) => setCrawlPassword(e.target.value)} />
                    </div>
                    <input className={`w-full ${fieldClass}`} placeholder="Session token (optional)" value={crawlSessionToken} onChange={(e) => setCrawlSessionToken(e.target.value)} />
                  </div>
                  <button
                    className={btnGhost}
                    disabled={busy === "crawl"}
                    onClick={() =>
                      withBusy("crawl", async () => {
                        if (!batchUrl.trim()) throw new Error("Enter a URL first.");
                        await api.crawlUrl(batchUrl.trim(), 2, {
                          username: crawlUsername.trim() || undefined,
                          password: crawlPassword.trim() || undefined,
                          sessionToken: crawlSessionToken.trim() || undefined,
                        });
                      })
                    }
                  >
                    {busy === "crawl" && <Spinner />}
                    {busy === "crawl" ? "Crawling…" : "Crawl URL"}
                  </button>
                </>
              )}
            </div>
          )}

          {tab === "integrations" && (
            <div className="space-y-4">
              <div>
                <p className="text-sm font-medium">Integrations</p>
                <p className="mt-1 text-xs text-ink/60">Pull structured input from an API spec or an external tracker.</p>
              </div>

              <div className="inline-flex items-center rounded-full border border-line bg-white/60 p-0.5 text-xs">
                <button
                  className={`rounded-full px-3 py-1.5 font-medium transition-colors duration-150 ${
                    integrationTab === "api" ? "bg-ink text-paper" : "text-ink/60 hover:text-ink"
                  }`}
                  onClick={() => setIntegrationTab("api")}
                >
                  Swagger/Postman
                </button>
                <button
                  className={`rounded-full px-3 py-1.5 font-medium transition-colors duration-150 ${
                    integrationTab === "external" ? "bg-ink text-paper" : "text-ink/60 hover:text-ink"
                  }`}
                  onClick={() => setIntegrationTab("external")}
                >
                  Jira/Azure DevOps
                </button>
              </div>

              {integrationTab === "api" && (
                <div className="space-y-3">
                  <textarea
                    className={`w-full ${fieldClass}`}
                    rows={5}
                    placeholder="Paste Swagger/OpenAPI JSON/YAML here"
                    value={openApiText}
                    onChange={(e) => setOpenApiText(e.target.value)}
                  />
                  <button
                    className={btnGhost}
                    disabled={busy === "openapi"}
                    onClick={() =>
                      withBusy("openapi", async () => {
                        if (!openApiText.trim()) throw new Error("Paste OpenAPI/Swagger content first.");
                        await api.importOpenApi(openApiText.trim());
                      })
                    }
                  >
                    {busy === "openapi" && <Spinner />}
                    {busy === "openapi" ? "Importing…" : "Import OpenAPI"}
                  </button>
                  <textarea
                    className={`w-full ${fieldClass}`}
                    rows={5}
                    placeholder="Paste a Postman collection JSON here"
                    value={postmanText}
                    onChange={(e) => setPostmanText(e.target.value)}
                  />
                  <button
                    className={btnGhost}
                    disabled={busy === "postman"}
                    onClick={() =>
                      withBusy("postman", async () => {
                        if (!postmanText.trim()) throw new Error("Paste a Postman collection first.");
                        await api.importPostman(postmanText.trim());
                      })
                    }
                  >
                    {busy === "postman" && <Spinner />}
                    {busy === "postman" ? "Importing…" : "Import Postman"}
                  </button>
                </div>
              )}

              {integrationTab === "external" && (
                <div className="space-y-3">
                  <div className="flex flex-wrap gap-2">
                    <select
                      className={fieldClass}
                      value={externalProvider}
                      onChange={(e) => setExternalProvider(e.target.value as "jira" | "azure")}
                    >
                      <option value="jira">Jira</option>
                      <option value="azure">Azure DevOps</option>
                    </select>
                    <input
                      className={fieldClass}
                      placeholder="https://company.atlassian.net"
                      value={externalBaseUrl}
                      onChange={(e) => setExternalBaseUrl(e.target.value)}
                    />
                    <input
                      className={fieldClass}
                      placeholder="token"
                      value={externalToken}
                      onChange={(e) => setExternalToken(e.target.value)}
                    />
                    <input
                      className={fieldClass}
                      placeholder="ABC-123, DEF-456"
                      value={externalIssueIds}
                      onChange={(e) => setExternalIssueIds(e.target.value)}
                    />
                  </div>
                  <button
                    className={btnPrimary}
                    disabled={busy === "external"}
                    onClick={() =>
                      withBusy("external", async () => {
                        if (!externalBaseUrl.trim() || !externalToken.trim() || !externalIssueIds.trim())
                          throw new Error("Provide base URL, token, and issue IDs.");
                        await api.importExternal(externalProvider, externalBaseUrl.trim(), externalToken.trim(), externalIssueIds.trim());
                      })
                    }
                  >
                    {busy === "external" && <Spinner className="h-3.5 w-3.5" />}
                    {busy === "external" ? "Importing…" : "Import external work items"}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {inputs.length > 0 && (
        <div className={`rounded-lg border border-line bg-white/60 shadow-panel ${compact ? "p-3" : "p-4"}`}>
          <p className="mb-2 text-xs font-medium text-ink/60">{inputs.length} input(s) ready — go to Review</p>
          <ul className="space-y-1 text-xs text-ink/70">
            {inputs.slice(0, compact ? 5 : undefined).map((i) => (
              <li key={i.id} className="flex items-center gap-2 rounded-md border border-line bg-white/50 px-2 py-1.5">
                <span className="flex-1 truncate">{i.content.slice(0, 80)}{i.content.length > 80 ? "…" : ""}</span>
                <GenerationStatusPill status={i.generation_status} />
              </li>
            ))}
            {compact && inputs.length > 5 && <li className="text-ink/40 px-1">+{inputs.length - 5} more</li>}
          </ul>
        </div>
      )}
      {!compact && inputs.length === 0 && (
        <div className="rounded-lg border border-line bg-white/60 shadow-panel p-4">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink/60">Inputs</p>
          <EmptyState icon="🗂️" text="No inputs yet. Upload a document, crawl a URL, or write a scenario above to get started." />
        </div>
      )}
    </div>
  );
}
