import { describe, expect, it } from 'vitest';
import {
  CleanedWebAbortError,
  CleanedWebConnectionError,
  ConfigurationError,
  RunFailedError,
  assertAccepted,
  isAccepted,
} from '../src/index.js';
import { API_ID, API_KEY, ENDPOINT_ID, RUN_ID, RUN_ROOT, finishedBody, json, runningBody, setup } from './helpers.js';

interface Repo {
  title: string;
  url: string;
}

describe('catalog.run', () => {
  it('sends one authenticated POST and returns the 200 result with the generated key', async () => {
    const { cw, calls, sleeps } = setup([() => json(200, finishedBody())]);
    const result = await cw.catalog.run<Repo>(API_ID, ENDPOINT_ID, {
      input: { sort: 'desc_stars' },
      maxItems: 25,
      timeoutSeconds: 3600,
      waitSeconds: 60,
      fields: ['title', 'url'],
      nulls: true,
      version: 2,
    });

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.url).toBe(`${RUN_ROOT}/run`);
    expect(call.headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(call.headers['content-type']).toBe('application/json');
    expect(call.headers['idempotency-key']).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(call.body).toEqual({
      input: { sort: 'desc_stars' },
      max_items: 25,
      timeout_seconds: 3600,
      wait_seconds: 60,
      fields: ['title', 'url'],
      nulls: true,
      version: 2,
    });
    expect(result.pending).toBe(false);
    expect(result.idempotencyKey).toBe(call.headers['idempotency-key']);
    expect(result.records[0]?.title).toBe('a');
    expect(result.delivery?.runId).toBe(RUN_ID);
    expect(result.run.stop_reason).toBe('source_exhausted');
    expect(sleeps).toEqual([]);
  });

  it('sends {} for input and omits unset options', async () => {
    const { cw, calls } = setup([() => json(200, finishedBody())]);
    await cw.catalog.run(API_ID, ENDPOINT_ID);
    expect(calls[0]!.body).toEqual({ input: {} });
  });

  it('on 202 polls /result with the same key after Retry-After and never resends the POST', async () => {
    const { cw, calls, sleeps } = setup([
      () => json(202, runningBody(), { 'retry-after': '7', location: `/v1/runs/${RUN_ID}` }),
      () => json(202, runningBody(), { 'retry-after': '3' }),
      () => json(200, finishedBody()),
    ]);
    const seen: string[] = [];
    const result = await cw.catalog.run(API_ID, ENDPOINT_ID, {
      idempotencyKey: 'job-42',
      maxItems: 5,
      nulls: true,
      onProgress: (run) => seen.push(run.status),
    });

    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `POST ${RUN_ROOT}/run`,
      `GET ${RUN_ROOT}/result?nulls=true`,
      `GET ${RUN_ROOT}/result?nulls=true`,
    ]);
    for (const call of calls) {
      expect(call.headers['idempotency-key']).toBe('job-42');
      expect(call.headers.authorization).toBe(`Bearer ${API_KEY}`);
    }
    expect(sleeps).toEqual([7000, 3000]);
    expect(seen).toEqual(['running', 'running']);
    expect(result.idempotencyKey).toBe('job-42');
    expect(result.summary.status).toBe('completed');
  });

  it('falls back to poll_after_seconds, then to 30 seconds, and never polls faster than 1 second', async () => {
    const { cw, sleeps } = setup([
      () => json(202, runningBody({ poll_after_seconds: 12 })),
      () => json(202, { run_id: RUN_ID, status: 'queued' }),
      () => json(202, runningBody(), { 'retry-after': '0' }),
      () => json(200, finishedBody()),
    ]);
    await cw.catalog.run(API_ID, ENDPOINT_ID);
    expect(sleeps).toEqual([12_000, 30_000, 1000]);
  });

  it('treats 409 result_not_complete as not ready and keeps polling with the same key', async () => {
    const { cw, calls, sleeps } = setup([
      () => json(202, runningBody(), { 'retry-after': '5' }),
      () => json(409, { detail: { code: 'result_not_complete', message: 'not yet' } }, { 'retry-after': '4' }),
      () => json(200, finishedBody()),
    ]);
    const result = await cw.catalog.run(API_ID, ENDPOINT_ID, { idempotencyKey: 'k1' });
    expect(result.pending).toBe(false);
    expect(sleeps).toEqual([5000, 4000]);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('wait: false returns the pending run with the key', async () => {
    const { cw, calls } = setup([() => json(202, runningBody(), { 'retry-after': '9' })]);
    const outcome = await cw.catalog.run(API_ID, ENDPOINT_ID, { wait: false, idempotencyKey: 'k2', waitSeconds: 0 });
    expect(outcome.pending).toBe(true);
    if (outcome.pending) {
      expect(outcome.run.run_id).toBe(RUN_ID);
      expect(outcome.retryAfter).toBe(9);
      expect(outcome.idempotencyKey).toBe('k2');
    }
    expect(calls).toHaveLength(1);
  });

  it('wait: false still returns a 200 result when the run ended within waitSeconds', async () => {
    const { cw } = setup([() => json(200, finishedBody())]);
    const outcome = await cw.catalog.run(API_ID, ENDPOINT_ID, { wait: false });
    expect(outcome.pending).toBe(false);
  });

  it('result() recovers a run by its key (idempotency reuse) without a new POST', async () => {
    const { cw, calls } = setup([() => json(200, finishedBody())]);
    const result = await cw.catalog.result(API_ID, ENDPOINT_ID, { idempotencyKey: 'saved-key' });
    expect(result.idempotencyKey).toBe('saved-key');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'GET', url: `${RUN_ROOT}/result` });
    expect(calls[0]!.headers['idempotency-key']).toBe('saved-key');
  });

  it('reuses a caller key on a retry of the same request and returns the same run', async () => {
    const { cw, calls } = setup([() => json(200, finishedBody()), () => json(200, finishedBody())]);
    const a = await cw.catalog.run(API_ID, ENDPOINT_ID, { idempotencyKey: 'same', input: { q: 1 } });
    const b = await cw.catalog.run(API_ID, ENDPOINT_ID, { idempotencyKey: 'same', input: { q: 1 } });
    expect(a.delivery?.runId).toBe(b.delivery?.runId);
    expect(calls.map((c) => c.headers['idempotency-key'])).toEqual(['same', 'same']);
  });

  it('generates a different key for each call', async () => {
    const { cw, calls } = setup([() => json(200, finishedBody()), () => json(200, finishedBody())]);
    await cw.catalog.run(API_ID, ENDPOINT_ID);
    await cw.catalog.run(API_ID, ENDPOINT_ID);
    expect(calls[0]!.headers['idempotency-key']).not.toBe(calls[1]!.headers['idempotency-key']);
  });

  it('rejects invalid keys and options before any request', async () => {
    const { cw, calls } = setup([]);
    await expect(cw.catalog.run(API_ID, ENDPOINT_ID, { idempotencyKey: '' })).rejects.toThrow(TypeError);
    await expect(cw.catalog.run(API_ID, ENDPOINT_ID, { idempotencyKey: 'has space' })).rejects.toThrow(TypeError);
    await expect(cw.catalog.run(API_ID, ENDPOINT_ID, { idempotencyKey: 'x'.repeat(201) })).rejects.toThrow(TypeError);
    await expect(cw.catalog.run(API_ID, ENDPOINT_ID, { maxItems: 0 })).rejects.toThrow(RangeError);
    await expect(cw.catalog.run(API_ID, ENDPOINT_ID, { timeoutSeconds: 59 })).rejects.toThrow(RangeError);
    await expect(cw.catalog.run(API_ID, ENDPOINT_ID, { version: 0 })).rejects.toThrow(RangeError);
    expect(calls).toHaveLength(0);
  });

  it('refuses to run without an API key and never contacts the service', async () => {
    const { cw, calls } = setup([], { apiKey: undefined });
    await expect(cw.catalog.run(API_ID, ENDPOINT_ID)).rejects.toBeInstanceOf(ConfigurationError);
    expect(calls).toHaveLength(0);
  });

  it('keeps the deprecation headers of a deprecated major on the result', async () => {
    const { cw } = setup([
      () => json(200, finishedBody(), { deprecation: '@1795046400', sunset: 'Sun, 17 Jan 2027 00:00:00 GMT' }),
    ]);
    const result = await cw.catalog.run(API_ID, ENDPOINT_ID, { version: 1 });
    expect(result.deprecation).toEqual({ deprecation: '@1795046400', sunset: 'Sun, 17 Jan 2027 00:00:00 GMT', link: null });
  });

  it('encodes path segments', async () => {
    const { cw, calls } = setup([() => json(200, finishedBody())]);
    await cw.catalog.run('a b', 'c/d');
    expect(calls[0]!.url).toBe('https://broker.cleanedweb.com/v1/catalog/public/apis/a%20b/endpoints/c%2Fd/run');
  });
});

