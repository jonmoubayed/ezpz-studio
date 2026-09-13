import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { assertDemoRequest, installDemoNetwork } from '../../src/demo/network.js'
import { build } from 'vite'

// Use the production resolver for the current frontend's TypeScript imports.
const apiBundle = await build({ configFile: false, logLevel: 'silent', build: {
  write: false, minify: false,
  lib: { entry: new URL('../../src/studio-preview/api.ts', import.meta.url).pathname, formats: ['es'] },
} })
const apiCode = apiBundle[0].output.find(file => file.type === 'chunk').code
const { request } = await import(`data:text/javascript;base64,${Buffer.from(apiCode).toString('base64')}`)

const origin = 'https://demo.example'
test('allows bundled assets, range reads, and browser-local files', () => {
  for (const url of ['/studio/samples/invoice-0.pdf', '/studio/vendor/pdfium.wasm', '/assets/worker.js', 'blob:https://demo.example/123']) {
    assert.doesNotThrow(() => assertDemoRequest(url, {headers: {Range: 'bytes=0-100'}}, origin))
  }
})
test('rejects real API, local provider, external, and write requests', () => {
  for (const url of ['/v1/ready', '/v1/documents', 'http://localhost:11434/api/generate', 'https://api.openai.com/v1/responses', '//external.example/assets/file.pdf', '/studio/samples/../../v1/ready', '/assets/%2f../v1/ready', '/assets/not-an-asset', 'blob:https://external.example/123']) {
    assert.throws(() => assertDemoRequest(url, {}, origin), /static demo/)
  }
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.throws(() => assertDemoRequest('/studio/samples/invoice-0.pdf', {method}, origin), /static demo/)
  }
  assert.throws(() => assertDemoRequest(new Request(`${origin}/v1/runs`, {method:'POST'}), {}, origin), /static demo/)
})
test('guard stops fetch and XHR before their underlying transports run', async () => {
  let fetches = 0, opens = 0
  class XHR { open() { opens++ } }
  const target = {location:{origin}, navigator:{}, XMLHttpRequest:XHR, fetch:async () => { fetches++; return 'asset' }}
  installDemoNetwork(target)
  await assert.rejects(target.fetch('/v1/runs', {method:'POST'}), /static demo/)
  assert.throws(() => new target.XMLHttpRequest().open('POST', '/v1/runs'), /static demo/)
  assert.throws(() => new target.WebSocket('wss://example.com'), /disabled/)
  assert.throws(() => new target.EventSource('/v1/events'), /disabled/)
  assert.equal(target.navigator.sendBeacon('/v1/events', 'data'), false)
  assert.equal(fetches, 0)
  assert.equal(opens, 0)
  assert.equal(await target.fetch('/studio/samples/invoice-0.pdf'), 'asset')
  assert.equal(fetches, 1)
})
test('studio API transport always fails closed, even when called directly', async () => {
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => { calls++; throw new Error('should never reach transport') }
  try {
    await assert.rejects(request('/ready'), /static demo/)
    await assert.rejects(request('/runs', {method:'POST'}), /static demo/)
    assert.equal(calls, 0)
  } finally { globalThis.fetch = original }
})
test('both built entry points have the static-demo browser policy', async () => {
  for (const file of ['dist/index.html', 'dist/studio/index.html']) {
    const html = (await readFile(new URL(`../../${file}`, import.meta.url), 'utf8')).replaceAll('&#39;', "'")
    assert.match(html, /Content-Security-Policy/)
    assert.match(html, /connect-src 'self' blob:/)
    assert.match(html, /form-action 'none'/)
  }
})

test('demo build includes the packaged workspace, automatic loop, and harness interfaces', async () => {
  for (const file of ['hill-loop.tsx', 'workspace-switcher.tsx', 'expected-values.tsx', 'harness-editor.tsx']) {
    const source = await readFile(new URL(`../../../src/${file}`, import.meta.url), 'utf8')
    const demo = await readFile(new URL(`../../src/studio-preview/${file}`, import.meta.url), 'utf8')
    assert.equal(demo, source, `${file} must match the shipped Studio frontend`)
  }
  const metadata = JSON.parse(await readFile(new URL('../../dist/studio/build.json', import.meta.url), 'utf8'))
  assert.equal(metadata.source, '..')
  assert.match(metadata.sourceSha256, /^[a-f0-9]{64}$/)
})

test('public demo opens with sample data even when the URL requests live mode', async () => {
  const output = await build({ configFile: false, logLevel: 'silent', build: {
    write: false, minify: false,
    lib: { entry: new URL('./demo-state.tsx', import.meta.url).pathname, formats: ['es'] },
  } })
  const code = output[0].output.find(file => file.type === 'chunk').code
  const savedLocation = globalThis.location
  const savedStorage = globalThis.localStorage
  try {
    globalThis.location = new URL('https://demo.example/studio/?demo=0#Overview')
    globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
    const { initialState } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
    const state = initialState()
    assert.equal(state.mode, 'demo')
    assert.equal(state.connection, 'ready')
    assert.ok(state.documents > 0, 'sample documents must be available without a backend')
    assert.ok(state.datasets > 0, 'sample benchmarks must be available without a backend')
  } finally {
    if (savedLocation === undefined) delete globalThis.location
    else globalThis.location = savedLocation
    if (savedStorage === undefined) delete globalThis.localStorage
    else globalThis.localStorage = savedStorage
  }
})
