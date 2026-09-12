import { useCallback, useState } from "react";
import { ArrowDown, ArrowUp, ChevronRight, GitBranch, Plus, Trash2, Undo2 } from "lucide-react";
import { Button } from "./ui";
import { FieldSelect } from "./components/field-select";
import { HarnessCanvas } from "./harness-canvas";
import { blockTrail, harnessGraph, savedConnections, updateConnection, removeBlock } from "./harness-graph";
import { ModelPicker } from "./model-picker";
import { ModelSettingsForm } from "./model-settings-form";
import type { Config } from "./domain";
import type { ModelSettings } from "./model-settings";
import { blockNames, children, findBlock, harnessError, harnessRecipe, newBlock, recipes, routingError, schemaPaths, transformBlock, type HarnessBlock, type HarnessConfig, type HarnessConnection, type BlockKind } from "./harness";
import "./harness.css";

export function HarnessEditor({ config, onChange, live }: { config: Config; onChange: (c: Config) => void; live: boolean }) {
  const [selected, setSelected] = useState("");
  const [selectedEdge, setSelectedEdge] = useState("");
  const [scopeId, setScopeId] = useState("");
  const [addKind, setAddKind] = useState<BlockKind>("extract");
  const [recipe, setRecipe] = useState("parsed");
  const [view, setView] = useState("builder");
  const [history, setHistory] = useState<(HarnessConfig | undefined)[]>([]);
  const [json, setJson] = useState("");
  const [jsonError, setJsonError] = useState("");
  const spec = config.harness;
  const root = spec?.name === "workflow" ? spec.flow : undefined;
  const active = findBlock(root, selected) || root;
  const paths = schemaPaths(config.schema);
  const trail = root ? blockTrail(root, scopeId) : [];
  const scope = trail.at(-1) || root;
  const ancestry = root && active ? blockTrail(root, active.id) : [];
  const parent = ancestry.at(-2);
  const parentGroup = parent && children(parent).find(([, list]) => list.some(b => b.id === active?.id));
  const movable = !parent?.routing && parentGroup && ["steps", "tiers", "branches"].includes(parentGroup[0]);
  const siblingIndex = parentGroup?.[1].findIndex(b => b.id === active?.id) ?? -1;
  const openFlow = useCallback((id: string) => { setScopeId(id); setSelected(id); setSelectedEdge(""); }, []);
  const selectBlock = useCallback((id: string) => { setSelected(id); setSelectedEdge(""); }, []);
  const graph = scope ? harnessGraph(scope, config.model) : undefined;
  const edge = graph?.edges.find(edge => edge.id === selectedEdge);
  function editEdges(edges: HarnessConnection[]) {
    if (!root || !scope || !spec) return;
    if (children(scope).length) changeBlock(scope.id, b => ({ ...b, routing: { edges } }));
    else {
      const wrapper = { ...newBlock("sequence"), steps: [scope], routing: { edges } };
      save({ ...spec, flow: transformBlock(root, scope.id, () => wrapper) });
      setScopeId(wrapper.id);
    }
  }
  function deleteEdges(ids: string[]) {
    if (scope) editEdges(savedConnections(scope).filter(edge => !ids.includes(edge.id)));
    setSelectedEdge("");
  }
  function save(next: HarnessConfig) {
    setHistory(previous => [...previous.slice(-19), structuredClone(spec)]);
    onChange({ ...config, harness: next });
  }
  function changeBlock(id: string, edit: (b: HarnessBlock) => HarnessBlock) {
    if (root && spec) save({ ...spec, flow: transformBlock(root, id, edit) });
  }
  function addBlock() {
    if (!root || !scope || !spec) return;
    const child = newBlock(addKind);
    const group = { sequence: "steps", cascade: "tiers", consensus: "branches", parallel: "branches" }[scope.kind as "sequence"];
    if (group) {
      const list = [...(scope[group as "steps"] || []), child];
      changeBlock(scope.id, b => ({ ...b, [group]: list, ...(b.kind === "consensus" && b.quorum !== undefined ? { quorum: Math.max(b.quorum, Math.floor(list.length / 2) + 1) } : {}) }));
    } else {
      const target = scope.kind === "gate" && active ? active : scope.body || scope;
      const wrapper = { ...newBlock("sequence"), steps: [target, child] };
      save({ ...spec, flow: transformBlock(root, target.id, () => wrapper) });
      setScopeId(wrapper.id);
    }
    setSelected(child.id); setSelectedEdge("");
  }
  function moveBlock(direction: number) {
    if (!parent || !parentGroup || !movable) return;
    const list = [...parentGroup[1]];
    const next = siblingIndex + direction;
    if (next < 0 || next >= list.length) return;
    [list[siblingIndex], list[next]] = [list[next], list[siblingIndex]];
    changeBlock(parent.id, b => ({ ...b, [parentGroup[0]]: list }));
  }
  const patch = (changes: Partial<HarnessBlock>) => active && changeBlock(active.id, b => ({ ...b, ...changes }));
  return <section className="harness-editor" aria-label="Harness builder">
    <div className="harness-intro"><h2>Extraction flow</h2><p>Compose models, acceptance checks, and parallel extractions. Every saved processor version keeps its exact flow.</p></div>
    <div className="harness-toolbar">
      <label>Starting recipe<FieldSelect aria-label="Starting recipe" value={recipe} onValueChange={setRecipe} options={recipes.map(r => ({ value: r.id, label: r.name }))} /></label>
      <Button onClick={() => { const next = harnessRecipe(recipe); save(next); setSelected(next.flow!.id); setScopeId(next.flow!.id); }}>Use recipe</Button>
      <Button disabled={!history.length} onClick={() => { const previous = history.at(-1); setHistory(history.slice(0, -1)); onChange({ ...config, harness: previous }); }}><Undo2 size={14} /> Undo</Button>
    </div>
    {!root ? <div className="harness-empty"><GitBranch size={24} /><h3>{spec?.name === "custom" ? "Custom harness" : "Choose a starting recipe"}</h3><p>{spec?.name === "custom" ? "This processor uses a custom plugin. Its configuration is preserved until you choose a replacement recipe." : "Your current saved extraction behavior is preserved. Choose a recipe to start composing a flow."}</p>{spec && <details><summary>Current harness configuration</summary><pre>{JSON.stringify(spec, null, 2)}</pre></details>}</div> : <>
      <div className="harness-toolbar">
        <label>Document input<FieldSelect aria-label="Document input" value={spec?.input || "parsed"} onValueChange={input => save({ ...spec!, input: input as "parsed" | "document" })} options={[{ value: "parsed", label: `Parser text and layout · ${config.parser}` }, { value: "document", label: "Original document · no parser" }]} /></label>
        <label>Maximum model calls<input type="number" min="1" max="1000" value={spec?.limits?.max_calls ?? 30} onChange={e => save({ ...spec!, limits: { concurrency: spec?.limits?.concurrency ?? 3, max_calls: Number(e.target.value) } })} /></label>
        <label>Concurrent calls<input type="number" min="1" max="16" value={spec?.limits?.concurrency ?? 3} onChange={e => save({ ...spec!, limits: { max_calls: spec?.limits?.max_calls ?? 30, concurrency: Number(e.target.value) } })} /></label>
      </div>
      {spec?.input === "document" && <p className="harness-hint">PDF and image input requires a compatible hosted model and includes model-estimated source boxes. Locations may be approximate; fields without a locatable source have no box. Plain text can be sent directly. Add a Parse block anywhere you need text or page layout.</p>}
      <div className="harness-view-switch" aria-label="Harness views">{["builder", "flow", "json"].map(v => <button type="button" aria-pressed={view === v} key={v} onClick={() => { setView(v); if (v === "json") { setJson(JSON.stringify(spec, null, 2)); setJsonError(""); } }}>{v === "json" ? "JSON" : v === "flow" ? "Flow overview" : "Canvas"}</button>)}</div>
      {harnessError(spec) && <p className="form-error" role="alert">{harnessError(spec)}</p>}
      {view === "json" ? <div className="harness-json"><textarea aria-label="Harness JSON" value={json} onChange={e => setJson(e.target.value)} spellCheck={false} /><Button onClick={() => { try { const parsed = JSON.parse(json); const error = harnessError(parsed); if (parsed.name !== "workflow" || error) throw new Error(error || "Use a workflow specification."); save(parsed); setJsonError(""); } catch (e) { setJsonError((e as Error).message); } }}>Apply JSON</Button>{jsonError && <p role="alert" className="form-error">{jsonError}</p>}</div> : <div className={`harness-layout ${view}`}>
        <div className="harness-flow">
          <div className="harness-canvas-toolbar">
            <nav className="harness-breadcrumbs" aria-label="Flow path">{(trail.length ? trail : [root]).map((block, index) => <span key={block.id}>{index > 0 && <ChevronRight size={12} />}<button type="button" onClick={() => openFlow(block.id)} aria-current={block.id === scope?.id ? "location" : undefined}>{index === 0 ? "Main flow" : block.label || blockNames[block.kind]}</button></span>)}</nav>
            {view === "builder" && <div className="harness-add"><FieldSelect aria-label="New block type" value={addKind} onValueChange={value => setAddKind(value as BlockKind)} options={Object.entries(blockNames).map(([value, label]) => ({ value, label }))} /><Button onClick={addBlock}><Plus size={14} /> {scope?.kind === "cascade" ? "Add tier" : ["consensus", "parallel"].includes(scope?.kind || "") ? "Add branch" : scope?.kind === "gate" ? "Add after selected" : "Add step"}</Button></div>}
          </div>
          {scope && <HarnessCanvas scope={scope} rootId={root.id} defaultModel={config.model} selected={active?.id || ""} onSelect={selectBlock} onOpen={openFlow}
            selectedEdge={selectedEdge} onSelectEdge={setSelectedEdge} onDeleteEdges={deleteEdges}
            onConnect={(connection, replaceId) => { const condition = connection.sourceHandle === "accepted" ? "accepted" : connection.sourceHandle === "unresolved" ? "unresolved" : "always"; editEdges(updateConnection(scope, { source: connection.source, target: connection.target, condition }, replaceId)); if (replaceId) setSelectedEdge(replaceId); }} />}
          {scope && routingError(scope) && <p className="form-error" role="alert">{routingError(scope)}</p>}
          <p className="harness-canvas-help">Select an arrow to edit its source, destination, or condition. Drag an arrow’s endpoint to reconnect it. Bottom handles always continue; right handles route accepted results; left handles route unresolved results. Unconnected steps do not run.</p>

        </div>
        {view === "builder" && edge && scope && graph ? <aside className="harness-settings" aria-label="Connection settings">
          <h3>Connection</h3>
          <label>From<FieldSelect aria-label="Connection source" value={edge.source} options={graph.nodes.map((node, index) => ({ ...node, optionLabel: node.block ? `${index}. ${node.label}` : node.label })).filter(node => node.boundary !== "output").map(node => ({ value: node.id, label: node.optionLabel }))} onValueChange={source => editEdges(updateConnection(scope, { source, target: edge.target, condition: edge.condition }, edge.id))} /></label>
          <label>To<FieldSelect aria-label="Connection destination" value={edge.target} options={graph.nodes.map((node, index) => ({ ...node, optionLabel: node.block ? `${index}. ${node.label}` : node.label })).filter(node => node.boundary !== "input").map(node => ({ value: node.id, label: node.optionLabel }))} onValueChange={target => editEdges(updateConnection(scope, { source: edge.source, target, condition: edge.condition }, edge.id))} /></label>
          <label>Continue when<FieldSelect aria-label="Connection condition" value={edge.condition} options={[{ value: "always", label: "Always" }, { value: "accepted", label: "Accepted" }, { value: "unresolved", label: "Unresolved" }]} onValueChange={condition => editEdges(updateConnection(scope, { source: edge.source, target: edge.target, condition: condition as HarnessConnection["condition"] }, edge.id))} /></label>
          <p className="harness-hint">Conditional arrows use this flow’s confidence and validation checks. Saved evaluations follow these connections.</p>
          <Button onClick={() => { setSelected(scope.id); setSelectedEdge(""); }}>Edit flow checks</Button>
          <Button onClick={() => deleteEdges([edge.id])}><Trash2 size={14} /> Delete connection</Button>
        </aside> : view === "builder" && active && <aside className="harness-settings" aria-label="Selected block settings" key={active.id}>
          <div className="harness-settings-heading"><h3>{blockNames[active.kind]}</h3><div className="harness-block-actions">
            <button type="button" aria-label="Move block earlier" disabled={!movable || siblingIndex < 1} onClick={() => moveBlock(-1)}><ArrowUp size={14} /></button>
            <button type="button" aria-label="Move block later" disabled={!movable || siblingIndex >= (parentGroup?.[1].length || 0) - 1} onClick={() => moveBlock(1)}><ArrowDown size={14} /></button>
            <button type="button" aria-label="Remove block" disabled={!root || !active || removeBlock(root, active.id) === root} onClick={() => { const next = removeBlock(root, active.id); if (next !== root) { save({ ...spec!, flow: next }); setSelected(parent!.id); } }}><Trash2 size={14} /></button>
          </div></div>
          <label>Block name<input value={active.label || ""} placeholder={blockNames[active.kind]} onChange={e => patch({ label: e.target.value })} /></label>
          <label>Block type<FieldSelect aria-label="Block type" value={active.kind} onValueChange={value => { const replacement = newBlock(value as BlockKind); changeBlock(active.id, () => ({ ...replacement, id: active.id, label: active.label })); }} options={Object.entries(blockNames).map(([value, label]) => ({ value, label }))} /></label>
          {active.kind === "extract" && <>
            <label className="harness-check"><input type="checkbox" checked={!!active.model} onChange={e => patch({ model: e.target.checked ? { provider: config.provider, name: config.model } : undefined })} /> Choose a model for this step</label>
            {active.model && <><label>Provider<FieldSelect aria-label="Provider" value={active.model.provider || config.provider} onValueChange={provider => patch({ model: { provider, name: "" } })} options={["local", "openai", "anthropic", "google", "ollama", "openai-compatible"].map(value => ({ value, label: value }))} /></label><ModelPicker provider={active.model.provider || config.provider} value={active.model.name || ""} endpoint={active.model.base_url} live={live} onChange={name => patch({ model: { ...active.model, name } })} />{["ollama", "openai-compatible"].includes(active.model.provider || "") && <label>Endpoint<input value={active.model.base_url || ""} onChange={e => patch({ model: { ...active.model, base_url: e.target.value } })} /></label>}</>}
            <label>Step instructions<textarea value={String(active.prompt?.extraction || "")} placeholder="Use processor instructions" onChange={e => patch({ prompt: { ...active.prompt, extraction: e.target.value || undefined } })} /></label>
            <FieldScope label="Extract fields" paths={paths} value={active.fields || []} onChange={fields => patch({ fields })} />
            <p className="harness-hint">Leave fields empty to extract the current scope. A tier can inherit unresolved fields from its parent.</p>
            <details><summary>Model settings</summary><ModelSettingsForm provider={active.model?.provider || config.provider} model={active.model?.name || config.model} value={(active.prompt || {}) as ModelSettings} onChange={value => patch({ prompt: { ...value, extraction: active.prompt?.extraction } })} /></details>
          </>}
          {active.kind === "parse" && <label>Parser<FieldSelect aria-label="Parser" value={active.parser?.name || config.parser} onValueChange={name => patch({ parser: { name } })} options={["native", "docling", "llama-parse"].map(value => ({ value, label: value }))} /></label>}
          {["gate", "cascade", "validate", "return", "repair"].includes(active.kind) && <>
            <label>Confidence threshold<input type="number" min="0" max="1" step="0.01" placeholder="Validation only" value={active.threshold ?? ""} onChange={e => patch({ threshold: e.target.value === "" ? undefined : Number(e.target.value) })} /></label>
            <label>Missing confidence<FieldSelect aria-label="Missing confidence" value={active.missing_confidence || "escalate"} onValueChange={value => patch({ missing_confidence: value as "escalate" | "ignore" })} options={[{ value: "escalate", label: "Treat as unresolved" }, { value: "ignore", label: "Use other validation checks" }]} /></label>
            <FieldScope label="Critical fields" paths={paths} value={active.critical_fields || []} onChange={critical_fields => patch({ critical_fields })} />
            <p className="harness-hint">Empty means all fields. Model-reported confidence is separate from vote agreement.</p>
            <JsonSetting label="Arithmetic checks" value={active.rules || []} onChange={rules => patch({ rules })} />
          </>}
          {active.kind === "cascade" && <label>Escalation scope<FieldSelect aria-label="Escalation scope" value={active.scope || "document"} onValueChange={value => patch({ scope: value as "document" | "unresolved" })} options={[{ value: "document", label: "Whole document" }, { value: "unresolved", label: "Only unresolved fields" }]} /></label>}
          {active.kind === "consensus" && <><label>Required agreeing voters<input type="number" min={Math.floor((active.branches?.length || 0) / 2) + 1} max={active.branches?.length} value={active.quorum ?? Math.floor((active.branches?.length || 0) / 2) + 1} onChange={e => patch({ quorum: Number(e.target.value) })} /></label><label>Numeric tolerance<input type="number" min="0" step="0.01" value={active.normalization?.tolerance ?? 0} onChange={e => patch({ normalization: { ...active.normalization, tolerance: Number(e.target.value) } })} /></label><label className="harness-check"><input type="checkbox" checked={active.normalization?.case_insensitive || false} onChange={e => patch({ normalization: { ...active.normalization, case_insensitive: e.target.checked } })} /> Ignore letter case</label><JsonSetting label="Field comparison policies" value={active.field_policies || {}} onChange={field_policies => patch({ field_policies })} /><p className="harness-hint">Arrays require a row_key policy. No majority returns an unresolved field; add an acceptance gate to escalate.</p></>}
          {active.kind === "repair" && <><label>Maximum repair attempts<input type="number" min="1" max="5" value={active.attempts ?? 1} onChange={e => patch({ attempts: Number(e.target.value) })} /></label><label className="harness-check"><input type="checkbox" checked={active.always_verify || false} onChange={e => patch({ always_verify: e.target.checked })} /> Verify even when validation passes</label></>}
          {active.kind === "pages" && <JsonSetting label="Table row keys by field" value={active.row_keys || {}} onChange={row_keys => patch({ row_keys })} />}
          {active.kind === "parallel" && <p className="harness-hint">Assign different field scopes to the branches. Conflicting values remain unresolved.</p>}
        </aside>}
      </div>}
    </>}
  </section>;
}

function FieldScope({ label, paths, value, onChange }: { label: string; paths: string[]; value: string[]; onChange: (v: string[]) => void }) {
  return <fieldset className="harness-fields"><legend>{label}</legend>{paths.map(path => <label className="harness-check" key={path}><input type="checkbox" checked={value.includes(path)} onChange={e => onChange(e.target.checked ? [...value, path] : value.filter(p => p !== path))} />{path}</label>)}</fieldset>;
}
function JsonSetting<T>({ label, value, onChange }: { label: string; value: T; onChange: (v: T) => void }) {
  const [text, setText] = useState(JSON.stringify(value, null, 2));
  const [error, setError] = useState("");
  return <details><summary>{label}</summary><label>{label}<textarea value={text} onChange={e => setText(e.target.value)} /></label><Button onClick={() => { try { onChange(JSON.parse(text)); setError(""); } catch { setError("Enter valid JSON."); } }}>Apply</Button>{error && <p role="alert">{error}</p>}</details>;
}
