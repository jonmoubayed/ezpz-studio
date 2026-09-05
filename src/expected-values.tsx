import { useEffect, useState } from "react";
import { Check, Database, Plus } from "lucide-react";
import { FieldSelect } from "./components/field-select";
import { Button, Busy } from "./ui";
import { useStudio } from "./store";
import * as api from "./api";
import {
  displayValue,
  type Document,
  type Field,
  type JsonValue,
} from "./domain";
import { equalValues, expectedValues, hasExpected } from "./result-model";

export function FieldValues({ field }: { field: Field }) {
  const annotated = hasExpected(field);
  const match = annotated && equalValues(field.value, field.expected);
  return (
    <>
      <span
        className={`field-comparison ${annotated && !match ? "has-difference" : ""}`}
      >
        <span>
          <small>RESULT</small>
          <code>{displayValue(field.value)}</code>
        </span>
        <span>
          <small>EXPECTED</small>
          <code>
            {annotated ? displayValue(field.expected) : "Not annotated"}
          </code>
        </span>
      </span>
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
  onSaved?: () => void;
}) {
  const s = useStudio();
  const [raw, setRaw] = useState(() =>
    JSON.stringify(expectedValues(document), null, 2),
  );
  const [loading, setLoading] = useState(s.mode === "live");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [datasetId, setDatasetId] = useState("");
  const [name, setName] = useState("");
  useEffect(() => {
    setNotice("");
    setError("");
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
        setRaw(JSON.stringify(values, null, 2));
        s.updateExpectedValues(document.id, values);
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [document.id, s.mode, attempt]);
  const disabled = loading || s.busy;
  async function save(addToDataset = false) {
    setError("");
    setNotice("");
    try {
      const value = JSON.parse(raw) as Record<string, JsonValue>;
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Expected values must be a JSON object.");
      if (addToDataset && !Object.keys(value).length)
        throw new Error(
          "Add expected values before creating a scored benchmark.",
        );
      if (addToDataset && (!datasetId || (datasetId === "new" && !name.trim())))
        throw new Error("Choose a dataset or enter a name for a new one.");
      const target = addToDataset
        ? datasetId === "new"
          ? { name: name.trim() }
          : { id: datasetId }
        : undefined;
      if (await s.saveExpectedValues(document, value, target)) {
        setNotice(
          addToDataset
            ? "Document and ground truth saved to the dataset."
            : "Ground truth saved.",
        );
        onSaved?.();
      } else
        setError(
          "The operation did not finish. Check the workspace message and try again.",
        );
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <div className="expected-values-editor">
      <p>
        Define the correct values from the source document. These become its
        ground truth for future evaluations.
      </p>
      {loading ? (
        <Busy label="Loading expected values…" />
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
              disabled={s.busy}
              onChange={(e) => {
                setRaw(e.target.value);
                setNotice("");
              }}
            />
          </label>
          <div className="expected-actions">
            <Button
              disabled={disabled}
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
                setNotice(
                  "Check these extracted values against the source before saving.",
                );
              }}
            >
              Use extraction as starting point
            </Button>
            <Button
              variant="primary"
              disabled={disabled}
              onClick={() => save()}
            >
              <Check size={14} />
              Save ground truth
            </Button>
          </div>
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
                onValueChange={setDatasetId}
                options={[
                  { value: "", label: "Choose a dataset…", disabled: true },
                  ...s.datasets.map((d) => ({ value: d.id, label: d.name })),
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
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Invoice regression cases"
                />
              </label>
            )}
            <p>
              Saves this document with the expected values above. Ground truth
              is shared by datasets containing this document.
            </p>
            <Button
              variant="primary"
              disabled={
                disabled || !datasetId || (datasetId === "new" && !name.trim())
              }
              onClick={() => save(true)}
            >
              <Plus size={14} />
              Add document & ground truth
            </Button>
          </section>
        </>
      )}
      {notice && (
        <p className="expected-success" role="status">
          {notice}
        </p>
      )}
      {error && (
        <div className="form-error" role="alert">
          <p>{error}</p>
          <Button disabled={disabled} onClick={() => setAttempt((a) => a + 1)}>
            Reload saved values
          </Button>
        </div>
      )}
    </div>
  );
}
