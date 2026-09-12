import { StructuredValue, isObjectArray } from "./structured-value";
import { useEffect, useRef, useState } from "react";
import { Check, Database, Plus } from "lucide-react";
import { FieldSelect } from "./components/field-select";
import { Button, Busy } from "./ui";
import { useStudio } from "./store";
import * as api from "./api";
import { type Document, type Field, type JsonValue } from "./domain";
import { equalValues, expectedValues, hasExpected } from "./result-model";

export function FieldValues({ field }: { field: Field }) {
  const annotated = hasExpected(field);
  const match = annotated && equalValues(field.value, field.expected);
  return (
    <>
      <div
        className={`field-comparison ${isObjectArray(field.value) || (annotated && isObjectArray(field.expected)) ? "has-table" : ""} ${annotated && !match ? "has-difference" : ""}`}
      >
        <div>
          <small>RESULT</small>
          <StructuredValue value={field.value} label={`${field.key} result`} />
        </div>
        <div>
          <small>EXPECTED</small>
          {annotated ? (
            <StructuredValue
              value={field.expected}
              label={`${field.key} expected`}
            />
          ) : (
            <code>Not annotated</code>
          )}
        </div>
      </div>
      {annotated && (
        <span className={`field-match ${match ? "match" : "different"}`}>
          {match ? "Matches expected" : "Different from expected"}
        </span>
      )}
    </>
  );
}

