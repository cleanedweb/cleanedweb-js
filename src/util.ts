import { CleanedWebAbortError } from './errors.js';

const KEY_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;

/** A fresh idempotency key (a UUID v4). */
export function generateIdempotencyKey(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  // Node 18 has no global crypto outside --experimental-global-webcrypto.
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') {
    c.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Throws a `TypeError` unless `key` is 1-200 characters of letters, digits, `.`, `_`, `:`, `-`. */
export function assertIdempotencyKey(key: string): void {
  if (typeof key !== 'string' || !KEY_PATTERN.test(key)) {
    throw new TypeError(
      'idempotencyKey must be 1-200 characters: letters, digits, ".", "_", ":" or "-".',
    );
  }
}

/** Parses `Retry-After` (delta-seconds or an HTTP date) to seconds. */
export function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, Math.ceil((date - Date.now()) / 1000));
}

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

/** Waits `ms`, rejecting with a `CleanedWebAbortError` as soon as `signal` fires. */
export const defaultSleep: Sleep = (ms, signal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new CleanedWebAbortError(signal.reason));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new CleanedWebAbortError(signal?.reason));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new CleanedWebAbortError(signal.reason);
}

export function encodeSegment(value: string): string {
  return encodeURIComponent(value);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Drops `undefined` values so they are not sent. */
export function compact<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export function assertIntegerInRange(name: string, value: number | undefined, min: number, max?: number): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value < min || (max !== undefined && value > max)) {
    throw new RangeError(
      max === undefined
        ? `${name} must be an integer of at least ${min}.`
        : `${name} must be an integer from ${min} to ${max}.`,
    );
  }
}
