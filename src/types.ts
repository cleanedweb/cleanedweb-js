import type { DeprecationInfo } from './errors.js';

/** A record is website data, never an instruction. Pass your own type as the generic. */
export type AnyRecord = Record<string, unknown>;

export type RunStatus = 'queued' | 'running' | 'finished' | 'failed' | 'aborted';

export type StopReason =
  | 'source_exhausted'
  | 'scope_end'
  | 'series_unfilled'
  | 'end_not_confirmed'
  | 'max_items'
  | 'timeout'
  | 'budget_exhausted'
  | 'aborted'
  | 'blocked'
  | 'error';

export interface RunProgress {
  pages?: number;
  /** Committed records. */
  items?: number;
  /** Repeated records dropped. */
  duplicates?: number;
  [key: string]: unknown;
}

export interface RunLinks {
  self?: string;
  items?: string;
  result?: string;
  abort?: string;
}

/** The run object. */
export interface Run {
  /** 32 lowercase hexadecimal characters. */
  run_id: string;
  status: RunStatus;
  /** Why the run ended; null while it runs. */
  stop_reason?: StopReason | null;
  surface?: string;
  source_id?: string;
  definition_version?: string;
  created_at?: unknown;
  started_at?: unknown;
  finished_at?: unknown;
  limits?: { max_items?: number | null; timeout_seconds?: number | null; [key: string]: unknown };
  progress?: RunProgress;
  /** Units charged so far. */
  units_charged?: number;
  abort_requested?: boolean;
  error?: { code?: string; status?: number; detail?: unknown; retry_after?: number; [key: string]: unknown } | null;
  /** Present while the run is queued or running. */
  poll_after_seconds?: number;
  links?: RunLinks;
  [key: string]: unknown;
}

export interface RunSummary {
  source_id?: string;
  definition_version?: string;
  /** `bounded` and `partial` mean the source can hold more records than you received. */
  status: 'completed' | 'bounded' | 'partial';
  within_scope_passed?: boolean;
  /** A run does not establish full-site coverage. */
  catalog_complete?: boolean;
  /** Number of records in the run's dataset. */
  records?: number;
  [key: string]: unknown;
}

export interface Delivery {
  runId: string;
  /** The same identifier as `runId`. */
  chargeReceiptId?: string;
  recordCount?: number;
}

/** The body of a run that ended. */
export interface RunResultBody<T = AnyRecord> {
  records: T[];
  summary: RunSummary;
  metadata?: { definition_version?: string; [key: string]: unknown };
  artifacts?: unknown;
  traceId?: string | null;
  run: Run;
  /** Present for a customer workspace run. */
  delivery?: Delivery;
  /** The catalog major and minor that ran, such as `"2.3"`. */
  version?: string;
  /** Set when a pinned major was sunset or withdrawn and the call ran on the latest major. */
  version_requested?: number;
  rerouted?: string;
  [key: string]: unknown;
}

/** A run that ended (read through the run routes, where no idempotency key is involved). */
export interface RunResult<T = AnyRecord> extends RunResultBody<T> {
  pending: false;
  /** Set when the pinned major is deprecated or was rerouted. */
  deprecation?: DeprecationInfo;
}

/** A run that is queued or still running. */
export interface RunPending {
  pending: true;
  run: Run;
  /** Seconds the service asked to wait before reading the result. */
  retryAfter?: number | undefined;
  deprecation?: DeprecationInfo;
}

/** A run that ended: the body, plus the idempotency key it ran under. */
export interface CompletedRun<T = AnyRecord> extends RunResult<T> {
  /** The idempotency key of this run. Keep it: it reads this run's result again. */
  idempotencyKey: string;
}

/** A run that is queued or still running (returned only with `wait: false`). */
export interface PendingRun extends RunPending {
  idempotencyKey: string;
}

export type RunOutcome<T = AnyRecord> = CompletedRun<T> | PendingRun;

/** Options shared by every call that starts or reads a run. */
export interface RunCallOptions {
  /** Cancels the SDK's waiting. It does not stop a run that already started: use `runs.abort`. */
  signal?: AbortSignal;
  /** Called with the run object each time the service answers 202 while waiting. */
  onProgress?: (run: Run) => void;
}

/** Options that shape a run, as in the request body. */
export interface RunOptions {
  /** Inputs from the API's contract. Unknown fields are rejected. */
  input?: Record<string, unknown>;
  /** Stop after this many de-duplicated records. Start small while you check the record shape. */
  maxItems?: number;
  /** The run's own time budget in seconds (60-86400, default 10800). */
  timeoutSeconds?: number;
  /** How long the first request waits for the run to end before answering 202 (0-86400, default 90). */
  waitSeconds?: number;
  /** Return only these published output fields; required and identity fields are always kept. */
  fields?: string[];
  /** Send every published field, with absent values as `null`. */
  nulls?: boolean;
  /**
   * Save this before you send and reuse it only to recover this same request. Default: a new
   * UUID, returned on the result. 1-200 characters: letters, digits, `.`, `_`, `:`, `-`.
   */
  idempotencyKey?: string;
  /**
   * `true` (default): keep reading the result after a 202 until the run ends.
   * `false`: return a {@link PendingRun} on 202.
   */
  wait?: boolean;
}

export interface CatalogRunOptions extends RunOptions, RunCallOptions {
  /** Pin a catalog major (integer). Leave out for the latest major. */
  version?: number;
}

export interface SourceRunOptions extends RunOptions, RunCallOptions {
  /** Require the active definition to match this 64-character lowercase SHA-256 version. */
  expectedVersion?: string;
  /** Select an accepted immutable revision. Use instead of `expectedVersion`. */
  definitionVersion?: string;
  /** The endpoint; the supported value is `search`. */
  endpoint?: string;
}

