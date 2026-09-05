import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const target = path.join(root, 'src/studio-preview')
async function update(file, adapt) {
  const full = path.join(target, file)
  await writeFile(full, adapt(await readFile(full, 'utf8')))
}
await update('api.ts', text => {
  const start = text.indexOf('export async function request(')
  const end = text.indexOf('\nconst post =', start)
  if (start < 0 || end < 0) throw new Error('API source changed; review demo isolation before syncing.')
  return text.slice(0, start) + `// Deliberately no network transport in the public studio snapshot.
export async function request(_path: string, _options: RequestInit = {}): Promise<any> {
  throw new Error("This is a static demo. API and provider calls are disabled.");
}
` + text.slice(end)
})
await update('store.tsx', text => {
  if (!text.includes('async function connect()') || !text.includes('function demo()')) throw new Error('Store source changed; review demo isolation before syncing.')
  text = text.replace('const [mode, setMode] = useState<"demo" | "live">("demo");', 'const [mode] = useState<"demo" | "live">("demo");')
  text = text.slice(0, text.indexOf('  async function connect()')) + `  async function connect() {
    setMessage("This demo cannot connect to an API. All results use sample data.");
  }
` + text.slice(text.indexOf('  function demo()'))
  text = text.replace('    setMode("demo");\n', '')
  if (text.includes('setMode(')) throw new Error('An unexpected mode switch remains in the demo.')
  return text.replaceAll('Files opened locally for this session. Connect the local API to extract your own documents.', 'Files opened in this browser only. Extraction is available for sample documents in this demo.')
    .replaceAll('Your file is ready to preview. Connect the local API in Settings to run a real extraction.', 'Your file stays in this browser. Choose a sample document to try the simulated extraction.')
    .replaceAll('Demo run added using a fixed illustrative score. Connect the API to measure real changes.', 'Demo run added using a fixed illustrative score. No API or model was called.')
})
await update('pages.tsx', text => {
  text = text.replace(/Demo runs use a fixed sample score\. Switch to the local API for\s+measured results\./g, "Demo runs use fixed sample scores. No API or model calls are made.").replaceAll("Demo mode uses fixed fixture scores. Switch to the local API to measure this hypothesis.", "Demo mode uses fixed sample scores. No API or model is called.")
  const start = text.indexOf('        <section className="panel settings-connection">')
  const end = text.indexOf('\n        <section className="panel">', start)
  if (start < 0 || end < 0) throw new Error('Settings source changed; review demo isolation before syncing.')
  return text.slice(0, start) + `        <section className="panel settings-connection">
          <PanelTitle title="Demo workspace" description="Explore the studio with sample documents." />
          <div className="connection-row"><span>Current workspace</span><Badge tone="green">Static demo</Badge></div>
          <p>Extractions and evaluation scores are simulated. This site does not connect to a backend or call model providers.</p>
          <div className="settings-buttons"><Button onClick={s.resetDemo}>Reset demo</Button></div>
          <div className="privacy-note"><ShieldCheck size={18} /><p>Files you open stay in this browser. Configuration changes are saved only in local browser storage.</p></div>
        </section>` + text.slice(end)
})
await update('App.tsx', text => text.replace('Preview files locally. Connect your API to extract and persist them.', 'Preview files in this browser. Sample documents have simulated extraction results.'))
await update('configuration.tsx', text => text.replace(/Illustrative invoice fixture; no model was called\. Connect the local\s+API[^<]*/g, 'Illustrative invoice fixture; no model was called. This demo uses sample results.'))
await update('main.tsx', text => text.includes('../demo/install-network') ? text : 'import "../demo/install-network";\n' + text)
console.log('Studio snapshot locked to browser-only demo mode.')
