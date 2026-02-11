/**
 * Token bucket rate limiter for Coinbase API calls.
 *
 * Default budget is 25 req/s, leaving a 5 req/s margin from
 * Coinbase's 30 req/s limit for safety.
 */

import { createModuleLogger } from '../core/logger.js';

const log = createModuleLogger('rate-limiter');

export class RateLimiter {
  private tokens: number;
  private readonly maxTokens: number;
  private readonly refillRate: number; // tokens per millisecond
  private lastRefill: number;

  /**
   * @param maxRequestsPerSecond - Maximum requests per second (default 25)
   */
  constructor(maxRequestsPerSecond: number = 25) {
    this.maxTokens = maxRequestsPerSecond;
    this.tokens = maxRequestsPerSecond;
    this.refillRate = maxRequestsPerSecond / 1000; // per ms
    this.lastRefill = Date.now();
  }

  /**
   * Acquire a token, waiting if none available.
   * Resolves when a token is available.
   */
  async acquire(): Promise<void> {
    this.refill();

    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }

    // Calculate wait time for 1 token
    const waitMs = Math.ceil((1 - this.tokens) / this.refillRate);
    log.debug({ waitMs, tokens: this.tokens }, 'Rate limiter waiting');

    await this.sleep(waitMs);
    this.refill();
    this.tokens -= 1;
  }

  /**
   * Try to acquire a token without waiting.
   * @returns true if token was acquired, false if bucket is empty
   */
  tryAcquire(): boolean {
    this.refill();

    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }

    return false;
  }

  /**
   * Reset the bucket to full capacity.
   */
  reset(): void {
    this.tokens = this.maxTokens;
    this.lastRefill = Date.now();
  }

  /** Current available tokens (for testing/monitoring). */
  get availableTokens(): number {
    return this.tokens;
  }

  // ── Private ─────────────────────────────────────────────────────────

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;

    if (elapsed > 0) {
      this.tokens = Math.min(
        this.maxTokens,
        this.tokens + elapsed * this.refillRate,
      );
      this.lastRefill = now;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
