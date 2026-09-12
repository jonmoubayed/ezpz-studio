import { ConfidenceBadge } from "./ui";
import { ExpectedValuesEditor, FieldValues } from "./expected-values";
import { withExpectedValues } from "./result-model";
import { FieldSelect } from "./components/field-select";
import { useRef, useState } from "react";
import {
  Braces,
  Check,
  Code2,
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
import { ProcessorCodePanel } from "./processor-code-panel";
import { HarnessEditor } from "./harness-editor";
import { HarnessTrace } from "./harness-trace";
import { harnessError } from "./harness";
import { ConfigForm } from "./pages";
import { useStudio } from "./store";
import { Badge, Button, Busy, Empty, Heading } from "./ui";

import { WorkbenchControls, WorkbenchSource } from "./workbench";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./components/ui/tabs";
import {
  downloadJson,
  type Document as SourceDocument,
  type Config,
} from "./domain";

type Preview = { document: SourceDocument; config: Config; demo: boolean };
export function Configuration() {
  const s = useStudio();
  const settings = useRef<HTMLDetailsElement>(null);
  const schemaSection = useRef<HTMLElement>(null);
  const [pane, setPane] = useState("configure");
  const [previews, setPreviews] = useState<Record<string, Preview>>({});
  const [running, setRunning] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const [activeField, setActiveField] = useState("");
  const source = s.selected;
  const preview = source ? previews[source.id] : undefined;
  const field =
    pane === "results" && !running && !previewError
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
  const valid = !error && !jsonDirty && !harnessError(s.config.harness);
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
            <Button onClick={() => setPane("code")}>
              <Code2 size={14} /> Code snippet
            </Button>
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
      <WorkbenchControls
        status={!valid ? "Unsaved schema changes" : "Working configuration"}
        onConfigure={() => {
          setPane("configure");
          if (settings.current) settings.current.open = true;
        }}
        onSchema={() => {
          setPane("configure");
          if (settings.current) settings.current.open = false;
          requestAnimationFrame(() =>
            schemaSection.current?.scrollIntoView({ block: "nearest" }),
          );
        }}
      />
      <div className={`workbench-layout processor-workspace${pane === "harness" ? " harness-workspace" : ""}`}>
        <WorkbenchSource
          document={source}
          field={field}
          label="Processor source document"
          onDocumentChange={() => {
            setActiveField("");
            setPreviewError("");
          }}
        />
        <Tabs
          value={pane}
          onValueChange={setPane}
          className="results-pane processor-workspace-editor"
        >
          <div className="pane-heading">
            <span className="results-title">
              <Braces size={17} />
              Processor workspace
            </span>
            <Badge>
              {s.activeProcessor ? `v${s.activeProcessor.version}` : "Draft"}
            </Badge>
          </div>
          <div className="processor-pane-tabs results-tabs">
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
              <TabsTrigger value="harness">Harness</TabsTrigger>
              <TabsTrigger value="code">
                <Code2 size={14} /> Code
              </TabsTrigger>
            </TabsList>
          </div>
          <TabsContent value="harness" className="processor-config-content">
            <HarnessEditor config={s.config} onChange={s.updateConfig} live={s.mode === "live"} />
          </TabsContent>
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
                      <FieldSelect
                        aria-label="Load processor version"
                        defaultValue=""
                        onValueChange={(value) => {
                          const v = s.activeProcessor?.versions.find(
                            (v) => v.id === value,
                          );
                          if (v) {
                            s.chooseProcessor(s.activeProcessor!, v.config);
                          }
                        }}
                        options={[
                          {
                            value: "",
                            label: "Load a saved version…",
                            disabled: true,
                          },
                          ...s.activeProcessor.versions.map((v) => ({
                            value: v.id,
                            label:
                              "v" +
                              v.version +
                              " · " +
                              new Date(v.date).toLocaleDateString() +
                              (v.author?.startsWith("mcp:") ? ` · ${v.author} · ${v.status === "draft" ? "candidate" : "published"}` : ""),
                          })),
                        ]}
                      />
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
                <details
                  ref={settings}
                  className="configuration-card processor-extraction-settings"
                >
                  <summary className="configuration-section-title">
                    <span className="configuration-section-icon">
                      <Settings2 size={17} />
                    </span>
                    <div>
                      <h2>Extraction settings</h2>
                      <p>
                        {s.config.model} · {s.config.parser}
                      </p>
                    </div>
                    <ChevronDown size={14} className="configuration-number" />
                  </summary>
                  <ConfigForm
                    config={s.config}
                    onChange={s.updateConfig}
                    showSchema={false}
                  />
                </details>
                <section
                  ref={schemaSection}
                  className="configuration-card schema-card"
                >
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
          <TabsContent value="code" className="processor-code-content">
            <ProcessorCodePanel config={s.config} valid={valid} />
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
  const s = useStudio();
  const latest = s.documents.find((d) => d.id === preview.document.id);
  const resultDocument = latest?.groundTruth
    ? withExpectedValues(preview.document, latest.groundTruth)
    : preview.document;
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
          Illustrative invoice fixture; no model was called. Connect the local
          API to test your custom schema.
        </p>
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
          <TabsTrigger value="expected">Expected</TabsTrigger>
          <TabsTrigger value="steps">Execution steps</TabsTrigger>
        </TabsList>
        <TabsContent value="steps"><HarnessTrace steps={preview.document.harnessSteps} /></TabsContent>
        <TabsContent value="fields">
          <div className="processor-preview-fields">
            {resultDocument.fields.map((f) => (
              <article
                className={`processor-preview-field ${activeField === f.key ? "active" : ""}`}
                key={f.key}
                onClick={() => onField(f.key)}
              >
                <button
                  type="button"
                  className="field-source-trigger"
                  aria-label={`Inspect source for ${f.key}`}
                  aria-pressed={activeField === f.key}
                >
                  <strong>{f.key}</strong>
                  <ConfidenceBadge field={f} />
                </button>
                <FieldValues field={f} />
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
              </article>
            ))}
            {!preview.document.fields.length && (
              <Empty
                title="No fields returned"
                description="Check the instructions and schema, then run again."
              />
            )}
          </div>
        </TabsContent>
        <TabsContent value="expected">
          <ExpectedValuesEditor
            key={resultDocument.id}
            document={resultDocument}
          />
        </TabsContent>
        <TabsContent value="json">
          <pre className="json-output">{JSON.stringify(output, null, 2)}</pre>
        </TabsContent>
      </Tabs>
    </div>
  );
}
