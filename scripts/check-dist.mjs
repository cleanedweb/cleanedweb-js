// Loads the built package through both module systems and checks the public surface.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const expected = ['CleanedWeb', 'APIError', 'RateLimitError', 'InsufficientCreditError', 'isAccepted', 'assertAccepted'];

const esm = await import(pathToFileURL(resolve(root, 'dist/index.js')).href);
const cjs = createRequire(import.meta.url)(resolve(root, 'dist/index.cjs'));

for (const [label, mod] of [['esm', esm], ['cjs', cjs]]) {
  for (const name of expected) {
    if (typeof mod[name] !== 'function') throw new Error(`${label}: missing export ${name}`);
  }
  const client = new mod.CleanedWeb({ apiKey: 'test' });
  for (const part of ['catalog', 'runs', 'sources']) {
    if (typeof client[part] !== 'object') throw new Error(`${label}: client.${part} missing`);
  }
}
console.log('dist ok: esm and cjs export the public API');
