import {
  APIError,
  AuthenticationError,
  CleanedWebAbortError,
  CleanedWebConnectionError,
  CleanedWebTimeoutError,
  ConfigurationError,
  IdempotencyConflictError,
  InsufficientCreditError,
  NotFoundError,
  PermissionError,
  RateLimitError,
  ResultNotReadyError,
  RunFailedError,
  ServerError,
  UsageBudgetExceededError,
  ValidationError,
  VersionConflictError,
} from './errors.js';
import type { APIErrorInit, DeprecationInfo } from './errors.js';
import { isRecord, parseRetryAfter, throwIfAborted } from './util.js';
import type { Sleep } from './util.js';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpConfig {
  apiKey: string | undefined;
  /** Run origin (runs, results, run routes). */
  baseUrl: string;
  /** Live catalog origin (anonymous reads). */
  catalogUrl: string;
  /** Public site origin (catalog index). */
  siteUrl: string;
  fetch: FetchLike;
  maxRetries: number;
  timeoutMs: number;
  maxRetryDelayMs: number;
  sleep: Sleep;
}

export type Target = 'run' | 'catalog' | 'site';

export interface RequestSpec {
  target: Target;
  method: 'GET' | 'POST';
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  idempotencyKey?: string;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
  /** Override the client's `maxRetries` for this request. */
  maxRetries?: number | undefined;
}

export interface HttpResponse {
  status: number;
  headers: Headers;
  /** Parsed JSON; the raw text when the body was not JSON; null when empty. */
  body: unknown;
}

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const RESULT_NOT_READY = new Set(['result_not_available', 'result_not_complete', 'result_not_running']);
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 8_000;

