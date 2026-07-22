/** Typed errors surfaced by provider implementations. */

export class ProviderError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
  }
}

/** Authentication failed (401): token missing, expired, or lacking scopes. */
export class AuthError extends ProviderError {
  constructor(message: string, status = 401) {
    super(message, status);
    this.name = 'AuthError';
  }
}

/** The provider rate limit was hit; retry after `resetAt` when known. */
export class RateLimitError extends ProviderError {
  /** When the limit resets, if the provider reported it. */
  readonly resetAt?: Date;

  constructor(message: string, resetAt?: Date, status = 403) {
    super(message, status);
    this.name = 'RateLimitError';
    this.resetAt = resetAt;
  }
}
