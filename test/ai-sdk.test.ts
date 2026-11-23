import { generateText, isStepCount } from 'ai';
import type { ToolSet } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { cleanedwebTools, findApi, getApi, runApi } from '../src/ai-sdk.js';
import { API_ID, ENDPOINT_ID, RUN_ROOT, finishedBody, json, setup } from './helpers.js';
import type { RecordedCall } from './helpers.js';

const CATALOG = 'https://app.cleanedweb.com/api/catalog/apis';

const api = {
  api_id: API_ID,
  name: 'GitHub Topic Repositories',
  short_description: 'Public GitHub repositories listed under a topic.',
  category: 'uncategorized',
  record_types: [],
  countries: [],
  languages: [],
  tags: [],
  limitations: [],
  health: 'healthy',
  site: { name: 'GitHub', domain: 'github.com' },
  endpoints: [{ endpoint_id: ENDPOINT_ID, name: 'List GitHub Topic Repositories', status: 'available' }],
};

const other = {
  ...api,
  api_id: 'generated_000000000000000000000001',
  name: 'Tori.fi listings',
  short_description: 'Classified ads from tori.fi.',
  site: { name: 'Tori', domain: 'tori.fi' },
  endpoints: [{ endpoint_id: 'generated_000000000000000000000001_search', name: 'Search', status: 'available' }],
};

const index = {
  apis: [
    {
      api_id: API_ID,
      slug: 'github-topics-repositories-api',
      url: 'https://cleanedweb.com/catalog/github-topics-repositories-api/',
      key_fields: ['title', 'url', 'stars'],
    },
  ],
};

const contract = {
  endpoint_id: ENDPOINT_ID,
  definition_version: 'v'.repeat(64),
  method: 'POST',
  path: `/v1/catalog/public/apis/${API_ID}/endpoints/${ENDPOINT_ID}/run`,
  operation_type: 'list',
  input_schema: { type: 'object' },
  output_schema: {
    type: 'object',
    required: ['title', 'url'],
    properties: { title: { type: 'string' }, url: { type: 'string' }, stars: { type: 'integer' } },
  },
  parameters: [
    {
      name: 'topics',
      type: 'string',
      required: false,
      description: 'A GitHub topic.',
      examples: Array.from({ length: 40 }, (_, i) => `topic-${i}`),
    },
  ],
  examples: [
    {
      kind: 'saved_validation_records',
      records: [
        { title: 'a', url: 'https://github.com/a/a', readme: 'x'.repeat(2000) },
        { title: 'b', url: 'https://github.com/b/b' },
        { title: 'c', url: 'https://github.com/c/c' },
        { title: 'd', url: 'https://github.com/d/d' },
      ],
    },
  ],
};

/** Answers the catalog, contract and run routes like the live service. */
function service(call: RecordedCall): Response {
  const url = new URL(call.url);
  if (call.url.startsWith(`${CATALOG}/${API_ID}/endpoints/`)) return json(200, contract);
  if (call.url.startsWith(`${CATALOG}/${API_ID}`)) return json(200, api);
  if (call.url.startsWith(CATALOG)) {
    return json(200, { items: url.searchParams.get('offset') === '0' ? [api, other] : [] });
  }
  if (url.pathname === '/catalog/index.json') return json(200, index);
  if (call.url === `${RUN_ROOT}/run`) {
    return json(200, finishedBody([{ title: 'scrapy', url: 'https://github.com/scrapy/scrapy', stars: 55000 }]));
  }
  throw new Error(`unexpected ${call.method} ${call.url}`);
}

const opts = { toolCallId: 'call-1', messages: [], context: {} };

// AI SDK 7 needs Node 22 or later; the core SDK's Node 18 and 20 runs skip these.
const nodeMajor = Number(process.versions.node.split('.')[0]);

