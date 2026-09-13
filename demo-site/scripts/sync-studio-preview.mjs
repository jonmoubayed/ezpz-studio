// Build the public demo from the same frontend shipped in the Python package.
import { cp, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = path.resolve(process.argv[2] || path.join(root, '..'))
const target = path.join(root, 'src/studio-preview')
const sourceHash = createHash('sha256')
async function hashSource(directory, prefix = '') {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (/ \d+(?:\.|$)/.test(entry.name)) continue
    const relative = prefix + entry.name
    if (entry.isDirectory()) await hashSource(path.join(directory, entry.name), relative + '/')
    else sourceHash.update(relative + '\0').update(await readFile(path.join(directory, entry.name))).update('\0')
  }
}
await hashSource(path.join(source, 'src'))
sourceHash.update(await readFile(path.join(source, 'package.json')))
if (source === root || source.startsWith(target)) throw new Error('Sync source must be an independent frontend directory.')
// This directory is generated; remove obsolete modules from earlier snapshots.
await rm(target, { recursive: true, force: true })
await mkdir(target, { recursive: true })
await cp(path.join(source, 'src'), target, { recursive: true, filter: file => !/ \d+(?:\.|$)/.test(path.basename(file)) })
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
      .replaceAll('${import.meta.env.BASE_URL}assets/', '/studio/assets/')
      .replaceAll('from "../package.json"', 'from "./studio-package.json"')
    // Keep the embedded demo separate from data saved in the standalone redesign.
    text = text.replaceAll('ezpz-redesign-', 'ezpz-landing-demo-')
    await writeFile(full, text)
  }
}
await adapt(target)
const { version: studioVersion } = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'))
await writeFile(path.join(target, 'studio-package.json'), JSON.stringify({ version: studioVersion }) + '\n')
// Reapply the mandatory demo boundary after every source refresh.
await import('./harden-studio-demo.mjs')
await import('./apply-studio-brand.mjs')
await cp(path.join(source, 'public'), path.join(root, 'public/studio'), { recursive: true })
await mkdir(path.join(root, 'licenses/studio-preview'), { recursive: true })
await cp(path.join(source, 'licenses'), path.join(root, 'licenses/studio-preview'), { recursive: true })
await cp(path.join(source, 'EXTEND-LICENSE.md'), path.join(root, 'licenses/studio-preview/EXTEND-LICENSE.md'))
const version = (await readFile(path.join(source, 'pyproject.toml'), 'utf8')).match(/^version = "([^"]+)"/m)?.[1]
await writeFile(path.join(root, 'public/studio/build.json'), JSON.stringify({ version, source: path.relative(root, source), sourceSha256: sourceHash.digest('hex') }, null, 2) + '\n')
await writeFile(path.join(target, 'SOURCE.md'), `# Studio preview source\n\nGenerated from \`${path.relative(root, source)}/src\`, the frontend shipped in Studio ${version}. Every \`pnpm build\` and \`pnpm dev\` refreshes this snapshot. Edit the packaged frontend for interface changes; edit the hardening script for public-demo adaptations.\n\nImport aliases, asset paths, storage keys, API transport, and live-mode controls are adapted. The public snapshot is always a static demo. Its source fingerprint is published at \`/studio/build.json\`. Third-party notices are retained in \`licenses/studio-preview\`.\n`)
console.log(`Synced packaged Studio ${version} and its local assets.`)
