import { CleanedWeb } from '../src/index.js';
import type { CleanedWebOptions, RunResultBody } from '../src/index.js';

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  signal: AbortSignal | undefined;
}

export type Responder = (call: RecordedCall) => Response | Promise<Response> | Error;

export const API_KEY = 'cw_test_key_0123456789';
export const API_ID = 'generated_047a8ebb25911ccf62f4a212';
export const ENDPOINT_ID = `${API_ID}_search`;
export const RUN_ROOT = `https://broker.cleanedweb.com/v1/catalog/public/apis/${API_ID}/endpoints/${ENDPOINT_ID}`;
export const RUN_ID = 'a'.repeat(32);

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

export const finishedBody = (records: unknown[] = [{ title: 'a', url: 'https://example.com/a' }]): RunResultBody<unknown> => ({
  records,
  summary: {
    status: 'completed',
    within_scope_passed: true,
    catalog_complete: false,
    records: records.length,
    definition_version: 'v'.repeat(64),
  },
  metadata: { definition_version: 'v'.repeat(64) },
  traceId: 'trace-1',
  run: { run_id: RUN_ID, status: 'finished', stop_reason: 'source_exhausted', units_charged: records.length },
  delivery: { runId: RUN_ID, chargeReceiptId: RUN_ID, recordCount: records.length },
  version: '1.1',
});

export const runningBody = (extra: Record<string, unknown> = {}) => ({
  run_id: RUN_ID,
  status: 'running',
  stop_reason: null,
  poll_after_seconds: 30,
  links: { items: `/v1/runs/${RUN_ID}/items`, result: `/v1/runs/${RUN_ID}/result` },
  ...extra,
});

/** A client whose fetch answers from a queue and whose sleep records its waits. */
export function setup(responders: Responder[] | Responder, options: CleanedWebOptions = {}) {
  const calls: RecordedCall[] = [];
  const sleeps: number[] = [];
  const router = typeof responders === 'function' ? responders : undefined;
  const queue = typeof responders === 'function' ? [] : [...responders];
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const call: RecordedCall = {
      url,
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      signal: init?.signal ?? undefined,
    };
    calls.push(call);
    const next = router ?? queue.shift();
    if (!next) throw new Error(`Unexpected request #${calls.length}: ${call.method} ${url}`);
    const answer = await next(call);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  const cw = new CleanedWeb({
    apiKey: API_KEY,
    fetch,
    sleep: async (ms, signal) => {
      sleeps.push(ms);
      if (signal?.aborted) throw signal.reason;
    },
    ...options,
  });
  return { cw, calls, sleeps, remaining: () => queue.length };
}
