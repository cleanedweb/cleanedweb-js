import { describe, expect, it } from 'vitest';
import { VersionConflictError } from '../src/index.js';
import { RUN_ID, finishedBody, json, runningBody, setup } from './helpers.js';

const BASE = 'https://api.cleanedweb.com';
const VERSION = 'f'.repeat(64);

describe('sources', () => {
  it('run posts to /v1/sources/{id}/run with the documented body and returns the key', async () => {
    const { cw, calls } = setup([() => json(200, finishedBody())]);
    const result = await cw.sources.run('src_abc', {
      expectedVersion: VERSION,
      input: { query: 'x' },
      endpoint: 'search',
      maxItems: 25,
      idempotencyKey: 'src-key',
    });
    expect(calls[0]).toMatchObject({ method: 'POST', url: `${BASE}/v1/sources/src_abc/run` });
    expect(calls[0]!.body).toEqual({
      expected_version: VERSION,
      input: { query: 'x' },
      endpoint: 'search',
      max_items: 25,
    });
    expect(calls[0]!.headers['idempotency-key']).toBe('src-key');
    expect(result.idempotencyKey).toBe('src-key');
    expect(result.pending).toBe(false);
  });

  it('on 202 reads GET /v1/runs/{run_id}/result until the run ends', async () => {
    const { cw, calls, sleeps } = setup([
      () => json(202, runningBody(), { 'retry-after': '30' }),
      () => json(202, runningBody(), { 'retry-after': '30' }),
      () => json(200, finishedBody()),
    ]);
    const result = await cw.sources.run('src_abc', { definitionVersion: VERSION });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `POST ${BASE}/v1/sources/src_abc/run`,
      `GET ${BASE}/v1/runs/${RUN_ID}/result`,
      `GET ${BASE}/v1/runs/${RUN_ID}/result`,
    ]);
    expect(calls[0]!.body).toMatchObject({ definition_version: VERSION });
    expect(sleeps).toEqual([30_000, 30_000]);
    expect(result.summary.status).toBe('completed');
  });

  it('refuses expectedVersion together with definitionVersion', async () => {
    const { cw, calls } = setup([]);
    await expect(cw.sources.run('s', { expectedVersion: VERSION, definitionVersion: VERSION })).rejects.toThrow(TypeError);
    expect(calls).toHaveLength(0);
  });

  it('maps a version conflict', async () => {
    const { cw } = setup([() => json(409, { detail: { code: 'builder_definition_version_conflict' } })]);
    await expect(cw.sources.run('s', { expectedVersion: VERSION, idempotencyKey: 'k' })).rejects.toBeInstanceOf(VersionConflictError);
  });

  it('start posts to /runs, reports replay, and returns the run with the key', async () => {
    const { cw, calls } = setup([() => json(202, runningBody(), { 'idempotent-replayed': 'true', 'retry-after': '30' })]);
    const started = await cw.sources.start('src_abc', { input: {}, idempotencyKey: 'start-1' });
    expect(calls[0]).toMatchObject({ method: 'POST', url: `${BASE}/v1/sources/src_abc/runs` });
    expect(started).toMatchObject({ idempotencyKey: 'start-1', replayed: true, retryAfter: 30 });
    expect(started.run.run_id).toBe(RUN_ID);
  });

  it('sends the key only to the configured run origin', async () => {
    const { cw, calls } = setup([() => json(200, finishedBody())], { baseUrl: 'https://runs.example.com/' });
    await cw.sources.run('src_abc');
    expect(calls[0]!.url).toBe('https://runs.example.com/v1/sources/src_abc/run');
  });
});
