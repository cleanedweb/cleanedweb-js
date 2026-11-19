import type { HttpClient } from './http.js';
import { settle, withKey } from './runner.js';
import type { AnyRecord, Run, RunPending, RunResult, SourceRunOptions } from './types.js';
import {
  assertIdempotencyKey,
  assertIntegerInRange,
  compact,
  encodeSegment,
  generateIdempotencyKey,
  isRecord,
} from './util.js';

const DEFAULT_WAIT_SECONDS = 90;
const REQUEST_HEADROOM_MS = 30_000;

/** The run object from `sources.start`. */
export interface StartedRun {
  run: Run;
  idempotencyKey: string;
  /** True when the service replayed an earlier request with the same key (`Idempotent-Replayed`). */
  replayed: boolean;
  /** Seconds the service asked to wait before reading the result. */
  retryAfter?: number | undefined;
}

/**
 * Run your own (private) generated source APIs: `POST /v1/sources/{source_id}/run`. The origin
 * comes from the API's connection details: pass it as `baseUrl` to the client. Needs a key with the
 * `run` scope and access to the source.
 */
export class Sources {
  constructor(private readonly http: HttpClient) {}

  /**
   * Runs a source and waits for its records (a `202` is followed with `GET /v1/runs/{run_id}/result`,
   * never by resending the POST). Pass `expectedVersion` to fail with a `VersionConflictError`
   * instead of running a different definition than the one you reviewed.
   */
  run<T = AnyRecord>(sourceId: string, options: SourceRunOptions & { wait: false }): Promise<(RunResult<T> | RunPending) & { idempotencyKey: string }>;
  run<T = AnyRecord>(sourceId: string, options?: SourceRunOptions & { wait?: true }): Promise<RunResult<T> & { idempotencyKey: string }>;
  async run<T = AnyRecord>(
    sourceId: string,
    options: SourceRunOptions = {},
  ): Promise<(RunResult<T> | RunPending) & { idempotencyKey: string }> {
    const { idempotencyKey, body, timeoutMs } = this.prepare(options);
    return withKey(idempotencyKey, async () => {
      const first = await this.http.request({
        target: 'run',
        method: 'POST',
        path: `/v1/sources/${encodeSegment(sourceId)}/run`,
        body,
        idempotencyKey,
        signal: options.signal,
        timeoutMs,
      });
      const outcome = await settle<T>(first, {
        http: this.http,
        wait: options.wait !== false,
        signal: options.signal,
        onProgress: options.onProgress,
        readResult: () =>
          this.http.request({
            target: 'run',
            method: 'GET',
            path: `/v1/runs/${encodeSegment(runIdOf(first))}/result`,
            query: { nulls: options.nulls === true ? 'true' : undefined },
            signal: options.signal,
          }),
      });
      return { ...outcome, idempotencyKey };
    });
  }

  /**
   * Starts a run without waiting (`POST /v1/sources/{source_id}/runs`; `waitSeconds` defaults to 0).
   * Read records with `runs.items(run.run_id)` and the final body with `runs.result(run.run_id)`.
   */
  async start(sourceId: string, options: Omit<SourceRunOptions, 'wait' | 'onProgress'> = {}): Promise<StartedRun> {
    const { idempotencyKey, body, timeoutMs } = this.prepare(options);
    return withKey(idempotencyKey, async () => {
      const res = await this.http.request({
        target: 'run',
        method: 'POST',
        path: `/v1/sources/${encodeSegment(sourceId)}/runs`,
        body,
        idempotencyKey,
        signal: options.signal,
        timeoutMs,
      });
      const retry = res.headers.get('retry-after');
      return {
        run: res.body as Run,
        idempotencyKey,
        replayed: res.headers.get('idempotent-replayed') === 'true',
        ...(retry !== null && retry !== '' ? { retryAfter: Number(retry) } : {}),
      };
    });
  }

  private prepare(options: SourceRunOptions) {
    assertIntegerInRange('maxItems', options.maxItems, 1);
    assertIntegerInRange('timeoutSeconds', options.timeoutSeconds, 60, 86_400);
    assertIntegerInRange('waitSeconds', options.waitSeconds, 0, 86_400);
    if (options.expectedVersion !== undefined && options.definitionVersion !== undefined) {
      throw new TypeError('Pass either expectedVersion or definitionVersion, not both.');
    }
    const idempotencyKey = options.idempotencyKey ?? generateIdempotencyKey();
    assertIdempotencyKey(idempotencyKey);
    const body = compact({
      expected_version: options.expectedVersion,
      definition_version: options.definitionVersion,
      input: options.input ?? {},
      endpoint: options.endpoint,
      max_items: options.maxItems,
      timeout_seconds: options.timeoutSeconds,
      wait_seconds: options.waitSeconds,
      fields: options.fields,
      nulls: options.nulls,
    });
    return {
      idempotencyKey,
      body,
      timeoutMs: Math.max(this.http.config.timeoutMs, (options.waitSeconds ?? DEFAULT_WAIT_SECONDS) * 1000 + REQUEST_HEADROOM_MS),
    };
  }
}

function runIdOf(res: { body: unknown }): string {
  const id = isRecord(res.body) ? res.body.run_id : undefined;
  return typeof id === 'string' ? id : '';
}
