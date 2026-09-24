/**
 * Error taxonomy used by workers to decide between retrying and giving up.
 * BullMQ retries anything thrown; `PermanentError` is converted to
 * `UnrecoverableError` at the worker boundary so it fails once, loudly.
 */
export class PermanentError extends Error {
  constructor(message: string, readonly detail?: unknown) {
    super(message);
    this.name = "PermanentError";
  }
}

export class TransientError extends Error {
  constructor(message: string, readonly retryAfterMs?: number, readonly detail?: unknown) {
    super(message);
    this.name = "TransientError";
  }
}

export class BudgetExceededError extends PermanentError {
  constructor(message: string) {
    super(message);
    this.name = "BudgetExceededError";
  }
}

export class RateLimitedError extends TransientError {
  constructor(message: string, retryAfterMs?: number) {
    super(message, retryAfterMs);
    this.name = "RateLimitedError";
  }
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return typeof e === "string" ? e : JSON.stringify(e);
}
