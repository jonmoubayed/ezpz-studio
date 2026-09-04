import { useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Braces,
  Check,
  Code2,
  FileScan,
  Play,
  Save,
  Settings2,
} from "lucide-react";
import {
  SchemaBuilderPanel,
  type SchemaBuilderSchema,
} from "./components/extend/schema-builder";
import { readSchema, writeSchema, type SchemaDocument } from "./schema-adapter";
import { ConfigForm } from "./pages";
import { useStudio } from "./store";
import { Badge, Button, Heading } from "./ui";

export function Configuration() {
  const s = useStudio();
  const [processorName, setProcessorName] = useState(
    s.activeProcessor?.name ?? "",
  );
  const [processorDescription, setProcessorDescription] = useState(
    s.activeProcessor?.description ?? "",
  );
  const initial = () => {
    try {
      return readSchema(s.config.schema);
    } catch {
      return null;
    }
  };
  const [document, setDocument] = useState<SchemaDocument | null>(initial);
  const [schema, setSchema] = useState<SchemaBuilderSchema>(
    () => document?.schema ?? { properties: [] },
  );
  const [raw, setRaw] = useState(s.config.schema);
  const [editingJson, setEditingJson] = useState(!document);
  const [error, setError] = useState("");
  const [unsupported, setUnsupported] = useState(() => {
    try {
      readSchema(s.config.schema);
      return "";
    } catch (e) {
      return (e as Error).message;
    }
  });
  const [jsonDirty, setJsonDirty] = useState(false);
  const valid = !error && !jsonDirty;
  const update = (next: SchemaBuilderSchema) => {
    setSchema(next);
    try {
      const text = JSON.stringify(writeSchema(document!, next), null, 2);
      s.updateConfig({ ...s.config, schema: text });
      setRaw(text);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const applyJson = () => {
    try {
      const value = JSON.parse(raw);
      if (
        !value ||
        value.type !== "object" ||
        !value.properties ||
        typeof value.properties !== "object" ||
        Array.isArray(value.properties)
      )
        throw new Error("Enter an object schema with a properties object.");
      const text = JSON.stringify(value, null, 2);
      let parsed: SchemaDocument | null = null;
      try {
        parsed = readSchema(text);
        setUnsupported("");
      } catch (e) {
        setUnsupported((e as Error).message);
      }
      setDocument(parsed);
      setSchema(parsed?.schema ?? { properties: [] });
      s.updateConfig({ ...s.config, schema: text });
      setRaw(text);
      setError("");
      setJsonDirty(false);
      if (parsed) setEditingJson(false);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="configuration-page">
      <div className="configuration-trail">
        <button
          onClick={() =>
            s.navigate(s.activeProcessor ? "Processors" : "Playground")
          }
        >
          <ArrowLeft size={14} />{" "}
          {s.activeProcessor ? "Processors" : "Playground"}
        </button>
        <span>/</span>
        <span>Edit configuration</span>
        <Badge tone={valid ? "green" : "orange"}>
          {valid ? (
            <>
              <Check size={12} />{" "}
              {s.activeProcessor ? "Local working copy" : "Saved locally"}
            </>
          ) : (
            "Unsaved schema changes"
          )}
        </Badge>
      </div>
      <Heading
        title={
          s.activeProcessor
            ? s.activeProcessor.name
            : "Extraction configuration"
        }
        description={
          s.activeProcessor
            ? `Processor · latest saved version ${s.activeProcessor.version} · edit a working copy, then save a version.`
            : "Model, instructions, and output schema."
        }
        actions={
          <>
            <Button
              disabled={!valid || s.busy}
              onClick={() =>
                s.activeProcessor
                  ? void s.saveProcessor(processorName, processorDescription)
                  : s.saveAsProcessor()
              }
            >
              <Save size={14} />
              {s.activeProcessor ? "Save version" : "Save as processor"}
            </Button>
            <Button
              variant="primary"
              disabled={!valid || s.busy || !s.selected}
              onClick={() => {
                s.navigate("Playground");
                void s.extract();
              }}
            >
              <Play size={14} /> Run extraction
            </Button>
          </>
        }
      />
      {s.activeProcessor && (
        <div className="processor-identity">
          <label>
            Processor name
            <input
              value={processorName}
              onChange={(e) => setProcessorName(e.target.value)}
            />
          </label>
          <label>
            Description
            <input
              value={processorDescription}
              onChange={(e) => setProcessorDescription(e.target.value)}
            />
          </label>
          <div className="processor-history">
            <label>
              Saved versions
              <select
                aria-label="Load processor version"
                defaultValue=""
                onChange={(e) => {
                  const v = s.activeProcessor?.versions.find(
                    (v) => v.id === e.target.value,
                  );
                  if (v) {
                    s.chooseProcessor(s.activeProcessor!, v.config);
                  }
                }}
              >
                <option value="" disabled>
                  Load a saved version…
                </option>
                {s.activeProcessor.versions.map((v) => (
                  <option key={v.id} value={v.id}>
                    v{v.version} · {new Date(v.date).toLocaleDateString()}
                  </option>
                ))}
              </select>
            </label>
            <button onClick={s.saveAsProcessor}>Save as new processor</button>
          </div>
        </div>
      )}
      <div className="configuration-layout">
        <div className="configuration-sections">
          <section className="configuration-card">
            <div className="configuration-section-title">
              <span className="configuration-section-icon">
                <Settings2 size={17} />
              </span>
              <div>
                <h2>Extraction settings</h2>
                <p>Use any provider. Keep your workflow.</p>
              </div>
              <span className="configuration-number">01</span>
            </div>
            <ConfigForm
              config={s.config}
              onChange={s.updateConfig}
              showSchema={false}
            />
          </section>
          <section className="configuration-card schema-card">
            <div className="configuration-section-title">
              <span className="configuration-section-icon">
                <Braces size={18} />
              </span>
              <div>
                <h2>Target schema</h2>
                <p>Define fields, descriptions, and nested structures.</p>
              </div>
              <span className="configuration-number">02</span>
            </div>
            <div className="schema-editor-toolbar">
              <span>
                {schema.properties.length} top-level fields{" "}
                <span className="schema-toolbar-dot">·</span> JSON Schema
              </span>
              <Button
                disabled={!!error && !editingJson}
                onClick={() => {
                  if (editingJson && document) {
                    setEditingJson(false);
                    setRaw(s.config.schema);
                    setJsonDirty(false);
                    setError("");
                  } else setEditingJson(true);
                }}
              >
                <Code2 size={14} />
                {editingJson && document ? "Back to builder" : "Edit JSON"}
              </Button>
            </div>
            {editingJson ? (
              <div className="schema-raw-editor">
                {unsupported && (
                  <p className="form-hint">
                    {unsupported} Your schema is preserved in full.
                  </p>
                )}
                <label htmlFor="schema-json-input">Schema JSON</label>
                <textarea
                  id="schema-json-input"
                  spellCheck={false}
                  value={raw}
                  onChange={(e) => {
                    setRaw(e.target.value);
                    setJsonDirty(true);
                    setError("");
                  }}
                />
                <div className="schema-raw-actions">
                  <span>Apply changes to synchronize the field table.</span>
                  <Button variant="primary" onClick={applyJson}>
                    Apply JSON
                  </Button>
                </div>
              </div>
            ) : (
              <SchemaBuilderPanel
                className="studio-schema-builder"
                schema={schema}
                onSchemaChange={update}
                jsonSchema={JSON.parse(s.config.schema)}
                theme="light"
              />
            )}
            {error && (
              <p className="schema-error" role="alert">
                {error} These changes have not been saved.
              </p>
            )}
            <div className="schema-editor-footer">
              <span>Drag fields to reorder or move them into objects.</span>
              <span>Built with Extend UI</span>
            </div>
          </section>
          <div className="configuration-bottom">
            <span>
              <Check size={14} /> Valid changes save automatically to this
              browser.
            </span>
            <Button disabled={!valid} onClick={() => s.navigate("Playground")}>
              Open playground <ArrowRight size={14} />
            </Button>
          </div>
        </div>
        <aside className="configuration-context">
          <div className="configuration-context-label">YOUR TEST DOCUMENT</div>
          <div className="configuration-document">
            <FileScan size={25} />
            <strong>{s.selected?.name ?? "No document selected"}</strong>
            <span>
              {s.selected
                ? `${s.selected.pages} page${s.selected.pages === 1 ? "" : "s"}`
                : "Add a document in the playground"}
            </span>
            <Button onClick={() => s.navigate("Playground")}>
              View document <ArrowRight size={13} />
            </Button>
          </div>
          <div className="configuration-tip">
            <h3>A little guidance goes a long way.</h3>
            <p>
              Use field descriptions to explain formats, edge cases, and what to
              return when a value is missing.
            </p>
            <code>invoice_date</code>
            <p className="configuration-tip-example">
              “The issue date, in YYYY-MM-DD format. Return null if absent.”
            </p>
          </div>
          <div className="configuration-context-note">
            <Braces size={15} />
            <p>
              Your schema and instructions travel with you across models and
              evaluation runs.
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}
