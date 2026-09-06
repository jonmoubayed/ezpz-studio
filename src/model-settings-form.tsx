import { ChevronDown } from "lucide-react";
import { FieldSelect } from "./components/field-select";
import { modelCapabilities, modelSettingsError, type ModelSettings } from "./model-settings";
import "./model-settings.css";

export function ModelSettingsForm({ provider, model, value = {}, onChange }: {
  provider: string; model: string; value?: ModelSettings; onChange: (value: ModelSettings) => void;
}) {
  if (provider === "local") return null;
  const caps = modelCapabilities(provider, model);
  const error = modelSettingsError(provider, model, value);
  const update = (key: keyof ModelSettings, next: string | number | boolean | undefined) => {
    const changed = { ...value, [key]: next };
    if (next === undefined) delete changed[key];
    if (provider === "anthropic" && key === "temperature") delete changed.top_p;
    if (provider === "anthropic" && key === "top_p") delete changed.temperature;
    onChange(changed);
  };
  const numeric = (key: "max_tokens" | "temperature" | "top_p" | "thinking_budget", label: string, min: number, max: number, step: number, placeholder: string) => <label>
    {label}
    <input type="number" min={min} max={max} step={step} value={value[key] ?? ""} placeholder={placeholder}
      onChange={e => update(key, e.target.value === "" ? undefined : Number(e.target.value))} />
  </label>;
  const sampling = caps.sampling && !(provider === "anthropic" && (value.reasoning_effort || value.thinking_budget !== undefined));
  return <details className="model-settings" open>
    <summary>Model settings <ChevronDown size={14} /></summary>
    <div className="model-settings-body">
      <div className="model-settings-grid">
        {caps.efforts.length > 0 && <label>Reasoning effort
          <FieldSelect aria-label="Reasoning effort" value={value.reasoning_effort ?? ""} onValueChange={next => update("reasoning_effort", next || undefined)}
            options={[
              { value: "", label: "Provider default" },
              ...caps.efforts.map(effort => ({ value: effort, label: effort === "xhigh" ? "Extra high" : effort[0].toUpperCase() + effort.slice(1) })),
            ]}
          />
        </label>}
        {numeric("max_tokens", "Output token limit", 1, 1000000, 1, "4096 · app default")}
        {caps.verbosity && <label>Response verbosity
          <FieldSelect aria-label="Response verbosity" value={value.verbosity ?? ""} onValueChange={next => update("verbosity", next || undefined)}
            options={[
              { value: "", label: "Provider default" },
              ...["low", "medium", "high"].map(level => ({ value: level, label: level[0].toUpperCase() + level.slice(1) })),
            ]}
          />
        </label>}
        {caps.budget_min !== undefined && numeric("thinking_budget", "Thinking token budget", ["google", "gemini"].includes(provider) ? -1 : caps.budget_min, caps.budget_max!, 1, "Provider default")}
        {sampling && numeric("temperature", "Temperature", 0, provider === "anthropic" ? 1 : 2, 0.1, "0 · app default")}
        {sampling && numeric("top_p", "Top P", 0, 1, 0.05, "Provider default")}
        {caps.strict && <label>Output format
          <FieldSelect aria-label="Output format" value={value.structured_outputs ? "strict" : "json"} onValueChange={next => update("structured_outputs", next === "strict")}
            options={[
              { value: "json", label: "JSON object" },
              { value: "strict", label: "Strict JSON schema" },
            ]}
          />
        </label>}
      </div>
      <p className="model-settings-hint">Higher effort can improve difficult extractions and increase latency and cost. The output limit includes reasoning tokens; model-specific limits still apply.</p>
      {!sampling && <p className="model-settings-hint">Temperature and Top P are omitted for this reasoning configuration.</p>}
      {caps.budget_min !== undefined && <p className="model-settings-hint">Budget range: {caps.budget_min}–{caps.budget_max} tokens.{["google", "gemini"].includes(provider) ? " Use -1 for automatic thinking." : " Leave blank to keep thinking off by default."}</p>}
      <label>System instructions
        <textarea rows={3} value={value.system ?? ""} placeholder="Return only valid JSON matching the supplied schema."
          onChange={e => update("system", e.target.value || undefined)} />
      </label>
      {error && <p className="schema-error" role="alert">{error}</p>}
      <button type="button" className="btn" onClick={() => onChange({})} disabled={!Object.keys(value).length}>Reset model settings</button>
    </div>
  </details>;
}