export function deprecationFrom(headers: Headers): DeprecationInfo | undefined {
  const deprecation = headers.get('deprecation');
  const sunset = headers.get('sunset');
  const link = headers.get('link');
  if (deprecation === null && sunset === null) return undefined;
  return { deprecation, sunset, link };
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

export class HttpClient {
  constructor(readonly config: HttpConfig) {}

  get sleep(): Sleep {
    return this.config.sleep;
  }

  private originFor(target: Target): string {
    switch (target) {
      case 'run':
        return this.config.baseUrl;
      case 'catalog':
        return this.config.catalogUrl;
      default:
        return this.config.siteUrl;
    }
  }

  /**
   * Sends one request, retrying 429/502/503/504 and lost connections with bounded backoff.
   * Every request the SDK sends is safe to repeat: runs carry an idempotency key, the rest are
   * reads or an abort. A failed run (an error with `error_code`) is final and is never retried.
   * Resolves for 2xx; throws a typed error otherwise.
   */
  async request(spec: RequestSpec): Promise<HttpResponse> {
    const { config } = this;
    if (spec.target === 'run' && !config.apiKey) {
      throw new ConfigurationError(
        'No API key. Pass { apiKey } or set CLEANEDWEB_API_KEY (a key with the "run" scope).',
      );
    }
    const url = this.buildUrl(spec);
    const maxRetries = spec.maxRetries ?? config.maxRetries;
    const headers: Record<string, string> = { Accept: 'application/json' };
    // The key goes only to the run origin; the catalog reads are anonymous.
    if (spec.target === 'run' && config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
    if (spec.idempotencyKey !== undefined) headers['Idempotency-Key'] = spec.idempotencyKey;
    let payload: string | undefined;
    if (spec.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(spec.body);
    }

    for (let attempt = 0; ; attempt += 1) {
      throwIfAborted(spec.signal);
      let response: HttpResponse;
      try {
        response = await this.send(url, spec, headers, payload);
      } catch (error) {
        if (error instanceof CleanedWebAbortError || error instanceof ConfigurationError) throw error;
        if (attempt < maxRetries) {
          await config.sleep(this.backoff(attempt), spec.signal);
          continue;
        }
        throw error;
      }

      if (response.status >= 200 && response.status < 300) return response;

      const error = this.toError(response);
      if (
        attempt < maxRetries &&
        RETRYABLE_STATUS.has(response.status) &&
        !(error instanceof RunFailedError)
      ) {
        const wanted = error.retryAfter === undefined ? this.backoff(attempt) : error.retryAfter * 1000;
        if (wanted <= config.maxRetryDelayMs) {
          await config.sleep(wanted, spec.signal);
          continue;
        }
      }
      throw error;
    }
  }

  private buildUrl(spec: RequestSpec): string {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(spec.query ?? {})) {
      if (value !== undefined) query.set(key, String(value));
    }
    const qs = query.toString();
    return `${stripTrailingSlash(this.originFor(spec.target))}${spec.path}${qs ? `?${qs}` : ''}`;
  }

  private backoff(attempt: number): number {
    const base = Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_CAP_MS);
    return Math.round(base / 2 + Math.random() * (base / 2));
  }

  private async send(
    url: string,
    spec: RequestSpec,
    headers: Record<string, string>,
    payload: string | undefined,
  ): Promise<HttpResponse> {
    const { config } = this;
    const timeoutMs = spec.timeoutMs ?? config.timeoutMs;
    const controller = new AbortController();
    const caller = spec.signal;
    const onCallerAbort = () => controller.abort(caller?.reason);
    caller?.addEventListener('abort', onCallerAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      const init: RequestInit = {
        method: spec.method,
        headers,
        // A redirect means the wrong origin: nothing ran. Surface it instead of following it.
        redirect: 'manual',
        signal: controller.signal,
      };
      if (payload !== undefined) init.body = payload;
      const res = await config.fetch(url, init);
      if ((res.status >= 300 && res.status < 400) || res.type === 'opaqueredirect') {
        throw new ConfigurationError(
          `The server redirected (HTTP ${res.status}) instead of answering. Nothing ran. Check baseUrl: runs are served by https://broker.cleanedweb.com.`,
        );
      }
      const text = await res.text();
      return { status: res.status, headers: res.headers, body: this.parseBody(text) };
    } catch (error) {
      if (error instanceof ConfigurationError) throw error;
      if (caller?.aborted) throw new CleanedWebAbortError(caller.reason);
      if (timedOut) {
        throw new CleanedWebTimeoutError(
          `No answer within ${timeoutMs} ms. The run may have started: keep the idempotency key and read the result with it.`,
          { cause: error },
        );
      }
      throw new CleanedWebConnectionError(
        'The connection failed. The run may have started: keep the idempotency key and read the result with it.',
        { cause: error },
      );
    } finally {
      clearTimeout(timer);
      caller?.removeEventListener('abort', onCallerAbort);
    }
  }

  private parseBody(text: string): unknown {
    // Error bodies can echo credentials: scrub the key before anything is parsed or kept.
    const key = this.config.apiKey;
    const safe = key && text.includes(key) ? text.split(key).join('[redacted]') : text;
    if (safe === '') return null;
    try {
      return JSON.parse(safe) as unknown;
    } catch {
      return safe;
    }
  }

  private toError(response: HttpResponse): APIError {
    const { status, headers, body } = response;
    const detail = isRecord(body) ? body.detail : undefined;
    const detailObject = isRecord(detail) ? detail : undefined;
    const code = typeof detailObject?.code === 'string' ? detailObject.code : undefined;
    let message: string;
    if (typeof detailObject?.message === 'string') message = detailObject.message;
    else if (typeof detail === 'string' && detail !== '') message = detail;
    else if (Array.isArray(detail)) message = describeIssues(detail);
    else message = `HTTP ${status}`;
    const retryAfter =
      parseRetryAfter(headers.get('retry-after')) ??
      numberOrUndefined(detailObject?.retryAfterSeconds) ??
      numberOrUndefined(detailObject?.retry_after);
    const init: APIErrorInit = {
      status,
      code,
      message: code ? `${code}: ${message}` : message,
      detail,
      body,
      retryAfter,
      deprecation: deprecationFrom(headers),
    };

    const marker = detailObject?.error_code;
    if (marker === 'run_failed' || marker === 'failed_run_replayed') {
      return new RunFailedError({ ...init, errorCode: marker, replayed: detailObject?.replayed === true });
    }
    if (code === 'delivery_identity_conflict') return new IdempotencyConflictError(init);
    if (code === 'usage_budget_exceeded') return new UsageBudgetExceededError(init);
    if (code && RESULT_NOT_READY.has(code)) return new ResultNotReadyError(init);
    if (code === 'builder_definition_version_conflict' || code === 'catalog_version_conflict') {
      return new VersionConflictError(init);
    }
    if (status === 402) return new InsufficientCreditError(init);
    if (status === 401) return new AuthenticationError(init);
    if (status === 403) return new PermissionError(init);
    if (status === 404) return new NotFoundError(init);
    if (status === 429) return new RateLimitError(init);
    if (status === 400 || status === 415 || status === 422) return new ValidationError(init);
    if (status >= 500) return new ServerError(init);
    return new APIError(init);
  }
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function describeIssues(issues: unknown[]): string {
  const parts = issues.map((issue) => {
    if (isRecord(issue) && typeof issue.msg === 'string') {
      const where = Array.isArray(issue.loc) ? `${issue.loc.join('.')}: ` : '';
      return `${where}${issue.msg}`;
    }
    return typeof issue === 'string' ? issue : 'invalid value';
  });
  return parts.join('; ') || 'invalid request';
}
