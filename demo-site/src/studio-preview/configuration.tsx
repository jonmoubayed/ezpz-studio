import { useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Braces,
  Check,
  Code2,
  FileScan,
  Plus,
  Download,
  Focus,
  ChevronDown,
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
import { Badge, Button, Busy, Empty, Heading } from "./ui";

import { SourceViewer } from "./workbench";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./components/ui/tabs";
import {
  displayValue,
  downloadJson,
  type Document as SourceDocument,
  type Config,
} from "./domain";

type Preview = { document: SourceDocument; config: Config; demo: boolean };
export function Configuration() {
  const s = useStudio();
  const [pane, setPane] = useState("configure");
  const [previews, setPreviews] = useState<Record<string, Preview>>({});
  const [running, setRunning] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const [activeField, setActiveField] = useState("");
  const source = s.selected;
  const preview = source ? previews[source.id] : undefined;
  const field =
    pane === "results"
      ? preview?.document.fields.find((f) => f.key === activeField)
      : undefined;
  async function runExtraction() {
    const config = structuredClone(s.config);
    setPane("results");
    setRunning(true);
    setPreviewError("");
    const document = await s.extract();
    if (document) {
      setPreviews((current) => ({
        ...current,
        [document.id]: { document, config, demo: s.mode === "demo" },
      }));
      setActiveField(
        document.fields.find((f) => f.area)?.key ||
          document.fields[0]?.key ||
          "",
      );
    } else
      setPreviewError(
        "Extraction could not complete. Check the message above, adjust your settings, and try again.",
      );
    setRunning(false);
  }
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
              onClick={runExtraction}
            >
              {running ? (
                <Busy label="Extracting…" />
              ) : (
                <>
                  <Play size={14} /> Run extraction
                </>
              )}
            </Button>
          </>
        }
      />
      <div className="processor-workspace">
        <Tabs
          value={pane}
          onValueChange={setPane}
          className="processor-workspace-editor"
        >
          <div className="processor-pane-tabs">
            <TabsList aria-label="Processor workspace">
              <TabsTrigger value="configure">
                <Settings2 size={14} />
                Configure
              </TabsTrigger>
              <TabsTrigger value="results">
                <Braces size={14} />
                Results{" "}
                {preview && <span>{preview.document.fields.length}</span>}
              </TabsTrigger>
            </TabsList>
            <span>
              {running ? "Running extraction…" : "Build → test → refine"}
            </span>
          </div>
          <TabsContent
            value="configure"
            forceMount
            className="processor-config-content data-[state=inactive]:hidden"
          >
            {s.activeProcessor && (
              <details className="processor-build-details">
                <summary>
                  Processor details & version history <ChevronDown size={13} />
                </summary>
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
                            v{v.version} ·{" "}
                            {new Date(v.date).toLocaleDateString()}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button onClick={s.saveAsProcessor}>
                      Save as new processor
                    </button>
                  </div>
                </div>
              </details>
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
                      {editingJson && document
                        ? "Back to builder"
                        : "Edit JSON"}
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
                        <span>
                          Apply changes to synchronize the field table.
                        </span>
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
                    <span>
                      Drag fields to reorder or move them into objects.
                    </span>
                    <span>Built with Extend UI</span>
                  </div>
                </section>
                <div className="configuration-bottom">
                  <span>
                    <Check size={14} /> Valid changes save automatically to this
                    browser.
                  </span>
                </div>
              </div>
            </div>
          </TabsContent>
          <TabsContent
            value="results"
            forceMount
            className="processor-results-content data-[state=inactive]:hidden"
          >
            {running ? (
              <div className="processor-preview-empty" role="status">
                <Busy label="Extracting from your document…" />
                <p>The source stays in place while the model works.</p>
              </div>
            ) : previewError ? (
              <Empty
                title="Extraction failed"
                description={previewError}
                action={
                  <Button onClick={() => setPane("configure")}>
                    Back to configuration
                  </Button>
                }
              />
            ) : preview ? (
              <ProcessorPreview
                preview={preview}
                changed={
                  JSON.stringify(preview.config) !== JSON.stringify(s.config)
                }
                activeField={activeField}
                onField={setActiveField}
              />
            ) : (
              <Empty
                title="Test your processor"
                description="Run an extraction to see its fields here. Your configuration stays available in the Configure tab."
                action={
                  <Button
                    variant="primary"
                    disabled={!valid || s.busy || !source}
                    onClick={runExtraction}
                  >
                    <Play size={14} />
                    Run extraction
                  </Button>
                }
              />
            )}
          </TabsContent>
        </Tabs>
        <section
          className="source-pane processor-build-source"
          aria-label="Processor source document"
        >
          <div className="pane-heading">
            <FileScan size={15} />
            <select
              aria-label="Processor source document"
              value={source?.id || ""}
              disabled={running}
              onChange={(e) => {
                s.setSelectedId(e.target.value);
                setActiveField("");
                setPreviewError("");
              }}
            >
              {!source && <option value="">Choose a document</option>}
              {s.documents.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
            <Button
              title="Upload source document"
              disabled={s.busy}
              onClick={() => s.setUploadOpen(true)}
            >
              <Plus size={14} />
            </Button>
          </div>
          {source ? (
            <SourceViewer document={source} field={field} />
          ) : (
            <Empty
              title="Add a test document"
              description="Keep the source beside your schema as you build."
              action={
                <Button onClick={() => s.setUploadOpen(true)}>
                  <Plus size={14} />
                  Add document
                </Button>
              }
            />
          )}
          <div className="source-footer">
            <span>
              <Focus size={12} />
              {field?.area
                ? `${field.key} · page ${field.page || 1}`
                : "Source document"}
            </span>
            {source && (
              <a href={source.src} download={source.name}>
                <Download size={12} />
                Download
              </a>
            )}
            <span>Extend UI</span>
          </div>
        </section>
      </div>
    </div>
  );
}

function ProcessorPreview({
  preview,
  changed,
  activeField,
  onField,
}: {
  preview: Preview;
  changed: boolean;
  activeField: string;
  onField: (key: string) => void;
}) {
  const [view, setView] = useState("fields");
  const output = Object.fromEntries(
    preview.document.fields.map((f) => [f.key, f.value]),
  );
  return (
    <div className="processor-preview">
      <div className="processor-preview-status">
        <span>
          <Check size={13} />
          {preview.demo ? "Sample extraction" : "Extraction complete"}
        </span>
        <Badge>{preview.document.fields.length} fields</Badge>
      </div>
      <div className="processor-preview-context">
        <span>
          {preview.config.model} · {preview.config.parser}
        </span>
        <button
          onClick={() => downloadJson(`${preview.document.name}.json`, output)}
        >
          <Download size={13} />
          Export JSON
        </button>
      </div>
      {preview.demo && (
        <p className="processor-preview-note">
          Illustrative invoice fixture; no model was called. This demo uses sample results.</p>
      )}
      {changed && (
        <p className="processor-preview-note">
          Configuration changed since this extraction. Run again to see updated
          results.
        </p>
      )}
      {!!preview.document.warnings?.length && (
        <div className="processor-preview-note" role="status">
          {preview.document.warnings.map((warning, i) => (
            <p key={i}>{warning}</p>
          ))}
        </div>
      )}
      <Tabs
        value={view}
        onValueChange={setView}
        className="processor-output-tabs"
      >
        <TabsList aria-label="Extraction output format">
          <TabsTrigger value="fields">Fields</TabsTrigger>
          <TabsTrigger value="json">JSON</TabsTrigger>
        </TabsList>
        <TabsContent value="fields">
          <div className="processor-preview-fields">
            {preview.document.fields.map((f) => (
              <button
                className={`processor-preview-field ${activeField === f.key ? "active" : ""}`}
                key={f.key}
                onClick={() => onField(f.key)}
              >
                <span>
                  <strong>{f.key}</strong>
                  <Badge tone={f.confidence < 0.9 ? "orange" : "green"}>
                    {Math.round(f.confidence * 100)}%
                  </Badge>
                </span>
                <code>{displayValue(f.value)}</code>
                <small>
                  {f.area ? (
                    <>
                      <Focus size={11} />
                      Source · page {f.page || 1}
                    </>
                  ) : (
                    "No source citation"
                  )}
                </small>
              </button>
            ))}
            {!preview.document.fields.length && (
              <Empty
                title="No fields returned"
                description="Check the instructions and schema, then run again."
              />
            )}
          </div>
        </TabsContent>
        <TabsContent value="json">
          <pre className="json-output">{JSON.stringify(output, null, 2)}</pre>
        </TabsContent>
      </Tabs>
    </div>
  );
}
