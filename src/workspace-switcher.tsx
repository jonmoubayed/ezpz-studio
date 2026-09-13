import { useEffect, useState } from "react";
import { Box, Check, ChevronDown, Pencil, Plus } from "lucide-react";
import { request } from "./api";
import { useStudio } from "./store";
import { Button, Busy, Modal } from "./ui";
import { demoWorkspaces, openWorkspace, saveDemoWorkspace, workspaceId, type Workspace } from "./workspace-context";

export function WorkspaceSwitcher() {
  const s = useStudio();
  const [open, setOpen] = useState(false);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [retry, setRetry] = useState(0);
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState("");
  useEffect(() => {
    const url = new URL(location.href);
    url.searchParams.set("workspace", workspaceId);
    history.replaceState(null, "", url);
  }, []);
  const active = workspaces.find(w => w.id === workspaceId);
  useEffect(() => {
    let cancelled = false;
    setError(""); setLoadError("");
    if (s.mode === "demo") { setWorkspaces(demoWorkspaces()); setLoading(false); return; }
    setLoading(true);
    // Listing is available even if a bookmarked workspace no longer exists.
    request("/workspaces").then(data => {
      if (!cancelled) setWorkspaces(data.workspaces);
    }).catch(e => {
      if (!cancelled) {
        setWorkspaces([]);
        setLoadError(e.message === "Not found"
          ? "The connected Studio service is out of date. Restart Studio with the latest release, then retry."
          : e.message);
      }
    })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [s.mode, s.connection, open, retry]);
  async function save() {
    if (loading || loadError || pending) return;
    setPending(true); setError("");
    try {
      const workspace = s.mode === "demo" ? saveDemoWorkspace(name, editing || undefined) :
        (await request(editing ? `/workspaces/${encodeURIComponent(editing)}` : "/workspaces", {
          method: editing ? "PATCH" : "POST", body: JSON.stringify({ name }),
        })).workspace as Workspace;
      if (!editing) { openWorkspace(workspace.id, s.mode === "demo"); return; }
      setWorkspaces(items => items.map(w => w.id === workspace.id ? workspace : w));
      setEditing(null); setName("");
    } catch (e) { setError(e instanceof Error ? e.message : "Could not save workspace."); }
    finally { setPending(false); }
  }
  return <>
    <button className="workspace-switch" aria-label={`Switch workspace: ${active?.name || "My workspace"}`} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
      <span className="workspace-symbol"><Box size={17} /></span>
      <span><strong>{active?.name || "My workspace"}</strong><small>{s.mode === "demo" ? "Browser demo" : "Local environment"}</small></span>
      <ChevronDown size={14} />
    </button>
    <Modal title="Workspaces" description="Keep documents, processors, and evaluations organized in separate workspaces." open={open} onClose={() => { if (!pending) { setOpen(false); setEditing(null); setName(""); } }}>
      {loading ? <Busy label="Loading workspaces…" /> : <div className="workspace-list">
        {workspaces.map(w => <div className={`workspace-row ${w.id === workspaceId ? "selected" : ""}`} key={w.id}>
          <button className="workspace-choice" disabled={pending || s.busy} aria-current={w.id === workspaceId ? "true" : undefined} onClick={() => w.id === workspaceId ? setOpen(false) : openWorkspace(w.id, s.mode === "demo")}>
            <Box size={18} /><span><strong>{w.name}</strong><small>{w.id === workspaceId ? "Current workspace" : "Open workspace"}</small></span>{w.id === workspaceId && <Check size={17} />}
          </button>
          <button className="icon-button" disabled={pending} aria-label={`Rename ${w.name}`} onClick={() => { setEditing(w.id); setName(w.name); setError(""); }}><Pencil size={15} /></button>
        </div>)}
      </div>}
      {loadError && <div className="workspace-load-error">
        <p role="alert" className="workspace-error">{loadError}</p>
        <Button onClick={() => setRetry(value => value + 1)}>Retry connection</Button>
      </div>}
      <form className="workspace-form" onSubmit={e => { e.preventDefault(); void save(); }}>
        <label htmlFor="workspace-name">{editing ? "Rename workspace" : "Create a workspace"}</label>
        <input id="workspace-name" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Finance documents" maxLength={80} required disabled={pending} />
        {error && <p role="alert" className="workspace-error">{error}</p>}
        <div className="workspace-actions">{editing && <Button disabled={pending} onClick={() => { setEditing(null); setName(""); }}>Cancel</Button>}
          <Button type="submit" variant="primary" disabled={pending || loading || Boolean(loadError) || s.busy || !name.trim()}>{pending ? <Busy label="Saving…" /> : editing ? "Save name" : <><Plus size={15} />Create workspace</>}</Button>
        </div>
      </form>
      {s.mode === "demo" && <p className="workspace-hint">Demo workspaces are saved in this browser. New workspaces start empty.</p>}
    </Modal>
  </>;
}
