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
// cleanedweb/ai-sdk needs the `ai` package, which (AI SDK 7) needs Node 22 or later.
if (Number(process.versions.node.split('.')[0]) >= 22) {
  const aiEsm = await import(pathToFileURL(resolve(root, 'dist/ai-sdk.js')).href);
  const aiCjs = createRequire(import.meta.url)(resolve(root, 'dist/ai-sdk.cjs'));
  for (const [label, mod] of [['esm', aiEsm], ['cjs', aiCjs]]) {
    const tools = mod.cleanedwebTools({ apiKey: 'test' });
    for (const name of ['findApi', 'getApi', 'runApi']) {
      if (typeof mod[name] !== 'function') throw new Error(`${label} ai-sdk: missing export ${name}`);
      if (typeof tools[name]?.execute !== 'function') throw new Error(`${label} ai-sdk: ${name} is not a tool`);
    }
  }
}
console.log('dist ok: esm and cjs export the public API');
