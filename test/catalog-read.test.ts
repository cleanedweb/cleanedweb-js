import { describe, expect, it } from 'vitest';
import { ConfigurationError, CleanedWeb, NotFoundError, ValidationError } from '../src/index.js';
import { API_ID, ENDPOINT_ID, json, setup } from './helpers.js';

const LIVE = 'https://app.cleanedweb.com';
const SITE = 'https://cleanedweb.com';

const api = (id: string, name: string, domain: string, extra: Record<string, unknown> = {}) => ({
  api_id: id,
  name,
  short_description: `${name} records`,
  category: 'commerce',
  record_types: [],
  countries: [],
  languages: [],
  tags: [],
  limitations: [],
  site: { name, domain },
  endpoints: [{ endpoint_id: `${id}_search`, name: 'Extract records', status: 'available' }],
  ...extra,
});

const index = {
  count: 3,
  apis: [
    { name: 'GitHub Topics Repositories API', api_id: API_ID, slug: 'github-topics-repositories-api', url: `${SITE}/catalog/github-topics-repositories-api/`, contract: `${SITE}/catalog/github-topics-repositories-api/contract.json`, key_fields: ['title', 'url', 'stargazer_count'] },
    { name: 'Worten', api_id: 'generated_w', slug: 'worten-laptops-api', url: `${SITE}/catalog/worten-laptops-api/`, key_fields: ['title', 'price', 'url'] },
  ],
};

const liveList = [
  api(API_ID, 'GitHub Topics Repositories', 'github.com'),
  api('generated_w', 'Worten Computadores Portateis', 'www.worten.pt'),
  api('generated_x', 'Other', 'shop.example.com'),
];

/** Answers by URL, whatever the order of the requests. */
const router = (routes: { index?: () => Response; list?: () => Response }) => (call: { url: string }) => {
  if (call.url.startsWith(`${SITE}/catalog/index.json`)) return (routes.index ?? (() => json(200, index)))();
  if (call.url.startsWith(`${LIVE}/api/catalog/apis?`)) return (routes.list ?? (() => json(200, { items: liveList })))();
  throw new Error(`unexpected ${call.url}`);
};

