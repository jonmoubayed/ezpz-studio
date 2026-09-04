import { useState } from "react";
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  BarChart3,
  Braces,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  Clock3,
  Code2,
  Database,
  Download,
  FileScan,
  FileText,
  FlaskConical,
  GitBranch,
  Layers,
  Link2,
  MessageSquareText,
  Monitor,
  Mountain,
  Play,
  Plus,
  Search,
  Server,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Target,
  TrendingUp,
  X,
  Zap,
} from "lucide-react";
import {
  Badge,
  Button,
  Busy,
  Empty,
  Heading,
  LinkButton,
  Modal,
  PanelTitle,
  Stat,
} from "./ui";
import { useStudio } from "./store";
import {
  downloadJson,
  pct,
  type Config,
  type Run,
  type Dataset,
} from "./domain";
import * as api from "./api";
export function ModelMark({ provider }: { provider: string }) {
  const p = provider.toLowerCase();
  return (
    <span
      className={`model-mark ${p.includes("anthropic") ? "anthropic" : p.includes("google") ? "google" : p.includes("ollama") || p === "local" ? "local-model" : "openai"}`}
    >
      {p.includes("anthropic") ? (
        <span>✳</span>
      ) : p.includes("google") ? (
        <Sparkles size={14} />
      ) : p.includes("ollama") || p === "local" ? (
        <Monitor size={13} />
      ) : (
        <span>◎</span>
      )}
    </span>
  );
}
export function PerformanceChart({
  runs,
  compact = false,
}: {
  runs: Run[];
  compact?: boolean;
}) {
  const ordered = [...runs]
    .filter((r) => r.score !== null)
    .slice(0, 8)
    .reverse();
  const [focus, setFocus] = useState<number | null>(null);
  const min = Math.min(0.8, ...ordered.map((r) => r.score!));
  const points = ordered.map((r, i) => ({
    x: 52 + (i * 610) / Math.max(1, ordered.length - 1),
    y: 192 - ((r.score! - min) / (1 - min)) * 158,
    r,
  }));
  return (
    <div className={`performance-chart ${compact ? "compact" : ""}`}>
      <svg
        viewBox="0 0 700 240"
        role="img"
        aria-label={`Field accuracy over ${ordered.length} runs, from ${pct(ordered[0]?.score ?? null)} to ${pct(ordered.at(-1)?.score ?? null)}`}
      >
        <defs>
          <linearGradient id="chartFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#34735d" stopOpacity=".13" />
            <stop offset="100%" stopColor="#34735d" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0, 0.25, 0.5, 0.75, 1].map((p) => (
          <g key={p}>
            <text x="0" y={196 - p * 158} className="axis-label">
              {Math.round((min + (1 - min) * p) * 100)}%
            </text>
            <line
              x1="48"
              x2="680"
              y1={192 - p * 158}
              y2={192 - p * 158}
              stroke="#e9ece8"
              strokeDasharray={p === 0 ? "" : "3 5"}
            />
          </g>
        ))}
        {points.length > 0 && (
          <>
            <path
              d={`M ${points[0].x},192 ${points.map((p) => `L ${p.x},${p.y}`).join(" ")} L ${points.at(-1)!.x},192 Z`}
              fill="url(#chartFill)"
            />
            <polyline
              points={points.map((p) => `${p.x},${p.y}`).join(" ")}
              fill="none"
              stroke="#337258"
              strokeWidth="2.5"
              strokeLinejoin="round"
              strokeLinecap="round"
            />
            {points.map((p, i) => (
              <g
                key={p.r.id}
                onMouseEnter={() => setFocus(i)}
                onMouseLeave={() => setFocus(null)}
              >
                <circle cx={p.x} cy={p.y} r="13" fill="transparent" />
                <circle
                  cx={p.x}
                  cy={p.y}
                  r={i === points.length - 1 ? 5 : 3.5}
                  fill="white"
                  stroke="#337258"
                  strokeWidth="2"
                />
                <text
                  x={p.x}
                  y="219"
                  textAnchor="middle"
                  className="axis-label"
                >
                  v{p.r.version}
                </text>
                {(focus === i || i === points.length - 1) && (
                  <g>
                    <rect
                      x={Math.min(p.x - 27, 636)}
                      y={p.y - 35}
                      width="55"
                      height="23"
                      rx="5"
                      fill="#eef5ef"
                    />
                    <text
                      x={Math.min(p.x, 663)}
                      y={p.y - 19}
                      textAnchor="middle"
                      fill="#32694f"
                      fontSize="11"
                      fontWeight="600"
                    >
                      {pct(p.r.score)}
                    </text>
                  </g>
                )}
              </g>
            ))}
          </>
        )}
      </svg>
      {!points.length && (
        <p className="chart-empty">
          Run a scored benchmark to see performance over time.
        </p>
      )}
    </div>
  );
}
export function Overview() {
  const s = useStudio();
  const best = s.runs
    .filter((r) => r.score !== null)
    .sort((a, b) => b.score! - a.score!)[0];
  const low = s.documents
    .filter((d) => s.mode === "demo" || d.runId)
    .flatMap((d) =>
      d.fields.filter(
        (f) =>
          f.confidence < 0.9 &&
          !s.reviews.some(
            (r) =>
              r.documentId === d.id &&
              r.field === f.key &&
              r.runId === (d.runId || ""),
          ),
      ),
    );
  return (
    <>
      <Heading
        eyebrow="YOUR EXTRACTION WORKSPACE"
        title="Good data starts here."
        description="Extract, evaluate, and make your next run a little better."
        actions={
          <>
            <Button onClick={() => s.navigate("Playground")}>
              <FlaskConical size={15} />
              Open playground
            </Button>
            <Button variant="primary" onClick={() => s.setUploadOpen(true)}>
              <Plus size={16} />
              Add documents
            </Button>
          </>
        }
      />
      <div className="intro-banner">
        <div>
          <span className="banner-icon">
            <Layers size={24} />
          </span>
          <div>
            <h2>Document intelligence, on your terms.</h2>
            <p>
              Bring any model. See every field. Build confidence in what you
              extract.
            </p>
          </div>
        </div>
        <button onClick={() => s.navigate("Settings")}>
          Connect your stack
          <ArrowUpRight size={16} />
        </button>
        <div className="banner-art" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
      </div>
      <div className="stats-grid">
        <Stat
          label="Documents"
          value={String(s.documents.length)}
          detail={`Across ${s.datasets.length} benchmark dataset${s.datasets.length === 1 ? "" : "s"}`}
        >
          <FileText size={15} />
        </Stat>
        <Stat
          label="Best field accuracy"
          value={pct(best?.score ?? null)}
          change={s.mode === "demo" ? "+11.5 pts" : undefined}
          detail={
            best ? "Your highest-scoring configuration" : "No scored runs yet"
          }
        >
          <Target size={15} />
        </Stat>
        <Stat
          label="Evaluation runs"
          value={String(s.runs.length)}
          detail={`${new Set(s.runs.map((r) => r.provider)).size} model providers explored`}
        >
          <BarChart3 size={15} />
        </Stat>
        <Stat
          label="Needs a closer look"
          value={String(low.length)}
          detail="Fields ready for human review"
        >
          <MessageSquareText size={15} />
        </Stat>
      </div>
      <div className="overview-middle">
        <section className="panel performance-panel">
          <PanelTitle
            title="A little better, every iteration"
            description="Field accuracy across your recent experiments"
            action={
              <Badge tone="green">
                <i />
                {best?.dataset || "No benchmark yet"}
              </Badge>
            }
          />
          <div className="chart-heading">
            <strong>{pct(best?.score ?? null)}</strong>
            <span>best field accuracy</span>
            <div className="chart-legend">
              <i />
              Evaluation run
            </div>
          </div>
          <PerformanceChart
            runs={s.runs.filter((r) => r.datasetId === (best?.datasetId || ""))}
          />
          <div className="panel-footer">
            <span>
              <GitBranch size={14} />
              {s.runs.length} experiments. One shared benchmark.
            </span>
            <LinkButton onClick={() => s.navigate("Hill climbing")}>
              Keep improving
            </LinkButton>
          </div>
        </section>
        <section className="panel review-summary">
          <div className="review-summary-top">
            <span className="orange-icon">
              <MessageSquareText size={21} />
            </span>
            <Badge tone="orange">{low.length} to review</Badge>
          </div>
          <h2>
            A human touch
            <br />
            goes a long way.
          </h2>
          <p>
            Turn uncertain fields into useful feedback. Your next experiment
            will thank you.
          </p>
          <div className="review-list">
            {[
              "Low-confidence values",
              "Source-grounded corrections",
              "A traceable feedback loop",
            ].map((v, i) => (
              <span key={v}>
                {i === 0 ? (
                  <Target size={15} />
                ) : i === 1 ? (
                  <FileScan size={15} />
                ) : (
                  <GitBranch size={15} />
                )}{" "}
                {v}
              </span>
            ))}
          </div>
          <Button onClick={() => s.navigate("Review queue")}>
            Open review queue
            <ArrowRight size={15} />
          </Button>
        </section>
      </div>
      <section className="panel">
        <PanelTitle
          title="Recent experiments"
          description="Every configuration has a story. Here are the latest."
          action={
            <LinkButton onClick={() => s.navigate("Evaluations")}>
              View all runs
            </LinkButton>
          }
        />
        <RunsTable
          runs={s.runs.slice(0, 4)}
          onOpen={() => s.navigate("Evaluations")}
        />
      </section>
      <div className="bottom-note">
        <ShieldCheck size={15} />
        <span>
          Built for your machine. OpenAI, Anthropic, Gemini, Ollama, or whatever
          comes next.
        </span>
        <button onClick={() => s.navigate("Settings")}>
          Your connections
          <ArrowUpRight size={13} />
        </button>
      </div>
    </>
  );
}
export function RunsTable({
  runs,
  onOpen,
  selected = [],
  onSelect,
}: {
  runs: Run[];
  onOpen: (r: Run) => void;
  selected?: string[];
  onSelect?: (id: string) => void;
}) {
  return (
    <div className="table-scroll">
      <table className="data-table">
        <thead>
          <tr>
            {onSelect && <th className="check-cell" />}
            <th>Experiment</th>
            <th>Model</th>
            <th>Field accuracy</th>
            <th>Latency</th>
            <th>Status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {runs.map((r, i) => (
            <tr key={r.id}>
              {onSelect && (
                <td className="check-cell">
                  <input
                    type="checkbox"
                    aria-label={`Compare ${r.name}`}
                    checked={selected.includes(r.id)}
                    onChange={() => onSelect(r.id)}
                  />
                </td>
              )}
              <td>
                <button className="experiment-name" onClick={() => onOpen(r)}>
                  <span className="experiment-icon">
                    <FlaskConical size={16} />
                  </span>
                  <span>
                    <strong>{r.name}</strong>
                    <small>
                      {r.dataset}
                      <span>·</span>v{r.version}
                    </small>
                  </span>
                </button>
              </td>
              <td>
                <span className="model-label">
                  <ModelMark provider={r.provider} />
                  {r.model}
                </span>
              </td>
              <td>
                <span className="accuracy-cell">
                  <strong>{pct(r.score)}</strong>
                  {r.score !== null &&
                    r.score ===
                      Math.max(...runs.map((run) => run.score ?? -1)) && (
                      <span className="tiny-best">BEST</span>
                    )}
                </span>
                <div className="accuracy-track">
                  <i style={{ width: `${(r.score ?? 0) * 100}%` }} />
                </div>
              </td>
              <td className="mono">{r.latency.toFixed(1)}s</td>
              <td>
                <Badge tone={r.status === "Completed" ? "green" : "neutral"}>
                  {r.status === "Completed" && <Check size={11} />} {r.status}
                </Badge>
              </td>
              <td>
                <button
                  className="icon-button"
                  aria-label={`Inspect ${r.name}`}
                  onClick={() => onOpen(r)}
                >
                  <ArrowUpRight size={16} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {runs.length === 0 && (
        <Empty
          title="Your first run starts here"
          description="Create a benchmark run to measure a configuration against your dataset."
        />
      )}
    </div>
  );
}
export function ConfigForm({
  config,
  onChange,
}: {
  config: Config;
  onChange: (c: Config) => void;
}) {
  const patch = (p: Partial<Config>) => onChange({ ...config, ...p });
  return (
    <div className="config-form">
      <div className="form-row">
        <label>
          Model provider
          <select
            value={config.provider}
            onChange={(e) =>
              patch({
                provider: e.target.value,
                model: (
                  {
                    local: "deterministic-local",
                    openai: "gpt-4.1",
                    anthropic: "claude-sonnet-4-20250514",
                    google: "gemini-2.5-flash",
                    ollama: "qwen3:8b",
                    "openai-compatible": "custom-model",
                  } as Record<string, string>
                )[e.target.value],
              })
            }
          >
            {[
              ["local", "Local · deterministic"],
              ["openai", "OpenAI"],
              ["anthropic", "Anthropic"],
              ["google", "Google Gemini"],
              ["ollama", "Ollama"],
              ["openai-compatible", "OpenAI-compatible endpoint"],
            ].map(([v, l]) => (
              <option value={v} key={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label>
          Model ID
          <input
            value={config.model}
            onChange={(e) => patch({ model: e.target.value })}
            placeholder="Enter any model ID"
          />
        </label>
      </div>
      {["ollama", "openai-compatible"].includes(config.provider) && (
        <label>
          Endpoint URL
          <input
            type="url"
            value={config.baseUrl}
            onChange={(e) => patch({ baseUrl: e.target.value })}
          />
        </label>
      )}
      <label>
        Document parser
        <select
          value={config.parser}
          onChange={(e) => patch({ parser: e.target.value })}
        >
          <option value="native">Native text · local</option>
          <option value="docling">Docling · local</option>
          <option value="llama-parse">LlamaParse</option>
        </select>
      </label>
      <label>
        Extraction instructions
        <textarea
          rows={4}
          value={config.prompt}
          onChange={(e) => patch({ prompt: e.target.value })}
        />
      </label>
      <label>
        Output schema <span className="label-note">JSON Schema</span>
        <textarea
          className="code-editor"
          rows={8}
          spellCheck={false}
          value={config.schema}
          onChange={(e) => patch({ schema: e.target.value })}
        />
      </label>
    </div>
  );
}
export function RunModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const s = useStudio();
  const [name, setName] = useState("Untitled experiment");
  const [dataset, setDataset] = useState(s.datasets[0]?.id || "");
  const [config, setConfig] = useState(s.config);
  const [error, setError] = useState("");
  return (
    <Modal
      title="New evaluation run"
      description="Test one configuration against a fixed benchmark."
      open={open}
      onClose={onClose}
      wide
    >
      <label>
        Experiment name
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        Benchmark dataset
        <select value={dataset} onChange={(e) => setDataset(e.target.value)}>
          <option value="" disabled>
            Select a dataset
          </option>
          {s.datasets.map((d) => (
            <option value={d.id} key={d.id}>
              {d.name} ({d.count} documents)
            </option>
          ))}
        </select>
      </label>
      <ConfigForm
        config={config}
        onChange={(c) => {
          setConfig(c);
          s.updateConfig(c);
        }}
      />
      {s.mode === "demo" && (
        <p className="form-hint">
          Demo runs use a fixed sample score. Switch to the local API for
          measured results.
        </p>
      )}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <div className="modal-actions">
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="primary"
          disabled={s.busy || !dataset || !name.trim()}
          onClick={async () => {
            try {
              const schema = JSON.parse(config.schema);
              if (schema.type !== "object") throw new Error();
            } catch {
              setError("Enter a valid JSON object schema.");
              return;
            }
            setError("");
            s.updateConfig(config);
            if (await s.benchmark(name, dataset, config)) onClose();
          }}
        >
          {s.busy ? (
            <Busy label="Running benchmark…" />
          ) : (
            <>
              <Play size={14} />
              Run evaluation
            </>
          )}
        </Button>
      </div>
    </Modal>
  );
}
export function Evaluations() {
  const s = useStudio();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState("all");
  const [sort, setSort] = useState("recent");
  const [selected, setSelected] = useState<string[]>([]);
  const [compare, setCompare] = useState(false);
  const [newRun, setNewRun] = useState(false);
  const [detail, setDetail] = useState<Run | null>(null);
  const [raw, setRaw] = useState<any>(null);
  const rows = s.runs
    .filter(
      (r) =>
        `${r.name} ${r.model}`.toLowerCase().includes(q.toLowerCase()) &&
        (filter === "all" || r.datasetId === filter),
    )
    .sort((a, b) =>
      sort === "accuracy"
        ? (b.score ?? -1) - (a.score ?? -1)
        : new Date(b.date).getTime() - new Date(a.date).getTime(),
    );
  const chosen = s.runs.filter((r) => selected.includes(r.id));
  const valid =
    chosen.length === 2 &&
    !!chosen[0].datasetId &&
    chosen[0].datasetId === chosen[1].datasetId;
  const ordered = [...chosen].sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
  );
  async function open(r: Run) {
    setDetail(r);
    setRaw(null);
    if (s.mode === "live")
      try {
        setRaw(await api.request(`/runs/${r.id}`));
      } catch (e) {
        s.notifyError(e);
      }
  }
  async function inspectRun() {
    if (!detail) return;
    if (s.mode === "live" && raw?.run) {
      const run = raw.run;
      const extraction = run.extractions?.[0];
      if (!extraction) {
        s.setMessage("This run does not contain an extraction.");
        return;
      }
      const document = s.documents.find((d) => d.id === extraction.document_id);
      if (document) {
        s.setDocuments((documents) =>
          documents.map((doc) => {
            const ex = run.extractions.find(
              (e: any) => e.document_id === doc.id,
            );
            if (!ex) return { ...doc, fields: [], runId: undefined };
            const evaluation = run.evaluations?.find(
              (e: any) => e.extraction_id === ex.id,
            );
            const fields = api.extractionFields(ex).map((field) => ({
              ...field,
              expected: evaluation?.fields?.[field.key]?.expected ?? null,
              status: evaluation?.fields?.[field.key]?.status,
            }));
            return {
              ...doc,
              fields,
              runId: detail.id,
              warnings: ex.warnings || [],
            };
          }),
        );
        s.setReviews(
          (run.review_decisions || []).map((r: any) => ({
            documentId: r.document_id,
            field: r.field_path,
            status: r.status,
            value: r.corrected_value,
            note: r.note,
            runId: r.run_id,
            at: r.updated_at,
          })),
        );
        s.setSelectedId(document.id);
        s.navigate("Review queue");
      }
    } else {
      s.navigate("Playground");
    }
    setDetail(null);
  }
  return (
    <>
      <Heading
        eyebrow="MEASURE WHAT MATTERS"
        title="Every run, in perspective."
        description="Compare configurations against the same ground truth. Find what actually improves."
        actions={
          <>
            <Button
              onClick={() => downloadJson("ezpz-evaluation-runs.json", s.runs)}
            >
              <Download size={15} />
              Export runs
            </Button>
            <Button variant="primary" onClick={() => setNewRun(true)}>
              <Plus size={16} />
              New evaluation
            </Button>
          </>
        }
      />
      <div className="eval-summary">
        <div>
          <span className="feature-icon">
            <FlaskConical size={23} />
          </span>
          <section>
            <h3>Your experiments, all in one place.</h3>
            <p>
              A run captures the model, prompt, parser, and schema used for
              every result.
            </p>
          </section>
        </div>
        <span>
          <strong>{s.runs.length}</strong>total runs
        </span>
        <span>
          <strong>{s.datasets.length}</strong>benchmarks
        </span>
      </div>
      <section className="panel">
        <div className="table-toolbar">
          <div className="search-box">
            <Search size={16} />
            <input
              aria-label="Search runs"
              placeholder="Search experiments or models…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <select
            aria-label="Filter by dataset"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          >
            <option value="all">All datasets</option>
            {s.datasets.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
          <select
            aria-label="Sort runs"
            value={sort}
            onChange={(e) => setSort(e.target.value)}
          >
            <option value="recent">Most recent</option>
            <option value="accuracy">Highest accuracy</option>
          </select>
          <Button disabled={!valid} onClick={() => setCompare(true)}>
            <GitBranch size={14} />
            Compare {selected.length > 0 && `(${selected.length})`}
          </Button>
        </div>
        <RunsTable
          runs={rows}
          selected={selected}
          onSelect={(id) =>
            setSelected((ids) =>
              ids.includes(id)
                ? ids.filter((i) => i !== id)
                : [...ids.slice(-1), id],
            )
          }
          onOpen={open}
        />
        <div className="panel-footer">
          <span>
            {rows.length} runs
            {selected.length > 0
              ? " · Select two runs from the same dataset to compare."
              : ""}
          </span>
          <span>Immutable results. Reproducible experiments.</span>
        </div>
      </section>
      <RunModal open={newRun} onClose={() => setNewRun(false)} />
      <Modal
        title="Compare evaluation runs"
        description="Changes measured on the same benchmark dataset."
        open={compare}
        onClose={() => setCompare(false)}
        wide
      >
        {ordered.length === 2 && (
          <>
            <div className="comparison-head">
              <div>
                <Badge>BASELINE</Badge>
                <h3>{ordered[0].name}</h3>
                <p>{ordered[0].model}</p>
              </div>
              <ArrowRight size={22} />
              <div>
                <Badge tone="green">CANDIDATE</Badge>
                <h3>{ordered[1].name}</h3>
                <p>{ordered[1].model}</p>
              </div>
            </div>
            <table className="data-table comparison-table">
              <thead>
                <tr>
                  <th>Metric</th>
                  <th>Baseline</th>
                  <th>Candidate</th>
                  <th>Change</th>
                </tr>
              </thead>
              <tbody>
                {[
                  [
                    "Field accuracy",
                    pct(ordered[0].score),
                    pct(ordered[1].score),
                    ordered.every((r) => r.score !== null)
                      ? `${((ordered[1].score! - ordered[0].score!) * 100).toFixed(1)} pts`
                      : "—",
                  ],
                  [
                    "Latency",
                    `${ordered[0].latency.toFixed(1)}s`,
                    `${ordered[1].latency.toFixed(1)}s`,
                    `${(ordered[1].latency - ordered[0].latency).toFixed(1)}s`,
                  ],
                  [
                    "Run cost",
                    `$${ordered[0].cost.toFixed(3)}`,
                    `$${ordered[1].cost.toFixed(3)}`,
                    `$${(ordered[1].cost - ordered[0].cost).toFixed(3)}`,
                  ],
                ].map((row) => (
                  <tr key={row[0]}>
                    {row.map((v, i) => (
                      <td key={i}>{v}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            <Button
              onClick={() => downloadJson("ezpz-comparison.json", ordered)}
            >
              <Download size={14} />
              Export comparison
            </Button>
          </>
        )}
      </Modal>
      <Modal
        title={detail?.name || "Run details"}
        description="An immutable snapshot of this experiment."
        open={!!detail}
        onClose={() => setDetail(null)}
        wide
      >
        {detail && (
          <>
            <div className="detail-metrics">
              <Stat
                label="Field accuracy"
                value={pct(detail.score)}
                detail={detail.dataset}
              />
              <Stat
                label="Latency"
                value={`${detail.latency.toFixed(1)}s`}
                detail={`${detail.documents} documents`}
              />
              <Stat
                label="Run cost"
                value={`$${detail.cost.toFixed(3)}`}
                detail={detail.model}
              />
            </div>
            <pre className="json-output">
              {JSON.stringify(raw?.run?.processor_version || detail, null, 2)}
            </pre>
            <div className="modal-actions">
              <Button
                onClick={() => downloadJson(`${detail.id}.json`, raw || detail)}
              >
                <Download size={14} />
                Export snapshot
              </Button>
              <Button
                variant="primary"
                onClick={inspectRun}
                disabled={s.mode === "live" && !raw}
              >
                Inspect results
                <ArrowRight size={14} />
              </Button>
            </div>
          </>
        )}
      </Modal>
    </>
  );
}
export function HillClimbing() {
  const s = useStudio();
  const [candidate, setCandidate] = useState("Be explicit about currency");
  const [config, setConfig] = useState(s.config);
  const [dataset, setDataset] = useState(s.datasets[0]?.id || "");
  const [baseline, setBaseline] = useState(s.runs[0]?.id || "");
  const [error, setError] = useState("");
  const choices = [
    [
      "Be explicit about currency",
      "Separate subtotal, tax, and total. Preserve the original currency.",
      "Prompt refinement",
    ],
    [
      "Ground every table cell",
      "Use source evidence for each line item. Do not infer missing cells.",
      "Grounding",
    ],
    [
      "Try a local model",
      "Compare an open model with the same schema and benchmark.",
      "Model comparison",
    ],
  ];
  const benchmarkRuns = s.runs.filter((r) => r.datasetId === dataset);
  const base = benchmarkRuns.find((r) => r.id === baseline) || benchmarkRuns[0];
  return (
    <>
      <Heading
        eyebrow="SMALL CHANGES. MEASURABLE PROGRESS."
        title="Make the next run better."
        description="One hypothesis at a time. Keep the benchmark fixed, and let the results decide."
        actions={
          <Badge tone="green">
            <Mountain size={13} />
            Manual experiment loop
          </Badge>
        }
      />
      <div className="hill-grid">
        <div>
          <section className="panel hill-baseline">
            <PanelTitle
              title="01 / Start from a benchmark"
              description="Compare like for like, every time."
            />
            <div className="form-row">
              <label>
                Dataset
                <select
                  value={dataset}
                  onChange={(e) => {
                    setDataset(e.target.value);
                    setBaseline("");
                  }}
                >
                  {s.datasets.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Baseline run
                <select
                  value={base?.id || ""}
                  onChange={(e) => setBaseline(e.target.value)}
                >
                  {benchmarkRuns.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="baseline-score">
              <span>
                <Target size={17} />
                Baseline accuracy
              </span>
              <strong>{pct(base?.score ?? null)}</strong>
            </div>
            <PerformanceChart runs={benchmarkRuns} compact />
          </section>
          <section className="panel hypotheses">
            <PanelTitle
              title="Ideas worth testing"
              description="Starting points for your next hypothesis."
            />
            {choices.map(([name, description, kind]) => (
              <button
                className={candidate === name ? "selected" : ""}
                key={name}
                onClick={() => {
                  setCandidate(name);
                  const next = {
                    ...config,
                    prompt: `${config.prompt}\n${description}`,
                    ...(kind === "Model comparison"
                      ? { provider: "ollama", model: "qwen3:8b" }
                      : {}),
                  };
                  setConfig(next);
                  s.updateConfig(next);
                }}
              >
                <span className="hypothesis-icon">
                  <Sparkles size={17} />
                </span>
                <section>
                  <strong>{name}</strong>
                  <p>{description}</p>
                  <small>{kind}</small>
                </section>
                {candidate === name ? <Check size={16} /> : <Plus size={16} />}
              </button>
            ))}
          </section>
        </div>
        <section className="panel candidate-panel">
          <PanelTitle
            title="02 / Shape your candidate"
            description="A clear hypothesis makes a useful experiment."
            action={<Badge>Draft</Badge>}
          />
          <div className="candidate-form">
            <label>
              Experiment hypothesis
              <input
                value={candidate}
                onChange={(e) => setCandidate(e.target.value)}
              />
            </label>
            <ConfigForm
              config={config}
              onChange={(c) => {
                setConfig(c);
                s.updateConfig(c);
              }}
            />
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <p className="form-hint">
              {s.mode === "demo"
                ? "Demo mode uses fixed fixture scores. Switch to the local API to measure this hypothesis."
                : "Runs synchronously against the local API. Provider credentials are read by your backend."}
            </p>
            <Button
              variant="primary full-width"
              disabled={s.busy || !dataset || !candidate.trim()}
              onClick={async () => {
                try {
                  const schema = JSON.parse(config.schema);
                  if (schema.type !== "object")
                    throw new Error("Use an object at the root of the schema.");
                  setError("");
                } catch (e) {
                  setError((e as Error).message);
                  return;
                }
                if (await s.benchmark(candidate, dataset, config))
                  s.navigate("Evaluations");
              }}
            >
              {s.busy ? (
                <Busy label="Evaluating candidate…" />
              ) : (
                <>
                  <Play size={14} />
                  Run candidate on benchmark
                  <ArrowRight size={15} />
                </>
              )}
            </Button>
          </div>
        </section>
      </div>
    </>
  );
}
export function Datasets() {
  const s = useStudio();
  const [newOpen, setNewOpen] = useState(false);
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [detail, setDetail] = useState<Dataset | null>(null);
  const [members, setMembers] = useState<string[]>([]);
  const [q, setQ] = useState("");
  async function create() {
    s.setBusy(true);
    try {
      if (s.mode === "live") {
        await api.createDataset(name, selected);
        await s.refresh();
      } else {
        s.setDatasets((ds) => [
          ...ds,
          {
            id: crypto.randomUUID(),
            name,
            description: "A session-local demo dataset.",
            count: selected.length,
            members: selected,
          },
        ]);
      }
      setNewOpen(false);
      setName("");
      s.setMessage(
        "Dataset created. Add ground truth before using it as a scored benchmark.",
      );
    } catch (e) {
      s.notifyError(e);
    } finally {
      s.setBusy(false);
    }
  }
  async function open(d: Dataset) {
    setDetail(d);
    if (s.mode === "live") {
      try {
        const data = await api.request(`/datasets/${d.id}`);
        setMembers(data.documents.map((x: any) => x.id));
      } catch (e) {
        s.notifyError(e);
      }
    } else
      setMembers(
        d.members ||
          s.documents
            .filter((x) => x.sample)
            .slice(0, d.count)
            .map((x) => x.id),
      );
  }
  return (
    <>
      <Heading
        eyebrow="GIVE YOUR EXPERIMENTS SOLID GROUND"
        title="A home for your documents."
        description="Organize your sources, establish ground truth, and build a benchmark you can trust."
        actions={
          <>
            <Button onClick={() => s.setUploadOpen(true)}>
              <Plus size={15} />
              Add documents
            </Button>
            <Button variant="primary" onClick={() => setNewOpen(true)}>
              <Database size={15} />
              New dataset
            </Button>
          </>
        }
      />
      <div className="dataset-cards">
        {s.datasets.map((d, i) => (
          <button className="dataset-card" onClick={() => open(d)} key={d.id}>
            <div>
              <span className={`dataset-icon color-${i % 3}`}>
                <Database size={24} />
              </span>
              <ArrowUpRight size={18} />
            </div>
            <h2>{d.name}</h2>
            <p>{d.description || "A local document benchmark."}</p>
            <footer>
              <span>
                <FileText size={14} />
                {d.count} documents
              </span>
              <Badge>Benchmark</Badge>
            </footer>
          </button>
        ))}
        <button
          className="dataset-card add-dataset"
          onClick={() => setNewOpen(true)}
        >
          <Plus size={28} />
          <h3>A new collection of possibilities</h3>
          <p>Create a dataset for your next use case.</p>
        </button>
      </div>
      <section className="panel">
        <PanelTitle
          title="Source library"
          description="Original documents, ready to explore."
          action={
            <div className="search-box">
              <Search size={15} />
              <input
                aria-label="Search documents"
                placeholder="Find a document…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </div>
          }
        />
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Document</th>
                <th>Format</th>
                <th>Pages</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {s.documents
                .filter((d) => d.name.toLowerCase().includes(q.toLowerCase()))
                .map((d) => (
                  <tr key={d.id}>
                    <td>
                      <button
                        className="document-name"
                        onClick={() => {
                          s.selectDocument(d);
                          s.navigate("Playground");
                        }}
                      >
                        <span className="pdf-icon">
                          <FileText size={17} />
                        </span>
                        <strong>{d.name}</strong>
                      </button>
                    </td>
                    <td>{d.name.split(".").at(-1)?.toUpperCase()}</td>
                    <td>{d.pages}</td>
                    <td>
                      <Badge
                        tone={
                          d.status === "Needs review"
                            ? "orange"
                            : d.status === "Extracted"
                              ? "green"
                              : "neutral"
                        }
                      >
                        {d.status}
                      </Badge>
                    </td>
                    <td>
                      <button
                        className="icon-button"
                        aria-label={`Open ${d.name}`}
                        onClick={() => {
                          s.selectDocument(d);
                          s.navigate("Playground");
                        }}
                      >
                        <ArrowUpRight size={15} />
                      </button>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
        {!s.documents.length && (
          <Empty
            title="Add your first document"
            description="Upload a source to start building your benchmark."
            action={
              <Button onClick={() => s.setUploadOpen(true)}>
                Add documents
              </Button>
            }
          />
        )}
      </section>
      <Modal
        title="Create a benchmark dataset"
        description="Choose documents to evaluate together."
        open={newOpen}
        onClose={() => setNewOpen(false)}
      >
        <label>
          Dataset name
          <input
            autoFocus
            placeholder="e.g. Purchase orders · September"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <div className="document-checkboxes">
          {s.documents.map((d) => (
            <label key={d.id}>
              <input
                type="checkbox"
                checked={selected.includes(d.id)}
                onChange={() =>
                  setSelected((ids) =>
                    ids.includes(d.id)
                      ? ids.filter((x) => x !== d.id)
                      : [...ids, d.id],
                  )
                }
              />
              <FileText size={15} />
              {d.name}
            </label>
          ))}
        </div>
        <div className="modal-actions">
          <span>{selected.length} documents selected</span>
          <Button
            variant="primary"
            disabled={!name.trim() || s.busy}
            onClick={create}
          >
            {s.busy ? <Busy /> : "Create dataset"}
          </Button>
        </div>
      </Modal>
      <Modal
        title={detail?.name || "Dataset"}
        description="Documents in this benchmark."
        open={!!detail}
        onClose={() => setDetail(null)}
      >
        <div className="command-results">
          {s.documents
            .filter((d) => members.includes(d.id))
            .map((d) => (
              <button
                key={d.id}
                onClick={() => {
                  s.selectDocument(d);
                  s.navigate("Playground");
                  setDetail(null);
                }}
              >
                <FileText size={17} />
                {d.name}
                <ArrowRight size={15} />
              </button>
            ))}
        </div>
        <Button
          onClick={() =>
            downloadJson("dataset-manifest.json", {
              dataset: detail,
              document_ids: members,
            })
          }
        >
          <Download size={14} />
          Export manifest
        </Button>
      </Modal>
    </>
  );
}
export function Settings() {
  const s = useStudio();
  return (
    <>
      <Heading
        eyebrow="BUILT AROUND YOUR STACK"
        title="Your models. Your machine."
        description="Choose your provider and parser. Keep the freedom to change either one."
      />
      <div className="settings-grid">
        <section className="panel settings-connection">
          <PanelTitle
            title="Workspace connection"
            description="Run locally, with your existing ezpz backend."
          />
          <div className="connection-illustration">
            <Monitor size={32} />
            <span>··············</span>
            <Server size={32} />
          </div>
          <div className="connection-row">
            <span>Current workspace</span>
            <Badge tone={s.mode === "live" ? "green" : "orange"}>
              {s.mode === "live" ? "API connected" : "Demo mode"}
            </Badge>
          </div>
          <p>
            The frontend proxies <code>/v1</code> to your local backend. Set{" "}
            <code>EZPZ_API_URL</code> in this repo’s <code>.env</code> to use
            another address.
          </p>
          <div className="terminal-example">
            <span>Start the original backend</span>
            <code>python3 server.py</code>
          </div>
          <div className="settings-buttons">
            <Button variant="primary" disabled={s.busy} onClick={s.connect}>
              {s.busy ? (
                <Busy label="Connecting…" />
              ) : (
                <>
                  <Link2 size={15} />
                  {s.mode === "live"
                    ? "Refresh connection"
                    : "Connect local API"}
                </>
              )}
            </Button>
            {s.mode === "live" ? (
              <Button onClick={s.demo}>Use demo</Button>
            ) : (
              <Button onClick={s.resetDemo}>Reset demo</Button>
            )}
          </div>
          <div className="privacy-note">
            <ShieldCheck size={18} />
            <p>
              Files stay on your machine until you run a configured external
              provider. Credentials are managed by the backend.
            </p>
          </div>
        </section>
        <section className="panel">
          <PanelTitle
            title="Default extraction configuration"
            description="Any supported provider. Any model ID. One consistent workflow."
          />
          <div className="candidate-form">
            <ConfigForm config={s.config} onChange={s.updateConfig} />
            <div className="saved-caption">
              <Check size={14} />
              Saved automatically in this browser
            </div>
            <Button
              onClick={() => downloadJson("ezpz-configuration.json", s.config)}
            >
              <Download size={14} />
              Export configuration
            </Button>
          </div>
        </section>
      </div>
      <section className="panel providers-panel">
        <PanelTitle
          title="A flexible foundation"
          description="A shared schema and evaluation loop across providers."
        />
        <div className="provider-grid">
          {[
            ["OpenAI", "Hosted models"],
            ["Anthropic", "Hosted models"],
            ["Google", "Hosted models"],
            ["Ollama", "Open models, locally"],
            ["Compatible API", "Your own endpoint"],
          ].map(([name, desc]) => (
            <div key={name}>
              <ModelMark provider={name} />
              <h3>{name}</h3>
              <p>{desc}</p>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
