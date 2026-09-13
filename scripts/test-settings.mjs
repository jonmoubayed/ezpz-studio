import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { mkdtemp, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const temp = await mkdtemp(path.join(root, '.settings-test-'));
const dom = new JSDOM('<div id="root"></div>', { url: 'http://settings.test/?workspace=ws_test' });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, location: dom.window.location,
  localStorage: dom.window.localStorage, HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
});
try {
  const outfile = path.join(temp, 'settings.mjs');
  await build({ entryPoints: [path.join(root, 'tests/credential-settings.unit.tsx')], outfile,
    bundle: true, platform: 'node', format: 'esm', packages: 'external',
    loader: { '.css': 'empty' }, define: { 'import.meta.env.BASE_URL': '"/"' },
    tsconfig: path.join(root, 'tsconfig.json'), logLevel: 'silent' });
  await import(pathToFileURL(outfile).href);
} finally {
  dom.window.close();
  await rm(temp, { recursive: true, force: true });
}
