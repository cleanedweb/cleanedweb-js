/**
 * Typed errors. Every error the SDK throws extends {@link CleanedWebError}.
 *
 * Errors never carry request headers, so the API key is not exposed through them.
 * `idempotencyKey` and `runId` are filled in when known, so a caller can recover a run
 * after a failure without having kept the key itself.
 */

/** Deprecation headers sent when a pinned catalog major is deprecated or was rerouted. */
export interface DeprecationInfo {
  /** `Deprecation: @<unix seconds>` (RFC 9745 date). */
  deprecation: string | null;
  /** `Sunset: <HTTP date>`, when the major has a sunset date. */
  sunset: string | null;
  /** `Link: <...>; rel="deprecation"`, the listing's changelog. */
  link: string | null;
}

export class CleanedWebError extends Error {
  /** The idempotency key of the run this error belongs to, when there is one. */
  idempotencyKey?: string;
  /** The run this error belongs to, when known. */
  runId?: string;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** The SDK was used with missing or unusable configuration (no API key, wrong origin). */
export class ConfigurationError extends CleanedWebError {}

/** No response arrived (connection lost, DNS, TLS). The run may have started: keep the key. */
export class CleanedWebConnectionError extends CleanedWebError {}

/** The client-side time limit passed before a response arrived. The run is not stopped. */
export class CleanedWebTimeoutError extends CleanedWebConnectionError {}

/**
 * The caller's `AbortSignal` fired. `name` is `AbortError`. Aborting only stops the SDK from
 * waiting: a run that was already admitted keeps running and is charged. Use `runs.abort` to
 * stop it, and `cause` holds the signal's reason.
 */
export class CleanedWebAbortError extends CleanedWebError {
  constructor(cause?: unknown) {
    super('The request was aborted by the caller. A run that already started keeps running.', { cause });
    this.name = 'AbortError';
  }
}

/** A finished run did not pass the acceptance checks of {@link assertAccepted}. */
export class ResultNotAcceptedError extends CleanedWebError {
  readonly reasons: string[];
  constructor(reasons: string[]) {
    super(`The run result needs review: ${reasons.join('; ')}`);
    this.reasons = reasons;
  }
}

export interface APIErrorInit {
  status: number;
  code?: string | undefined;
  message: string;
  detail?: unknown;
  body?: unknown;
  retryAfter?: number | undefined;
  deprecation?: DeprecationInfo | undefined;
}

/** The service answered with an error status. */
export class APIError extends CleanedWebError {
  /** HTTP status. */
  readonly status: number;
  /** The documented error `code` (for example `insufficient_units`), when the body has one. */
  readonly code: string | undefined;
  /** The raw `detail` of the body: text, an object, or a list of validation issues. */
  readonly detail: unknown;
  /** The parsed body (or the text, if it was not JSON). Never contains the API key. */
  readonly body: unknown;
  /** Seconds to wait before retrying, from `Retry-After` or the body. */
  readonly retryAfter: number | undefined;
  /** Deprecation headers, when the answer carried them. */
  readonly deprecation: DeprecationInfo | undefined;

  constructor(init: APIErrorInit) {
    super(init.message);
    this.status = init.status;
    this.code = init.code;
    this.detail = init.detail;
    this.body = init.body;
    this.retryAfter = init.retryAfter;
    this.deprecation = init.deprecation;
    const runId = (init.detail as { run_id?: unknown } | null)?.run_id;
    if (typeof runId === 'string') this.runId = runId;
  }
}

/** 401: no credential, or an invalid, expired or revoked key. */
export class AuthenticationError extends APIError {}

/** 403: the key lacks the `run` scope or is not tied to a workspace account. */
export class PermissionError extends APIError {}

/** 402 `insufficient_units`: the balance cannot fund the run. */
export class InsufficientCreditError extends APIError {
  /** Units the run needs. */
  readonly required: unknown;
  /** Units the balance has. */
  readonly available: unknown;
  constructor(init: APIErrorInit) {
    super(init);
    const detail = (init.detail ?? {}) as { required?: unknown; available?: unknown };
    this.required = detail.required;
    this.available = detail.available;
  }
}

/** 409 `usage_budget_exceeded`: the workspace's monthly usage budget cannot cover the request. */
export class UsageBudgetExceededError extends APIError {}

/** 409 `delivery_identity_conflict`: the idempotency key was already used for another request. */
export class IdempotencyConflictError extends APIError {}

/**
 * 409 version conflict: the active definition differs from `expectedVersion`
 * (`builder_definition_version_conflict`), or the endpoint's active version changed
 * (`catalog_version_conflict`).
 */
export class VersionConflictError extends APIError {}

/** 409 `result_not_available`, `result_not_complete` or `result_not_running`: retry the same key. */
export class ResultNotReadyError extends APIError {}

/**
 * 404: API, endpoint, run or delivery not found. For an unknown catalog major
 * (`catalog_version_not_found`) `available` lists the majors that answer.
 */
export class NotFoundError extends APIError {
  readonly available: number[] | undefined;
  constructor(init: APIErrorInit) {
    super(init);
    const available = (init.detail as { available?: unknown } | null)?.available;
    this.available = Array.isArray(available) ? (available as number[]) : undefined;
  }
}

/** 400, 415 or 422: an input, run option or query the service does not accept. Do not retry unchanged. */
export class ValidationError extends APIError {}

/** 429. `retryAfter` is the number of seconds to wait, when the service said so. */
export class RateLimitError extends APIError {}

/** 5xx without a failed-run marker. The run may not have started; retry with the same key. */
export class ServerError extends APIError {}

/**
 * The run itself failed (`detail.error_code` is `run_failed` or `failed_run_replayed`). This is final
 * for the idempotency key for 7 days: send a new key to run again. Records saved before the
 * failure stay readable through `runs.items(runId)`.
 */
export class RunFailedError extends APIError {
  /** `run_failed` for the failure itself, `failed_run_replayed` when the key was replayed. */
  readonly errorCode: 'run_failed' | 'failed_run_replayed';
  /** Whether this answer replays the key. */
  readonly replayed: boolean;
  constructor(init: APIErrorInit & { errorCode: 'run_failed' | 'failed_run_replayed'; replayed: boolean }) {
    super(init);
    this.errorCode = init.errorCode;
    this.replayed = init.replayed;
  }
}
