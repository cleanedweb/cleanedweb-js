import { NotFoundError } from './errors.js';
import type { HttpClient } from './http.js';
import { settle, withKey } from './runner.js';
import type {
  AnyRecord,
  CatalogApi,
  CatalogContract,
  CatalogFindParams,
  CatalogIndex,
  CatalogIndexEntry,
  CatalogListParams,
  CatalogMatch,
  CatalogPage,
  CatalogResultOptions,
  CatalogRunOptions,
  CompletedRun,
  RunOutcome,
} from './types.js';
import {
  assertIdempotencyKey,
  assertIntegerInRange,
  compact,
  encodeSegment,
  generateIdempotencyKey,
  isRecord,
} from './util.js';

const PAGE_SIZE = 100;
/** First request waits at most this long for a run to end (the documented default is 90 s). */
const DEFAULT_WAIT_SECONDS = 90;
const REQUEST_HEADROOM_MS = 30_000;

/**
 * Normalizes `https://www.GitHub.com./topics` to `github.com`; a bare name stays a lowercase name.
 * Drops the scheme, credentials, port, path, query, fragment, a leading `www.` and a trailing dot.
 */
function normalizeDomain(value: string): string {
  let host = value.trim().toLowerCase();
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  host = host.split(/[/?#]/)[0] ?? '';
  host = (host.split('@').pop() ?? '').split(':')[0] ?? '';
  host = host.replace(/^\.+|\.+$/g, '');
  return host.startsWith('www.') ? host.slice(4) : host;
}

/** `host` is `wanted` or a subdomain of it, or the other way round (a page of the site). */
function sameSiteHost(wanted: string, host: string): boolean {
  return wanted === host || host.endsWith(`.${wanted}`) || wanted.endsWith(`.${host}`);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `wanted` appears in a free-text name delimited as a host, so `seek.com.au` is not in `notseek.com.au`. */
function namesHost(wanted: string, text: string): boolean {
  return new RegExp(`(?<![a-z0-9.-])${escapeRegExp(wanted)}(?![a-z0-9-])`).test(text);
}

/**
 * Does `api` belong to `site` (a domain, a full URL, a name or a part of one)? A host-shaped `site`
 * (it has a dot) matches the API's domain and every `site.aliases` host on label boundaries: equal,
 * or one a subdomain of the other. Names match a host-shaped `site` only on host boundaries. A name
 * without a dot (`github`) is a substring of a host, the site name or the API name.
 */
function matchesSite(api: CatalogApi, site: string): boolean {
  const wanted = normalizeDomain(site);
  if (wanted === '') return true;
  const aliases = Array.isArray(api.site?.aliases) ? api.site.aliases : [];
  const hosts = [api.site?.domain, ...aliases]
    .map((h) => (typeof h === 'string' ? normalizeDomain(h) : ''))
    .filter((h) => h !== '');
  const names = [(api.site?.name ?? '').toLowerCase(), api.name.toLowerCase()].filter((t) => t !== '');
  if (wanted.includes('.') && !/\s/.test(wanted)) {
    return hosts.some((h) => sameSiteHost(wanted, h)) || names.some((t) => namesHost(wanted, t));
  }
  return [...hosts, ...names].some((t) => t.includes(wanted));
}

function normalizeField(field: string): string {
  return field.trim().toLowerCase();
}

/** Browse the public catalog (no API key) and run published catalog APIs. */
export class Catalog {
  constructor(private readonly http: HttpClient) {}

  /** One page of the live catalog list. Anonymous. */
  async list(params: CatalogListParams = {}): Promise<CatalogPage> {
    assertIntegerInRange('limit', params.limit, 1, 100);
    assertIntegerInRange('offset', params.offset, 0);
    const res = await this.http.request({
      target: 'catalog',
      method: 'GET',
      path: '/api/catalog/apis',
      query: { limit: params.limit, offset: params.offset, q: params.q, category: params.category, sort: params.sort },
      signal: params.signal,
    });
    const items = isRecord(res.body) && Array.isArray(res.body.items) ? (res.body.items as CatalogApi[]) : [];
    const limit = params.limit ?? 20;
    const offset = params.offset ?? 0;
    return { items, nextOffset: items.length >= limit ? offset + items.length : null };
  }

  /** Every published API, page by page. Offset paging reflects current content, not a snapshot. */
  async *iterate(params: Omit<CatalogListParams, 'limit' | 'offset'> = {}): AsyncGenerator<CatalogApi, void, undefined> {
    let offset: number | null = 0;
    while (offset !== null) {
      const page: CatalogPage = await this.list({ ...params, limit: PAGE_SIZE, offset });
      for (const item of page.items) yield item;
      offset = page.nextOffset;
    }
  }

  /** The catalog index on cleanedweb.com (`catalog/index.json`): slugs, sources and key fields. */
  async index(options: { signal?: AbortSignal } = {}): Promise<CatalogIndex> {
    const res = await this.http.request({
      target: 'site',
      method: 'GET',
      path: '/catalog/index.json',
      signal: options.signal,
    });
    const body = isRecord(res.body) ? res.body : {};
    return { ...body, apis: Array.isArray(body.apis) ? (body.apis as CatalogIndexEntry[]) : [] };
  }

  /**
   * One API with its endpoints and `active_version`. Takes an `api_id` (`generated_...`) or a
   * listing slug (`github-topics-repositories-api`); a slug is resolved through the catalog index.
   */
  async get(apiIdOrSlug: string, options: { signal?: AbortSignal } = {}): Promise<CatalogApi> {
    const slugLike = apiIdOrSlug.includes('-') && !apiIdOrSlug.startsWith('generated_');
    if (slugLike) {
      const entry = await this.findSlug(apiIdOrSlug, options.signal);
      if (entry) return this.getById(entry.api_id, options.signal);
    }
    try {
      return await this.getById(apiIdOrSlug, options.signal);
    } catch (error) {
      if (!slugLike && error instanceof NotFoundError) {
        const entry = await this.findSlug(apiIdOrSlug, options.signal).catch(() => undefined);
        if (entry) return this.getById(entry.api_id, options.signal);
      }
      throw error;
    }
  }

  /**
   * The contract of one endpoint: `input_schema`, `output_schema`, the run `path`, and the
   * `definition_version`. `version` reads a catalog major's contract.
   */
  async contract(
    apiId: string,
    endpointId: string,
    options: { version?: number; signal?: AbortSignal } = {},
  ): Promise<CatalogContract> {
    assertIntegerInRange('version', options.version, 1);
    const res = await this.http.request({
      target: 'catalog',
      method: 'GET',
      path: `/api/catalog/apis/${encodeSegment(apiId)}/endpoints/${encodeSegment(endpointId)}/contract`,
      query: { version: options.version },
      signal: options.signal,
    });
    return res.body as CatalogContract;
  }

  /**
   * Finds published APIs by site and by the fields you need. This filters on the client: it reads
   * the whole live list, and (for `fields`) the catalog index, whose `key_fields` are the fields a
   * listing highlights. Read the contract before relying on a field it does not list.
   */
  async find(params: CatalogFindParams = {}): Promise<CatalogMatch[]> {
    const wantFields = (params.fields ?? []).map(normalizeField).filter(Boolean);
    const listParams = compact({ q: params.q, category: params.category, signal: params.signal });
    const indexPromise = this.index({ ...(params.signal ? { signal: params.signal } : {}) });
    // With only `site` the index is a best-effort enrichment; with `fields` it is required.
    const indexOrNull = wantFields.length > 0 ? indexPromise : indexPromise.catch(() => null);
    const [apis, index] = await Promise.all([this.collect(listParams), indexOrNull]);
    const byId = new Map<string, CatalogIndexEntry>((index?.apis ?? []).map((entry) => [entry.api_id, entry]));

    const matches: CatalogMatch[] = [];
    for (const api of apis) {
      if (params.site !== undefined && !matchesSite(api, params.site)) continue;
      const entry = byId.get(api.api_id);
      const keyFields = entry?.key_fields?.map(normalizeField);
      if (wantFields.length > 0 && !(keyFields && wantFields.every((f) => keyFields.includes(f)))) continue;
      matches.push({
        ...api,
        ...(entry?.slug ? { slug: entry.slug } : {}),
        ...(entry?.url ? { pageUrl: entry.url } : {}),
        ...(entry?.contract ? { contractUrl: entry.contract } : {}),
        ...(entry?.key_fields ? { keyFields: entry.key_fields } : {}),
      });
    }
    return matches;
  }

  /**
   * Runs a catalog endpoint. Charged per record delivered, from your workspace's credit.
   *
   * Sends one `POST`. If the run ends within `waitSeconds` the answer is the result. Otherwise the
   * run continues on the server (`202`): with `wait` (default) this reads `/result` with the same
   * key after each `Retry-After` until the run ends and never resends the POST; with
   * `wait: false` it returns a pending run. The idempotency key (generated unless you pass one) is on
   * the result and on every error thrown, so a lost response can be recovered with
   * {@link Catalog.result}.
   *
   * Check {@link isAccepted} before using the records.
   */
  run<T = AnyRecord>(apiId: string, endpointId: string, options: CatalogRunOptions & { wait: false }): Promise<RunOutcome<T>>;
  run<T = AnyRecord>(apiId: string, endpointId: string, options?: CatalogRunOptions & { wait?: true }): Promise<CompletedRun<T>>;
  async run<T = AnyRecord>(apiId: string, endpointId: string, options: CatalogRunOptions = {}): Promise<RunOutcome<T>> {
    assertIntegerInRange('maxItems', options.maxItems, 1);
    assertIntegerInRange('timeoutSeconds', options.timeoutSeconds, 60, 86_400);
    assertIntegerInRange('waitSeconds', options.waitSeconds, 0, 86_400);
    assertIntegerInRange('version', options.version, 1);
    const idempotencyKey = options.idempotencyKey ?? generateIdempotencyKey();
    assertIdempotencyKey(idempotencyKey);
    const root = this.root(apiId, endpointId);
    const body = compact({
      input: options.input ?? {},
      max_items: options.maxItems,
      timeout_seconds: options.timeoutSeconds,
      wait_seconds: options.waitSeconds,
      fields: options.fields,
      nulls: options.nulls,
      version: options.version,
    });

    return withKey(idempotencyKey, async () => {
      const first = await this.http.request({
        target: 'run',
        method: 'POST',
        path: `${root}/run`,
        body,
        idempotencyKey,
        signal: options.signal,
        timeoutMs: Math.max(
          this.http.config.timeoutMs,
          (options.waitSeconds ?? DEFAULT_WAIT_SECONDS) * 1000 + REQUEST_HEADROOM_MS,
        ),
      });
      const outcome = await settle<T>(first, {
        http: this.http,
        wait: options.wait !== false,
        signal: options.signal,
        onProgress: options.onProgress,
        readResult: () => this.readResult(root, idempotencyKey, options.nulls, options.signal),
      });
      return { ...outcome, idempotencyKey } as RunOutcome<T>;
    });
  }

  /**
   * Reads a catalog run's result with the API key and the idempotency key it started with: after a
   * `202`, a lost response, or a crash. It never collects the website again, and works after the
   * API is unpublished or its version changes.
   */
  result<T = AnyRecord>(apiId: string, endpointId: string, options: CatalogResultOptions & { wait: false }): Promise<RunOutcome<T>>;
  result<T = AnyRecord>(apiId: string, endpointId: string, options: CatalogResultOptions & { wait?: true }): Promise<CompletedRun<T>>;
  async result<T = AnyRecord>(apiId: string, endpointId: string, options: CatalogResultOptions): Promise<RunOutcome<T>> {
    const { idempotencyKey } = options;
    assertIdempotencyKey(idempotencyKey);
    const root = this.root(apiId, endpointId);
    return withKey(idempotencyKey, async () => {
      const first = await this.readResult(root, idempotencyKey, options.nulls, options.signal);
      const outcome = await settle<T>(first, {
        http: this.http,
        wait: options.wait !== false,
        signal: options.signal,
        onProgress: options.onProgress,
        readResult: () => this.readResult(root, idempotencyKey, options.nulls, options.signal),
      });
      return { ...outcome, idempotencyKey } as RunOutcome<T>;
    });
  }

  private root(apiId: string, endpointId: string): string {
    return `/v1/catalog/public/apis/${encodeSegment(apiId)}/endpoints/${encodeSegment(endpointId)}`;
  }

  private readResult(root: string, idempotencyKey: string, nulls: boolean | undefined, signal: AbortSignal | undefined) {
    return this.http.request({
      target: 'run',
      method: 'GET',
      path: `${root}/result`,
      query: { nulls: nulls === true ? 'true' : undefined },
      idempotencyKey,
      signal,
    });
  }

  private async getById(apiId: string, signal: AbortSignal | undefined): Promise<CatalogApi> {
    const res = await this.http.request({
      target: 'catalog',
      method: 'GET',
      path: `/api/catalog/apis/${encodeSegment(apiId)}`,
      signal,
    });
    return res.body as CatalogApi;
  }

  private async findSlug(slug: string, signal: AbortSignal | undefined): Promise<CatalogIndexEntry | undefined> {
    const index = await this.index(signal ? { signal } : {});
    return index.apis.find((entry) => entry.slug === slug);
  }

  private async collect(params: Omit<CatalogListParams, 'limit' | 'offset'>): Promise<CatalogApi[]> {
    const all: CatalogApi[] = [];
    for await (const api of this.iterate(params)) all.push(api);
    return all;
  }
}
