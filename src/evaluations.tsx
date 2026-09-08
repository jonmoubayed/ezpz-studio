import { FieldValues } from "./expected-values";
import { FieldSelect } from "./components/field-select";
import { useEffect, useState } from "react";
import {
  ArrowRight,
  ChevronRight,
  Download,
  FileText,
  GitCompareArrows,
  Layers,
  Plus,
  Search,
  X,
} from "lucide-react";
import { Badge, Button, Busy, Empty, Heading, Modal } from "./ui";
import { RunModal, ModelMark } from "./pages";
import { SourceViewer } from "./workbench";
import { useStudio } from "./store";
import { downloadJson, pct, type Run, type Document } from "./domain";
import * as api from "./api";
import {
  formatCost,
  totalRunCost,
  formatRunDuration,
  groupRuns,
  groupExperiments,
  configurationChanges,
  evaluationPath,
  parseEvaluationPath,
  evaluationDocuments,
  demoEvaluationDocuments,
  failed,
  scoreDelta,
} from "./evaluation-model";

function Delta({ run, baseline }: { run: Run; baseline?: Run }) {
  const { mode } = useStudio();
  if (
    baseline &&
    mode !== "demo" &&
    (run.status.toLowerCase() !== "completed" ||
      baseline.status.toLowerCase() !== "completed" ||
      !run.benchmarkFingerprint ||
      run.benchmarkFingerprint !== baseline.benchmarkFingerprint)
  )
    return <span className="eval-delta">—</span>;
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
function go(path: string) {
  location.hash = path;
  window.scrollTo({ top: 0, behavior: "instant" });
}
function representative(runs: Run[]) {
  return (
    [...runs].reverse().find((r) => r.status.toLowerCase() === "completed") ||
    runs.at(-1)
  );
}
function EvaluationTrail({
  items,
}: {
  items: { label: string; path?: string }[];
}) {
  return (
    <nav className="evaluation-trail" aria-label="Evaluation breadcrumbs">
      <a href="#Evaluations">Evaluation groups</a>
      {items.map((item, i) => (
        <span key={i}>
          <ChevronRight size={12} />
          {item.path ? (
            <a href={item.path}>{item.label}</a>
          ) : (
            <span aria-current="page">{item.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}
function Stats({ items }: { items: [string, string, string][] }) {
  return (
    <div className="evaluation-stats">
      {items.map(([label, value, note]) => (
        <div key={label}>
          <span>{label}</span>
          <strong>{value}</strong>
          <small>{note}</small>
        </div>
      ))}
    </div>
  );
}
export function Evaluations() {
  const s = useStudio();
  const [hash, setHash] = useState(location.hash);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [newRun, setNewRun] = useState(false);
  const [newGroup, setNewGroup] = useState(false);
  const [baselineIds, setBaselineIds] = useState<Record<string, string>>({});
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const sync = () => {
      setHash(location.hash);
      setSelected([]);
      setQuery("");
      setError("");
      setNewRun(false);
    };
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);
  const route = parseEvaluationPath(hash);
  const groups = groupRuns(
    s.runs.filter((r) => !!r.datasetId),
    s.evalGroups,
  );
  const group = groups.find((g) => g.id === route.groupId);
  const experiments = group ? groupExperiments(group) : [];
  const experiment = experiments.find((e) => e.id === route.experimentId);
  const run = experiment?.runs.find((r) => r.id === route.runId);
  const representatives = experiments
    .map((e) => representative(e.runs))
    .filter((r): r is Run => !!r);
  const baseline =
    representatives.find((r) => r.id === baselineIds[group?.id || ""]) ||
    representatives.find((r) => r.score !== null && r.status.toLowerCase() === "completed") ||
    representatives[0];
  const best = [...representatives]
    .filter(
      (r) =>
        r.score !== null && r.status.toLowerCase() === "completed" &&
        (s.mode === "demo" ||
          (baseline?.benchmarkFingerprint &&
            r.benchmarkFingerprint === baseline.benchmarkFingerprint)),
    )
    .sort((a, b) => b.score! - a.score!)[0];
  const choose = (id: string) =>
    setSelected((ids) =>
      ids.includes(id)
        ? ids.filter((v) => v !== id)
        : ids.length < 4
          ? [...ids, id]
          : ids,
    );
  const compareSelected = () =>
    go(
      `${evaluationPath(group!.id)}/compare/${selected.map(encodeURIComponent).join("/")}`,
    );
  const datasetName = group
    ? s.datasets.find((d) => d.id === group.datasetId)?.name ||
      group.runs[0]?.dataset ||
      "Benchmark dataset"
    : "";
  const groupPath = group ? evaluationPath(group.id) : "#Evaluations";
  if (
    (route.groupId && !group) ||
    (route.experimentId && !experiment) ||
    (route.runId && !run)
  )
    return (
      <>
        <EvaluationTrail items={[]} />
        <Empty
          title="Evaluation not found"
          description="This group, experiment, or run is no longer in this workspace."
          action={
            <Button onClick={() => go("#Evaluations")}>Back to groups</Button>
          }
        />
      </>
    );
  if (group && experiment && run)
    return (
      <>
        <EvaluationTrail
          items={[
            { label: group.name, path: groupPath },
            {
              label: experiment.name,
              path: evaluationPath(group.id, experiment.id),
            },
            { label: `Run ${run.id.slice(-8)}` },
          ]}
        />
        <EvaluationResults key={run.id} run={run} />
      </>
    );
  if (group && route.compare) {
    let ids: string[] = [];
    try {
      ids = hash.split("/").slice(4).map(decodeURIComponent);
    } catch {
      /* Invalid links render an empty state. */
    }
    const runs = [...new Set(ids)]
      .map((id) =>
        group.runs.find((r) => r.id === id && r.datasetId === group.datasetId),
      )
      .filter((r): r is Run => !!r)
      .slice(0, 4);
    return (
      <div className="evaluations-page">
        <EvaluationTrail
          items={[
            { label: group.name, path: groupPath },
            { label: "Compare runs" },
          ]}
        />
        <Heading
          title="Compare experiments"
          description={`${group.name} · ${datasetName}. Highlighted cells differ from the selected baseline.`}
        />
        {runs.length >= 2 && runs.every(r => r.status.toLowerCase() === "completed") &&
        (s.mode === "demo" ||
          (runs[0].benchmarkFingerprint &&
            runs.every(
              (r) => r.benchmarkFingerprint === runs[0].benchmarkFingerprint,
            ))) ? (
          <RunComparison
            key={hash}
            runs={runs}
            onInspect={(r) =>
              go(
                evaluationPath(
                  group.id,
                  r.experimentId || `legacy:${r.id}`,
                  r.id,
                ),
              )
            }
            onClose={() => go(groupPath)}
          />
        ) : (
          <Empty
            title="Choose runs from the same benchmark snapshot"
            description="Select 2–4 completed runs made with identical documents and annotation revisions. Older runs without snapshots need to be run again."
            action={
              <Button onClick={() => go(groupPath)}>Choose experiments</Button>
            }
          />
        )}
      </div>
    );
  }
  if (group && experiment) {
    const latest = representative(experiment.runs);
    const config = experiment.config || latest?.config;
    return (
      <div className="evaluations-page">
        <EvaluationTrail
          items={[
            { label: group.name, path: groupPath },
            { label: experiment.name },
          ]}
        />
        <Heading
          eyebrow="EXPERIMENT"
          title={experiment.name}
          description={
            experiment.description ||
            "One saved configuration. Every execution below belongs to this experiment."
          }
          actions={
            <Button
              variant="primary"
              disabled={
                running ||
                s.mode === "demo" ||
                experiment.id.startsWith("legacy:")
              }
              onClick={async () => {
                setRunning(true);
                setError("");
                try {
                  const data = await api.request("/runs", {
                    method: "POST",
                    body: JSON.stringify({
                      eval_experiment_id: experiment.id,
                      dataset_id: group.datasetId,
                      metadata: { name: experiment.name },
                      force_refresh: true,
                      background: true,
                    }),
                  });
                  await s.refresh();
                  if (data.run)
                    go(evaluationPath(group.id, experiment.id, data.run.id));
                } catch (e) {
                  setError(e instanceof Error ? e.message : String(e));
                } finally {
                  setRunning(false);
                }
              }}
            >
              {running ? (
                <Busy label="Running…" />
              ) : (
                <>
                  <Plus size={14} />
                  Run again
                </>
              )}
            </Button>
          }
        />
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <Stats
          items={[
            [
              "Latest accuracy",
              pct(latest?.score ?? null),
              "Latest completed execution",
            ],
            [
              "Executions",
              String(experiment.runs.length),
              "Same saved configuration",
            ],
            [
              "Average latency",
              latest ? `${latest.latency.toFixed(1)}s` : "—",
              "Per document · latest execution",
            ],
            [
              "Est. total cost",
              formatCost(totalRunCost(experiment.runs)),
              "Across this experiment’s runs",
            ],
          ]}
        />
        <section className="panel experiment-config">
          <div className="evaluation-section-heading">
            <div>
              <h2>Configuration</h2>
              <p>{datasetName} · Fixed benchmark</p>
            </div>
            <Badge>{config?.model || "Not recorded"}</Badge>
          </div>
          <div className="experiment-config-meta">
            <span>
              Provider <strong>{config?.provider || "—"}</strong>
            </span>
            <span>
              Parser <strong>{config?.parser || "—"}</strong>
            </span>
            <span>
              Changes vs baseline{" "}
              <strong>
                {latest?.id === baseline?.id
                  ? "Baseline"
                  : configurationChanges(config, baseline?.config).join(", ") ||
                    "Same configuration"}
              </strong>
            </span>
          </div>
          <div className="experiment-snapshots">
            {(["prompt", "schema"] as const).map((key) => (
              <details key={key}>
                <summary>
                  {key === "prompt" ? "Extraction prompt" : "Extraction schema"}
                </summary>
                <pre>{config?.[key] || "Not recorded"}</pre>
              </details>
            ))}
          </div>
        </section>
        <section className="panel">
          <div className="evaluation-section-heading">
            <div>
              <h2>Runs</h2>
              <p>
                Inspect an execution to review documents, extracted values, and
                expected values.
              </p>
            </div>
            <Button disabled={selected.length < 2} onClick={compareSelected}>
              <GitCompareArrows size={14} />
              Compare runs{selected.length ? ` (${selected.length})` : ""}
            </Button>
          </div>
          <div className="eval-table-scroll">
            <table className="data-table eval-iteration-table">
              <thead>
                <tr>
                  <th aria-label="Select runs" />
                  <th>Execution</th>
                  <th>Status</th>
                  <th>Accuracy</th>
                  <th>Avg. latency / doc</th>
                  <th>Est. total cost</th>
                  <th>Documents</th>
                </tr>
              </thead>
              <tbody>
                {[...experiment.runs].reverse().map((r) => (
                  <tr key={r.id}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Compare run ${r.id.slice(-8)}`}
                        checked={selected.includes(r.id)}
                        disabled={
                          !selected.includes(r.id) && selected.length >= 4
                        }
                        onChange={() => choose(r.id)}
                      />
                    </td>
                    <td>
                      <a
                        className="eval-run-link"
                        href={evaluationPath(group.id, experiment.id, r.id)}
                      >
                        Run {r.id.slice(-8)} <ArrowRight size={12} />
                      </a>
                      <small>{new Date(r.date).toLocaleString()}</small>
                    </td>
                    <td>
                      <Badge>{r.status}</Badge>
                    </td>
                    <td>
                      <strong>{pct(r.score)}</strong>
                    </td>
                    <td>{r.latency.toFixed(1)}s</td>
                    <td>{formatCost(r.cost)}</td>
                    <td>{r.documents}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!experiment.runs.length && (
            <Empty
              title="No runs yet"
              description="Run this saved configuration to measure it against the group’s benchmark."
            />
          )}
        </section>
      </div>
    );
  }
  return (
    <div className="evaluations-page">
      {group && <EvaluationTrail items={[{ label: group.name }]} />}
      <Heading
        eyebrow={group ? "EVALUATION GROUP" : undefined}
        title={group?.name || "Evaluation groups"}
        description={
          group
            ? group.description ||
              "Compare experiments against one benchmark. Open an experiment to inspect its runs."
            : "A dedicated benchmark for each process. Open a group to explore experiments and improvements."
        }
        actions={
          <Button
            variant="primary"
            onClick={() => (group ? setNewRun(true) : setNewGroup(true))}
          >
            <Plus size={14} />
            {group ? "New experiment" : "New group"}
          </Button>
        }
      />
      {group ? (
        <>
          <div className="evaluation-context">
            <Layers size={14} />
            <strong>{datasetName}</strong>
            <span>
              {s.datasets.find((d) => d.id === group.datasetId)?.count ?? "—"}{" "}
              documents in current dataset
            </span>
            <Badge>Fixed benchmark</Badge>
          </div>
          <Stats
            items={[
              [
                "Experiments",
                String(experiments.length),
                `${group.runs.length} total runs`,
              ],
              [
                "Best accuracy",
                pct(best?.score ?? null),
                best
                  ? experiments.find((e) =>
                      e.runs.some((r) => r.id === best.id),
                    )?.name || best.name
                  : "No scored experiment yet",
              ],
              [
                "Improvement",
                scoreDelta(best?.score ?? null, baseline?.score ?? null),
                "Best vs selected baseline",
              ],
              [
                "Est. total cost",
                formatCost(totalRunCost(group.runs)),
                "Across all runs in this group",
              ],
            ]}
          />
          <section className="panel">
            <div className="evaluation-section-heading">
              <div>
                <h2>Experiments</h2>
                <p>
                  Metrics use each experiment’s latest completed run. Select 2–4
                  to compare.
                </p>
              </div>
              <Button disabled={selected.length < 2} onClick={compareSelected}>
                <GitCompareArrows size={14} />
                Compare{selected.length ? ` (${selected.length})` : ""}
              </Button>
            </div>
            {!!representatives.length && (
              <div className="evaluation-baseline">
                <label>
                  Baseline experiment{" "}
                  <FieldSelect
                    aria-label="Baseline experiment"
                    value={baseline?.id || ""}
                    onValueChange={(id) =>
                      setBaselineIds({ ...baselineIds, [group.id]: id })
                    }
                    options={experiments.flatMap((e) => {
                      const r = representative(e.runs);
                      return r ? [{ value: r.id, label: e.name }] : [];
                    })}
                  />
                </label>
              </div>
            )}
            {!!experiments.length ? (
              <div className="eval-table-scroll">
                <table className="data-table eval-iteration-table">
                  <thead>
                    <tr>
                      <th aria-label="Select experiments" />
                      <th>Experiment</th>
                      <th>Configuration / changes</th>
                      <th>Accuracy</th>
                      <th>Δ baseline</th>
                      <th>Runs</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {[...experiments].reverse().map((e) => {
                      const r = representative(e.runs);
                      const changes = configurationChanges(
                        e.config || r?.config,
                        baseline?.config,
                      );
                      return (
                        <tr
                          key={e.id}
                          className={
                            r && selected.includes(r.id) ? "is-selected" : ""
                          }
                        >
                          <td>
                            <input
                              type="checkbox"
                              aria-label={`Compare ${e.name}`}
                              checked={!!r && selected.includes(r.id)}
                              disabled={
                                !r ||
                                (!selected.includes(r.id) &&
                                  selected.length >= 4)
                              }
                              onChange={() => r && choose(r.id)}
                            />
                          </td>
                          <td>
                            <a
                              className="eval-run-link"
                              href={evaluationPath(group.id, e.id)}
                            >
                              {e.name}
                            </a>
                            <small>
                              {r ? r.status : "Not run"}
                              {r?.id === best?.id && (
                                <span className="eval-best-tag">Best</span>
                              )}
                              {r?.id === baseline?.id && (
                                <span className="eval-best-tag">Baseline</span>
                              )}
                            </small>
                          </td>
                          <td>
                            <span className="eval-model">
                              <ModelMark
                                provider={
                                  e.config?.provider || r?.provider || "local"
                                }
                              />
                              {e.config?.model || r?.model || "Not recorded"}
                            </span>
                            <small>
                              {r?.id === baseline?.id
                                ? "Reference configuration"
                                : changes.length
                                  ? `${changes.join(" + ")} changed`
                                  : "Same configuration"}
                            </small>
                          </td>
                          <td>
                            <strong>{pct(r?.score ?? null)}</strong>
                          </td>
                          <td>
                            {r ? <Delta run={r} baseline={baseline} /> : "—"}
                          </td>
                          <td>{e.runs.length}</td>
                          <td>
                            <a
                              className="eval-inspect-button"
                              href={evaluationPath(group.id, e.id)}
                            >
                              Open <ArrowRight size={12} />
                            </a>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty
                title="Start the first experiment"
                description="Choose a processor and test its model, prompt, and schema against this benchmark."
                action={
                  <Button onClick={() => setNewRun(true)}>
                    New experiment
                  </Button>
                }
              />
            )}
          </section>
        </>
      ) : (
        <>
          <div className="eval-command-bar">
            <div className="search-box">
              <Search size={14} />
              <input
                aria-label="Search evaluation groups"
                placeholder="Find a group or benchmark…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <span>{groups.length} groups</span>
          </div>
          <section className="panel evaluation-directory">
            <div className="eval-table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Group / benchmark</th>
                    <th>Experiments</th>
                    <th>Runs</th>
                    <th>Best accuracy</th>
                    <th>Last run</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {groups
                    .filter((g) =>
                      `${g.name} ${s.datasets.find((d) => d.id === g.datasetId)?.name || ""}`
                        .toLowerCase()
                        .includes(query.toLowerCase()),
                    )
                    .map((g) => {
                      const experiments = groupExperiments(g);
                      const scored = experiments
                        .map((e) => representative(e.runs))
                        .filter((r): r is Run => !!r && r.score !== null);
                      const best = scored.sort(
                        (a, b) => b.score! - a.score!,
                      )[0];
                      return (
                        <tr key={g.id}>
                          <td>
                            <a
                              className="evaluation-group-link"
                              href={evaluationPath(g.id)}
                            >
                              <span className="eval-group-icon">
                                <Layers size={16} />
                              </span>
                              <span>
                                <strong>{g.name}</strong>
                                <small>
                                  {s.datasets.find((d) => d.id === g.datasetId)
                                    ?.name ||
                                    g.runs[0]?.dataset ||
                                    "Benchmark"}
                                </small>
                              </span>
                            </a>
                          </td>
                          <td>{experiments.length}</td>
                          <td>{g.runs.length}</td>
                          <td>
                            <strong>{pct(best?.score ?? null)}</strong>
                          </td>
                          <td>
                            {g.runs.length
                              ? new Date(
                                  g.runs.at(-1)!.date,
                                ).toLocaleDateString()
                              : "No runs yet"}
                          </td>
                          <td>
                            <a
                              className="eval-inspect-button"
                              href={evaluationPath(g.id)}
                            >
                              Open group <ArrowRight size={12} />
                            </a>
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
            {!groups.length ? (
              <Empty
                title="Create an evaluation group"
                description="Choose a benchmark dataset, then track experiments for your extraction process."
                action={
                  <Button onClick={() => setNewGroup(true)}>New group</Button>
                }
              />
            ) : (
              query &&
              !groups.some((g) =>
                `${g.name} ${s.datasets.find((d) => d.id === g.datasetId)?.name || ""}`
                  .toLowerCase()
                  .includes(query.toLowerCase()),
              ) && (
                <Empty
                  title="No matching groups"
                  description="Try a different group or dataset name."
                />
              )
            )}
          </section>
          <p className="evaluation-directory-note">
            Group = shared benchmark · Experiment = one configuration · Run =
            one execution and its results
          </p>
        </>
      )}
      {newRun && group && (
        <RunModal
          groupId={group.id.startsWith("ungrouped:") ? undefined : group.id}
          open
          onClose={() => setNewRun(false)}
        />
      )}
      {newGroup && <NewEvaluationGroup onClose={() => setNewGroup(false)} />}
    </div>
  );
}
function NewEvaluationGroup({ onClose }: { onClose: () => void }) {
  const s = useStudio();
  const [name, setName] = useState("");
  const [dataset, setDataset] = useState(s.datasets[0]?.id || "");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  return (
    <Modal
      open
      onClose={onClose}
      title="New evaluation group"
      description="Give this process a fixed benchmark. Experiments will live inside this group."
    >
      <label>
        Group name
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Invoice extraction"
        />
      </label>
      <label>
        Benchmark dataset
        <FieldSelect
          aria-label="Benchmark dataset"
          value={dataset}
          onValueChange={setDataset}
          options={s.datasets.map((d) => ({
            value: d.id,
            label: `${d.name} (${d.count} documents)`,
          }))}
        />
      </label>
      {!s.datasets.length && (
        <p className="form-hint">
          Add a dataset with documents and ground truth from the Datasets page
          first.
        </p>
      )}
      <label>
        Description
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What are you trying to improve?"
        />
      </label>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <div className="modal-actions">
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="primary"
          disabled={saving || !name.trim() || !dataset}
          onClick={async () => {
            setSaving(true);
            setError("");
            try {
              const g = await s.createEvaluationGroup(
                name.trim(),
                dataset,
                description,
              );
              onClose();
              go(evaluationPath(g.id));
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            } finally {
              setSaving(false);
            }
          }}
        >
          {saving ? <Busy label="Creating…" /> : "Create group"}
        </Button>
      </div>
    </Modal>
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
    ["Documents", (r) => String(r.documents)],
    ["Status", (r) => r.status],
    ["Cache hits", (r) => String(r.cacheHits ?? "Not recorded")],
    [
      "Benchmark snapshot",
      (r) => r.benchmarkFingerprint?.slice(0, 12) || "Not recorded",
    ],
    ["Avg. latency / doc", (r) => `${r.latency.toFixed(1)}s`],
    ["Est. total cost", (r) => formatCost(r.cost)],
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
                  <small>
                    Run {r.id.slice(-8)} · {new Date(r.date).toLocaleString()}
                  </small>
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
function EvaluationResults({ run }: { run: Run }) {
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
  const [citationStatus, setCitationStatus] = useState({ key: "", message: "" });
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
  }, [run.id, attempt, s.mode, run.status, run.completedDocuments]);
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
      <Heading
        title={`Run ${run.id.slice(-8)}`}
        description={`${run.name} · ${run.model} · ${run.config?.parser || "Saved configuration"} · ${run.documents} documents`}
        actions={
          <>
            <Button
              disabled={loading || s.busy}
              onClick={async () => {
                if (await s.loadReviewRun(run.id)) s.navigate("Review queue");
              }}
            >
              Review fields
            </Button>
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
          </>
        }
      />
      {["running", "cancelling"].includes(run.status.toLowerCase()) && (
        <div className="evaluation-run-status" role="status">
          <Busy
            label={`${run.completedDocuments || 0} completed · ${run.failedDocuments || 0} failed / ${run.documents} documents`}
          />
          <Button
            disabled={run.status === "cancelling"}
            onClick={async () => {
              try {
                await api.request(`/runs/${encodeURIComponent(run.id)}/cancel`, {
                  method: "POST",
                });
                await s.refresh();
              } catch (error) {
                s.notifyError(error);
              }
            }}
          >
            {" "}
            {run.status === "cancelling"
              ? "Stopping after current document…"
              : "Cancel run"}
          </Button>
        </div>
      )}
      {(run.error ||
        [
          "failed",
          "interrupted",
          "cancelled",
          "completed_with_failures",
        ].includes(run.status.toLowerCase())) && (
        <p className="form-error" role="alert">
          {run.error ||
            `Run ${run.status.replaceAll("_", " ")}. ${run.failedDocuments || 0} documents failed. Open the experiment to run it again.`}
        </p>
      )}
      {!!snapshot?.metrics?.failures?.length && (
        <details className="experiment-config">
          <summary>
            Document errors ({snapshot.metrics.failures.length})
          </summary>
          {snapshot.metrics.failures.map(
            (f: { document_id: string; error: string }) => (
              <p key={f.document_id}>
                {s.documents.find((d) => d.id === f.document_id)?.name ||
                  f.document_id}
                : {f.error}
              </p>
            ),
          )}
        </details>
      )}
      <p className="eval-fixture-note">
        Benchmark:{" "}
        {run.benchmarkFingerprint?.slice(0, 12) || "Snapshot not recorded"} ·
        Cache hits: {run.cacheHits ?? "Not recorded"}. New evaluation runs
        request fresh extractions.
      </p>
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
          Avg. latency / doc <strong>{run.latency.toFixed(1)}s</strong>
        </span>
        <span>
          Est. total cost <strong>{formatCost(run.cost)}</strong>
        </span>
        <span title="Elapsed time from run start to completion, including scoring and overhead.">
          Total run time <strong>{formatRunDuration(run.duration)}</strong>
        </span>
      </div>
      <p className="eval-fixture-note">
        Latency averages extraction time per completed document, including parsing and model calls.
        Cost estimates cover all completed documents using token usage and model rates; provider discounts and parser fees are excluded.
      </p>
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
                  onCitationStatus={(message) => setCitationStatus({ key: `${document.id}:${active?.key}`, message })}
                  onCitationsResolved={(citations) => setDocs((current) => current.map((d) =>
                    d.id !== document.id ? d : { ...d, fields: d.fields.map((f) =>
                      f.key !== active?.key ? f : { ...f, citations, page: citations[0].page, area: citations[0].area }
                    ) }
                  ))}
                />
                <div className="source-footer">
                  {active?.area
                    ? `Highlighted: ${active.key} · page ${active.page || 1}`
                    : citationStatus.key === `${document.id}:${active?.key}`
                      ? citationStatus.message
                    : active?.sourceExcerpt && document.type.includes("pdf")
                      ? "Locating source excerpt…"
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
                    <article
                      className={`eval-field ${active?.key === f.key ? "active" : ""} ${failed(f) ? "is-failed" : ""}`}
                      key={f.key}
                      onClick={() => setFieldKey(f.key)}
                    >
                      <button
                        className="eval-field-name"
                        aria-label={`Inspect source for ${f.key}`}
                        onClick={() => setFieldKey(f.key)}
                      >
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
                      </button>
                      <FieldValues field={f} />
                      {f.area && (
                        <span className="eval-field-citation">
                          View source · page {f.page || 1}
                          <ArrowRight size={11} />
                        </span>
                      )}
                    </article>
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