export function ExpectedValuesEditor({
  document,
  onSaved,
}: {
  document: Document;
  onSaved?: (message: string) => void;
}) {
  const s = useStudio();
  const [raw, setRaw] = useState(() =>
    JSON.stringify(expectedValues(document), null, 2),
  );
  const [revision, setRevision] = useState<number>();
  const [provenance, setProvenance] = useState<{ author?: string; status?: string }>({});
  const [loading, setLoading] = useState(s.mode === "live");
  const [loadError, setLoadError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [datasetId, setDatasetId] = useState("");
  const [name, setName] = useState("");
  const [pending, setPending] = useState<"truth" | "dataset" | null>(null);
  const [status, setStatus] = useState<{
    scope: "truth" | "dataset";
    message: string;
    error?: boolean;
  } | null>(null);
  const statusRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    statusRef.current?.scrollIntoView({ block: "nearest" });
  }, [status]);
  useEffect(() => {
    setStatus(null);
    setLoadError("");
    if (s.mode !== "live") {
      setRaw(JSON.stringify(expectedValues(document), null, 2));
      setLoading(false);
      return;
    }
    const abort = new AbortController();
    setLoading(true);
    api
      .request(`/documents/${document.id}/ground-truth`, {
        signal: abort.signal,
      })
      .then((data) => {
        if (abort.signal.aborted) return;
        const values = data.ground_truth?.value || {};
        setRevision(data.ground_truth?.revision || 0);
        setProvenance({ author: data.ground_truth?.author, status: data.ground_truth?.annotation_status });
        setRaw(JSON.stringify(values, null, 2));
        s.updateExpectedValues(document.id, values);
      })
      .catch((e) => {
        if (!abort.signal.aborted) setLoadError(e.message);
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [document.id, s.mode, attempt]);
  const disabled = loading || !!loadError || s.busy || !!pending;
  async function save(scope: "truth" | "dataset") {
    if (disabled) return;
    setStatus(null);
    try {
      let value: Record<string, JsonValue>;
      try {
        value = JSON.parse(raw);
      } catch {
        throw new Error(
          "Expected values contain invalid JSON. Correct the JSON above and try again.",
        );
      }
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Expected values must be a JSON object.");
      if (scope === "dataset" && !Object.keys(value).length)
        throw new Error(
          "Add expected values before adding this document to a benchmark.",
        );
      if (
        scope === "dataset" &&
        (!datasetId || (datasetId === "new" && !name.trim()))
      )
        throw new Error("Choose a dataset or enter a name for a new one.");
      const target =
        scope === "dataset"
          ? datasetId === "new"
            ? { name: name.trim() }
            : { id: datasetId }
          : undefined;
      setPending(scope);
      const result = await s.saveExpectedValues(document, value, target, revision);
      if (result.groundTruthRevision !== undefined) {
        setRevision(result.groundTruthRevision);
        setProvenance({ author: "local", status: "complete" });
      }
      if (result.dataset) {
        setDatasetId(result.dataset.id);
        setName("");
      }
      if (!result.ok) {
        setStatus({
          scope,
          message: result.error || "Save could not be confirmed. Please retry.",
          error: true,
        });
        return;
      }
      const message = result.dataset
        ? `${result.alreadyMember ? "Updated" : "Added"} ${document.name} with these expected values in “${result.dataset.name}”. ${result.dataset.count} document${result.dataset.count === 1 ? "" : "s"} in this dataset.${result.alreadyMember ? " This document was already a member; no duplicate was added." : ""}`
        : `Ground truth saved for ${document.name}.`;
      setStatus({ scope, message });
      onSaved?.(message);
    } catch (e) {
      setStatus({ scope, message: (e as Error).message, error: true });
    } finally {
      setPending(null);
    }
  }
  function feedback(scope: "truth" | "dataset") {
    return status?.scope === scope ? (
      <div
        ref={statusRef}
        role={status.error ? "alert" : "status"}
        className={
          status.error ? "expected-feedback error" : "expected-feedback success"
        }
      >
        <p>{status.message}</p>
        {!status.error && scope === "dataset" && (
          <Button onClick={() => s.navigate("Datasets")}>View datasets</Button>
        )}
      </div>
    ) : null;
  }
  return (
    <div className="expected-values-editor">
      <p>
        Define the correct values from {document.name}. These become its ground
        truth for future evaluations.
      </p>
      {provenance.status === "unverified" && <p role="status">Unverified annotations from {provenance.author || "an agent"}. These are excluded from evaluation scores. Check the source before saving as ground truth.</p>}
      {provenance.author && provenance.status !== "unverified" && <p>Last saved by {provenance.author}.</p>}
      {revision !== undefined && document.groundTruthRevision !== undefined && revision !== document.groundTruthRevision && <p role="status">Expected values changed in another session. Your edits are preserved; reload the saved values to reconcile them.</p>}
      {loading ? (
        <Busy label="Loading expected values…" />
      ) : loadError ? (
        <div role="alert" className="expected-feedback error">
          <p>Could not load saved ground truth. {loadError}</p>
          <Button onClick={() => setAttempt((a) => a + 1)}>
            Retry loading expected values
          </Button>
        </div>
      ) : (
        <>
          <label>
            Expected values
            <textarea
              aria-label="Expected values"
              spellCheck={false}
              className="code-editor"
              rows={10}
              value={raw}
              disabled={disabled}
              onChange={(e) => {
                setRaw(e.target.value);
                setStatus(null);
              }}
            />
          </label>
          <div className="expected-actions">
            <Button disabled={disabled} onClick={() => setAttempt(a => a + 1)}>Reload saved values</Button>
            <Button
              disabled={disabled || !document.fields.length}
              onClick={() => {
                setRaw(
                  JSON.stringify(
                    Object.fromEntries(
                      document.fields.map((f) => [f.key, f.value]),
                    ),
                    null,
                    2,
                  ),
                );
                setStatus({
                  scope: "truth",
                  message:
                    "Copied extraction values into the editor. Check them against the source, then save.",
                });
              }}
            >
              Use extraction as starting point
            </Button>
            <Button
              variant="primary"
              disabled={disabled}
              onClick={() => save("truth")}
            >
              {pending === "truth" ? (
                <Busy label="Saving…" />
              ) : (
                <>
                  <Check size={14} />
                  Save ground truth
                </>
              )}
            </Button>
          </div>
          {feedback("truth")}
          <section className="expected-dataset">
            <h3>
              <Database size={15} />
              Add to evaluation dataset
            </h3>
            <label>
              Evaluation dataset
              <FieldSelect
                aria-label="Expected values dataset"
                value={datasetId}
                disabled={disabled}
                onValueChange={(id) => {
                  setDatasetId(id);
                  setStatus(null);
                }}
                options={[
                  { value: "", label: "Choose a dataset…", disabled: true },
                  ...s.datasets.map((d) => ({
                    value: d.id,
                    label: `${d.name} · ${d.count} document${d.count === 1 ? "" : "s"}`,
                  })),
                  { value: "new", label: "Create a new dataset…" },
                ]}
              />
            </label>
            {datasetId === "new" && (
              <label>
                New dataset name
                <input
                  value={name}
                  disabled={disabled}
                  onChange={(e) => {
                    setName(e.target.value);
                    setStatus(null);
                  }}
                  placeholder="e.g. Invoice regression cases"
                />
              </label>
            )}
            <p>
              {!datasetId
                ? "Choose an existing dataset or create a new one to enable this action."
                : "Saves the expected values above and adds this document. If it is already in the dataset, only its ground truth is updated."}
            </p>
            <Button
              variant="primary"
              disabled={
                disabled || !datasetId || (datasetId === "new" && !name.trim())
              }
              onClick={() => save("dataset")}
            >
              {pending === "dataset" ? (
                <Busy label="Saving document & ground truth…" />
              ) : (
                <>
                  <Plus size={14} />
                  Add document & ground truth
                </>
              )}
            </Button>
            {feedback("dataset")}
            <p>
              Ground truth is shared by datasets containing this document. Saved
              evaluation runs retain their original results.
            </p>
          </section>
        </>
      )}
    </div>
  );
}
