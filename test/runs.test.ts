import { describe, expect, it } from 'vitest';
import { CleanedWebAbortError, NotFoundError, RunFailedError } from '../src/index.js';
import { RUN_ID, finishedBody, json, runningBody, setup } from './helpers.js';

const BASE = 'https://api.cleanedweb.com';

const page = (items: unknown[], next: number | null, status = 'running') => ({
  run_id: RUN_ID,
  items,
  count: items.length,
  next_cursor: next,
  run_status: status,
});

describe('runs', () => {
  it('get reads the run object', async () => {
    const { cw, calls } = setup([() => json(200, runningBody())]);
    const run = await cw.runs.get(RUN_ID);
    expect(run.status).toBe('running');
    expect(calls[0]).toMatchObject({ method: 'GET', url: `${BASE}/v1/runs/${RUN_ID}` });
    expect(calls[0]!.headers.authorization).toMatch(/^Bearer /);
    expect(calls[0]!.headers['idempotency-key']).toBeUndefined();
  });

  it('get maps 404 to NotFoundError', async () => {
    const { cw } = setup([() => json(404, { detail: 'Run not found' })], { maxRetries: 0 });
    await expect(cw.runs.get('nope')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('items iterates every cursor page of a finished run and stops at a null cursor', async () => {
    const { cw, calls, sleeps } = setup([
      () => json(200, page([{ n: 1 }, { n: 2 }], 2, 'finished')),
      () => json(200, page([{ n: 3 }, { n: 4 }], 4, 'finished')),
      () => json(200, page([{ n: 5 }], null, 'finished')),
    ]);
    const seen: number[] = [];
    for await (const item of cw.runs.items<{ n: number }>(RUN_ID, { limit: 2 })) seen.push(item.n);
    expect(seen).toEqual([1, 2, 3, 4, 5]);
    expect(calls.map((c) => c.url)).toEqual([
      `${BASE}/v1/runs/${RUN_ID}/items?cursor=0&limit=2`,
      `${BASE}/v1/runs/${RUN_ID}/items?cursor=2&limit=2`,
      `${BASE}/v1/runs/${RUN_ID}/items?cursor=4&limit=2`,
    ]);
    expect(sleeps).toEqual([]);
  });

  it('items follows a running run: waits when no new record is committed, then continues', async () => {
    const { cw, calls, sleeps } = setup([
      () => json(200, page([{ n: 1 }], 1)),
      () => json(200, page([], 1)), // nothing new yet, run still running
      () => json(200, page([{ n: 2 }], 2)),
      () => json(200, page([], null, 'finished')),
    ]);
    const seen: number[] = [];
    for await (const item of cw.runs.items<{ n: number }>(RUN_ID, { pollIntervalMs: 50 })) seen.push(item.n);
    expect(seen).toEqual([1, 2]);
    expect(sleeps).toEqual([50]);
    expect(calls).toHaveLength(4);
  });

  it('items stops on a stalled cursor once the run has ended', async () => {
    const { cw, calls } = setup([() => json(200, page([{ n: 1 }], 1, 'finished')), () => json(200, page([], 1, 'finished'))]);
    const seen: unknown[] = [];
    for await (const item of cw.runs.items(RUN_ID)) seen.push(item);
    expect(seen).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });

  it('items with follow: false ends at what is committed', async () => {
    const { cw, sleeps } = setup([() => json(200, page([{ n: 1 }], 1)), () => json(200, page([], 1))]);
    const seen: unknown[] = [];
    for await (const item of cw.runs.items(RUN_ID, { follow: false })) seen.push(item);
    expect(seen).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it('items starts at a given cursor, passes nulls, and can be aborted', async () => {
    const { cw, calls } = setup([() => json(200, page([{ n: 9 }], null, 'finished'))]);
    for await (const item of cw.runs.items(RUN_ID, { cursor: 8, nulls: true })) void item;
    expect(calls[0]!.url).toBe(`${BASE}/v1/runs/${RUN_ID}/items?cursor=8&nulls=true`);

    const controller = new AbortController();
    const { cw: cw2 } = setup([() => json(200, page([{ n: 1 }], 1))]);
    const consume = async () => {
      for await (const item of cw2.runs.items(RUN_ID, { signal: controller.signal })) {
        void item;
        controller.abort();
      }
    };
    await expect(consume()).rejects.toBeInstanceOf(CleanedWebAbortError);
  });

  it('itemsPage returns one page with its cursor', async () => {
    const { cw } = setup([() => json(200, page([{ n: 1 }], 1))]);
    const result = await cw.runs.itemsPage(RUN_ID, { limit: 1 });
    expect(result.next_cursor).toBe(1);
    expect(result.run_status).toBe('running');
  });

  it('result returns a finished body, and polls a 202 with the run route', async () => {
    const { cw, calls, sleeps } = setup([
      () => json(202, runningBody(), { 'retry-after': '6' }),
      () => json(200, finishedBody()),
    ]);
    const result = await cw.runs.result(RUN_ID);
    expect(result.summary.status).toBe('completed');
    expect(calls.map((c) => c.url)).toEqual([`${BASE}/v1/runs/${RUN_ID}/result`, `${BASE}/v1/runs/${RUN_ID}/result`]);
    expect(sleeps).toEqual([6000]);
    expect(calls[0]!.headers['idempotency-key']).toBeUndefined();
  });

  it('result with wait: false returns the pending run', async () => {
    const { cw } = setup([() => json(202, runningBody(), { 'retry-after': '6' })]);
    const outcome = await cw.runs.result(RUN_ID, { wait: false });
    expect(outcome.pending).toBe(true);
  });

  it('result throws RunFailedError for a failed run and names the run', async () => {
    const { cw } = setup([() => json(502, { detail: { run_id: RUN_ID, error_code: 'run_failed', replayed: false } })]);
    const error = (await cw.runs.result(RUN_ID).catch((e: unknown) => e)) as RunFailedError;
    expect(error).toBeInstanceOf(RunFailedError);
    expect(error.runId).toBe(RUN_ID);
  });

  it('abort posts to the abort route and returns the run', async () => {
    const { cw, calls } = setup([() => json(202, runningBody({ abort_requested: true }))]);
    const run = await cw.runs.abort(RUN_ID);
    expect(run.abort_requested).toBe(true);
    expect(calls[0]).toMatchObject({ method: 'POST', url: `${BASE}/v1/runs/${RUN_ID}/abort` });
  });

  it('abort accepts 200 for a run that had already ended', async () => {
    const { cw } = setup([() => json(200, { run_id: RUN_ID, status: 'finished', stop_reason: 'source_exhausted' })]);
    expect((await cw.runs.abort(RUN_ID)).status).toBe('finished');
  });

  it('list sends filters and cursor, and returns next_cursor', async () => {
    const { cw, calls } = setup([() => json(200, { runs: [runningBody()], next_cursor: 'c2' })]);
    const result = await cw.runs.list({ sourceId: 'src_1', status: 'running', cursor: 'c1', limit: 10 });
    expect(result.runs).toHaveLength(1);
    expect(result.next_cursor).toBe('c2');
    expect(calls[0]!.url).toBe(`${BASE}/v1/runs?source_id=src_1&status=running&cursor=c1&limit=10`);
  });

  it('list defaults next_cursor to null', async () => {
    const { cw } = setup([() => json(200, { runs: [] })]);
    expect(await cw.runs.list()).toEqual({ runs: [], next_cursor: null });
  });
});