describe('catalog reads', () => {
  it('list sends only the documented query parameters, anonymously (no API key)', async () => {
    const { cw, calls } = setup([() => json(200, { items: liveList })]);
    const page = await cw.catalog.list({ limit: 20, offset: 40, q: 'shoes', category: 'commerce', sort: 'name' });
    expect(calls[0]!.url).toBe(`${LIVE}/api/catalog/apis?limit=20&offset=40&q=shoes&category=commerce&sort=name`);
    expect(calls[0]!.headers.authorization).toBeUndefined();
    expect(page.items).toHaveLength(3);
    expect(page.nextOffset).toBeNull();
  });

  it('list works without any API key and reports the next offset when the page is full', async () => {
    const { cw } = setup([() => json(200, { items: [api('a', 'A', 'a.com'), api('b', 'B', 'b.com')] })], { apiKey: undefined });
    const page = await cw.catalog.list({ limit: 2, offset: 4 });
    expect(page.nextOffset).toBe(6);
  });

  it('list rejects a limit outside 1-100 before sending', async () => {
    const { cw, calls } = setup([]);
    await expect(cw.catalog.list({ limit: 101 })).rejects.toThrow(RangeError);
    expect(calls).toHaveLength(0);
  });

  it('list maps invalid_catalog_query to ValidationError', async () => {
    const { cw } = setup([() => json(422, { detail: { code: 'invalid_catalog_query', message: 'invalid catalog query' } })], { maxRetries: 0 });
    await expect(cw.catalog.list({ sort: 'name' })).rejects.toBeInstanceOf(ValidationError);
  });

  it('iterate pages with limit 100 until a short page', async () => {
    const full = Array.from({ length: 100 }, (_, i) => api(`id${i}`, `N${i}`, `d${i}.com`));
    const { cw, calls } = setup([() => json(200, { items: full }), () => json(200, { items: [api('last', 'L', 'l.com')] })]);
    const seen: string[] = [];
    for await (const item of cw.catalog.iterate({ q: 'x' })) seen.push(item.api_id);
    expect(seen).toHaveLength(101);
    expect(calls.map((c) => c.url)).toEqual([
      `${LIVE}/api/catalog/apis?limit=100&offset=0&q=x`,
      `${LIVE}/api/catalog/apis?limit=100&offset=100&q=x`,
    ]);
  });

  it('get reads one API by api_id', async () => {
    const { cw, calls } = setup([() => json(200, api(API_ID, 'GitHub', 'github.com'))]);
    const result = await cw.catalog.get(API_ID);
    expect(result.api_id).toBe(API_ID);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${LIVE}/api/catalog/apis/${API_ID}`);
  });

  it('get resolves a slug through the catalog index', async () => {
    const { cw, calls } = setup([() => json(200, index), () => json(200, api(API_ID, 'GitHub', 'github.com'))]);
    const result = await cw.catalog.get('github-topics-repositories-api');
    expect(result.api_id).toBe(API_ID);
    expect(calls.map((c) => c.url)).toEqual([`${SITE}/catalog/index.json`, `${LIVE}/api/catalog/apis/${API_ID}`]);
  });

  it('get falls through to the live route for an unknown slug, which is a NotFoundError', async () => {
    const { cw } = setup([() => json(200, index), () => json(404, { detail: { code: 'catalog_not_found', message: 'nope' } })], { maxRetries: 0 });
    await expect(cw.catalog.get('no-such-api')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('contract reads the live contract and can pin a major', async () => {
    const { cw, calls } = setup([() => json(200, { endpoint_id: ENDPOINT_ID, definition_version: 'd'.repeat(64), method: 'POST', path: '/x', input_schema: {}, output_schema: {} })]);
    const contract = await cw.catalog.contract(API_ID, ENDPOINT_ID, { version: 1 });
    expect(contract.definition_version).toBe('d'.repeat(64));
    expect(calls[0]!.url).toBe(`${LIVE}/api/catalog/apis/${API_ID}/endpoints/${ENDPOINT_ID}/contract?version=1`);
  });

  it('find filters by site on the client: domains, subdomains, URLs and names', async () => {
    const mk = () => setup(router({}));
    expect((await mk().cw.catalog.find({ site: 'github.com' })).map((m) => m.api_id)).toEqual([API_ID]);
    expect((await mk().cw.catalog.find({ site: 'https://www.worten.pt/laptops' })).map((m) => m.api_id)).toEqual(['generated_w']);
    expect((await mk().cw.catalog.find({ site: 'example.com' })).map((m) => m.api_id)).toEqual(['generated_x']);
    expect((await mk().cw.catalog.find({ site: 'worten' })).map((m) => m.api_id)).toEqual(['generated_w']);
    expect(await mk().cw.catalog.find({ site: 'nothing.example.org' })).toEqual([]);
  });

  it('find filters by fields against the index key_fields and joins the listing details', async () => {
    const { cw, calls } = setup(router({}));
    const matches = await cw.catalog.find({ fields: ['Title', 'price'] });
    expect(matches.map((m) => m.api_id)).toEqual(['generated_w']);
    expect(matches[0]).toMatchObject({ slug: 'worten-laptops-api', keyFields: ['title', 'price', 'url'] });
    expect(calls.map((c) => c.url).sort()).toEqual([`${LIVE}/api/catalog/apis?limit=100&offset=0`, `${SITE}/catalog/index.json`].sort());
    expect(calls.every((c) => c.headers.authorization === undefined)).toBe(true);
  });

  it('find combines site and fields', async () => {
    const { cw } = setup(router({}));
    const matches = await cw.catalog.find({ site: 'github.com', fields: ['stargazer_count'] });
    expect(matches.map((m) => m.api_id)).toEqual([API_ID]);
    expect(matches[0]!.pageUrl).toContain('github-topics-repositories-api');
  });

  it('find by site alone still works when the index cannot be read', async () => {
    const { cw } = setup(router({ index: () => json(503, { detail: 'down' }) }), { maxRetries: 0 });
    const matches = await cw.catalog.find({ site: 'github.com' });
    expect(matches.map((m) => m.api_id)).toEqual([API_ID]);
    expect(matches[0]!.slug).toBeUndefined();
  });

  it('find with fields fails when the index cannot be read', async () => {
    const { cw } = setup(router({ index: () => json(503, { detail: 'down' }) }), { maxRetries: 0 });
    await expect(cw.catalog.find({ fields: ['title'] })).rejects.toMatchObject({ status: 503 });
  });
});

describe('client configuration', () => {
  it('reads CLEANEDWEB_API_KEY by default and sends it as a bearer token', async () => {
    const previous = process.env.CLEANEDWEB_API_KEY;
    process.env.CLEANEDWEB_API_KEY = 'env_key_123';
    try {
      const seen: string[] = [];
      const cw = new CleanedWeb({
        fetch: async (_url, init) => {
          seen.push(new Headers(init?.headers).get('authorization') ?? '');
          return json(200, { run_id: 'r', status: 'finished' });
        },
      });
      await cw.runs.get('r');
      expect(seen).toEqual(['Bearer env_key_123']);
    } finally {
      if (previous === undefined) delete process.env.CLEANEDWEB_API_KEY;
      else process.env.CLEANEDWEB_API_KEY = previous;
    }
  });

  it('an explicit apiKey: undefined does not fall back to the environment', async () => {
    const previous = process.env.CLEANEDWEB_API_KEY;
    process.env.CLEANEDWEB_API_KEY = 'env_key_123';
    try {
      const cw = new CleanedWeb({ apiKey: undefined, fetch: async () => json(200, {}) });
      await expect(cw.runs.get('r')).rejects.toBeInstanceOf(ConfigurationError);
    } finally {
      if (previous === undefined) delete process.env.CLEANEDWEB_API_KEY;
      else process.env.CLEANEDWEB_API_KEY = previous;
    }
  });

  it('rejects a non-https run origin so the key is not sent in clear text', () => {
    expect(() => new CleanedWeb({ apiKey: 'k', baseUrl: 'http://broker.example.com' })).toThrow(ConfigurationError);
    expect(() => new CleanedWeb({ apiKey: 'k', baseUrl: 'not a url' })).toThrow(ConfigurationError);
    expect(() => new CleanedWeb({ apiKey: 'k', baseUrl: 'http://localhost:8080' })).not.toThrow();
  });
});
