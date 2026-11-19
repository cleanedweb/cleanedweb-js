/**
 * Live smoke test. Skipped unless CLEANEDWEB_LIVE=1 (npm run test:live).
 * It reads ONLY the anonymous catalog endpoints: no API key is used and nothing is ever run or charged.
 */
import { describe, expect, it } from 'vitest';
import { CleanedWeb } from '../src/index.js';

describe.skipIf(process.env.CLEANEDWEB_LIVE !== '1')('live catalog reads (no key, no runs)', () => {
  const cw = new CleanedWeb({ apiKey: undefined });

  it('lists published APIs', async () => {
    const page = await cw.catalog.list({ limit: 5 });
    expect(page.items.length).toBeGreaterThan(0);
    const first = page.items[0]!;
    expect(first.api_id).toBeTruthy();
    expect(first.endpoints.length).toBeGreaterThan(0);
  });

  it('reads one API and its contract', async () => {
    const [first] = (await cw.catalog.list({ limit: 1 })).items;
    const api = await cw.catalog.get(first!.api_id);
    expect(api.api_id).toBe(first!.api_id);
    const endpoint = api.endpoints[0]!;
    const contract = await cw.catalog.contract(api.api_id, endpoint.endpoint_id);
    expect(contract.method).toBe('POST');
    expect(contract.path).toContain('/run');
    expect(contract.definition_version).toMatch(/^[0-9a-f]{64}$/);
  });

  it('reads the catalog index and resolves a slug', async () => {
    const index = await cw.catalog.index();
    expect(index.apis.length).toBeGreaterThan(0);
    const entry = index.apis[0]!;
    const api = await cw.catalog.get(entry.slug);
    expect(api.api_id).toBe(entry.api_id);
  });

  it('finds APIs by site', async () => {
    const index = await cw.catalog.index();
    const domain = index.apis.find((a) => a.source?.domain)?.source?.domain;
    expect(domain).toBeTruthy();
    const matches = await cw.catalog.find({ site: domain! });
    expect(matches.length).toBeGreaterThan(0);
  });
});