describe('failed runs and transport', () => {
  it('maps a failed-run marker to RunFailedError and never retries it, even on 503', async () => {
    const { cw, calls } = setup([
      () =>
        json(
          503,
          { detail: { code: 'source_unavailable', message: 'down', run_id: RUN_ID, error_code: 'run_failed', replayed: false } },
          { location: `/v1/runs/${RUN_ID}` },
        ),
    ]);
    const error = await cw.catalog.run(API_ID, ENDPOINT_ID, { idempotencyKey: 'fail-1' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RunFailedError);
    const failed = error as RunFailedError;
    expect(failed.runId).toBe(RUN_ID);
    expect(failed.errorCode).toBe('run_failed');
    expect(failed.replayed).toBe(false);
    expect(failed.idempotencyKey).toBe('fail-1');
    expect(calls).toHaveLength(1);
  });

  it('marks a replayed failure and a failure found while polling with the run id', async () => {
    const { cw } = setup([
      () => json(202, runningBody(), { 'retry-after': '2' }),
      () => json(500, { detail: { run_id: RUN_ID, error_code: 'failed_run_replayed', replayed: true } }),
    ]);
    const error = (await cw.catalog.run(API_ID, ENDPOINT_ID, { idempotencyKey: 'fail-2' }).catch((e: unknown) => e)) as RunFailedError;
    expect(error).toBeInstanceOf(RunFailedError);
    expect(error.replayed).toBe(true);
    expect(error.errorCode).toBe('failed_run_replayed');
  });

  it('retries a 503 with the same key and Retry-After, then succeeds', async () => {
    const { cw, calls, sleeps } = setup([
      () => json(503, { detail: { code: 'runs_unavailable', message: 'later' } }, { 'retry-after': '2' }),
      () => json(200, finishedBody()),
    ]);
    const result = await cw.catalog.run(API_ID, ENDPOINT_ID, { idempotencyKey: 'retry-1' });
    expect(result.pending).toBe(false);
    expect(calls.map((c) => c.headers['idempotency-key'])).toEqual(['retry-1', 'retry-1']);
    expect(calls.map((c) => c.method)).toEqual(['POST', 'POST']);
    expect(sleeps).toEqual([2000]);
  });

  it('stops retrying after maxRetries and throws the typed error with the key attached', async () => {
    const { cw, calls } = setup(
      [() => json(503, { detail: 'busy' }), () => json(503, { detail: 'busy' }), () => json(503, { detail: 'busy' })],
      { maxRetries: 2 },
    );
    const error = await cw.catalog.run(API_ID, ENDPOINT_ID, { idempotencyKey: 'retry-2' }).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: 'ServerError', status: 503, idempotencyKey: 'retry-2' });
    expect(calls).toHaveLength(3);
  });

  it('does not retry when a Retry-After is longer than maxRetryDelayMs', async () => {
    const { cw, calls } = setup([() => json(429, { detail: 'slow down' }, { 'retry-after': '120' })]);
    const error = await cw.catalog.run(API_ID, ENDPOINT_ID).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: 'RateLimitError', status: 429, retryAfter: 120 });
    expect(calls).toHaveLength(1);
  });

  it('retries a lost connection with the same key, then reports a connection error with the key', async () => {
    const lost = () => new TypeError('fetch failed');
    const { cw, calls } = setup([lost, lost, lost], { maxRetries: 2 });
    const error = await cw.catalog.run(API_ID, ENDPOINT_ID, { idempotencyKey: 'net-1' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CleanedWebConnectionError);
    expect((error as CleanedWebConnectionError).idempotencyKey).toBe('net-1');
    expect(calls).toHaveLength(3);
  });

  it('turns a redirect into a configuration error and does not follow or retry it', async () => {
    const { cw, calls } = setup([() => new Response(null, { status: 302, headers: { location: 'https://app.cleanedweb.com/' } })]);
    await expect(cw.catalog.run(API_ID, ENDPOINT_ID)).rejects.toBeInstanceOf(ConfigurationError);
    expect(calls).toHaveLength(1);
  });

  it('never puts the API key in an error', async () => {
    const { cw } = setup([() => json(401, { detail: `bad key ${API_KEY}` })]);
    const error = (await cw.catalog.run(API_ID, ENDPOINT_ID).catch((e: unknown) => e)) as Error;
    expect(JSON.stringify({ m: error.message, e: error })).not.toContain(API_KEY);
    expect(error.message).toContain('[redacted]');
  });

  it('times out on the client without hanging', async () => {
    const hang = (call: { signal: AbortSignal | undefined }) =>
      new Promise<Response>((_, reject) => call.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
    const { cw } = setup([hang as never], { timeoutMs: 20, maxRetries: 0 });
    const error = await cw.runs.get(RUN_ID).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: 'CleanedWebTimeoutError' });
    expect(error).toBeInstanceOf(CleanedWebConnectionError);
  });

  it('gives a run request at least waitSeconds plus headroom before timing out', async () => {
    let seenTimeout = 0;
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
      if (ms === 120_000) seenTimeout = ms;
      return realSetTimeout(fn, ms, ...rest);
    }) as typeof setTimeout;
    try {
      const { cw } = setup([() => json(200, finishedBody())], { timeoutMs: 1000 });
      await cw.catalog.run(API_ID, ENDPOINT_ID, { waitSeconds: 90 });
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    expect(seenTimeout).toBe(120_000);
  });
});

