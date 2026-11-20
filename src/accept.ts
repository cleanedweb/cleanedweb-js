import { ResultNotAcceptedError } from './errors.js';
import { acceptanceProblems } from './runner.js';
import type { AcceptOptions } from './runner.js';
import type { RunResultBody } from './types.js';

export type { AcceptOptions };

/**
 * Whether a finished run passes the documented acceptance checks: `summary.status` is `completed`
 * or `bounded`, `summary.within_scope_passed` is true, the run finished (and, with `definitionVersion`, the
 * summary names that version). `bounded` and `partial` mean the source can hold more records.
 */
export function isAccepted(result: RunResultBody<unknown>, options?: AcceptOptions): boolean {
  return acceptanceProblems(result, options).length === 0;
}

/** Throws a {@link ResultNotAcceptedError} naming each failed check. */
export function assertAccepted(result: RunResultBody<unknown>, options?: AcceptOptions): void {
  const problems = acceptanceProblems(result, options);
  if (problems.length > 0) throw new ResultNotAcceptedError(problems);
}
