import { Catalog } from './catalog.js';
import { ConfigurationError } from './errors.js';
import { HttpClient } from './http.js';
import type { FetchLike } from './http.js';
import { Runs } from './runs.js';
import { Sources } from './sources.js';
import { defaultSleep } from './util.js';
import type { Sleep } from './util.js';

/** The run origin: runs, results and the generic run routes. */
export const DEFAULT_BASE_URL = 'https://api.cleanedweb.com';
/** The live catalog (anonymous reads). */
export const DEFAULT_CATALOG_URL = 'https://app.cleanedweb.com';
/** The public site (catalog index). */
export const DEFAULT_SITE_URL = 'https://cleanedweb.com';

export interface CleanedWebOptions {
  /**
   * An API key with the `run` scope. Defaults to `process.env.CLEANEDWEB_API_KEY`. Keep it on the
   * server: never bundle it into browser code. Catalog reads need no key.
   */
  apiKey?: string | undefined;
  /**
   * The run origin, without a path (default `https://api.cleanedweb.com`). For a private source
   * API, use the origin from its connection details. The API key is sent only to this origin.
   */
  baseUrl?: string;
  /** The live catalog origin (default `https://app.cleanedweb.com`). Never receives the key. */
  catalogUrl?: string;
  /** The public site origin for the catalog index (default `https://cleanedweb.com`). Never receives the key. */
  siteUrl?: string;
  /** A fetch implementation (default: the global `fetch`). */
  fetch?: FetchLike;
  /**
   * How often a request is repeated after a lost connection, `429`, `502`, `503` or `504`
   * (default 2; 0 turns retries off). Retries keep the idempotency key and wait `Retry-After`. A
   * failed run is never retried.
   */
  maxRetries?: number;
  /** Per-request client time limit in ms (default 120000). A run request waits longer when `waitSeconds` asks for it. */
  timeoutMs?: number;
  /** A `Retry-After` longer than this many ms is thrown instead of waited for (default 30000). */
  maxRetryDelayMs?: number;
  /** Replaces the timer used between retries and polls. For tests. */
  sleep?: Sleep;
}

function envApiKey(): string | undefined {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  const value = proc?.env?.CLEANEDWEB_API_KEY;
  return value && value.trim() !== '' ? value.trim() : undefined;
}

function validateOrigin(name: string, value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigurationError(`${name} must be an absolute URL, such as ${DEFAULT_BASE_URL}.`);
  }
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    throw new ConfigurationError(`${name} must be an https:// URL, so the API key is not sent in clear text.`);
  }
  return value.replace(/\/+$/, '');
}

/**
 * The CleanedWeb client.
 *
 * ```ts
 * const cw = new CleanedWeb(); // reads CLEANEDWEB_API_KEY
 * const result = await cw.catalog.run(apiId, endpointId, { input: {}, maxItems: 25 });
 * ```
 */
export class CleanedWeb {
  /** Browse the public catalog and run published APIs. */
  readonly catalog: Catalog;
  /** Read and control runs by `run_id`. */
  readonly runs: Runs;
  /** Run your own (private) source APIs. */
  readonly sources: Sources;

  constructor(options: CleanedWebOptions = {}) {
    const apiKey = 'apiKey' in options ? options.apiKey : envApiKey();
    const fetchImpl = options.fetch ?? (globalThis as { fetch?: FetchLike }).fetch;
    if (typeof fetchImpl !== 'function') {
      throw new ConfigurationError('No global fetch found. Use Node 18+, or pass { fetch }.');
    }
    const maxRetries = options.maxRetries ?? 2;
    if (!Number.isInteger(maxRetries) || maxRetries < 0) {
      throw new RangeError('maxRetries must be a non-negative integer.');
    }
    const http = new HttpClient({
      apiKey: apiKey && apiKey.trim() !== '' ? apiKey.trim() : undefined,
      baseUrl: validateOrigin('baseUrl', options.baseUrl ?? DEFAULT_BASE_URL),
      catalogUrl: validateOrigin('catalogUrl', options.catalogUrl ?? DEFAULT_CATALOG_URL),
      siteUrl: validateOrigin('siteUrl', options.siteUrl ?? DEFAULT_SITE_URL),
      // Call through globalThis so a bare global fetch keeps its receiver in browsers and workers.
      fetch: options.fetch ?? ((input, init) => (fetchImpl as FetchLike).call(globalThis, input, init)),
      maxRetries,
      timeoutMs: options.timeoutMs ?? 120_000,
      maxRetryDelayMs: options.maxRetryDelayMs ?? 30_000,
      sleep: options.sleep ?? defaultSleep,
    });
    this.catalog = new Catalog(http);
    this.runs = new Runs(http);
    this.sources = new Sources(http);
  }
}
