import { HillLoop } from "./hill-loop";
import { HillSuggestions } from "./hill-suggestions-panel";
import { applySuggestion } from "./hill-suggestions";
import { workspaceId, defaultWorkspaceId } from "./workspace-context";
import { ModelSettingsForm } from "./model-settings-form";
import { CredentialSettings } from "./credential-settings";
import { settingsAfterModelChange } from "./model-settings";
import { ModelPicker, builtinModels } from "./model-picker";
import { isLowConfidence } from "./confidence";
import { FieldSelect } from "./components/field-select";
import { useEffect, useState } from "react";
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
  const low = s.reviewDocuments
    .filter((d) => s.mode === "demo" || d.runId)
    .flatMap((d) =>
      d.fields.filter(
        (f) =>
          (isLowConfidence(f) ||
            (f.status && !["correct", "unscored"].includes(f.status))) &&
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
        {s.mode === "live" && s.documents.length === 0 && (
          <button onClick={s.demo}>Explore sample <ArrowRight size={16} /></button>
        )}
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
            <th>Avg. latency / doc</th>
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
  showSchema = true,
  collapseModelSettings = false,
}: {
  config: Config;
  onChange: (c: Config) => void;
  showSchema?: boolean;
  collapseModelSettings?: boolean;
}) {
  const s = useStudio();
  const patch = (p: Partial<Config>) => onChange({
    ...config, ...p,
    ...((p.provider !== undefined && p.provider !== config.provider) || (p.model !== undefined && p.model !== config.model)
      ? { modelSettings: p.provider === "local" ? {} : settingsAfterModelChange(config.modelSettings) } : {}),
  });
  return (
    <div className="config-form">
      <div className="form-row">
        <label>
          Model provider
          <FieldSelect
            value={config.provider}
            onValueChange={(value) =>
              patch({
                provider: value,
                baseUrl:
                  s.adapters?.llm.find((p) => p.id === value)
                    ?.default_endpoint || config.baseUrl,
                model:
                  s.adapters?.llm.find((p) => p.id === value)?.models[0] ||
                  (
                    {
                      local: "deterministic-local",
                      openai: builtinModels("openai")[0],
                      anthropic: builtinModels("anthropic")[0],
                      google: builtinModels("google")[0],
                      ollama: "qwen3:8b",
                      "openai-compatible": "custom-model",
                    } as Record<string, string>
                  )[value] ||
                  "",
              })
            }
            aria-label="Model provider"
            options={
              s.mode === "live" && s.adapters
                ? s.adapters.llm.map((p) => ({ value: p.id, label: p.label }))
                : [
                    ["local", "Local · deterministic"],
                    ["openai", "OpenAI"],
                    ["anthropic", "Anthropic"],
                    ["google", "Google Gemini"],
                    ["ollama", "Ollama"],
                    ["openai-compatible", "OpenAI-compatible endpoint"],
                  ].map(([value, label]) => ({ value, label }))
            }
          />
        </label>
        <ModelPicker
          provider={config.provider}
          endpoint={["ollama", "openai-compatible"].includes(config.provider) ? config.baseUrl : undefined}
          value={config.model}
          onChange={(model) => patch({ model })}
          live={s.mode === "live"}
        />
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
      <ModelSettingsForm initiallyOpen={!collapseModelSettings} provider={config.provider} model={config.model}
        value={config.modelSettings} onChange={modelSettings => patch({ modelSettings })} />
      <label>
        Document parser
        <FieldSelect
          value={config.parser}
          onValueChange={(value) => patch({ parser: value })}
          aria-label="Document parser"
          options={
            s.mode === "live" && s.adapters
              ? s.adapters.parsers.map((p) => ({ value: p.id, label: p.label }))
              : [
                  { value: "none", label: "Original document · no parser" },
                  { value: "native", label: "Native text · local" },
                  { value: "docling", label: "Docling · local" },
                  { value: "llama-parse", label: "LlamaParse" },
                ]
          }
        />
      </label>
      {config.parser === "none" && <p className="form-hint">PDF and image input requires a compatible hosted model. Source boxes are model estimates and may be approximate. Fields without a locatable source have no box.</p>}
      <label>
        Extraction instructions
        <textarea
          rows={4}
          value={config.prompt}
          onChange={(e) => patch({ prompt: e.target.value })}
        />
      </label>
      {showSchema && (
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
      )}
    </div>
  );
}
export function RunModal({
  open,
  onClose,
  groupId,
}: {
  open: boolean;
  onClose: () => void;
  groupId?: string;
}) {
  const s = useStudio();
  const [name, setName] = useState("Untitled experiment");
  const [processorId, setProcessorId] = useState(s.activeProcessor?.id || "");
  const [group, setGroup] = useState(groupId || s.evalGroups[0]?.id || "new");
  const [groupName, setGroupName] = useState("");
  const [dataset, setDataset] = useState(
    s.evalGroups.find((g) => g.id === (groupId || s.evalGroups[0]?.id))
      ?.datasetId ||
      s.datasets[0]?.id ||
      "",
  );
  const [config, setConfig] = useState(s.config);
  const [error, setError] = useState("");
  return (
    <Modal
      title="New experiment"
      description="Test a model, prompt, or schema change against this group’s benchmark. Reusing a saved configuration adds a run to its existing experiment."
      open={open}
      onClose={onClose}
      wide
    >
      <label>
        Processor configuration
        <FieldSelect
          value={processorId}
          onValueChange={(value) => {
            setProcessorId(value);
            const p = s.processors.find((p) => p.id === value);
            setConfig(structuredClone(p?.config || s.config));
          }}
          aria-label="Processor configuration"
          options={[
            { value: "", label: "Current playground configuration" },
            ...s.processors.map((p) => ({
              value: p.id,
              label: p.name + " · v" + p.version,
            })),
          ]}
        />
      </label>
      <label>
        Evaluation group
        <FieldSelect
          value={group}
          disabled={!!groupId}
          onValueChange={(value) => {
            setGroup(value);
            const g = s.evalGroups.find((g) => g.id === value);
            if (g) setDataset(g.datasetId);
          }}
          aria-label="Evaluation group"
          options={[
            ...s.evalGroups.map((g) => ({ value: g.id, label: g.name })),
            { value: "new", label: "Create a new group…" },
          ]}
        />
      </label>
      {group === "new" && (
        <label>
          Group name
          <input
            value={groupName}
            onChange={(e) => setGroupName(e.target.value)}
            placeholder="e.g. Invoice extraction"
          />
        </label>
      )}
      <label>
        Experiment name
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        Benchmark dataset
        <FieldSelect
          value={dataset}
          disabled={group !== "new"}
          onValueChange={(value) => setDataset(value)}
          aria-label="Benchmark dataset"
          options={[
            { value: "", label: "Select a dataset", disabled: true },
            ...s.datasets.map((d) => ({
              value: d.id,
              label: d.name + " (" + d.count + " documents)",
            })),
          ]}
        />
      </label>
      <ConfigForm
        config={config}
        onChange={(c) => {
          setConfig(c);
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
          disabled={
            s.busy ||
            !dataset ||
            !name.trim() ||
            (group === "new" && !groupName.trim())
          }
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
            if (
              await s.benchmark(
                name,
                dataset,
                config,
                group === "new"
                  ? { name: groupName, processorId }
                  : { id: group, processorId },
              )
            )
              onClose();
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
export function HillClimbing() {
  const s = useStudio();
  const [loopActive, setLoopActive] = useState(false);
  const [candidate, setCandidate] = useState("");
  const [selectedSuggestion, setSelectedSuggestion] = useState("");
  const [config, setConfig] = useState(s.runs[0]?.config || s.config);
  const [dataset, setDataset] = useState(
    s.runs[0]?.datasetId || s.datasets[0]?.id || "",
  );
  const [baseline, setBaseline] = useState(s.runs[0]?.id || "");
  const [error, setError] = useState("");
  const benchmarkRuns = s.runs.filter((r) => r.datasetId === dataset);
  const base = benchmarkRuns.find((r) => r.id === baseline);
  useEffect(() => {
    if (!dataset && s.datasets.length) {
      const first = s.runs[0];
      setDataset(first?.datasetId || s.datasets[0].id);
      setBaseline(first?.id || "");
      setConfig(first?.config || s.config);
    }
  }, [dataset, s.datasets, s.runs, s.config]);
  const [mode, setMode] = useState<"automatic" | "manual">("automatic");
  return (
    <div className="hill-workspace">
      <Heading title="Hill climbing" description="Improve prompts against a fixed benchmark." />
      <section className="hill-benchmark" aria-label="Benchmark selection">
        <label>
          <FileText size={19} aria-hidden="true" />
          <span>Dataset
            <FieldSelect disabled={loopActive || s.busy} value={dataset}
              onValueChange={(value) => {
                setDataset(value); setCandidate(""); setSelectedSuggestion(""); setError(""); setBaseline(s.runs.find((r) => r.datasetId === value)?.id || "");
                setConfig(s.runs.find((r) => r.datasetId === value)?.config || s.config);
              }}
              aria-label="Dataset"
              options={s.datasets.map((d) => ({ value: d.id, label: d.name }))} />
          </span>
        </label>
        <label>
          <BarChart3 size={19} aria-hidden="true" />
          <span>Baseline
            <FieldSelect disabled={loopActive || s.busy} value={base?.id || ""}
              placeholder="Initial baseline will be evaluated"
              onValueChange={(value) => {
                setBaseline(value); setCandidate(""); setSelectedSuggestion(""); setError("");
                setConfig(s.runs.find((r) => r.id === value)?.config || s.config);
              }}
              aria-label="Baseline run"
              options={[{ value: "", label: "Evaluate a new baseline" }, ...benchmarkRuns.map((r) => ({ value: r.id, label: r.name }))]} />
          </span>
        </label>
        <div className="hill-benchmark-score"><span>Baseline accuracy</span><strong>{pct(base?.score ?? null)}</strong></div>
      </section>
      {!dataset && <p className="form-hint">Create a dataset before starting a loop.</p>}
      <div className="hill-mode-tabs" role="tablist" aria-label="Experiment mode">
        {(["automatic", "manual"] as const).map((value) => <button key={value} type="button" role="tab"
          id={`hill-tab-${value}`} aria-controls={`hill-mode-${value}`} aria-selected={mode === value}
          tabIndex={mode === value ? 0 : -1} onClick={() => setMode(value)}
          onKeyDown={(event) => {
            if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
              event.preventDefault();
              const next = event.key === "Home" ? "automatic" : event.key === "End" ? "manual" : mode === "automatic" ? "manual" : "automatic";
              setMode(next); document.getElementById(`hill-tab-${next}`)?.focus();
            }
          }}>{value === "automatic" ? "Automatic" : "Manual experiment"}{value === "automatic" && loopActive && <span className="hill-live-dot" aria-label="Running" />}</button>)}
      </div>
      <div className="hill-mode-panel" role="tabpanel" id="hill-mode-automatic" aria-labelledby="hill-tab-automatic" hidden={mode !== "automatic"}>
        <HillLoop base={base} datasetId={dataset} config={config}
          onActiveChange={setLoopActive} onUseBest={(best, runId, datasetId) => {
            setBaseline(runId); setDataset(datasetId); setConfig(best); setCandidate("Best configuration from automatic hill climbing"); setSelectedSuggestion("");
            setMode("manual"); s.setMessage("Best configuration loaded into your manual candidate.");
          }} />
      </div>
      <div className="hill-mode-panel" role="tabpanel" id="hill-mode-manual" aria-labelledby="hill-tab-manual" hidden={mode !== "manual"}>
      <div className="hill-grid">
        <div>
          <HillSuggestions
            key={`${s.mode}:${dataset}:${base?.id || "none"}`}
            base={base}
            datasetId={dataset}
            config={config}
            selected={selectedSuggestion}
            onChoose={(idea) => {
              setCandidate(idea.title);
              setSelectedSuggestion(idea.id);
              setConfig(applySuggestion(base?.config || config, idea));
              setError("");
            }}
          />
        </div>
        <section className="panel candidate-panel">
          <PanelTitle
            title="Shape your candidate"
            description="A clear hypothesis makes a useful experiment."
            action={<Badge>Draft</Badge>}
          />
          <div className="candidate-form">
            <label>
              Experiment hypothesis
              <input
                value={candidate}
                placeholder="Choose a suggestion or write your hypothesis"
                onChange={(e) => { setCandidate(e.target.value); setSelectedSuggestion(""); }}
              />
            </label>
            <ConfigForm
              config={config}
              collapseModelSettings
              onChange={(c) => {
                setConfig(c);
                setSelectedSuggestion("");
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
            {!candidate.trim() && <p className="form-hint">Choose a suggestion or enter a hypothesis to run a candidate.</p>}
            {loopActive && <p className="form-hint" role="status">An automatic loop is running. Stop it or wait for it to finish before running a manual candidate.</p>}
            <Button
              variant="full-width"
              disabled={loopActive || s.busy || !dataset || !candidate.trim()}
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
                if (
                  await s.benchmark(candidate, dataset, config, {
                    id: base?.groupId,
                    processorId: base?.processorId,
                  })
                )
                  s.navigate("Evaluations");
              }}
            >
              {s.busy ? (
                <Busy label="Evaluating candidate…" />
              ) : (
                <>
                  <Play size={14} />
                  Run this candidate once
                  <ArrowRight size={15} />
                </>
              )}
            </Button>
          </div>
        </section>
      </div>
      </div>
    </div>
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
    setMembers([]);
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
          onClick={async () => {
            try {
              const manifest =
                s.mode === "live"
                  ? (await api.request(`/datasets/${detail!.id}/manifest`))
                      .manifest
                  : { dataset: detail, document_ids: members };
              downloadJson("dataset-manifest.json", manifest);
            } catch (e) {
              s.notifyError(e);
            }
          }}
        >
          <Download size={14} />
          Export manifest
        </Button>
      </Modal>
    </>
  );
}
const settingsTabs = [
  { id: "connections", label: "Connections" },
  { id: "defaults", label: "Extraction defaults" },
  { id: "workspace", label: "Workspace" },
] as const;
type SettingsTab = typeof settingsTabs[number]["id"];

export function Settings() {
  const s = useStudio();
  const [activeTab, setActiveTab] = useState<SettingsTab>("connections");
  const [credentialRevision, setCredentialRevision] = useState(0);
  const selectTab = (id: SettingsTab) => {
    setActiveTab(id);
    document.getElementById(`settings-tab-${id}`)?.focus();
  };
  return (
    <div className="settings-page">
      <Heading title="Settings" description="Connect your stack and set your extraction defaults." />
      <div className="settings-tabs" role="tablist" aria-label="Settings sections">
        {settingsTabs.map((tab, index) => (
          <button key={tab.id} id={`settings-tab-${tab.id}`} type="button" role="tab"
            aria-selected={activeTab === tab.id} aria-controls={`settings-panel-${tab.id}`}
            tabIndex={activeTab === tab.id ? 0 : -1}
            onClick={() => setActiveTab(tab.id)}
            onKeyDown={event => {
              const next = event.key === "ArrowRight" ? (index + 1) % settingsTabs.length
                : event.key === "ArrowLeft" ? (index + settingsTabs.length - 1) % settingsTabs.length
                : event.key === "Home" ? 0 : event.key === "End" ? settingsTabs.length - 1 : -1;
              if (next < 0) return;
              event.preventDefault(); selectTab(settingsTabs[next].id);
            }}>
            {tab.label}
          </button>
        ))}
      </div>
      <div id="settings-panel-connections" role="tabpanel" aria-labelledby="settings-tab-connections"
        hidden={activeTab !== "connections"} tabIndex={0}>
        <CredentialSettings live={s.mode === "live"} onSaved={() => setCredentialRevision(value => value + 1)}
          onDefaults={() => selectTab("defaults")} onWorkspace={() => selectTab("workspace")} />
      </div>
      <div id="settings-panel-defaults" role="tabpanel" aria-labelledby="settings-tab-defaults"
        hidden={activeTab !== "defaults"} tabIndex={0}>
        <section className="settings-defaults">
          <div className="settings-section-heading">
            <div><h2>Extraction defaults</h2><p>Choose the model, parser, and instructions for your next extraction.</p></div>
            <Button onClick={() => downloadJson("ezpz-configuration.json", s.config)}>
              <Download size={15} />Export configuration
            </Button>
          </div>
          <div className="candidate-form">
            <ConfigForm key={credentialRevision} config={s.config} onChange={s.updateConfig} />
            <div className="saved-caption"><Check size={14} />Saved automatically in this browser</div>
          </div>
        </section>
      </div>
      <div id="settings-panel-workspace" role="tabpanel" aria-labelledby="settings-tab-workspace"
        hidden={activeTab !== "workspace"} tabIndex={0}>
        <section className="settings-connection settings-workspace">
          <PanelTitle
            title="Workspace connection"
            description="Your documents and evaluations are saved on this machine."
          />
          <div className="connection-row">
            <span>Current workspace</span>
            <Badge tone={s.mode === "live" ? "green" : "orange"}>
              {s.mode === "live" ? "API connected" : "Demo mode"}
            </Badge>
          </div>
          <p>
            Studio and its local service run together. Your saved workspace
            remains available when you stop, restart, or upgrade the app.
          </p>
          <div className="terminal-example">
            <span>Reopen your workspace</span>
            <code>ezpz studio</code>
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
          <div className="settings-drafts">
            <h3>Browser drafts</h3>
            <p>Clear working copies and selections in this browser. Saved documents and evaluations stay in your workspace.</p>
            <Button
              disabled={s.busy}
              title="Clear browser working copies and selections. Saved backend data is unaffected."
              onClick={() => {
                for (const key of Object.keys(localStorage)) {
                  if (
                    workspaceId === defaultWorkspaceId
                      ? key.startsWith("ezpz-live-") || key.startsWith("ezpz-redesign-")
                      : key.startsWith(`ezpz-workspace:${workspaceId}:`)
                  )
                    localStorage.removeItem(key);
                }
                location.reload();
              }}
            >
              Clear browser drafts
            </Button>
          </div>
          <div className="privacy-note">
            <ShieldCheck size={18} />
            <p>
              Files stay on your machine until you run a configured external
              provider. Credentials are managed by the backend.
            </p>
          </div>
        </section>
      </div>
    </div>
  );
}