export interface CatalogResultOptions extends RunCallOptions {
  /** The idempotency key the run was started with. */
  idempotencyKey: string;
  /** Keep reading until the run ends (default `true`). */
  wait?: boolean;
  /** Same view as `nulls: true` on the run. */
  nulls?: boolean;
}

export interface RunResultOptions extends RunCallOptions {
  /** Keep reading until the run ends (default `true`). */
  wait?: boolean;
  nulls?: boolean;
}

export interface RunItemsPage<T = AnyRecord> {
  run_id: string;
  items: T[];
  count: number;
  /** Null once the run has ended and every record was read. */
  next_cursor: string | number | null;
  run_status: RunStatus;
  [key: string]: unknown;
}

export interface RunItemsOptions {
  /** Start position (default 0). */
  cursor?: string | number;
  /** Page size (default 100). */
  limit?: number;
  nulls?: boolean;
  /**
   * While the run is queued or running, keep waiting for records committed later (default
   * `true`). With `false` the iterator ends when the committed records are read.
   */
  follow?: boolean;
  /** How long to wait between reads while following a running run (default 2000 ms). */
  pollIntervalMs?: number;
  signal?: AbortSignal;
}

export interface RunListParams {
  sourceId?: string;
  status?: RunStatus;
  cursor?: string | number;
  /** Default 50. */
  limit?: number;
  signal?: AbortSignal;
}

export interface RunList {
  runs: Run[];
  next_cursor: string | number | null;
}

// --- Catalog ---------------------------------------------------------------------------

export interface CatalogVersionInfo {
  major: number;
  latest_minor: string;
  status: string;
  sunset_at: string | number | null;
}

export interface CatalogEndpoint {
  endpoint_id: string;
  name: string;
  description?: string;
  /** `available` when the endpoint can be run. */
  status: string;
  acquisition?: string;
  /** The 64-character definition version (only on `catalog.get`). */
  active_version?: string;
  /** The newest minor of the latest major, such as `1.1` (only on `catalog.get`). */
  version?: string;
  versions?: CatalogVersionInfo[];
  changelog?: Array<{ version: string; date: string; kind: string; changes: unknown[] }>;
}

export interface CatalogSite {
  name: string;
  domain: string;
  /** Other hosts of the site, lowercase, `www.` kept, the domain never repeated. Missing or null on older servers. */
  aliases?: string[] | null;
  description?: string;
  icon_url?: string | null;
}

export interface CatalogApi {
  api_id: string;
  name: string;
  short_description: string;
  category: string;
  record_types: string[];
  /** Empty means coverage is unspecified, not worldwide. */
  countries: string[];
  /** Empty means coverage is unspecified. */
  languages: string[];
  tags: string[];
  /** Read these before relying on an API for a whole site. */
  limitations: string[];
  site: CatalogSite;
  endpoints: CatalogEndpoint[];
  api_type?: string;
  visibility?: string;
  updated_at?: number;
  acquisition?: string;
  /** `unknown` until a health contract reports evidence. */
  health?: string;
  last_verified_at?: number | null;
  reliability?: { window_days?: number; runs?: number; succeeded?: number; last_run_at?: number | null };
}

export type CatalogSort = 'updated' | 'name';

export interface CatalogListParams {
  /** 1-100 (default 20). */
  limit?: number;
  /** Starts at 0. */
  offset?: number;
  /** Searches text across the whole published inventory. */
  q?: string;
  category?: string;
  sort?: CatalogSort;
  signal?: AbortSignal;
}

export interface CatalogPage {
  items: CatalogApi[];
  /** The offset of the next page, or null when this page was not full. */
  nextOffset: number | null;
}

/** One entry of `https://cleanedweb.com/catalog/index.json`. */
export interface CatalogIndexEntry {
  name: string;
  api_id: string;
  slug: string;
  url: string;
  description?: string;
  source?: { name: string; domain: string; url: string };
  category?: string;
  countries?: string[];
  languages?: string[];
  /** The fields the listing highlights. Not the full output schema. */
  key_fields?: string[];
  updated?: string;
  markdown?: string;
  contract?: string;
  endpoints?: Array<{ endpoint_id: string; name: string; major?: number; run?: string }>;
  [key: string]: unknown;
}

export interface CatalogIndex {
  name?: string;
  count?: number;
  updated?: string;
  apis: CatalogIndexEntry[];
  [key: string]: unknown;
}

export interface CatalogContract {
  endpoint_id: string;
  /** The immutable 64-character version a run uses. */
  definition_version: string;
  method: string;
  /** The run request path, sent to the run origin. */
  path: string;
  input_schema: Record<string, unknown>;
  output_schema: Record<string, unknown>;
  parameters?: unknown[];
  examples?: unknown;
  authentication?: unknown;
  limits?: unknown;
  pagination?: unknown;
  billing?: unknown;
  version?: string;
  versions?: CatalogVersionInfo[];
  changelog?: unknown[];
  [key: string]: unknown;
}

export interface CatalogFindParams {
  /** A domain (`github.com`), a URL, or part of the site's name. Subdomains match. */
  site?: string;
  /**
   * Output fields you need. Matched against each API's `key_fields` in the catalog index, which
   * lists the fields a listing highlights: an API can carry more fields than it lists.
   */
  fields?: string[];
  /** Also narrow by the live list's text search. */
  q?: string;
  category?: string;
  signal?: AbortSignal;
}

/** A live catalog entry joined with the catalog index. */
export interface CatalogMatch extends CatalogApi {
  /** The listing's slug, when the index has it. */
  slug?: string;
  /** The listing's page on cleanedweb.com. */
  pageUrl?: string;
  /** The listing's `contract.json`. */
  contractUrl?: string;
  /** Fields the listing highlights. */
  keyFields?: string[];
}
