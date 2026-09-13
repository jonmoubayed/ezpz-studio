export type Workspace = { id: string; name: string; created_at: string };
export const defaultWorkspaceId = "ws_local";
const selectionKey = (demo: boolean) => demo ? "ezpz-selected-demo-workspace" : "ezpz-selected-workspace";
// Capture scope once per page: in-flight requests and other tabs keep their scope.
export const workspaceId = (() => {
  if (typeof location === "undefined") return defaultWorkspaceId;
  const query = new URLSearchParams(location.search);
  try {
    return query.get("workspace") || localStorage.getItem(selectionKey(true)) || defaultWorkspaceId;
  } catch { return query.get("workspace") || defaultWorkspaceId; }
})();
export function workspaceUrl(path: string) {
  return `${path}${path.includes("?") ? "&" : "?"}workspace_id=${encodeURIComponent(workspaceId)}`;
}
export function storageKey(key: string) {
  return workspaceId === defaultWorkspaceId ? key : `ezpz-workspace:${workspaceId}:${key}`;
}
export const workspaceStorage = {
  getItem: (key: string) => localStorage.getItem(storageKey(key)),
  setItem: (key: string, value: string) => localStorage.setItem(storageKey(key), value),
  removeItem: (key: string) => localStorage.removeItem(storageKey(key)),
};
export function openWorkspace(id: string, demo: boolean) {
  const url = new URL(location.href);
  url.searchParams.set("workspace", id);
  if (demo) url.searchParams.set("demo", "1");
  else url.searchParams.delete("demo");
  url.hash = "Overview";
  try { localStorage.setItem(selectionKey(demo), id); } catch { /* URL retains selection. */ }
  location.assign(url.href);
}
const demoKey = "ezpz-demo-workspaces";
export function demoWorkspaces(): Workspace[] {
  try {
    const saved = JSON.parse(localStorage.getItem(demoKey) || "[]");
    if (Array.isArray(saved) && saved.some(w => w.id === defaultWorkspaceId)) return saved;
  } catch { /* Start with the existing demo. */ }
  return [{ id: defaultWorkspaceId, name: "My workspace", created_at: "" }];
}
export function saveDemoWorkspace(name: string, id?: string): Workspace {
  const workspaces = demoWorkspaces();
  name = name.trim();
  if (!name || name.length > 80) throw new Error("Enter a workspace name between 1 and 80 characters.");
  if (workspaces.some(w => w.id !== id && w.name.toLowerCase() === name.toLowerCase()))
    throw new Error("A workspace with this name already exists.");
  const workspace = { id: id || `demo_${crypto.randomUUID()}`, name, created_at: new Date().toISOString() };
  localStorage.setItem(demoKey, JSON.stringify(id ? workspaces.map(w => w.id === id ? { ...w, name } : w) : [...workspaces, workspace]));
  return workspace;
}
