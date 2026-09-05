// Preserve the selected public-demo identity when refreshing the studio snapshot.
import { readFile, writeFile } from 'node:fs/promises'
const base = new URL('../src/studio-preview/', import.meta.url)
const mark = (size) => `<img src="/assets/brand/field-mark.png" width={${size}} height={${size}} alt="" />`
for (const [file, before, after] of [
  ['App.tsx', '<Layers size={21} strokeWidth={2.5} />', mark(24)],
  ['pages.tsx', '<Layers size={24} />', mark(28)],
]) {
  const url = new URL(file, base)
  let text = await readFile(url, 'utf8')
  if (!text.includes(before) && !text.includes(after)) throw new Error(`Review branding after studio changes in ${file}`)
  text = text.replace(before, after)
  await writeFile(url, text)
}
const css = new URL('styles.css', base)
let text = await readFile(css, 'utf8')
if (!text.includes('/* Public demo identity */')) text += `
/* Public demo identity */
.brand strong, .brand strong span { color: #365d47; }
.brand-mark img, .banner-icon img { display: block; flex: none; object-fit: contain; }
`
await writeFile(css, text)