describe.skipIf(nodeMajor < 22)('cleanedweb/ai-sdk', () => {
  it('findApi filters by site and returns compact matches without an API key', async () => {
    const { cw, calls } = setup(service);
    const result = await findApi({ client: cw }).execute!({ site: 'github.com' }, opts);
    expect(result).toEqual({
      total: 1,
      apis: [
        {
          apiId: API_ID,
          slug: 'github-topics-repositories-api',
          name: 'GitHub Topic Repositories',
          description: 'Public GitHub repositories listed under a topic.',
          site: 'github.com',
          category: 'uncategorized',
          health: 'healthy',
          keyFields: ['title', 'url', 'stars'],
          pageUrl: 'https://cleanedweb.com/catalog/github-topics-repositories-api/',
          endpoints: [{ endpointId: ENDPOINT_ID, name: 'List GitHub Topic Repositories' }],
        },
      ],
    });
    expect(calls.every((c) => c.headers.authorization === undefined)).toBe(true);
  });

  it('findApi lists `limit` matches and reports the total', async () => {
    const { cw } = setup(service);
    const result = await findApi({ client: cw }).execute!({ limit: 1 }, opts);
    expect(result).toMatchObject({ total: 2, apis: [{ apiId: API_ID }] });
  });

  it('findApi ranks by words and fields instead of dropping APIs that lack a field', async () => {
    const { cw, calls } = setup(service);
    const result = await findApi({ client: cw }).execute!(
      { query: 'github repositories web-scraping', fields: ['name', 'url'] },
      opts,
    );
    expect(result).toMatchObject({
      total: 1,
      apis: [{ apiId: API_ID, fieldsMatched: ['url'], fieldsMissing: ['name'] }],
    });
    expect(calls.some((c) => new URL(c.url).searchParams.has('q'))).toBe(false);
  });

  it('findApi says what to try when no API matches the words', async () => {
    const { cw } = setup(service);
    const result = await findApi({ client: cw }).execute!({ query: 'airline fares' }, opts);
    expect(result).toMatchObject({ total: 0, apis: [], note: expect.stringMatching(/fewer or broader words/) });
  });

  it('getApi returns inputs, output fields and shortened sample records', async () => {
    const { cw } = setup(service);
    const result = await getApi({ client: cw }).execute!({ apiId: API_ID }, opts);
    if (Symbol.asyncIterator in result) throw new Error('expected a plain result');
    const endpoint = result.endpoints[0]!;
    expect(endpoint.inputs).toEqual([
      {
        name: 'topics',
        type: 'string',
        required: false,
        description: 'A GitHub topic.',
        examples: Array.from({ length: 10 }, (_, i) => `topic-${i}`),
      },
    ]);
    expect(endpoint.outputFields).toEqual([
      { name: 'title', type: 'string', required: true },
      { name: 'url', type: 'string', required: true },
      { name: 'stars', type: 'integer', required: false },
    ]);
    expect(endpoint.sampleRecords).toHaveLength(3);
    expect(String(endpoint.sampleRecords[0]!.readme)).toHaveLength(301);
  });

  it('getApi refuses an endpoint the API does not have', async () => {
    const { cw } = setup(service);
    await expect(getApi({ client: cw }).execute!({ apiId: API_ID, endpointId: 'nope' }, opts)).rejects.toThrow(
      /has no endpoint nope/,
    );
  });

  it('runApi sends the input and a default max_items, and reports acceptance', async () => {
    const { cw, calls } = setup(service);
    const result = await runApi({ client: cw }).execute!(
      { apiId: API_ID, endpointId: ENDPOINT_ID, input: { topics: 'web-scraping' } },
      opts,
    );
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.body).toEqual({ input: { topics: 'web-scraping' }, max_items: 20 });
    expect(post.headers.authorization).toBe('Bearer cw_test_key_0123456789');
    expect(post.headers['idempotency-key']).toBeTruthy();
    expect(result).toMatchObject({
      accepted: true,
      recordCount: 1,
      records: [{ title: 'scrapy' }],
      status: 'completed',
      unitsCharged: 1,
    });
  });

  it('runApi uses the model maxItems over the configured default', async () => {
    const { cw, calls } = setup(service);
    await runApi({ client: cw, maxItems: 5, timeoutSeconds: 600 }).execute!(
      { apiId: API_ID, endpointId: ENDPOINT_ID, maxItems: 50, fields: ['title'] },
      opts,
    );
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({
      input: {},
      max_items: 50,
      timeout_seconds: 600,
      fields: ['title'],
    });
  });

  it('runApi without an API key names CLEANEDWEB_API_KEY', async () => {
    const { cw } = setup(service, { apiKey: undefined });
    await expect(runApi({ client: cw }).execute!({ apiId: API_ID, endpointId: ENDPOINT_ID }, opts)).rejects.toThrow(
      /CLEANEDWEB_API_KEY/,
    );
  });

  it('runs find, get and run through generateText with the current AI SDK', async () => {
    const { cw } = setup(service);
    const steps = [
      { toolName: 'findApi', input: { site: 'github.com', fields: ['stars'] } },
      { toolName: 'getApi', input: { apiId: API_ID } },
      { toolName: 'runApi', input: { apiId: API_ID, endpointId: ENDPOINT_ID, input: { topics: 'web-scraping' }, maxItems: 5 } },
    ];
    const usage = {
      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 1, reasoning: 0 },
    };
    let call = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        const step = steps[call];
        call += 1;
        if (!step) {
          return { content: [{ type: 'text', text: 'scrapy has 55000 stars.' }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] };
        }
        return {
          content: [{ type: 'tool-call', toolCallId: `c${call}`, toolName: step.toolName, input: JSON.stringify(step.input) }],
          finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
          usage,
          warnings: [],
        };
      },
    });
    const tools: ToolSet = cleanedwebTools({ client: cw });
    const result = await generateText({ model, tools, prompt: 'Top web-scraping repos', stopWhen: isStepCount(6) });
    expect(result.text).toBe('scrapy has 55000 stars.');
    const outputs = result.steps.flatMap((s) => s.toolResults.map((r) => [r.toolName, r.output]));
    expect(outputs.map(([name]) => name)).toEqual(['findApi', 'getApi', 'runApi']);
    expect(outputs[2]![1]).toMatchObject({ accepted: true, recordCount: 1 });
  });
});
