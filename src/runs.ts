import type { HttpClient } from './http.js';
import { settle } from './runner.js';
import type {
  AnyRecord,
  Run,
  RunItemsOptions,
  RunItemsPage,
  RunList,
  RunListParams,
  RunPending,
  RunResult,
  RunResultOptions,
} from './types.js';
import { assertIntegerInRange, encodeSegment, isRecord, throwIfAborted } from './util.js';

const DEFAULT_FOLLOW_MS = 2000;
const TERMINAL = new Set(['finished', 'failed', 'aborted']);

/** Read and control runs by `run_id`. Needs a key with the `run` scope (`results` also reads). */
export class Runs {
  constructor(private readonly http: HttpClient) {}

  /** The run object: `status`, `stop_reason`, `progress`, `units_charged`. */
  async get(runId: string, options: { signal?: AbortSignal } = {}): Promise<Run> {
    const res = await this.http.request({
      target: 'run',
      method: 'GET',
      path: `/v1/runs/${encodeSegment(runId)}`,
      signal: options.signal,
    });
    return res.body as Run;
  }

  /** The caller's runs, newest first. Pass `next_cursor` as `cursor` for the next page. */
  async list(params: RunListParams = {}): Promise<RunList> {
    assertIntegerInRange('limit', params.limit, 1);
    const res = await this.http.request({
      target: 'run',
      method: 'GET',
      path: '/v1/runs',
      query: { source_id: params.sourceId, status: params.status, cursor: params.cursor, limit: params.limit },
      signal: params.signal,
    });
    const body = isRecord(res.body) ? res.body : {};
    return {
      runs: Array.isArray(body.runs) ? (body.runs as Run[]) : [],
      next_cursor: (body.next_cursor as RunList['next_cursor'] | undefined) ?? null,
    };
  }

  /** One page of records committed so far. Readable while the run runs. */
  async itemsPage<T = AnyRecord>(runId: string, options: Omit<RunItemsOptions, 'follow' | 'pollIntervalMs'> = {}): Promise<RunItemsPage<T>> {
    assertIntegerInRange('limit', options.limit, 1);
    const res = await this.http.request({
      target: 'run',
      method: 'GET',
      path: `/v1/runs/${encodeSegment(runId)}/items`,
      query: {
        cursor: options.cursor ?? 0,
        limit: options.limit,
        nulls: options.nulls === true ? 'true' : undefined,
      },
      signal: options.signal,
    });
    return res.body as RunItemsPage<T>;
  }

  /** Every page of a run's records, following `next_cursor`. See {@link RunItemsOptions.follow}. */
  async *pages<T = AnyRecord>(runId: string, options: RunItemsOptions = {}): AsyncGenerator<RunItemsPage<T>, void, undefined> {
    const follow = options.follow !== false;
    const pollMs = options.pollIntervalMs ?? DEFAULT_FOLLOW_MS;
    let cursor: string | number = options.cursor ?? 0;
    for (;;) {
      throwIfAborted(options.signal);
      const page: RunItemsPage<T> = await this.itemsPage<T>(runId, { ...options, cursor });
      yield page;
      const next = page.next_cursor;
      const items = Array.isArray(page.items) ? page.items : [];
      if (next === null || next === undefined) return;
      const stalled = items.length === 0 && String(next) === String(cursor);
      if (stalled) {
        // Nothing new yet: stop if the run has ended, otherwise wait for more commits.
        if (TERMINAL.has(page.run_status) || !follow) return;
        await this.http.sleep(pollMs, options.signal);
      }
      cursor = next;
    }
  }

  /**
   * Async iterator over a run's records, across cursor pages:
   * `for await (const record of client.runs.items(runId)) { ... }`.
   * While the run is still running it waits for later commits and ends once the run has ended and
   * every record was read (pass `follow: false` to stop at what is committed now). Reading records
   * never collects the website again.
   */
  async *items<T = AnyRecord>(runId: string, options: RunItemsOptions = {}): AsyncGenerator<T, void, undefined> {
    for await (const page of this.pages<T>(runId, options)) {
      for (const item of page.items ?? []) yield item;
    }
  }

  /**
   * The run's final body: `200` once it ended; with `wait` (default) a `202` keeps reading after
   * `Retry-After` until it does. With `wait: false` it returns a pending run instead.
   */
  result<T = AnyRecord>(runId: string, options: RunResultOptions & { wait: false }): Promise<RunResult<T> | RunPending>;
  result<T = AnyRecord>(runId: string, options?: RunResultOptions & { wait?: true }): Promise<RunResult<T>>;
  async result<T = AnyRecord>(runId: string, options: RunResultOptions = {}): Promise<RunResult<T> | RunPending> {
    const read = () =>
      this.http.request({
        target: 'run',
        method: 'GET',
        path: `/v1/runs/${encodeSegment(runId)}/result`,
        query: { nulls: options.nulls === true ? 'true' : undefined },
        signal: options.signal,
      });
    try {
      return await settle<T>(await read(), {
        http: this.http,
        wait: options.wait !== false,
        signal: options.signal,
        onProgress: options.onProgress,
        readResult: read,
      });
    } catch (error) {
      if (error instanceof Error && 'runId' in error) (error as { runId?: string }).runId ??= runId;
      throw error;
    }
  }

  /**
   * Stops a run you no longer need. Answers `202` with the run object while it stops, or `200` if it
   * had already ended. Records committed so far stay readable (and charged).
   */
  async abort(runId: string, options: { signal?: AbortSignal } = {}): Promise<Run> {
    const res = await this.http.request({
      target: 'run',
      method: 'POST',
      path: `/v1/runs/${encodeSegment(runId)}/abort`,
      signal: options.signal,
    });
    return res.body as Run;
  }
}
