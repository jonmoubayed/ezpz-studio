import { FieldSelect } from "./components/field-select";
import { useEffect, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  Download,
  FileText,
  GitCompareArrows,
  Layers,
  Plus,
  Search,
  X,
} from "lucide-react";
import { Badge, Button, Busy, Empty, Heading } from "./ui";
import { RunModal, ModelMark } from "./pages";
import { SourceViewer } from "./workbench";
import { useStudio } from "./store";
import {
  displayValue,
  downloadJson,
  pct,
  type Run,
  type Document,
} from "./domain";
import * as api from "./api";
import {
  groupRuns,
  evaluationDocuments,
  demoEvaluationDocuments,
  failed,
  scoreDelta,
} from "./evaluation-model";

function Delta({ run, baseline }: { run: Run; baseline?: Run }) {
  const change =
    run.score !== null && baseline?.score != null
      ? run.score - baseline.score
      : 0;
  return (
    <span
      className={`eval-delta ${change > 0 ? "positive" : change < 0 ? "negative" : ""}`}
    >
      {baseline ? scoreDelta(run.score, baseline.score) : "—"}
    </span>
  );
}
function Trend({ runs }: { runs: Run[] }) {
  const scored = runs.filter((r) => r.score !== null);
  if (!scored.length) return null;
  const min = Math.max(0, Math.min(...scored.map((r) => r.score!)) - 0.04),
    max = Math.min(1, Math.max(...scored.map((r) => r.score!)) + 0.04);
  return (
    <svg
      className="eval-sparkline"
      viewBox="0 0 140 32"
      role="img"
      aria-label="Accuracy across iterations"
    >
      <polyline
        points={scored
          .map(
            (r, i) =>
              `${5 + (i * 130) / Math.max(1, scored.length - 1)},${28 - ((r.score! - min) / (max - min || 1)) * 24}`,
          )
          .join(" ")}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      {scored.map((r, i) => (
        <circle
          key={r.id}
          cx={5 + (i * 130) / Math.max(1, scored.length - 1)}
          cy={28 - ((r.score! - min) / (max - min || 1)) * 24}
          r="2.5"
          fill="currentColor"
        >
          <title>
            {r.name}: {pct(r.score)}
          </title>
        </circle>
      ))}
    </svg>
  );
}
export function Evaluations() {
  const s = useStudio();
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [baselines, setBaselines] = useState<Record<string, string>>({});
  const [compare, setCompare] = useState(false);
  const [newRun, setNewRun] = useState<{ groupId?: string } | null>(null);
  const [detail, setDetail] = useState<Run | null>(null);
  const groups = groupRuns(s.runs, s.evalGroups);
  const chosen = selected
    .map((id) => s.runs.find((r) => r.id === id))
    .filter((r): r is Run => !!r);
  const comparable =
    chosen.length >= 2 &&
    chosen.every(
      (r) =>
        r.datasetId &&
        r.datasetId === chosen[0].datasetId &&
        r.groupId === chosen[0].groupId,
    );
  if (detail)
    return (
      <EvaluationResults
        key={detail.id}
        run={detail}
        onBack={() => setDetail(null)}
      />
    );
  return (
    <div className="evaluations-page">
      <Heading
        title="Evaluations"
        description="Compare iterations. Find regressions. Inspect the fields behind the score."
        actions={
          <>
            <Button
              onClick={() => downloadJson("evaluation-runs.json", s.runs)}
            >
              <Download size={14} />
              Export
            </Button>
            <Button variant="primary" onClick={() => setNewRun({})}>
              <Plus size={14} />
              New evaluation
            </Button>
          </>
        }
      />
      <div className="eval-command-bar">
        <div className="search-box">
          <Search size={14} />
          <input
            aria-label="Search evaluation groups"
            placeholder="Search groups, runs, or models…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <span>
          {groups.length} groups <span>·</span> {s.runs.length} runs
        </span>
        <Button disabled={!comparable} onClick={() => setCompare((v) => !v)}>
          <GitCompareArrows size={14} />
          {compare
            ? "Hide comparison"
            : `Compare${selected.length ? ` (${selected.length})` : ""}`}
        </Button>
      </div>
      {compare && comparable && (
        <RunComparison
          runs={chosen}
          onInspect={setDetail}
          onClose={() => setCompare(false)}
        />
      )}
      <div className="eval-groups">
        {groups
          .filter((g) =>
            `${g.name} ${g.runs.map((r) => r.name + " " + r.model).join(" ")}`
              .toLowerCase()
              .includes(query.toLowerCase()),
          )
          .map((g) => {
            const baseline =
              g.runs.find((r) => r.id === baselines[g.id]) ||
              g.runs.find((r) => r.score !== null);
            const best = [...g.runs]
              .filter((r) => r.score !== null)
              .sort((a, b) => b.score! - a.score!)[0];
            const closed = collapsed.includes(g.id);
            return (
              <section className="eval-group" key={g.id}>
                <div className="eval-group-header">
                  <button
                    className="eval-group-toggle"
                    aria-expanded={!closed}
                    onClick={() =>
                      setCollapsed((ids) =>
                        closed
                          ? ids.filter((id) => id !== g.id)
                          : [...ids, g.id],
                      )
                    }
                  >
                    {closed ? (
                      <ChevronRight size={15} />
                    ) : (
                      <ChevronDown size={15} />
                    )}
                    <span className="eval-group-icon">
                      <Layers size={16} />
                    </span>
                    <span>
                      <strong>{g.name}</strong>
                      <small>
                        {s.datasets.find((d) => d.id === g.datasetId)?.name ||
                          g.runs[0]?.dataset ||
                          "Benchmark"}{" "}
                        · {g.runs.length} iterations
                      </small>
                    </span>
                  </button>
                  <Trend runs={g.runs} />
                  <div className="eval-best">
                    <small>BEST ACCURACY</small>
                    <strong>
                      {pct(best?.score ?? null)}{" "}
                      {best && <Delta run={best} baseline={baseline} />}
                    </strong>
                  </div>
                  <Button
                    onClick={() =>
                      setNewRun({
                        groupId: g.id.startsWith("ungrouped:")
                          ? undefined
                          : g.id,
                      })
                    }
                  >
                    <Plus size={13} />
                    Iteration
                  </Button>
                </div>
                {!closed && (
                  <>
                    <div className="eval-table-scroll">
                      <table className="data-table eval-iteration-table">
                        <thead>
                          <tr>
                            <th>
                              <span className="sr-only">Compare</span>
                            </th>
                            <th>Iteration / hypothesis</th>
                            <th>Configuration</th>
                            <th>Accuracy</th>
                            <th>Δ baseline</th>
                            <th>Latency</th>
                            <th>Cost</th>
                            <th>Baseline</th>
                            <th />
                          </tr>
                        </thead>
                        <tbody>
                          {[...g.runs].reverse().map((r) => (
                            <tr
                              key={r.id}
                              className={
                                selected.includes(r.id) ? "is-selected" : ""
                              }
                            >
                              <td>
                                <input
                                  type="checkbox"
                                  aria-label={`Compare ${r.name}`}
                                  checked={selected.includes(r.id)}
                                  onChange={() => {
                                    setCompare(false);
                                    setSelected((ids) =>
                                      ids.includes(r.id)
                                        ? ids.filter((id) => id !== r.id)
                                        : chosen.length &&
                                            (chosen[0].groupId !== r.groupId ||
                                              chosen[0].datasetId !==
                                                r.datasetId)
                                          ? [r.id]
                                          : [...ids.slice(-3), r.id],
                                    );
                                  }}
                                />
                              </td>
                              <td>
                                <button
                                  className="eval-run-link"
                                  onClick={() => setDetail(r)}
                                >
                                  {r.name}
                                </button>
                                <small>
                                  {new Date(r.date).toLocaleDateString(
                                    undefined,
                                    { month: "short", day: "numeric" },
                                  )}{" "}
                                  · {r.status}{" "}
                                  {r.id === best?.id && (
                                    <span className="eval-best-tag">Best</span>
                                  )}
                                </small>
                              </td>
                              <td>
                                <span className="eval-model">
                                  <ModelMark provider={r.provider} />
                                  {r.model}
                                </span>
                                <small>
                                  {r.config?.parser || "Parser unavailable"} · v
                                  {r.version}
                                </small>
                              </td>
                              <td>
                                <strong>{pct(r.score)}</strong>
                              </td>
                              <td>
                                <Delta run={r} baseline={baseline} />
                              </td>
                              <td>{r.latency.toFixed(1)}s</td>
                              <td>${r.cost.toFixed(3)}</td>
                              <td>
                                <input
                                  type="radio"
                                  name={`baseline-${g.id}`}
                                  aria-label={`Use ${r.name} as baseline`}
                                  checked={baseline?.id === r.id}
                                  onChange={() =>
                                    setBaselines({ ...baselines, [g.id]: r.id })
                                  }
                                />
                              </td>
                              <td>
                                <button
                                  className="eval-inspect-button"
                                  onClick={() => setDetail(r)}
                                >
                                  Inspect <ArrowRight size={12} />
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {!g.runs.length && (
                      <Empty
                        title="Ready for your first iteration"
                        description="Run a configuration against this group's benchmark."
                      />
                    )}
                    <div className="eval-group-footer">
                      <span>
                        Baseline: {baseline?.name || "No scored run yet"}
                      </span>
                      <span>
                        Select 2–4 iterations to compare configurations.
                      </span>
                    </div>
                  </>
                )}
              </section>
            );
          })}
      </div>
      {!groups.length && (
        <Empty
          title="Start an evaluation group"
          description="Give a process a benchmark, then compare model and prompt iterations."
          action={<Button onClick={() => setNewRun({})}>New evaluation</Button>}
        />
      )}
      {newRun && (
        <RunModal
          key={newRun.groupId || "new"}
          groupId={newRun.groupId}
          open
          onClose={() => setNewRun(null)}
        />
      )}
    </div>
  );
}
function RunComparison({
  runs,
  onInspect,
  onClose,
}: {
  runs: Run[];
  onInspect: (r: Run) => void;
  onClose: () => void;
}) {
  const [baselineId, setBaselineId] = useState(
    [...runs].sort(
      (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
    )[0].id,
  );
  const baseline = runs.find((r) => r.id === baselineId) || runs[0];
  const ordered = [baseline, ...runs.filter((r) => r.id !== baseline.id)];
  const metrics: [string, (r: Run) => string][] = [
    ["Accuracy", (r) => pct(r.score)],
    ["Δ accuracy", (r) => scoreDelta(r.score, baseline.score)],
    ["Model", (r) => r.model],
    ["Provider", (r) => r.provider],
    ["Parser", (r) => r.config?.parser || "Not recorded"],
    ["Latency", (r) => `${r.latency.toFixed(1)}s`],
    ["Cost", (r) => `$${r.cost.toFixed(3)}`],
    ["Prompt", (r) => r.config?.prompt || "Not recorded"],
    ["Schema", (r) => r.config?.schema || "Not recorded"],
  ];
  return (
    <section className="eval-comparison panel">
      <div className="eval-comparison-title">
        <strong>
          <GitCompareArrows size={15} /> Configuration comparison
        </strong>
        <label>
          Baseline{" "}
          <FieldSelect
            aria-label="Comparison baseline"
            value={baseline.id}
            onValueChange={(value) => setBaselineId(value)}
            options={runs.map((r) => ({ value: r.id, label: r.name }))}
          />
        </label>
        <button aria-label="Close comparison" onClick={onClose}>
          <X size={16} />
        </button>
      </div>
      <div className="eval-table-scroll">
        <table className="data-table eval-compare-table">
          <thead>
            <tr>
              <th>Measure / setting</th>
              {ordered.map((r, i) => (
                <th key={r.id}>
                  <span>{i === 0 ? "BASELINE" : `CANDIDATE ${i}`}</span>
                  <button onClick={() => onInspect(r)}>
                    {r.name}
                    <ArrowRight size={12} />
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {metrics.map(([label, value]) => (
              <tr key={label}>
                <th>{label}</th>
                {ordered.map((r) => (
                  <td
                    key={r.id}
                    className={
                      value(r) !== value(baseline) ? "config-changed" : ""
                    }
                  >
                    {label === "Prompt" || label === "Schema" ? (
                      <details>
                        <summary>
                          {value(r) === value(baseline)
                            ? r.id === baseline.id
                              ? "View snapshot"
                              : "Same as baseline"
                            : "Changed · view snapshot"}
                        </summary>
                        <pre>{value(r)}</pre>
                      </details>
                    ) : (
                      value(r)
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
function EvaluationResults({ run, onBack }: { run: Run; onBack: () => void }) {
  const s = useStudio();
  const [docs, setDocs] = useState<Document[]>(
    s.mode === "demo" ? demoEvaluationDocuments(run) : [],
  );
  const [loading, setLoading] = useState(s.mode === "live");
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [documentId, setDocumentId] = useState("");
  const [fieldKey, setFieldKey] = useState("");
  const [filter, setFilter] = useState("failures");
  const [search, setSearch] = useState("");
  const [fieldFilter, setFieldFilter] = useState("");
  const [snapshot, setSnapshot] = useState<any>(null);
  useEffect(() => {
    if (s.mode !== "live") return;
    const abort = new AbortController();
    setLoading(true);
    setError("");
    api
      .request(`/runs/${encodeURIComponent(run.id)}`, { signal: abort.signal })
      .then((data) => {
        if (abort.signal.aborted) return;
        setSnapshot(data.run);
        setDocs(evaluationDocuments(data.run, s.documents));
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [run.id, attempt, s.mode]);
  const failureCounts = new Map<string, number>();
  docs.forEach((d) =>
    d.fields
      .filter(failed)
      .forEach((f) =>
        failureCounts.set(f.key, (failureCounts.get(f.key) || 0) + 1),
      ),
  );
  const totalFailures = [...failureCounts.values()].reduce((a, b) => a + b, 0);
  const visibleDocs = docs.filter(
    (d) =>
      (filter !== "failures" || d.fields.some(failed)) &&
      (!fieldFilter ||
        d.fields.some((f) => f.key === fieldFilter && failed(f))) &&
      `${d.name} ${d.fields.map((f) => f.key).join(" ")}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const document =
    visibleDocs.find((d) => d.id === documentId) || visibleDocs[0];
  const fields =
    document?.fields.filter(
      (f) =>
        (filter !== "failures" || failed(f)) &&
        (!fieldFilter || f.key === fieldFilter),
    ) ?? [];
  const active = fields.find((f) => f.key === fieldKey) || fields[0];
  return (
    <div className="evaluation-results-page">
      <div className="eval-result-back">
        <button onClick={onBack}>
          <ArrowLeft size={14} />
          Evaluations
        </button>
        <span>/ {run.groupName || run.dataset}</span>
        <Badge>
          {s.mode === "demo" ? "Illustrative sample" : "Saved evaluation"}
        </Badge>
      </div>
      <Heading
        title={run.name}
        description={`${run.model} · ${run.config?.parser || "Saved configuration"} · ${run.documents} documents`}
        actions={
          <Button
            onClick={() =>
              downloadJson(
                `${run.id}-results.json`,
                snapshot || { run, documents: docs },
              )
            }
          >
            <Download size={14} />
            Export results
          </Button>
        }
      />
      <div className="eval-result-metrics">
        <span>
          Field accuracy <strong>{pct(run.score)}</strong>
        </span>
        <span>
          Incorrect fields{" "}
          <strong className={totalFailures ? "negative" : ""}>
            {loading ? "—" : totalFailures}
          </strong>
        </span>
        <span>
          Documents with errors{" "}
          <strong>
            {loading ? "—" : docs.filter((d) => d.fields.some(failed)).length}
          </strong>
        </span>
        <span>
          Latency <strong>{run.latency.toFixed(1)}s</strong>
        </span>
        <span>
          Cost <strong>${run.cost.toFixed(3)}</strong>
        </span>
      </div>
      {s.mode === "demo" && (
        <p className="eval-fixture-note">
          Field examples are illustrative; run metrics are sample fixtures.
        </p>
      )}
      {loading ? (
        <div className="panel empty">
          <Busy label="Loading evaluated documents…" />
        </div>
      ) : error ? (
        <div className="panel empty">
          <p role="alert">{error}</p>
          <Button onClick={() => setAttempt((v) => v + 1)}>Retry</Button>
        </div>
      ) : (
        <>
          <div className="eval-failure-strip">
            <span>FAILURE HOTSPOTS</span>
            {[...failureCounts]
              .sort((a, b) => b[1] - a[1])
              .map(([key, count]) => (
                <button
                  key={key}
                  className={fieldFilter === key ? "active" : ""}
                  onClick={() => {
                    setFieldFilter(fieldFilter === key ? "" : key);
                    setFilter("failures");
                  }}
                >
                  {key}
                  <b>{count}</b>
                </button>
              ))}
            {!totalFailures && <span>No scored failures</span>}
            {fieldFilter && (
              <button onClick={() => setFieldFilter("")}>
                <X size={11} />
                Clear
              </button>
            )}
          </div>
          <div className="eval-inspector-toolbar">
            <div className="review-filter">
              <button
                className={filter === "failures" ? "active" : ""}
                onClick={() => setFilter("failures")}
              >
                Incorrect fields ({totalFailures})
              </button>
              <button
                className={filter === "all" ? "active" : ""}
                onClick={() => {
                  setFilter("all");
                  setFieldFilter("");
                }}
              >
                All fields
              </button>
            </div>
            <div className="search-box">
              <Search size={13} />
              <input
                aria-label="Search evaluated documents"
                placeholder="Find a document or field…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <span>{visibleDocs.length} documents</span>
          </div>
          {document ? (
            <div className="eval-inspector">
              <nav
                className="eval-document-list"
                aria-label="Evaluated documents"
              >
                {visibleDocs.map((d) => (
                  <button
                    key={d.id}
                    className={document.id === d.id ? "active" : ""}
                    onClick={() => {
                      setDocumentId(d.id);
                      setFieldKey("");
                    }}
                  >
                    <FileText size={14} />
                    <span>
                      <strong>{d.name}</strong>
                      <small>
                        {d.fields.filter(failed).length
                          ? `${d.fields.filter(failed).length} incorrect fields`
                          : d.fields.some((f) => f.status === "unscored")
                            ? "Unscored fields"
                            : "All fields correct"}
                      </small>
                    </span>
                  </button>
                ))}
              </nav>
              <section className="source-pane eval-source">
                <div className="pane-heading">
                  <strong>{document.name}</strong>
                  <Badge>Source</Badge>
                </div>
                <SourceViewer
                  key={document.id}
                  document={document}
                  field={active}
                />
                <div className="source-footer">
                  {active?.area
                    ? `Highlighted: ${active.key} · page ${active.page || 1}`
                    : "No source citation for the selected field"}
                </div>
              </section>
              <section className="eval-field-panel">
                <div className="pane-heading">
                  <strong>Field results</strong>
                  <span>{fields.length} fields</span>
                </div>
                <div className="eval-field-list">
                  {fields.map((f) => (
                    <button
                      className={`eval-field ${active?.key === f.key ? "active" : ""} ${failed(f) ? "is-failed" : ""}`}
                      key={f.key}
                      onClick={() => setFieldKey(f.key)}
                    >
                      <span className="eval-field-name">
                        <strong>{f.key}</strong>
                        <Badge
                          tone={
                            failed(f)
                              ? "orange"
                              : f.status === "correct"
                                ? "green"
                                : "neutral"
                          }
                        >
                          {f.status?.replaceAll("_", " ") || "unscored"}
                        </Badge>
                      </span>
                      <span className="eval-field-values">
                        <span>
                          <small>EXTRACTED</small>
                          <code>{displayValue(f.value)}</code>
                        </span>
                        <span>
                          <small>EXPECTED</small>
                          <code>
                            {f.status === "unscored"
                              ? "Not annotated"
                              : displayValue(f.expected)}
                          </code>
                        </span>
                      </span>
                      {f.area && (
                        <span className="eval-field-citation">
                          View source · page {f.page || 1}
                          <ArrowRight size={11} />
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              </section>
            </div>
          ) : (
            <Empty
              title={
                search || fieldFilter
                  ? "No matching documents"
                  : filter === "failures"
                    ? "No incorrect fields to inspect"
                    : "No evaluated documents"
              }
              description={
                filter === "failures"
                  ? "Switch to all fields to inspect correct and unscored values."
                  : "This run has no results matching the current filters."
              }
              action={
                <Button
                  onClick={() => {
                    setFilter("all");
                    setFieldFilter("");
                    setSearch("");
                  }}
                >
                  Show all fields
                </Button>
              }
            />
          )}
        </>
      )}
    </div>
  );
}
