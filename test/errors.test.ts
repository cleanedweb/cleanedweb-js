import { describe, expect, it } from 'vitest';
import {
  APIError,
  AuthenticationError,
  CleanedWebError,
  IdempotencyConflictError,
  InsufficientCreditError,
  NotFoundError,
  PermissionError,
  RateLimitError,
  ServerError,
  UsageBudgetExceededError,
  ValidationError,
  VersionConflictError,
} from '../src/index.js';
import { API_ID, ENDPOINT_ID, json, setup } from './helpers.js';
import type { Responder } from './helpers.js';

async function failWith(responder: Responder) {
  const { cw } = setup([responder], { maxRetries: 0 });
  return (await cw.catalog.run(API_ID, ENDPOINT_ID, { idempotencyKey: 'err-1' }).catch((e: unknown) => e)) as APIError;
}

describe('typed errors', () => {
  it('401 -> AuthenticationError', async () => {
    const error = await failWith(() => json(401, { detail: 'Unauthorized' }));
    expect(error).toBeInstanceOf(AuthenticationError);
    expect(error).toBeInstanceOf(APIError);
    expect(error).toBeInstanceOf(CleanedWebError);
    expect(error.status).toBe(401);
    expect(error.message).toBe('Unauthorized');
    expect(error.idempotencyKey).toBe('err-1');
  });

  it('403 -> PermissionError with the code', async () => {
    const error = await failWith(() => json(403, { detail: { code: 'workspace_billing_identity_invalid', message: 'No workspace' } }));
    expect(error).toBeInstanceOf(PermissionError);
    expect(error.code).toBe('workspace_billing_identity_invalid');
  });

  it('402 insufficient_units -> InsufficientCreditError with required and available', async () => {
    const error = await failWith(() =>
      json(402, { detail: { code: 'insufficient_units', message: 'Add Units', required: 120, available: 40 } }),
    );
    expect(error).toBeInstanceOf(InsufficientCreditError);
    const credit = error as InsufficientCreditError;
    expect(credit.required).toBe(120);
    expect(credit.available).toBe(40);
    expect(credit.code).toBe('insufficient_units');
  });

  it('429 -> RateLimitError with retryAfter from the header', async () => {
    const error = await failWith(() => json(429, { detail: 'Too many requests' }, { 'retry-after': '17' }));
    expect(error).toBeInstanceOf(RateLimitError);
    expect(error.retryAfter).toBe(17);
  });

  it('429 reads retryAfterSeconds from the body when there is no header', async () => {
    const error = await failWith(() => json(429, { detail: { retryAfterSeconds: 9, message: 'slow' } }));
    expect(error.retryAfter).toBe(9);
  });

  it('parses an HTTP-date Retry-After', async () => {
    const date = new Date(Date.now() + 10_000).toUTCString();
    const error = await failWith(() => json(429, { detail: 'x' }, { 'retry-after': date }));
    expect(error.retryAfter).toBeGreaterThanOrEqual(8);
    expect(error.retryAfter).toBeLessThanOrEqual(11);
  });

  it('409 delivery_identity_conflict -> IdempotencyConflictError', async () => {
    const error = await failWith(() => json(409, { detail: { code: 'delivery_identity_conflict', message: 'Use a new key' } }));
    expect(error).toBeInstanceOf(IdempotencyConflictError);
  });

  it('409 usage_budget_exceeded -> UsageBudgetExceededError', async () => {
    const error = await failWith(() => json(409, { detail: { code: 'usage_budget_exceeded', message: 'budget' } }));
    expect(error).toBeInstanceOf(UsageBudgetExceededError);
  });

  it.each(['builder_definition_version_conflict', 'catalog_version_conflict'])('409 %s -> VersionConflictError', async (code) => {
    const error = await failWith(() => json(409, { detail: { code } }));
    expect(error).toBeInstanceOf(VersionConflictError);
    expect(error.code).toBe(code);
  });

  it('404 -> NotFoundError, listing available majors for an unknown version', async () => {
    const error = await failWith(() =>
      json(404, { detail: { code: 'catalog_version_not_found', message: 'No such version', available: [1, 2] } }),
    );
    expect(error).toBeInstanceOf(NotFoundError);
    expect((error as NotFoundError).available).toEqual([1, 2]);
  });

  it('422 -> ValidationError for run_option_invalid, text details and validation issue lists', async () => {
    const option = await failWith(() => json(422, { detail: { code: 'run_option_invalid', message: 'max_items out of range', option: 'max_items' } }));
    expect(option).toBeInstanceOf(ValidationError);
    expect(option.code).toBe('run_option_invalid');
    const issues = await failWith(() => json(422, { detail: [{ loc: ['body', 'input', 'sort'], msg: 'unexpected field', type: 'x' }] }));
    expect(issues).toBeInstanceOf(ValidationError);
    expect(issues.message).toBe('body.input.sort: unexpected field');
  });

  it('5xx -> ServerError; a non-JSON body is kept as text', async () => {
    const error = await failWith(() => new Response('<html>Bad gateway</html>', { status: 502 }));
    expect(error).toBeInstanceOf(ServerError);
    expect(error.body).toBe('<html>Bad gateway</html>');
    expect(error.message).toBe('HTTP 502');
  });

  it('an unknown 4xx is a plain APIError', async () => {
    const error = await failWith(() => json(418, { detail: { code: 'teapot', message: 'short and stout' } }));
    expect(error.constructor).toBe(APIError);
    expect(error.code).toBe('teapot');
  });
});
