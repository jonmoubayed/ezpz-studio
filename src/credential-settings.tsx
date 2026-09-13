import { useEffect, useState } from "react";
import { ArrowUpRight, ChevronRight, Code2, FileText, Monitor, ShieldCheck } from "lucide-react";
import { request } from "./api";
import { Badge, Button } from "./ui";
import "./credential-settings.css";

type Provider = { id: string; label: string; configured: boolean; source: "workspace" | "environment" | "none" };

function ProviderIcon({ id }: { id: string }) {
  const asset = id === "openai" ? "openai" : id === "anthropic" ? "anthropic" : id === "gemini" ? "google-color" : null;
  return <span className={`credential-icon credential-icon-${id}`} aria-hidden="true">
    {asset ? <img src={`${import.meta.env.BASE_URL}assets/providers/${asset}.svg`} alt="" />
      : id === "llama-parse" ? <FileText /> : <Code2 />}
  </span>;
}

function sourceLabel(provider: Provider) {
  return provider.source === "workspace" ? "Saved locally" : provider.source === "environment" ? "From environment" : "Not configured";
}

function CredentialEditor({ provider, onChange, onPending, onDefaults }: {
  provider: Provider;
  onChange: (providers: Provider[]) => void;
  onPending: (pending: boolean) => void;
  onDefaults: () => void;
}) {
  const [key, setKey] = useState("");
  const [pending, setPending] = useState<"save" | "remove" | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  async function update(remove = false) {
    if (pending || (!remove && !key.trim())) return;
    setPending(remove ? "remove" : "save"); onPending(true); setMessage(""); setError("");
    try {
      const result = await request(`/settings/credentials/${provider.id}`, {
        method: remove ? "DELETE" : "POST",
        headers: { "Content-Type": "application/json", "X-Ezpz-Settings": "1" },
        ...(remove ? {} : { body: JSON.stringify({ api_key: key.trim() }) }),
      });
      setKey("");
      onChange(result.providers);
      const current = result.providers.find((item: Provider) => item.id === provider.id);
      setMessage(remove ? current?.configured ? "Saved key removed. Using the environment key." : "Key removed."
        : "Key saved locally. Your provider will check it when you connect or extract.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(null); onPending(false);
    }
  }
  const inputId = `credential-${provider.id}`;
  const isParser = provider.id === "llama-parse";
  return <section className="credential-detail" aria-labelledby="credential-detail-title">
    <header className="credential-detail-heading">
      <div><ProviderIcon id={provider.id} /><h2 id="credential-detail-title">{provider.label}</h2></div>
      <p>{isParser ? "Add an API key to parse your documents with LlamaParse."
        : provider.id === "openai-compatible" ? "Add an API key for your OpenAI-compatible model endpoint."
        : `Add an API key to use ${provider.label} models in your extractions.`}</p>
    </header>
    <form className="credential-form" onSubmit={event => { event.preventDefault(); void update(); }}>
      <label htmlFor={inputId}>API key</label>
      <div className="credential-actions">
        <input id={inputId} type="password" autoComplete="new-password" spellCheck={false}
          aria-label={`${provider.label} API key`} aria-describedby={`${inputId}-privacy ${inputId}-status`}
          aria-invalid={Boolean(error)}
          placeholder={provider.configured ? "Paste a replacement key" : "Paste your API key"}
          value={key} disabled={Boolean(pending)} maxLength={4096}
          onChange={event => { setKey(event.target.value); setError(""); setMessage(""); }} />
        <Button type="submit" variant="primary" disabled={Boolean(pending) || !key.trim()}>
          {pending === "save" ? "Saving…" : provider.configured ? "Replace key" : "Save key"}
        </Button>
      </div>
      <p id={`${inputId}-privacy`} className="credential-help">Keys are stored in your local workspace and excluded from configuration exports.</p>
      <div id={`${inputId}-status`} className="credential-status" aria-live="polite">
        {error ? <span role="alert" className="form-error">{error}</span> : message ||
          (provider.source === "environment" ? "Set in your shell or .env. Saving here overrides it for this workspace." : "")}
      </div>
      {provider.source === "workspace" && <Button className="credential-remove" disabled={Boolean(pending)} onClick={() => void update(true)}>
        {pending === "remove" ? "Removing…" : "Remove saved key"}
      </Button>}
    </form>
    <div className="credential-usage">
      <h3>How this is used</h3>
      <p>After saving, choose {isParser ? "LlamaParse as your document parser" : provider.label} in Extraction defaults or in a processor configuration.</p>
      <button type="button" className="credential-link" onClick={onDefaults}>Go to extraction defaults <ArrowUpRight size={16} /></button>
    </div>
    <p className="credential-footnote">Saving confirms storage. Your provider checks the key when you connect or extract.</p>
  </section>;
}

export function CredentialSettings({ live, onSaved, onDefaults, onWorkspace }: {
  live: boolean; onSaved: () => void; onDefaults: () => void; onWorkspace: () => void;
}) {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [selectedId, setSelectedId] = useState("openai");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!live) return;
    const controller = new AbortController();
    setLoading(true); setError(""); setPending(false);
    request("/settings/credentials", { signal: controller.signal, cache: "no-store" })
      .then(result => { if (!controller.signal.aborted) setProviders(result.providers); })
      .catch(e => { if (!controller.signal.aborted) setError(e.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [live, retry]);
  const selected = providers.find(provider => provider.id === selectedId) ?? providers[0];
  if (!live) return <section className="credential-empty">
    <Monitor size={28} /><h2>Connect your local workspace</h2>
    <p>Manage API keys when Studio is connected to your local service. The sample workspace does not need a key.</p>
    <Button onClick={onWorkspace}>Open workspace settings</Button>
  </section>;
  if (loading) return <p className="credential-loading" role="status">Checking configured providers…</p>;
  if (error) return <div className="credential-empty"><h2>Couldn’t load your connections</h2><p role="alert">{error}</p><Button onClick={() => setRetry(value => value + 1)}>Retry</Button></div>;
  if (!selected) return <div className="credential-empty"><h2>No providers available</h2><p>Refresh your local connection to load supported providers.</p><Button onClick={onWorkspace}>Open workspace settings</Button></div>;
  return <div className="credential-workbench">
    <div className="credential-mobile-picker">
      <label htmlFor="credential-provider-select">Provider connection</label>
      <select id="credential-provider-select" value={selected.id} disabled={pending} onChange={event => setSelectedId(event.target.value)}>
        <optgroup label="Model providers">{providers.filter(p => p.id !== "llama-parse").map(p =>
          <option key={p.id} value={p.id}>{p.label} · {sourceLabel(p)}</option>)}</optgroup>
        <optgroup label="Document parsers">{providers.filter(p => p.id === "llama-parse").map(p =>
          <option key={p.id} value={p.id}>{p.label} · {sourceLabel(p)}</option>)}</optgroup>
      </select>
    </div>
    <nav className="credential-providers" aria-label="API key providers">
      {[{ label: "Model providers", items: providers.filter(p => p.id !== "llama-parse") },
        { label: "Document parsers", items: providers.filter(p => p.id === "llama-parse") }].map(group => group.items.length > 0 &&
        <div className="credential-group" key={group.label}>
          <h2>{group.label}</h2>
          <div className="credential-provider-list">{group.items.map(provider =>
            <button type="button" key={provider.id} className="credential-provider" aria-current={selected.id === provider.id ? "true" : undefined}
              disabled={pending} onClick={() => setSelectedId(provider.id)}>
              <ProviderIcon id={provider.id} /><span className="credential-provider-name">{provider.label}</span>
              <Badge tone={provider.configured ? "green" : "neutral"}>{sourceLabel(provider)}</Badge>
              <ChevronRight size={16} aria-hidden="true" />
            </button>)}</div>
        </div>)}
      <div className="credential-local-note"><ShieldCheck size={16} /><p>Using Ollama locally? You usually don’t need an API key.</p></div>
    </nav>
    <CredentialEditor key={selected.id} provider={selected} onPending={setPending} onDefaults={onDefaults}
      onChange={items => { setProviders(items); onSaved(); }} />
  </div>;
}
