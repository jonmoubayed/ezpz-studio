import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { assertDemoRequest, installDemoNetwork } from '../../src/demo/network.js'
import { request } from '../../src/studio-preview/api.ts'

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
