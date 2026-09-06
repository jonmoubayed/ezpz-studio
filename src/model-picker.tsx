import { useEffect, useId, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { request } from "./api";
import { FieldSelect } from "./components/field-select";
import bundled from "./model-catalog.json";
import "./model-picker.css";

type Model = { id: string; name: string };
type Catalog = {
  source: "provider" | "built-in";
  fetched_at: string;
  warnings: string[];
  models: Model[];
};

export function builtinModels(provider: string): string[] {
  return (bundled.providers as Record<string, string[]>)[provider] ?? [];
}

export async function fetchModelCatalog(provider: string, endpoint: string, signal: AbortSignal): Promise<Catalog> {
  const params = new URLSearchParams({ provider });
  if (endpoint) params.set("endpoint", endpoint);
  const result = await request(`/model-catalog?${params}`, { signal, cache: "no-store" });
  if (!result || !["provider", "built-in"].includes(result.source) ||
      !Array.isArray(result.models) || !Array.isArray(result.warnings) ||
      !result.models.every((m: Model) => m && typeof m.id === "string" && typeof m.name === "string") ||
      !result.warnings.every((w: unknown) => typeof w === "string")) {
    throw new Error("The model list could not be read. Try checking again.");
  }
  return result;
}

// A provider/endpoint key isolates requests and suggestions when switching providers.
export function ModelPicker(props: {
  provider: string;
  endpoint?: string;
  value: string;
  onChange: (value: string) => void;
  live: boolean;
}) {
  return <ProviderModelPicker key={`${props.provider}:${props.endpoint ?? ""}:${props.live}`} {...props} />;
}

function ProviderModelPicker({ provider, endpoint = "", value, onChange, live }: Parameters<typeof ModelPicker>[0]) {
  const id = useId();
  const [models, setModels] = useState<Model[]>(() => builtinModels(provider).map(id => ({ id, name: id })));
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const controller = useRef<AbortController | null>(null);
  const canRefresh = live && provider !== "local";

  async function refresh() {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setBusy(true);
    setStatus("");
    try {
      const result = await fetchModelCatalog(provider, endpoint, current.signal);
      if (current.signal.aborted) return;
      if (result.source === "provider") {
        const added = result.models.filter(m => !models.some(old => old.id === m.id)).length;
        setModels(result.models);
        setStatus(`${result.models.length} models available · ${added ? `${added} new · ` : ""}Checked ${new Date(result.fetched_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`);
      } else {
        // Keep a previously successful list when a later provider check fails.
        setStatus(`${result.warnings.join(" ")} Keeping the current suggestions.`);
      }
    } catch (error) {
      if (!current.signal.aborted) setStatus(`${(error as Error).message} Keeping the current suggestions.`);
    } finally {
      if (!current.signal.aborted) setBusy(false);
    }
  }

  useEffect(() => {
    // Wait for endpoint edits to settle before contacting the provider.
    const timer = canRefresh ? window.setTimeout(() => void refresh(), 400) : undefined;
    return () => {
      window.clearTimeout(timer);
      controller.current?.abort();
    };
  }, []);

  return <div className="model-picker">
    <label htmlFor={id}>Model ID</label>
    <FieldSelect
      aria-label="Available models"
      value={models.some(m => m.id === value) ? value : ""}
      onValueChange={next => { if (next) onChange(next); }}
      options={[
        { value: "", label: value ? `Custom · ${value}` : "Choose a model…" },
        ...models.map(model => ({ value: model.id, label: model.name })),
      ]}
    />
    <input id={id} value={value} onChange={e => onChange(e.target.value)} placeholder="Or enter any model ID" aria-describedby={`${id}-status`} />
    <button type="button" className="btn model-refresh" onClick={() => void refresh()} disabled={!canRefresh || busy} aria-busy={busy}>
      <RefreshCw size={13} className={busy ? "model-refresh-spinning" : ""} />
      {busy ? "Checking models…" : "Check for new models"}
    </button>
    <p id={`${id}-status`} className="model-catalog-status" role="status">
      {busy ? "Checking your provider’s available models…" : status || (provider === "local"
        ? "Local deterministic model."
        : live ? `Built-in suggestions · updated ${bundled.updated_at}`
        : `Demo suggestions · updated ${bundled.updated_at}. Live model checks are available in the local studio.`)}
    </p>
  </div>;
}
