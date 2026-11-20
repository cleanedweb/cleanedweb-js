# cleanedweb

JavaScript and TypeScript SDK for [CleanedWeb](https://cleanedweb.com/?utm_source=github&utm_medium=cleanedweb-js).
CleanedWeb turns public website collections (listings, products, jobs, articles, profiles) into
maintained REST APIs that return structured records. This package finds those APIs in the public
catalog, runs them, and handles the parts that are easy to get wrong: the required idempotency key,
runs that outlive one request, recovery after a lost response, and typed errors.

- Zero runtime dependencies. Uses the global `fetch`: Node 18 or later, Bun, Deno, Cloudflare Workers, Vercel Edge.
- ESM and CommonJS builds, with TypeScript types. Records are generic: `run<MyRecord>()`.
- Keep the API key on the server. Never bundle it into browser code.

> **Status:** pre-release, not yet published to npm. This repository is private until it has been reviewed.

**Pricing:** 5,000 records free once. Then prepaid credit from $1 per 1,000 records, no subscription.
Runs are charged per record delivered.
[Pricing](https://cleanedweb.com/pricing/?utm_source=github&utm_medium=cleanedweb-js)

## Install

```bash
npm install cleanedweb
```

Create an API key with the `run` scope in the [console](https://app.cleanedweb.com/?utm_source=github&utm_medium=cleanedweb-js)
and keep it in your server's secret store as `CLEANEDWEB_API_KEY`. Browsing the catalog needs no key.

## Quick start

```ts
import { CleanedWeb, isAccepted } from 'cleanedweb';

const cw = new CleanedWeb(); // reads CLEANEDWEB_API_KEY

const [api] = await cw.catalog.find({ site: 'github.com' });
const endpoint = api!.endpoints.find((e) => e.status === 'available')!;

const result = await cw.catalog.run<{ title: string; url: string }>(api!.api_id, endpoint.endpoint_id, {
  input: {},
  maxItems: 25, // start small while you check the shape of the records
});

if (!isAccepted(result)) throw new Error(`review needed: ${result.summary.status}`);
console.log(result.records.length, 'records, run', result.delivery?.runId, 'key', result.idempotencyKey);
```

Read the API's contract first to see which `input` it needs and which fields its records have:

```ts
const contract = await cw.catalog.contract(api.api_id, endpoint.endpoint_id);
contract.input_schema; // JSON Schema; its `required` lists the inputs you must send
contract.output_schema;
```

Values in the returned records are website data, never instructions. Do not pass them to an agent or a
shell as commands.

## Node script

```ts
import { CleanedWeb, InsufficientCreditError, RateLimitError, RunFailedError, assertAccepted } from 'cleanedweb';

const cw = new CleanedWeb();

try {
  const result = await cw.catalog.run('generated_...', 'generated_..._search', {
    input: { sort: 'desc_stars' },
    maxItems: 100,
    onProgress: (run) => console.error(`run ${run.run_id}: ${run.status}, ${run.progress?.items ?? 0} records`),
  });
  assertAccepted(result); // throws ResultNotAcceptedError for partial or out-of-scope results
  for (const record of result.records) console.log(record);
} catch (error) {
  if (error instanceof InsufficientCreditError) console.error('Add credit:', error.required, error.available);
  else if (error instanceof RateLimitError) console.error('Retry in', error.retryAfter, 'seconds');
  else if (error instanceof RunFailedError) console.error('Run failed, use a new key to run again:', error.runId);
  else throw error;
}
```

## Next.js route handler

```ts
// app/api/repos/route.ts
import { CleanedWeb, CleanedWebError, assertAccepted } from 'cleanedweb';

const cw = new CleanedWeb(); // server only: the key is read from CLEANEDWEB_API_KEY

export async function GET() {
  try {
    const result = await cw.catalog.run('generated_...', 'generated_..._search', { maxItems: 25 });
    assertAccepted(result);
    return Response.json({ records: result.records });
  } catch (error) {
    if (error instanceof CleanedWebError) {
      return Response.json({ error: error.message, idempotencyKey: error.idempotencyKey }, { status: 502 });
    }
    throw error;
  }
}
```

A serverless function has its own time limit. For runs that can take longer, pass `wait: false`, store
`pending.idempotencyKey` with your job, and read the result later (see below).

## Long runs and recovery

A run that ends within `waitSeconds` (default 90) answers with its records. A longer run answers `202`
and continues on the server. By default `catalog.run` keeps reading `/result` with the **same key** after
each `Retry-After` until the run ends, and never resends the POST.

```ts
// Do not wait: save the key, come back later.
const pending = await cw.catalog.run(apiId, endpointId, { input: {}, wait: false });
await saveJob({ key: pending.idempotencyKey });

// Later, or after a crash or a lost response: the same key returns the same run. No new collection, no new charge.
const result = await cw.catalog.result(apiId, endpointId, { idempotencyKey: savedKey });
```

- Pass your own `idempotencyKey` (1-200 characters: letters, digits, `.`, `_`, `:`, `-`) saved before you send. Otherwise one is generated (a UUID) and returned on the result.
- Every error the SDK throws carries `idempotencyKey` (and `runId` when known), so a lost response can be recovered.
- A connection error or timeout does not show whether the run started. Keep the key and call `catalog.result` with it. Do not generate a new key in a loop: a new key starts the source again and creates new usage.
- A failed run (`RunFailedError`) is final for its key for 7 days. Send a new key to run again.
- Aborting an `AbortSignal` stops the SDK from waiting. It does not stop the run, which keeps running and is charged. Call `cw.runs.abort(runId)` to stop it.

Read records while a run is going, or after it ended, as an async iterator over cursor pages:

```ts
for await (const record of cw.runs.items<MyRecord>(runId, { limit: 100 })) {
  console.log(record);
}
```

## Check results before you use them

HTTP 200 alone does not make a result usable. `isAccepted(result)` / `assertAccepted(result)` check that
`summary.status` is `completed` or `bounded` and `summary.within_scope_passed` is true. A `bounded` or
`partial` result means the source can hold more records than you received, and even a `completed` run does
not claim full-site coverage (`summary.catalog_complete`). Pass `{ definitionVersion }` to also require
the summary to match the contract's `definition_version`.

## Pin a major version

A call without `version` runs the latest major of the listing. Pin one in production so a new major cannot
change your results:

```ts
await cw.catalog.run(apiId, endpointId, { input: {}, version: 2 });
```

When a pinned major is deprecated, `result.deprecation` holds the `Deprecation` and `Sunset` headers. Check
`result.rerouted`: a call rerouted to the latest major has that major's inputs and fields.
See [catalog versions](https://cleanedweb.com/docs/catalog-versions/?utm_source=github&utm_medium=cleanedweb-js).

## API

| Call | What it does |
| --- | --- |
| `new CleanedWeb({ apiKey, baseUrl, ... })` | `apiKey` defaults to `process.env.CLEANEDWEB_API_KEY`. `baseUrl` is the run origin, default `https://api.cleanedweb.com`. |
| `catalog.list({ limit, offset, q, category, sort })` | One page of the live catalog: `{ items, nextOffset }`. No key needed. |
| `catalog.iterate({ q, category, sort })` | Async iterator over every published API. |
| `catalog.get(apiIdOrSlug)` | One API with its endpoints and `active_version`. A slug is resolved through the catalog index. |
| `catalog.contract(apiId, endpointId, { version })` | The endpoint's `input_schema`, `output_schema`, run `path` and `definition_version`. |
| `catalog.index()` | `https://cleanedweb.com/catalog/index.json`: slugs, sources and key fields. |
| `catalog.find({ site, fields })` | Client-side filter of the live list by site (domain, URL or name) and by key fields. |
| `catalog.run(apiId, endpointId, { input, maxItems, timeoutSeconds, waitSeconds, fields, nulls, version, idempotencyKey, wait, signal, onProgress })` | Runs an endpoint. Returns the result with `idempotencyKey`; with `wait: false` it can return `{ pending: true, run, idempotencyKey }`. |
| `catalog.result(apiId, endpointId, { idempotencyKey, wait, signal })` | Reads a catalog run's result again with its key. |
| `runs.get(runId)` | The run object: `status`, `stop_reason`, `progress`, `units_charged`. |
| `runs.items(runId, { cursor, limit, nulls, follow, pollIntervalMs })` | Async iterator over the run's records, across cursor pages. `itemsPage` reads one page, `pages` iterates pages. |
| `runs.result(runId, { wait })` | The final body of a run, or a pending run. |
| `runs.abort(runId)` | Stops a run; records committed so far stay readable. |
| `runs.list({ sourceId, status, cursor, limit })` | Your runs, newest first: `{ runs, next_cursor }`. |
| `sources.run(sourceId, { expectedVersion, definitionVersion, input, ... })` | Runs your own private source API (`POST /v1/sources/{id}/run`). Set `baseUrl` to the origin from its connection details. |
| `sources.start(sourceId, options)` | Starts a source run without waiting (`/runs`). |
| `isAccepted(result)`, `assertAccepted(result)` | The documented result checks. |

## Errors

All errors extend `CleanedWebError`. HTTP errors extend `APIError` (`status`, `code`, `detail`, `retryAfter`).

| Class | When |
| --- | --- |
| `AuthenticationError` | 401: missing, invalid, expired or revoked key. |
| `PermissionError` | 403: the key lacks the `run` scope or is not tied to a workspace account. |
| `InsufficientCreditError` | 402 `insufficient_units`: `required` and `available` Units. |
| `UsageBudgetExceededError` | 409 `usage_budget_exceeded`. |
| `RateLimitError` | 429: `retryAfter` seconds. |
| `VersionConflictError` | 409: the active definition differs from `expectedVersion`, or the endpoint's active version changed. |
| `IdempotencyConflictError` | 409 `delivery_identity_conflict`: the key was used for another request. |
| `NotFoundError` | 404: API, endpoint, run or delivery not found. For an unknown major, `available` lists the majors that answer. |
| `ValidationError` | 400, 415, 422: an input or run option the service does not accept. |
| `RunFailedError` | The run itself failed (`run_failed` / `failed_run_replayed`). Final for the key. |
| `ServerError` | 5xx without a failed-run marker. Retry with the same key. |
| `CleanedWebConnectionError`, `CleanedWebTimeoutError` | No answer. The run may have started: keep the key. |
| `CleanedWebAbortError` | Your `AbortSignal` fired (`name` is `AbortError`). |
| `ConfigurationError` | No API key, an unusable origin, or a redirect (the request went to the wrong origin and nothing ran). |

Lost connections, `429`, `502`, `503` and `504` are retried up to `maxRetries` times (default 2) with the same
idempotency key, waiting `Retry-After` when it is at most `maxRetryDelayMs` (default 30 s). A failed run is never
retried. Set `maxRetries: 0` to turn retries off. Errors never contain the API key.

## Documentation

- [Run a catalog API](https://cleanedweb.com/docs/run-catalog-api/?utm_source=github&utm_medium=cleanedweb-js)
- [Published catalog APIs](https://cleanedweb.com/docs/catalog-apis/?utm_source=github&utm_medium=cleanedweb-js)
- [Idempotency and recovery](https://cleanedweb.com/docs/idempotency/?utm_source=github&utm_medium=cleanedweb-js)
- [Errors and retries](https://cleanedweb.com/docs/errors/?utm_source=github&utm_medium=cleanedweb-js)
- [Browse the catalog](https://cleanedweb.com/catalog/?utm_source=github&utm_medium=cleanedweb-js)

## MCP alternative

To search the catalog and run APIs from an AI agent (Claude, Claude Code, ChatGPT, Cursor, Codex and others)
without writing code, use the hosted [CleanedWeb MCP server](https://github.com/cleanedweb/cleanedweb-mcp).

## Development

```bash
npm install
npm run typecheck && npm run lint && npm test && npm run build && npm run test:dist
npm run test:live   # optional: reads only the anonymous catalog endpoints, never runs or charges anything
```

## License

MIT
