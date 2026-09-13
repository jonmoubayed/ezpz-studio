import { Fragment, useEffect, useRef, useState } from "react";
import { ArrowRight, ArrowUpRight, CheckCircle2, ChevronRight, FolderOpen, Play, Square, XCircle } from "lucide-react";
import { Button, Busy } from "./ui";
import { pct, type Config, type Run } from "./domain";
import { useStudio } from "./store";
import * as api from "./api";
import "./hill-loop.css";
import { HillComparison, HillDiagnosis, type Diagnosis, type PairedComparison } from "./hill-evidence";

type Iteration = { index: number; title: string; status: string; run_id?: string;
  score?: number | null; parent_score?: number; delta?: number; prompt: string;
  field?: string; failed_documents?: number; parent_run_id?: string; cost_usd?: number | null;
  rationale?: string; prediction?: string; decision?: string; confirmed_score?: number;
  target_fields?: string[]; changes?: { section: string; before: string; after: string }[];
  diagnosis?: Diagnosis; comparison?: PairedComparison;
  comparisons?: { round: number; paired: PairedComparison; against_saved: PairedComparison; baseline_drift: PairedComparison }[];
  verification_runs?: { index: string; title: string; status: string; run_id?: string; score?: number; cost_usd?: number | null }[] };
type Loop = { version?: number; phase?: string; evaluation_count?: number; diagnosis?: Diagnosis;
  optimizer?: { provider: string; name: string }; planner_calls?: { index: number; status: string; summary?: string; concerns?: string[]; cost_usd?: number | null }[]; id: string; dataset_id: string; group_id?: string; status: string; reason: string;
  baseline_run_id: string | null; best_run_id: string | null; baseline_score: number | null;
  best_score: number | null; active_run_id: string | null; iterations: Iteration[];
  spent_usd: number; cost_complete: boolean; options: { max_candidates: number; patience: number; max_cost_usd: number | null; min_gain?: number; max_regressions?: number; confirmation_pairs?: number } };
const active = (job: Loop | null) => !!job && ["running", "stopping"].includes(job.status);