describe('abort signal', () => {
  it('fails before sending when the signal is already aborted', async () => {
    const { cw, calls } = setup([]);
    const controller = new AbortController();
    controller.abort();
    const error = await cw.catalog.run(API_ID, ENDPOINT_ID, { signal: controller.signal, idempotencyKey: 'ab-0' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CleanedWebAbortError);
    expect(error).toMatchObject({ name: 'AbortError', idempotencyKey: 'ab-0' });
    expect(calls).toHaveLength(0);
  });

  it('aborts an in-flight request and does not retry it', async () => {
    const controller = new AbortController();
    const inflight = (call: { signal: AbortSignal | undefined }) =>
      new Promise<Response>((_, reject) => {
        call.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        queueMicrotask(() => controller.abort(new Error('user cancelled')));
      });
    const { cw, calls } = setup([inflight as never], { maxRetries: 3 });
    const error = (await cw.catalog.run(API_ID, ENDPOINT_ID, { signal: controller.signal, idempotencyKey: 'ab-1' }).catch((e: unknown) => e)) as CleanedWebAbortError;
    expect(error).toBeInstanceOf(CleanedWebAbortError);
    expect(error.idempotencyKey).toBe('ab-1');
    expect((error.cause as Error).message).toBe('user cancelled');
    expect(calls).toHaveLength(1);
  });

  it('stops waiting between polls, carries the key and run id, and leaves the run running', async () => {
    const controller = new AbortController();
    const { cw, calls } = setup(
      [() => json(202, runningBody(), { 'retry-after': '5' }), () => json(200, finishedBody())],
      {
        sleep: async (_ms, signal) => {
          controller.abort();
          if (signal?.aborted) throw new CleanedWebAbortError(signal.reason);
        },
      },
    );
    const error = (await cw.catalog.run(API_ID, ENDPOINT_ID, { signal: controller.signal, idempotencyKey: 'ab-2' }).catch((e: unknown) => e)) as CleanedWebAbortError;
    expect(error).toBeInstanceOf(CleanedWebAbortError);
    expect(error.idempotencyKey).toBe('ab-2');
    expect(error.runId).toBe(RUN_ID);
    expect(calls).toHaveLength(1); // no abort request is sent for the run
  });

  it('really aborts the default sleep', async () => {
    const controller = new AbortController();
    const { cw } = setup([() => json(202, runningBody(), { 'retry-after': '30' })], { sleep: undefined });
    const pending = cw.catalog.run(API_ID, ENDPOINT_ID, { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toBeInstanceOf(CleanedWebAbortError);
  });
});

describe('acceptance helpers', () => {
  it('accepts completed and bounded results that passed scope', () => {
    expect(isAccepted(finishedBody())).toBe(true);
    const bounded = finishedBody();
    bounded.summary.status = 'bounded';
    expect(isAccepted(bounded)).toBe(true);
  });

  it('flags partial results, failed scope, version mismatch and a record count mismatch', () => {
    const partial = finishedBody();
    partial.summary.status = 'partial';
    partial.summary.within_scope_passed = false;
    expect(isAccepted(partial)).toBe(false);
    expect(() => assertAccepted(partial)).toThrow(/within_scope_passed/);
    expect(isAccepted(finishedBody(), { definitionVersion: 'x'.repeat(64) })).toBe(false);
    const short = finishedBody([{ a: 1 }]);
    short.summary.records = 3;
    expect(isAccepted(short)).toBe(false);
  });
});
