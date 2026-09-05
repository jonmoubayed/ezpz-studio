import { isLowConfidence } from "./confidence";
import { ExpectedValuesEditor, FieldValues } from "./expected-values";
import { FieldSelect } from "./components/field-select";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  Braces,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Code2,
  Copy,
  Download,
  ExternalLink,
  FileScan,
  FileText,
  Flag,
  Focus,
  Layers,
  MessageSquareText,
  Play,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Target,
  X,
} from "lucide-react";
import type { PDFViewerHandle } from "./components/extend/pdf-viewer";
const PDFViewer = lazy(() =>
  import("./components/extend/pdf-viewer").then((m) => ({
    default: m.PDFViewer,
  })),
);
import { HumanReviewHighlight } from "./components/extend/human-review-highlight";
import {
  ConfidenceBadge,
  Button,
  Badge,
  Busy,
  Empty,
  Heading,
  Modal,
} from "./ui";
import { useStudio } from "./store";
import { ModelMark } from "./pages";
import {
  downloadJson,
  displayValue,
  type JsonValue,
  type Document,
  type Field,
} from "./domain";
import * as api from "./api";
export function SourceViewer({
  document,
  field,
}: {
  document: Document;
  field?: Field;
}) {
  const viewer = useRef<PDFViewerHandle>(null);
  const container = useRef<HTMLDivElement>(null);
  const [viewerWidth, setViewerWidth] = useState(600);
  useEffect(() => {
    if (!container.current) return;
    const observer = new ResizeObserver(([entry]) =>
      setViewerWidth(entry.contentRect.width),
    );
    observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  const [text, setText] = useState("");
  const [viewerReady, setViewerReady] = useState(0);
  const citations = field?.citations?.length
    ? field.citations
    : field?.area
      ? [{ page: field.page || 1, area: field.area }]
      : [];
  useEffect(() => {
    if (field?.area)
      viewer.current?.scrollToPageArea(field.page || 1, field.area);
  }, [field?.key, field?.page, field?.area, document.id, viewerReady]);
  useEffect(() => {
    setText("");
    if (document.type.startsWith("text/")) {
      const abort = new AbortController();
      fetch(document.src, { signal: abort.signal })
        .then((r) => r.text())
        .then(setText)
        .catch(() => {});
      return () => abort.abort();
    }
  }, [document.src]);
  return (
    <div className="source-viewer" ref={container}>
      {document.type.includes("pdf") ||
      document.name.toLowerCase().endsWith(".pdf") ? (
        <Suspense
          fallback={
            <div className="empty">
              <Busy label="Loading document viewer…" />
            </div>
          }
        >
          <PDFViewer
            ref={viewer}
            onDocumentLoadSuccess={() =>
              requestAnimationFrame(() => setViewerReady((v) => v + 1))
            }
            defaultZoom={Math.max(0.25, Math.min(1, (viewerWidth - 40) / 612))}
            src={document.src}
            fileName={document.name}
            showUpload={false}
            showRotateControls={false}
            className="actual-pdf-viewer h-full border-0 rounded-none"
            renderPageOverlay={({ pageNumber }) =>
              citations
                .filter((c) => c.page === pageNumber)
                .map((citation, index) => (
                  <HumanReviewHighlight
                    key={`${pageNumber}-${index}`}
                    location={citation}
                  />
                ))
            }
          />
        </Suspense>
      ) : document.type.startsWith("image/") ? (
        <div className="image-source">
          <div className="image-page">
            <img src={document.src} alt={`Source document: ${document.name}`} />
            {citations
              .filter((c) => c.page === 1)
              .map((citation, index) => (
                <HumanReviewHighlight key={index} location={citation} />
              ))}
          </div>
        </div>
      ) : document.type.startsWith("text/") ? (
        <pre className="text-source">{text || "Loading source…"}</pre>
      ) : (
        <Empty
          title="Preview unavailable for this format"
          description="Download the original file, or upload a PDF or image."
          action={
            <a className="btn" href={document.src} download={document.name}>
              Download original
            </a>
          }
        />
      )}
    </div>
  );
}
export function WorkbenchControls({
  onConfigure,
  onSchema,
  status,
}: {
  onConfigure: () => void;
  onSchema: () => void;
  status?: string;
}) {
  const s = useStudio();
  return (
    <>
      <div className="playground-processor">
        <label>
          Processor
          <FieldSelect
            aria-label="Playground processor"
            disabled={s.busy}
            value={s.activeProcessor?.id || ""}
            onValueChange={(value) => {
              const p = s.processors.find((p) => p.id === value);
              if (p) s.chooseProcessor(p);
            }}
            options={[
              { value: "", label: "Unsaved configuration", disabled: true },
              ...s.processors.map((p) => ({
                value: p.id,
                label: p.name + " · v" + p.version,
              })),
            ]}
          />
        </label>
        <button onClick={s.saveAsProcessor}>Save as processor</button>
        <button onClick={() => s.navigate("Processors")}>
          Manage processors <ArrowRight size={12} />
        </button>
      </div>
      <div className="workbench-config">
        <div>
          <button className="config-step" onClick={onConfigure}>
            <span>01</span>
            <FileScan size={14} />
            {s.config.parser === "native" ? "Native text" : s.config.parser}
          </button>
          <ChevronRight size={13} />
          <button className="config-step" onClick={onConfigure}>
            <span>02</span>
            <ModelMark provider={s.config.provider} />
            {s.config.model}
            <ChevronDown size={12} />
          </button>
          <ChevronRight size={13} />
          <button className="config-step" onClick={onSchema}>
            <span>03</span>
            <Braces size={14} />
            Output schema
          </button>
        </div>
        <Badge tone={s.mode === "demo" ? "orange" : "green"}>
          {status ||
            (s.mode === "demo" ? "Sample fixture" : "Live configuration")}
        </Badge>
      </div>
    </>
  );
}

export function WorkbenchSource({
  document: d,
  field,
  label = "Source document",
  onDocumentChange,
}: {
  document?: Document;
  field?: Field;
  label?: string;
  onDocumentChange?: () => void;
}) {
  const s = useStudio();
  const [filesOpen, setFilesOpen] = useState(false);
  const [q, setQ] = useState("");
  return (
    <>
      <section className="source-pane" aria-label={label}>
        <div className="pane-heading">
          <button
            className="source-selector"
            disabled={s.busy}
            onClick={() => setFilesOpen(true)}
          >
            <span className="pdf-icon">
              <FileText size={16} />
            </span>
            <strong>{d?.name || "Choose a source document"}</strong>
            <ChevronDown size={14} />
          </button>
          <button
            className="icon-button"
            aria-label="Upload document"
            disabled={s.busy}
            onClick={() => s.setUploadOpen(true)}
          >
            <Plus size={17} />
          </button>
        </div>
        {d ? (
          <SourceViewer document={d} field={field} />
        ) : (
          <Empty
            title="Add a test document"
            description="Keep the source beside your schema as you build."
            action={
              <Button onClick={() => s.setUploadOpen(true)}>
                <Plus size={15} />
                Add document
              </Button>
            }
          />
        )}
        <div className="source-footer">
          <span>
            <ShieldCheck size={13} />
            Original source
          </span>
          {d && (
            <a href={d.src} download={d.name}>
              <Download size={13} />
              Download
            </a>
          )}
          <span>Viewer by Extend UI</span>
        </div>
      </section>
      <Modal
        title="Choose a source document"
        description="Inspect an existing document or add a new one."
        open={filesOpen}
        onClose={() => setFilesOpen(false)}
      >
        <div className="search-box">
          <Search size={16} />
          <input
            aria-label="Find source document"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Find a document…"
          />
        </div>
        <div className="command-results">
          {s.documents
            .filter((x) => x.name.toLowerCase().includes(q.toLowerCase()))
            .map((x) => (
              <button
                key={x.id}
                onClick={() => {
                  s.selectDocument(x);
                  setFilesOpen(false);
                  onDocumentChange?.();
                }}
              >
                <FileText size={16} />
                {x.name}
                {d?.id === x.id ? (
                  <Check size={15} />
                ) : (
                  <ArrowRight size={15} />
                )}
              </button>
            ))}
        </div>
        <Button
          onClick={() => {
            setFilesOpen(false);
            s.setUploadOpen(true);
          }}
        >
          <Plus size={14} />
          Add documents
        </Button>
      </Modal>
    </>
  );
}

export function Playground() {
  const s = useStudio();
  const [tab, setTab] = useState("Fields");
  const [active, setActive] = useState("invoice_number");
  const [groundTruthOpen, setGroundTruthOpen] = useState(false);
  const d = s.selected;
  const field = d?.fields.find((f) => f.key === active);
  const json = Object.fromEntries(d?.fields.map((f) => [f.key, f.value]) || []);
  return (
    <>
      <Heading
        title={s.activeProcessor ? s.activeProcessor.name : "Playground"}
        description="Test an extractor and inspect its output against the source."
        actions={
          <>
            <Button onClick={() => s.navigate("Configuration")}>
              <Settings2 size={15} />
              Configure
            </Button>
            <Button
              variant="primary"
              disabled={s.busy || !d}
              onClick={s.extract}
            >
              {s.busy ? (
                <Busy label="Extracting…" />
              ) : (
                <>
                  <Play size={14} />
                  Run extraction
                </>
              )}
            </Button>
          </>
        }
      />
      <WorkbenchControls
        onConfigure={() => s.navigate("Configuration")}
        onSchema={() => s.navigate("Configuration")}
      />
      {!d ? (
        <Empty
          title="A blank page, full of possibilities."
          description="Add a document to explore your extraction workflow."
          action={
            <Button variant="primary" onClick={() => s.setUploadOpen(true)}>
              <Plus size={15} />
              Add a document
            </Button>
          }
        />
      ) : (
        <div className="workbench-layout">
          <WorkbenchSource document={d} field={field} />
          <section className="results-pane">
            <div className="pane-heading">
              <span className="results-title">
                <Braces size={17} />
                Extraction output
              </span>
              <button
                className="icon-button"
                aria-label="Export extraction JSON"
                onClick={() => downloadJson(`${d.name}.json`, json)}
              >
                <Download size={16} />
              </button>
            </div>
            <div className="results-tabs">
              {["Fields", "JSON", "Expected", "Schema"].map((t) => (
                <button
                  key={t}
                  className={tab === t ? "active" : ""}
                  onClick={() => setTab(t)}
                >
                  {t}
                  {t === "Fields" && <span>{d.fields.length}</span>}
                </button>
              ))}
            </div>
            {tab === "Fields" ? (
              <>
                <div className="result-status">
                  <span>
                    <i />
                    {d.fields.length ? "Extraction ready" : "Ready to extract"}
                  </span>
                  <Badge>{d.fields.length} fields</Badge>
                </div>
                {d.fields.length ? (
                  <div className="field-list">
                    {d.fields.map((f) => (
                      <button
                        key={f.key}
                        className={`field-card ${active === f.key ? "selected" : ""} ${isLowConfidence(f) ? "uncertain" : ""}`}
                        onClick={() => setActive(f.key)}
                      >
                        <div>
                          <span className="field-name">
                            <span>
                              {typeof f.value === "number" ? "#" : "Aa"}
                            </span>
                            {f.key}
                          </span>
                          <ConfidenceBadge field={f} />
                        </div>
                        <FieldValues field={f} />
                        <small>
                          {f.area ? (
                            <>
                              <Focus size={11} />
                              Source · page {f.page || 1}
                              <ArrowUpRightIcon />
                            </>
                          ) : (
                            <>
                              <FileText size={11} />
                              No source citation available
                            </>
                          )}
                        </small>
                      </button>
                    ))}
                  </div>
                ) : (
                  <Empty
                    title="Your fields will appear here"
                    description="Choose a model and schema, then run an extraction."
                  />
                )}
              </>
            ) : tab === "Expected" ? (
              <div className="expected-tab">
                <ExpectedValuesEditor key={d.id} document={d} />
              </div>
            ) : tab === "JSON" ? (
              <pre className="json-output extraction-json">
                {JSON.stringify(json, null, 2)}
              </pre>
            ) : (
              <div className="schema-view">
                <p>The schema defines the shape of your extraction.</p>
                <pre className="json-output">{s.config.schema}</pre>
                <Button onClick={() => s.navigate("Configuration")}>
                  <Braces size={14} />
                  Edit schema
                </Button>
              </div>
            )}
            {d.warnings?.length ? (
              <div className="provider-warnings">
                {d.warnings.map((w, i) => (
                  <p key={i}>{w}</p>
                ))}
              </div>
            ) : null}
            <div className="results-footer">
              <Button
                disabled={s.busy}
                onClick={() => setGroundTruthOpen(true)}
              >
                <CheckCheck size={14} />
                Edit ground truth
              </Button>
              <button
                className="icon-button"
                aria-label="Copy extraction JSON"
                onClick={() =>
                  navigator.clipboard
                    .writeText(JSON.stringify(json, null, 2))
                    .then(() => s.setMessage("Extraction JSON copied."))
                    .catch(() =>
                      s.setMessage(
                        "Clipboard unavailable. Use Export JSON instead.",
                      ),
                    )
                }
              >
                <Copy size={15} />
              </button>
            </div>
          </section>
        </div>
      )}
      <Modal
        title="Document ground truth"
        description="Use the source to provide expected values for future evaluations."
        open={groundTruthOpen}
        onClose={() => setGroundTruthOpen(false)}
      >
        {d && (
          <ExpectedValuesEditor
            key={d.id}
            document={d}
            onSaved={() => {
              setGroundTruthOpen(false);
              s.setMessage("Document ground truth saved.");
            }}
          />
        )}
      </Modal>
    </>
  );
}
function ArrowUpRightIcon() {
  return <span className="citation-arrow">↗</span>;
}
export function ReviewQueue() {
  const s = useStudio();
  const [index, setIndex] = useState(0);
  const [filter, setFilter] = useState("pending");
  const [value, setValue] = useState("");
  const [note, setNote] = useState("");
  const items = s.reviewDocuments
    .filter((d) => s.mode === "demo" || d.runId)
    .flatMap((d) =>
      d.fields
        .filter(
          (f) =>
            filter === "all" ||
            isLowConfidence(f) ||
            (s.mode === "live" &&
              f.status &&
              f.status !== "correct" &&
              f.status !== "unscored"),
        )
        .map((f) => ({
          d,
          f,
          review: s.reviews.find(
            (r) =>
              r.documentId === d.id &&
              r.field === f.key &&
              r.runId === (d.runId || ""),
          ),
        })),
    )
    .filter((item) => filter === "all" || !item.review);
  const current = items[Math.min(index, Math.max(0, items.length - 1))];
  useEffect(() => {
    setValue(
      current
        ? displayValue(current.review ? current.review.value : current.f.value)
        : "",
    );
    setNote(current?.review?.note || "");
  }, [current?.d.id, current?.d.runId, current?.f.key, current?.review?.at]);
  const completed = s.reviews.length;
  async function save(status: string) {
    if (!current) return;
    let corrected: JsonValue = value;
    if (
      typeof current.f.value === "boolean" ||
      typeof current.f.value === "object"
    ) {
      try {
        corrected = JSON.parse(value);
      } catch {
        s.setMessage("Enter valid JSON for this structured field.");
        return;
      }
    }
    if (typeof current.f.value === "number") {
      corrected = Number(value);
      if (!Number.isFinite(corrected)) {
        s.setMessage("Enter a valid number for this field.");
        return;
      }
    }
    if (await s.review(current.d, current.f.key, status, corrected, note)) {
      setIndex(0);
    }
  }
  return (
    <>
      <Heading
        title="A closer look makes all the difference."
        description="Review uncertain values against the source. Keep a clear record of every decision."
        actions={
          <Button
            onClick={() =>
              downloadJson("ezpz-review-decisions.json", s.reviews)
            }
          >
            <Download size={15} />
            Export feedback
          </Button>
        }
      />
      {s.mode === "live" && (
        <div className="review-run-select">
          <label>
            Evaluation run
            <FieldSelect
              aria-label="Review evaluation run"
              value={s.reviewRunId}
              disabled={s.reviewLoading || s.busy}
              options={s.runs.map((r) => ({
                value: r.id,
                label: `${r.name} · ${r.dataset} · v${r.version}`,
              }))}
              onValueChange={(id) => {
                setIndex(0);
                void s.loadReviewRun(id);
              }}
            />
          </label>
          {s.reviewLoading && (
            <Busy label="Loading saved results and feedback…" />
          )}
        </div>
      )}
      <div className="review-progress">
        <div>
          <span className="review-progress-icon">
            <CheckCheck size={20} />
          </span>
          <span>
            <strong>{completed} decisions saved</strong>
            <small>
              Your feedback stays connected to the original extraction.
            </small>
          </span>
        </div>
        <div className="review-filter">
          <button
            className={filter === "pending" ? "active" : ""}
            onClick={() => {
              setFilter("pending");
              setIndex(0);
            }}
          >
            Needs review
          </button>
          <button
            className={filter === "all" ? "active" : ""}
            onClick={() => {
              setFilter("all");
              setIndex(0);
            }}
          >
            All fields
          </button>
        </div>
      </div>
      {!current ? (
        <section className="panel">
          <Empty
            title={
              s.mode === "live"
                ? s.reviewRunId
                  ? "No pending fields in this run"
                  : "No fields loaded for review"
                : "You’re all caught up."
            }
            description={
              s.mode === "live"
                ? "Choose a saved evaluation above, or switch to All fields to inspect reviewed values."
                : "Every uncertain field in this demo has a saved decision. Take the next step with a new experiment."
            }
            action={
              <Button
                variant="primary"
                onClick={() =>
                  s.navigate(
                    s.mode === "live" ? "Evaluations" : "Hill climbing",
                  )
                }
              >
                {s.mode === "live" ? "Open evaluations" : "Try an experiment"}
                <ArrowRight size={15} />
              </Button>
            }
          />
        </section>
      ) : (
        <div className="workbench-layout review-workbench">
          <section className="source-pane">
            <div className="pane-heading">
              <span className="source-selector">
                <span className="pdf-icon">
                  <FileText size={16} />
                </span>
                <strong>{current.d.name}</strong>
              </span>
              <Badge>Source</Badge>
            </div>
            <SourceViewer document={current.d} field={current.f} />
            <div className="source-footer">
              <span>
                <Focus size={13} />
                {current.f.area
                  ? `Citation on page ${current.f.page || 1}`
                  : "No citation for this field"}
              </span>
              <span>Viewer by Extend UI</span>
            </div>
          </section>
          <section className="review-decision">
            <div className="pane-heading">
              <span className="results-title">
                <MessageSquareText size={17} />
                Field review
              </span>
              <span>
                {Math.min(index + 1, items.length)} of {items.length}
              </span>
            </div>
            <div className="decision-body">
              <ConfidenceBadge field={current.f} />
              <h2>{current.f.key}</h2>
              <p>Check this value against the highlighted source.</p>
              <div className="review-values">
                <div>
                  <span>EXTRACTED VALUE</span>
                  <strong>{displayValue(current.f.value)}</strong>
                </div>
                <div>
                  <span>EXPECTED VALUE</span>
                  <strong>
                    {current.f.expected === null &&
                    (!current.f.status || current.f.status === "unscored")
                      ? "Not annotated"
                      : displayValue(current.f.expected)}
                  </strong>
                </div>
              </div>
              {current.review && (
                <div className="saved-review">
                  <Check size={15} />
                  Saved as {current.review.status}
                </div>
              )}
              <label>
                Reviewed value
                <input
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                />
              </label>
              <label>
                Reviewer note <span className="label-note">Optional</span>
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  rows={4}
                  placeholder="What should the next experiment learn from this?"
                />
              </label>
              <div className="review-context">
                <GitBranchIcon />
                <p>
                  Feedback is saved as a review decision. The original
                  extraction and benchmark ground truth stay traceable.
                </p>
              </div>
              <div className="decision-actions">
                <Button
                  variant="primary"
                  disabled={s.busy}
                  onClick={() =>
                    save(
                      value === displayValue(current.f.value)
                        ? "accepted"
                        : "corrected",
                    )
                  }
                >
                  <Check size={15} />
                  {value === displayValue(current.f.value)
                    ? "Accept value"
                    : "Save correction"}
                </Button>
                <Button disabled={s.busy} onClick={() => save("ambiguous")}>
                  <Flag size={14} />
                  Flag as ambiguous
                </Button>
              </div>
            </div>
            <div className="review-nav">
              <button
                disabled={index === 0}
                onClick={() => setIndex((i) => Math.max(0, i - 1))}
              >
                <ChevronLeft size={16} />
                Previous
              </button>
              <button
                disabled={index >= items.length - 1}
                onClick={() => setIndex((i) => i + 1)}
              >
                Skip for now
                <ChevronRight size={16} />
              </button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
function GitBranchIcon() {
  return <Layers size={17} />;
}