export function HillLoop({ base, datasetId, config, onActiveChange, onUseBest }: {
  base?: Run; datasetId: string; config: Config;
  onActiveChange: (active: boolean) => void;
  onUseBest: (config: Config, runId: string, datasetId: string) => void;
}) {
  const s = useStudio();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [job, setJob] = useState<Loop | null>(null);
  const [maxCandidates, setMaxCandidates] = useState("5");
  const [patience, setPatience] = useState("2");
  const [cost, setCost] = useState("");
  const [minGain, setMinGain] = useState("0.5");
  const [maxRegressions, setMaxRegressions] = useState("2");
  const [confirmationPairs, setConfirmationPairs] = useState("1");
  const [optimizerModel, setOptimizerModel] = useState("");
  const [loading, setLoading] = useState(s.mode === "live");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const requestId = useRef<string | null>(null);
  const mutationEpoch = useRef(0);
  const mounted = useRef(true);
  const demoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshed = useRef("");
  const isActive = active(job);
  useEffect(() => { onActiveChange(isActive || busy); }, [isActive, busy, onActiveChange]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; if (demoTimer.current) clearTimeout(demoTimer.current); };
  }, []);
  useEffect(() => {
    if (s.mode !== "live") return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      const epoch = mutationEpoch.current;
      try {
        const data = await api.request("/hill-climbs", { signal: abort.signal });
        if (abort.signal.aborted || epoch !== mutationEpoch.current) return;
        if (!Array.isArray(data.hill_climbs)) throw new Error("Restart the local backend to enable automatic hill climbing.");
        const current = data.hill_climbs.find((loop: Loop) => active(loop)) || data.hill_climbs.find((loop: Loop) => loop.dataset_id === datasetId) || null;
        setJob(current);
        setError("");
        if (current && !active(current) && refreshed.current !== current.id) {
          refreshed.current = current.id;
          void s.refresh();
        }
      } catch (e) {
        if (!abort.signal.aborted) setError(`${e instanceof Error ? e.message : "Could not read loop status"} Your loop may still be running; retry to reconnect.`);
      } finally {
        if (!abort.signal.aborted) { setLoading(false); timer = setTimeout(poll, 2000); }
      }
    }
    void poll();
    return () => { abort.abort(); clearTimeout(timer); };
  }, [s.mode, datasetId, retry]);

  async function start() {
    const limit = Number(maxCandidates), stall = Number(patience), budget = cost ? Number(cost) : null;
    if (!Number.isInteger(limit) || limit < 1 || limit > 20 || !Number.isInteger(stall) || stall < 1 || stall > 10 || (budget !== null && (!Number.isFinite(budget) || budget <= 0))) {
      setError("Choose 1–20 candidate attempts, 1–10 attempts without improvement, and a positive cost threshold if used."); return;
    }
    const gain = Number(minGain) / 100, regressions = Number(maxRegressions), pairs = Number(confirmationPairs);
    if (!Number.isFinite(gain) || gain <= 0 || gain > 1 || !Number.isInteger(regressions) || regressions < 0 || regressions > 1000 || !Number.isInteger(pairs) || pairs < 1 || pairs > 3) {
      setError("Choose a positive gain up to 100 points, 0–1000 allowed regressions, and 1–3 confirmation rounds."); return;
    }
    mutationEpoch.current++;
    setBusy(true); setError("");
    try {
      if (s.mode === "demo") {
        const sample: Loop = { id: crypto.randomUUID(), dataset_id: datasetId, status: "running", reason: "Simulating an automatic loop with sample results.",
          baseline_run_id: base?.id || null, best_run_id: base?.id || null, baseline_score: base?.score ?? 0.9, best_score: base?.score ?? 0.9,
          active_run_id: null, iterations: [], spent_usd: 0, cost_complete: true,
          options: { max_candidates: limit, patience: stall, max_cost_usd: budget } };
        setJob(sample);
        let current = sample;
        const step = () => {
          if (!mounted.current) return;
          const index = current.iterations.length + 1;
          const done = index >= Math.min(limit, stall, 2);
          current = { ...current, iterations: [...current.iterations, { index, title: `Sample prompt candidate ${index}`, prompt: "Illustrative source-verification prompt change.", score: current.best_score, delta: 0, status: "rejected" }],
            status: done ? "completed" : "running", reason: done ? "Demo complete: sample candidates tied the baseline, so the baseline was kept. No model was called." : "Simulating the next candidate from the best configuration." };
          setJob(current);
          if (!done) demoTimer.current = setTimeout(step, 1000);
        };
        demoTimer.current = setTimeout(step, 1000);
      } else {
        requestId.current ||= crypto.randomUUID();
        const data = await api.request("/hill-climbs", { method: "POST", body: JSON.stringify({
          request_id: requestId.current, dataset_id: datasetId, baseline_run_id: base?.id,
          ...(!base ? { config: api.configPayload(config) } : {}),
          max_candidates: limit, patience: stall, max_cost_usd: budget,
          min_gain: gain, max_regressions: regressions, confirmation_pairs: pairs, optimizer_model: optimizerModel.trim(),
        }) });
        if (!mounted.current) return;
        setJob(data.hill_climb);
        requestId.current = null;
      }
    } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : "Could not start the loop"); }
    finally { if (mounted.current) setBusy(false); }
  }
  async function stop() {
    if (!job) return;
    mutationEpoch.current++;
    setBusy(true);
    try {
      if (s.mode === "demo") {
        if (demoTimer.current) clearTimeout(demoTimer.current);
        setJob({ ...job, status: "stopped", reason: "Demo stopped. No model was called." });
      } else {
        const data = await api.request(`/hill-climbs/${encodeURIComponent(job.id)}/stop`, { method: "POST" });
        if (mounted.current) setJob(data.hill_climb);
      }
      setError("");
    } catch (e) { setError(`Stop was not confirmed. ${e instanceof Error ? e.message : "Retry Stop."}`); }
    finally { if (mounted.current) setBusy(false); }
  }
  async function useBest() {
    if (!job?.best_run_id) return;
    setBusy(true);
    try {
      const best = s.mode === "demo" ? base : api.normalizeRun((await api.request(`/runs/${encodeURIComponent(job.best_run_id)}`)).run);
      if (!best?.config) throw new Error("Best configuration is unavailable");
      onUseBest(best.config, best.id, best.datasetId);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not load the best configuration"); }
    finally { setBusy(false); }
  }
  async function inspect(runId: string) {
    await s.refresh();
    s.navigate("Evaluations");
    if (s.mode === "live") {
      const raw = (await api.request(`/runs/${encodeURIComponent(runId)}`)).run;
      const run = api.normalizeRun(raw);
      location.hash = `Evaluations/group/${encodeURIComponent(run.groupId || "")}/experiment/${encodeURIComponent(run.experimentId || "")}/run/${encodeURIComponent(run.id)}`;
    }
  }
  const gain = job?.baseline_score != null && job.best_score != null ? job.best_score - job.baseline_score : null;
  const points = (value: number | null) => value == null ? "—" : `${value > 0 ? "+" : ""}${(value * 100).toFixed(1)} pts`;
  const attempts = job?.iterations.filter((iteration) => iteration.index > 0) || [];
  const loopBaseline = s.runs.find((run) => run.id === job?.baseline_run_id);
  return <section className="hill-loop" aria-label="Automatic hill climbing">
    <div className="hill-loop-setup">
      <div className="hill-setup-row">
        <fieldset disabled={isActive || busy || loading || s.busy} className="hill-loop-limits">
          <legend className="sr-only">Loop limits</legend>
          <label>Maximum candidate attempts<input type="number" min="1" max="20" step="1" value={maxCandidates} onChange={(e) => { setMaxCandidates(e.target.value); requestId.current = null; }} /></label>
          <label>Stop after no improvement<input type="number" min="1" max="10" step="1" value={patience} onChange={(e) => { setPatience(e.target.value); requestId.current = null; }} /></label>
          <label>Cost threshold ($) · optional<input type="number" min="0.01" step="0.01" placeholder="No cost threshold" value={cost} onChange={(e) => { setCost(e.target.value); requestId.current = null; }} /></label>
        </fieldset>
        <div className="hill-loop-actions">
          {isActive ? <Button onClick={stop} disabled={busy || job?.status === "stopping"}><Square size={14} />{job?.status === "stopping" ? "Stopping…" : "Stop loop"}</Button>
            : <Button variant="primary" onClick={start} disabled={busy || s.busy || loading || !!error || !datasetId || (s.mode === "live" && !!base && base.status.toLowerCase() !== "completed")}>
              {busy ? <Busy label="Starting…" /> : <><Play size={16} />{s.mode === "demo" ? "Simulate loop" : job ? "Start new loop" : "Start loop"}</>}
            </Button>}
        </div>
      </div>
      <details className="hill-search-settings"><summary><ChevronRight size={15} />Advanced settings</summary>
        <fieldset disabled={isActive || busy || loading} className="hill-loop-limits hill-acceptance-settings">
          <legend className="sr-only">Search and acceptance settings</legend>
          <label>Minimum gain (percentage points)<input type="number" min="0.01" max="100" step="0.1" value={minGain} onChange={(e) => { setMinGain(e.target.value); requestId.current = null; }} /></label>
          <label>Allowed regressed fields<input type="number" min="0" max="1000" step="1" value={maxRegressions} onChange={(e) => { setMaxRegressions(e.target.value); requestId.current = null; }} /></label>
          <label>Confirmation rounds<input type="number" min="1" max="3" step="1" value={confirmationPairs} onChange={(e) => { setConfirmationPairs(e.target.value); requestId.current = null; }} /></label>
          <label>Optimizer model · optional<input type="text" maxLength={200} placeholder={base?.config?.model || config.model} value={optimizerModel} onChange={(e) => { setOptimizerModel(e.target.value); requestId.current = null; }} /></label>
        </fieldset>
        <p className="form-hint">The optimizer uses the baseline’s provider and endpoint ({base?.config?.provider || config.provider}); leave its model blank to use the extraction model. It receives saved mismatch examples, source excerpts, passing controls, schema, prompt, and previous attempts. The extraction model stays fixed.</p>
      <p className="form-hint">{s.mode === "demo" ? "This simulates the loop using sample scores. No API or model calls are made."
        : `${base ? "Uses the selected saved baseline." : "Runs an initial baseline first, then up to the candidate limit."} The optimizer can replace specific system or extraction rules. Model, parser, schema, scoring, documents, and annotations stay fixed. The loop continues when you leave this page while the backend is running.`}</p>
      {s.mode === "live" && <p className="form-hint">Each promising candidate needs one screening evaluation plus {Number(confirmationPairs) * 2 || 2} confirmation evaluations, rerunning both baseline and candidate. Up to {Number(maxCandidates) * (1 + 2 * Number(confirmationPairs)) + (base ? 0 : 1) || '—'} full benchmark evaluations and {maxCandidates} optimizer calls. Every comparison must clear the minimum gain (at least one net field) and regression limit. Repeated benchmark gains do not establish performance on unseen documents.</p>}
      {cost && <p className="form-hint">The threshold includes optimizer calls and all evaluations. Previous run costs estimate whether the next evaluation fits. An in-flight call or run can exceed the threshold; missing cost data stops the loop. Unverified candidates are never promoted.</p>}
      </details>

      {loading && <Busy label="Checking saved loops…" />}
      {s.mode === "demo" && <p className="form-hint">Sample simulation · no API or model calls.</p>}
      {base && base.status.toLowerCase() !== "completed" && s.mode === "live" && <p className="form-hint">Select a completed baseline before starting a loop.</p>}
      {error && <div role="alert" className="form-error">{error} <Button onClick={() => { setError(""); setRetry((n) => n + 1); }}>Retry connection</Button></div>}
    </div>
    {job ? <div className="hill-loop-history">
      <div className="hill-result-heading">
        <div className="hill-loop-summary" role="status">
          <h2>{isActive ? "Loop in progress" : job.status === "failed" ? "Loop needs attention" : "Last loop finished"}</h2>
          <p>{job.reason}</p>
        </div>
        {!!job.best_run_id && !isActive && <Button disabled={busy} onClick={useBest}><FolderOpen size={16} />Load best configuration</Button>}
      </div>
      <div className="hill-result-metrics" aria-label="Loop results">
        <div className="hill-baseline-metric"><span title={loopBaseline ? `This loop started from ${loopBaseline.name}. The selection above applies to your next loop.` : "The starting baseline of this saved loop"}>Loop baseline</span><strong>{pct(job.baseline_score)}</strong></div>
        <ArrowRight size={19} className="hill-score-arrow" aria-hidden="true" />
        <div className="hill-best-metric"><div><span>Best score</span><strong>{pct(job.best_score)}</strong></div><div className="hill-gain"><b className={gain != null && gain > 0 ? "positive" : ""}>{points(gain)}</b><small>vs baseline</small></div></div>
        <div className="hill-count-metric"><span>Attempts</span><strong>{attempts.length} / {job.options.max_candidates}</strong></div>
        <div className="hill-cost-metric"><span>Estimated cost</span><strong>{job.cost_complete ? `$${job.spent_usd.toFixed(2)}` : "Unavailable"}</strong>{!job.cost_complete && <small>Cost partly unavailable</small>}</div>
      </div>
      {!!job.iterations.length && <div className="hill-attempt-table-wrap" role="region" aria-label="Loop attempt history" tabIndex={0}>
        <table className="hill-attempt-table">
          <caption className="sr-only">Loop attempts. Gains compare with this loop’s starting baseline; expand an attempt for its acceptance evidence.</caption>
          <thead><tr><th scope="col">Attempt</th><th scope="col">Change</th><th scope="col">Score</th><th scope="col">vs baseline</th><th scope="col">Status</th><th scope="col"><span className="sr-only">Details</span></th></tr></thead>
          <tbody>{job.iterations.map((iteration) => {
            const key = `${job.id}-${iteration.index}`;
            const open = expanded === key;
            const delta = iteration.score != null && job.baseline_score != null ? iteration.score - job.baseline_score : null;
            return <Fragment key={key}>
              <tr className={`hill-attempt-row ${iteration.status}`}>
                <td>{iteration.index === 0 ? "Baseline" : iteration.index}</td>
                <th scope="row"><button type="button" className="hill-attempt-title" aria-expanded={open} aria-controls={`hill-detail-${key}`} onClick={() => setExpanded(open ? null : key)}>{iteration.title}</button></th>
                <td className="hill-score-cell">{pct(iteration.score ?? null)}</td>
                <td className={delta != null && delta > 0 ? "positive" : delta != null && delta < 0 ? "negative" : ""}>{points(delta)}</td>
                <td><span className={`hill-status ${iteration.status}`}>{iteration.status === "accepted" ? <CheckCircle2 size={16} /> : iteration.status === "rejected" ? <XCircle size={16} /> : null}{iteration.status.replaceAll("_", " ")}</span></td>
                <td><button type="button" className="hill-attempt-toggle" aria-label={`${open ? "Hide" : "View"} ${iteration.index === 0 ? "baseline" : `attempt ${iteration.index}`} details`} aria-expanded={open} aria-controls={`hill-detail-${key}`} onClick={() => setExpanded(open ? null : key)}><ChevronRight size={17} /></button></td>
              </tr>
              <tr id={`hill-detail-${key}`} className={`hill-loop-iteration ${iteration.status}`} hidden={!open}><td colSpan={6}>
          {iteration.rationale && <p><strong>Hypothesis:</strong> {iteration.rationale}</p>}
          {iteration.prediction && <p><strong>Expected effect:</strong> {iteration.prediction}</p>}
          {iteration.target_fields?.length && <p className="form-hint">Targets: {iteration.target_fields.join(', ')}</p>}
          {iteration.changes?.length ? <details><summary>Exact prompt edits · {iteration.changes.length} change(s)</summary>{iteration.changes.map((change, index) => <div className="hill-prompt-diff" key={index}><strong>{change.section} instructions</strong><div><section><small>Before</small><pre>{change.before || '(Append a new rule)'}</pre></section><section><small>After</small><pre>{change.after}</pre></section></div></div>)}</details>
            : iteration.prompt && <details><summary>Prompt change{iteration.failed_documents ? ` · ${iteration.failed_documents} affected documents` : ""}</summary><p>{iteration.prompt}</p></details>}
          {iteration.comparison && <HillComparison comparison={iteration.comparison} label="Screening" />}
          {iteration.comparisons?.map((comparison) => <div key={comparison.round}><HillComparison comparison={comparison.paired} label={`Confirmation ${comparison.round} vs fresh baseline`} /><HillComparison comparison={comparison.against_saved} label={`Confirmation ${comparison.round} vs saved best`} /><HillComparison comparison={comparison.baseline_drift} label={`Baseline variability in round ${comparison.round}`} /></div>)}
          {iteration.decision && <p className="hill-decision"><strong>{iteration.status === 'accepted' ? 'Accepted: ' : 'Decision: '}</strong>{iteration.decision}{iteration.confirmed_score != null ? ` Retained score: ${pct(iteration.confirmed_score)} (lowest observed candidate score).` : ''}</p>}
          {!!iteration.verification_runs?.length && <details><summary>Confirmation runs · {iteration.verification_runs.length}</summary>{iteration.verification_runs.map((run) => <div className="hill-verification-run" key={run.index}><span>{run.title} · {run.status}{run.score != null ? ` · ${pct(run.score)}` : ''}{run.cost_usd != null ? ` · $${run.cost_usd.toFixed(4)}` : ''}</span>{run.run_id && <Button onClick={() => { void inspect(run.run_id!).catch((e) => setError(e.message)); }}>Inspect confirmation <ArrowUpRight size={12} /></Button>}</div>)}</details>}
          {iteration.diagnosis && <HillDiagnosis diagnosis={iteration.diagnosis} />}
          {iteration.run_id && <Button onClick={() => { void inspect(iteration.run_id!).catch((e) => setError(e.message)); }}>Inspect run <ArrowUpRight size={12} /></Button>}
              </td></tr>
            </Fragment>;
          })}</tbody>
        </table>
      </div>}
      {!job.iterations.length && <p className="hill-empty">{isActive ? "Preparing the baseline. Attempts will appear here as the loop progresses." : "This loop finished before a candidate was evaluated."}</p>}
      <details className="hill-loop-evidence"><summary><ChevronRight size={15} />Loop details and evidence</summary>
        <p className="form-hint">Loop baseline: {loopBaseline?.name || "Initial baseline"}. The benchmark selection above applies to your next loop.</p>
        {job.version !== 2 && s.mode === "live" && <p className="form-hint">This saved loop used the previous generic proposal engine without repeat confirmation. Start a new loop to use v2.</p>}
        {job.version === 2 && <p className="form-hint">Phase: {job.phase?.replaceAll('_', ' ')} · {job.evaluation_count || 0} evaluations · {job.planner_calls?.filter((call) => call.status !== "unavailable").length || 0} optimizer calls{job.optimizer ? ` · ${job.optimizer.provider} / ${job.optimizer.name}` : ''}<br />This loop requires {((job.options.min_gain || 0) * 100).toFixed(2)} points of gain, at most {job.options.max_regressions} regressed fields, and {job.options.confirmation_pairs} confirmation round(s).</p>}
        {job.diagnosis && <HillDiagnosis diagnosis={job.diagnosis} />}
        {!!job.planner_calls?.length && <details className="hill-planner-history"><summary>Optimizer reasoning and annotation concerns</summary>{job.planner_calls.map((call) => <div key={call.index} className="hill-pattern"><strong>Proposal {call.index} · {call.status}</strong><p>{call.summary || 'Reading failure evidence…'}</p>{call.concerns?.map((concern, index) => <p key={index}><strong>Review concern:</strong> {concern}</p>)}<small>{call.cost_usd != null ? `$${call.cost_usd.toFixed(5)} estimated` : 'Cost unavailable or pending'}</small></div>)}</details>}

      </details>
      {job.active_run_id && <p className="form-hint">An evaluation is in progress. Stop waits for the current provider call, then skips remaining documents and candidates.</p>}
    </div> : !loading && <div className="hill-empty"><h2>Your first loop starts here</h2><p>Choose a benchmark and set your limits. Candidate scores and prompt changes will appear here.</p></div>}
  </section>;
}
