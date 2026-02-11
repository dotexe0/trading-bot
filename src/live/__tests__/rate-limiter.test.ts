/**
 * Tests for the token bucket rate limiter.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RateLimiter } from '../rate-limiter.js';

describe('RateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('acquires immediately when tokens are available', async () => {
    const limiter = new RateLimiter(25);

    // Should resolve without delay
    await limiter.acquire();
    expect(limiter.availableTokens).toBe(24);
  });

  it('blocks when tokens are exhausted', async () => {
    const limiter = new RateLimiter(2); // small bucket for testing

    // Drain all tokens
    await limiter.acquire();
    await limiter.acquire();
    expect(limiter.availableTokens).toBeLessThan(1);

    // Next acquire should block
    let resolved = false;
    const acquirePromise = limiter.acquire().then(() => {
      resolved = true;
    });

    // Should not resolve yet
    expect(resolved).toBe(false);

    // Advance time by 500ms (enough for 1 token at 2/s = 0.002/ms)
    await vi.advanceTimersByTimeAsync(500);

    await acquirePromise;
    expect(resolved).toBe(true);
  });

  it('refills tokens over time', async () => {
    const limiter = new RateLimiter(10);

    // Drain 5 tokens
    for (let i = 0; i < 5; i++) {
      await limiter.acquire();
    }
    expect(limiter.availableTokens).toBe(5);

    // Advance 1 second -- should refill to max (10)
    await vi.advanceTimersByTimeAsync(1000);

    // tryAcquire triggers refill
    expect(limiter.tryAcquire()).toBe(true);
    // After refill: 10 tokens - 1 acquired = 9
    expect(limiter.availableTokens).toBe(9);
  });

  it('tryAcquire returns false when bucket is empty', async () => {
    const limiter = new RateLimiter(2);

    // Drain all tokens
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(false);
  });

  it('reset restores full capacity', async () => {
    const limiter = new RateLimiter(10);

    // Drain all tokens
    for (let i = 0; i < 10; i++) {
      await limiter.acquire();
    }
    expect(limiter.availableTokens).toBeLessThan(1);

    limiter.reset();
    expect(limiter.availableTokens).toBe(10);

    // Should acquire immediately after reset
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.availableTokens).toBe(9);
  });
});
