import { CleanedWebError, ResultNotReadyError } from './errors.js';
import { deprecationFrom } from './http.js';
import type { HttpClient, HttpResponse } from './http.js';
import type { AnyRecord, Run, RunPending, RunResult, RunResultBody } from './types.js';
import { isRecord, parseRetryAfter, throwIfAborted } from './util.js';

/** Fallback wait when a 202 names neither `Retry-After` nor `poll_after_seconds`. */
const DEFAULT_POLL_SECONDS = 30;
/** Never poll faster than this, whatever the service says. */
const MIN_POLL_MS = 1000;

export interface SettleOptions {
  http: HttpClient;
  /** Keep reading until the run ends. */
  wait: boolean;
  /** Reads the result again (same key, or the run id). */
  readResult: () => Promise<HttpResponse>;
  signal: AbortSignal | undefined;
  onProgress: ((run: Run) => void) | undefined;
}

export function completedFrom<T>(res: HttpResponse): RunResult<T> {
  const body = (isRecord(res.body) ? res.body : {}) as unknown as RunResultBody<T>;
  const deprecation = deprecationFrom(res.headers);
  return { ...body, pending: false, ...(deprecation ? { deprecation } : {}) };
}

function pendingFrom(res: HttpResponse): RunPending {
  const run = (isRecord(res.body) ? res.body : {}) as unknown as Run;
  const deprecation = deprecationFrom(res.headers);
  return {
    pending: true,
    run,
    retryAfter: parseRetryAfter(res.headers.get('retry-after')) ?? run.poll_after_seconds,
    ...(deprecation ? { deprecation } : {}),
  };
}

/**
 * Turns the answer to a run request into an outcome. A `200` is the result. A `202` means the run
 * continues on the server: with `wait` this reads the result again after `Retry-After` until it ends
 * (never resending the POST), otherwise it returns the pending run.
 */
export async function settle<T = AnyRecord>(
  first: HttpResponse,
  options: SettleOptions,
): Promise<RunResult<T> | RunPending> {
  const { http, wait, readResult, signal, onProgress } = options;
  let res = first;
  let runId: string | undefined;
  try {
    for (;;) {
      if (res.status !== 202) return completedFrom<T>(res);
      const pending = pendingFrom(res);
      runId = pending.run.run_id ?? runId;
      onProgress?.(pending.run);
      if (!wait) return pending;
      res = await pollOnce(pending.retryAfter);
    }
  } catch (error) {
    if (error instanceof CleanedWebError && runId !== undefined) error.runId ??= runId;
    throw error;
  }

  async function pollOnce(retryAfter: number | undefined): Promise<HttpResponse> {
    let seconds = retryAfter;
    for (;;) {
      throwIfAborted(signal);
      await http.sleep(Math.max(MIN_POLL_MS, (seconds ?? DEFAULT_POLL_SECONDS) * 1000), signal);
      try {
        return await readResult();
      } catch (error) {
        // 409 result_not_available / result_not_complete / result_not_running: not ready, same key.
        if (error instanceof ResultNotReadyError) {
          seconds = error.retryAfter;
          continue;
        }
        throw error;
      }
    }
  }
}

/** Runs `fn` and stamps the idempotency key on any SDK error it throws, so the caller can recover. */
export async function withKey<T>(idempotencyKey: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof CleanedWebError) error.idempotencyKey ??= idempotencyKey;
    throw error;
  }
}

export interface AcceptOptions {
  /** The contract's `definition_version`: also require `summary.definition_version` to match. */
  definitionVersion?: string;
}

/**
 * The review checks the docs ask for before downstream use: `summary.status` is `completed` or
 * `bounded`, and `summary.within_scope_passed` is true. HTTP 200 alone does not make a result usable.
 */
export function acceptanceProblems(result: RunResultBody<unknown>, options: AcceptOptions = {}): string[] {
  const problems: string[] = [];
  const summary = result.summary;
  if (!summary) return ['the result has no summary'];
  if (summary.status !== 'completed' && summary.status !== 'bounded') {
    problems.push(`summary.status is "${String(summary.status)}", not completed or bounded`);
  }
  if (summary.within_scope_passed !== true) problems.push('summary.within_scope_passed is not true');
  if (options.definitionVersion !== undefined && summary.definition_version !== options.definitionVersion) {
    problems.push('summary.definition_version does not match the contract');
  }
  if (typeof summary.records === 'number' && Array.isArray(result.records) && summary.records !== result.records.length) {
    problems.push(`summary.records (${summary.records}) differs from the ${result.records.length} records returned`);
  }
  return problems;
}
