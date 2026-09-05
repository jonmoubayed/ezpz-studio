// Sync the actual redesign without modifying its independent working repository.
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = path.resolve(process.argv[2] || path.join(root, '..'))
const target = path.join(root, 'src/studio-preview')
await mkdir(target, { recursive: true })
await cp(path.join(source, 'src'), target, { recursive: true })
async function adapt(directory) {
  for (const file of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, file.name)
    if (file.isDirectory()) { await adapt(full); continue }
    if (!/\.(tsx?|css)$/.test(file.name)) continue
    let text = await readFile(full, 'utf8')
    text = text.replace(/(["'])@\/([^"']+)\1/g, (_, quote, imported) => {
      let relative = path.relative(directory, path.join(target, imported)).split(path.sep).join('/')
      if (!relative.startsWith('.')) relative = './' + relative
      return quote + relative + quote
    }).replace(/(["'`])\/(samples|vendor)\//g, '$1/studio/$2/')
    // Keep the embedded demo separate from data saved in the standalone redesign.
    text = text.replaceAll('ezpz-redesign-', 'ezpz-landing-demo-')
    await writeFile(full, text)
  }
}
await adapt(target)
// Reapply the mandatory demo boundary after every source refresh.
await import('./harden-studio-demo.mjs')
await import('./apply-studio-brand.mjs')
await cp(path.join(source, 'public'), path.join(root, 'public/studio'), { recursive: true })
await mkdir(path.join(root, 'licenses/studio-preview'), { recursive: true })
await cp(path.join(source, 'licenses'), path.join(root, 'licenses/studio-preview'), { recursive: true })
await cp(path.join(source, 'EXTEND-LICENSE.md'), path.join(root, 'licenses/studio-preview/EXTEND-LICENSE.md'))
await writeFile(path.join(target, 'SOURCE.md'), `# Studio preview source\n\nSnapshot of the green ezpz-studio-redesign frontend. Re-sync with \`node scripts/sync-studio-preview.mjs [source-directory]\`.\n\nImport aliases, asset paths, storage keys, API transport, and live-mode controls are adapted. The public snapshot is always a static demo; hardening is reapplied on every sync. The page is rendered in its own iframe so the actual redesign components, fonts, and styles stay isolated from the landing page and legacy app. Third-party notices are retained in \`licenses/studio-preview\`.\n`)
console.log('Synced the green studio frontend and its local assets.')
