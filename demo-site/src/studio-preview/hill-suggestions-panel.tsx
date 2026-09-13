import { useEffect, useRef, useState } from "react";
import { Check, Sparkles } from "lucide-react";
import { useStudio } from "./store";
import { Badge, Button, Busy, Modal, PanelTitle } from "./ui";
import { displayValue, type Config, type Document, type Run } from "./domain";
import { demoEvaluationDocuments, evaluationDocuments } from "./evaluation-model";
import { SourceViewer } from "./workbench";
import { suggestExperiments, starterSuggestions, type Suggestion } from "./hill-suggestions";
import * as api from "./api";
import "./hill-suggestions.css";

export function HillSuggestions({ base, datasetId, config, selected, onChoose }: {
  base?: Run;
  datasetId: string;
  config: Config;
  selected: string;
  onChoose: (suggestion: Suggestion) => void;
}) {
  const s = useStudio();
  const evidenceTrigger = useRef<HTMLButtonElement | null>(null);
  const [docs, setDocs] = useState<Document[]>([]);
  const [loading, setLoading] = useState(!!base);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [inspecting, setInspecting] = useState<Suggestion | null>(null);
  const [example, setExample] = useState(0);
  const complete = base?.status.toLowerCase() === "completed";
  useEffect(() => {
    if (!base || !complete) { setLoading(false); return; }
    const abort = new AbortController();
    setLoading(true);
    setError("");
    setDocs([]);
    async function load() {
      try {
        if (s.mode === "demo") {
          const members = s.datasets.find((d) => d.id === datasetId)?.members;
          setDocs(demoEvaluationDocuments(base!).filter((d) =>
            members ? members.includes(d.id) : datasetId === "invoices"));
        } else {
          const data = await api.request(`/runs/${encodeURIComponent(base!.id)}`, { signal: abort.signal });
          if (abort.signal.aborted) return;
          if (data.run?.id !== base!.id || data.run?.dataset_id !== datasetId)
            throw new Error("The returned results do not match this baseline and dataset.");
          setDocs(evaluationDocuments(data.run, s.documents));
        }
      } catch (e) {
        if (!abort.signal.aborted) setError(e instanceof Error ? e.message : "Could not load evaluation evidence.");
      } finally {
        if (!abort.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => abort.abort();
  }, [base?.id, complete, datasetId, s.mode, s.documents, s.datasets, attempt]);
  const choices = base ? suggestExperiments(base, docs) : starterSuggestions(config);
  const scored = docs.some((d) => d.fields.some((f) =>
    ["correct", "incorrect", "missing", "hallucinated", "validation_failed"].includes(f.status || "")));
  const active = inspecting?.evidence[example];
  return (
    <section className="panel hypotheses">
      <PanelTitle title="Ideas worth testing" description={base
        ? `Field reminders from ${base.name}, ranked by affected documents.`
        : "Starter suggestions · run a benchmark to get evidence-based ideas."}
        action={s.mode === "demo" ? <Badge>Sample evidence</Badge> : undefined} />
      {!datasetId ? <p className="hypothesis-state">Choose or create a dataset to start a benchmark.</p>
        : base && !complete ? <p className="hypothesis-state">{["running", "queued", "pending"].includes(base.status.toLowerCase())
          ? "This baseline is still running. Suggestions will be available when it completes."
          : "This baseline did not complete. Inspect its evaluation errors or select a completed run before testing a field-level change."}</p>
        : loading ? <div className="hypothesis-state" role="status"><Busy label="Finding patterns in evaluation results…" /></div>
        : error ? <div className="hypothesis-state" role="alert"><p>Could not load baseline evidence. {error}</p><Button onClick={() => setAttempt((n) => n + 1)}>Retry evidence</Button></div>
        : <>
          {base && !choices.length && <div className="hypothesis-state">
            <strong>{scored ? "No scored field failures found" : "No scored field evidence available"}</strong>
            <p>{scored ? "The available field checks passed. Add more varied annotated documents to test coverage before choosing another extraction change."
              : "Add expected values to your benchmark documents and run an evaluation. An aggregate score alone cannot explain which extraction change to try."}</p>
          </div>}
          {choices.map((idea) => <article className={`hypothesis-card ${selected === idea.id ? "selected" : ""}`} key={idea.id}>
            <div className="hypothesis-card-heading"><span className="hypothesis-icon"><Sparkles size={17} /></span><div><h3>{idea.title}</h3><small>{idea.kind}</small></div></div>
            <p className="hypothesis-observation">{idea.observation}</p>
            <p>{idea.rationale}</p>
            <details className="hypothesis-change"><summary>Proposed prompt change</summary><p>{idea.prompt}</p></details>
            <div className="hypothesis-actions">
              {!!idea.evidence.length && <button type="button" className="btn" onClick={(event) => { evidenceTrigger.current = event.currentTarget; setInspecting(idea); setExample(0); }}>Inspect {idea.evidence.length} failed {idea.evidence.length === 1 ? "document" : "documents"}</button>}
              <Button disabled={s.busy || (!!base && !base.config)} onClick={() => onChoose(idea)}>
                {selected === idea.id && <Check size={14} />}{selected === idea.id ? "Applied to candidate" : "Use suggestion"}
              </Button>
            </div>
          </article>)}
          {base && !base.config && <p className="hypothesis-state">The saved baseline configuration is unavailable. Select a run with a configuration snapshot to apply a suggestion.</p>}
          {!!choices.length && <p className="hypothesis-state">{base
            ? "Test one change on this dataset in the same evaluation group. Compare field failures and overall accuracy with this baseline; keep documents, annotations, and schema fixed."
            : "Start with an annotated baseline, then compare a candidate on the same documents."}</p>}
        </>}
      <Modal onCloseAutoFocus={(event) => { event.preventDefault(); evidenceTrigger.current?.focus(); }} open={!!inspecting} onClose={() => setInspecting(null)} title={`Evidence for ${inspecting?.field || "suggestion"}`}
        description={`${base?.name || "Baseline"} · saved evaluation values${s.mode === "demo" ? " · illustrative sample data" : ""}`} wide>
        {inspecting && <div className="hypothesis-evidence">
          <div className="hypothesis-example-list" aria-label="Failed documents">
            {inspecting.evidence.map(({ document, field }, index) => <button key={document.id} type="button" aria-pressed={example === index} onClick={() => setExample(index)}>
              <span>{document.name}</span><small>{field.status?.replaceAll("_", " ")}</small>
            </button>)}
          </div>
          {active && <>
            <div className="hypothesis-values"><div><strong>Extracted · {active.field.key}</strong><pre>{displayValue(active.field.value)}</pre></div><div><strong>Expected</strong><pre>{displayValue(active.field.expected)}</pre></div></div>
            <div className="hypothesis-source"><SourceViewer key={active.document.id} document={active.document} field={active.field} /></div>
          </>}
        </div>}
      </Modal>
    </section>
  );
}
