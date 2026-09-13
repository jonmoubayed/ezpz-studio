import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { CredentialSettings } from '../src/credential-settings';
// Mocked requests only: no keys or writes touch a user's workspace.
let providers = [
  { id: 'openai', label: 'OpenAI', configured: false, source: 'none' },
  { id: 'anthropic', label: 'Anthropic', configured: true, source: 'environment' },
  { id: 'llama-parse', label: 'LlamaParse', configured: false, source: 'none' },
];
let getFails = false, saveFails = false;
let release: (() => void) | undefined;
let saved = 0, defaults = 0, workspace = 0;
const calls: { url: string; init: RequestInit }[] = [];
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
  calls.push({ url, init });
  assert.ok(url.includes('workspace_id=ws_test'), 'requests retain workspace scope');
  if (!init.method) return getFails ? response({ error: 'Local service unavailable' }, 503) : response({ providers });
  assert.equal((init.headers as Record<string, string>)['X-Ezpz-Settings'], '1');
  if (saveFails) return response({ error: 'Key rejected for this test' }, 400);
  await new Promise<void>(resolve => { release = resolve; });
  const id = url.split('?')[0].split('/').pop();
  providers = providers.map(p => p.id === id ? { ...p,
    configured: init.method === 'POST' || p.id === 'anthropic',
    source: init.method === 'POST' ? 'workspace' : p.id === 'anthropic' ? 'environment' : 'none' } : p);
  return response({ providers });
}) as typeof fetch;
const root = createRoot(document.getElementById('root')!);
const mount = async (live = true) => act(async () => root.render(<CredentialSettings live={live}
  onSaved={() => saved++} onDefaults={() => defaults++} onWorkspace={() => workspace++} />));
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.includes(text))!;
const input = () => document.querySelector<HTMLInputElement>('input[type=password]')!;
const click = async (text: string) => act(async () => button(text).click());
const fill = async (value: string) => act(async () => {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input(), value);
  input().dispatchEvent(new window.Event('input', { bubbles: true }));
});
const submit = async () => act(async () => {
  document.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
});
const finish = async () => act(async () => { release!(); });
await mount();
assert.equal(input().getAttribute('aria-label'), 'OpenAI API key');
assert.equal(button('Save key').disabled, true);
await fill('mock-unsaved-key');
assert.equal(button('Save key').disabled, false);
await click('Anthropic');
assert.equal(input().value, '', 'unsaved keys never follow provider selection');
assert.match(document.body.textContent!, /Set in your shell or .env/);
assert.equal(button('Remove saved key'), undefined);
await fill('mock-replacement-key'); await submit();
assert.equal(button('OpenAI').disabled, true);
assert.equal((document.querySelector('select') as HTMLSelectElement).disabled, true);
assert.ok(calls.at(-1)!.url.includes('/anthropic?'));
assert.deepEqual(JSON.parse(calls.at(-1)!.init.body as string), { api_key: 'mock-replacement-key' });
await finish();
assert.equal(saved, 1); assert.equal(input().value, '');
assert.match(button('Anthropic').textContent!, /Saved locally/);
assert.match(document.body.textContent!, /Key saved locally/);
await click('Remove saved key'); assert.ok(button('Removing…').disabled); await finish();
assert.equal(saved, 2);
assert.match(button('Anthropic').textContent!, /From environment/);
assert.match(document.body.textContent!, /Using the environment key/);
await click('OpenAI'); saveFails = true;
await fill('mock-failed-key'); await submit();
assert.equal(document.querySelector('[role=alert]')?.textContent, 'Key rejected for this test');
assert.equal(input().value, 'mock-failed-key');
await click('LlamaParse');
assert.equal(document.querySelector('[role=alert]'), null);
assert.equal(input().value, '');
assert.match(document.body.textContent!, /parse your documents with LlamaParse/);
await click('Go to extraction defaults'); assert.equal(defaults, 1);
await mount(false); assert.equal(input(), null);
await click('Open workspace settings'); assert.equal(workspace, 1);
getFails = true; await mount(true);
assert.match(document.querySelector('[role=alert]')!.textContent!, /Local service unavailable/);
getFails = false; await click('Retry'); assert.ok(input());
await act(async () => root.unmount());
console.log('PASS: scoped requests, provider isolation, pending state, save/remove, environment fallback, error recovery, retry and demo navigation.');
