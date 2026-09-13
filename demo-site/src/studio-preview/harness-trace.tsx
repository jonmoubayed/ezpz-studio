import "./harness.css";
export type HarnessStep = { id?: string; name?: string; kind?: string; model?: string; latency_ms?: number; result?: any; [key: string]: unknown };
export function HarnessTrace({ steps = [] }: { steps?: HarnessStep[] }) {
  return <section className="harness-trace" aria-label="Harness execution steps">
    <h3>Execution steps</h3>
    {!steps.length ? <p>No step trace was recorded for this extraction.</p> : steps.map((step, index) => <details key={`${step.id}-${index}`}>
      <summary>{index + 1}. {step.name || step.kind || "Step"}{step.model ? ` · ${step.model}` : ""}{step.latency_ms !== undefined ? ` · ${(step.latency_ms / 1000).toFixed(2)}s` : ""}{step.result?.accepted !== undefined ? ` · ${step.result.accepted ? "Accepted" : "Unresolved"}` : ""}</summary>
      {step.result?.usage && <p>Input tokens: {step.result.usage.input_tokens ?? "—"} · Output tokens: {step.result.usage.output_tokens ?? "—"}</p>}
      <pre>{JSON.stringify(step, null, 2)}</pre>
    </details>)}
  </section>;
}
