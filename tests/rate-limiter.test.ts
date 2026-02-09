import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { RateLimiter } from "../src/rate-limiter";

describe("RateLimiter", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test("acquire within burst capacity resolves immediately", async () => {
    const limiter = new RateLimiter({ perSecond: 10, burst: 3 });
    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();
  });

  test("acquire beyond capacity waits for refill", async () => {
    const limiter = new RateLimiter({ perSecond: 1, burst: 1 });
    await limiter.acquire();

    let resolved = false;
    const promise = limiter.acquire().then(() => {
      resolved = true;
    });

    expect(resolved).toBe(false);

    jest.advanceTimersByTime(1000);
    await promise;
    expect(resolved).toBe(true);
  });

  test("advancing less than needed keeps acquire pending", async () => {
    const limiter = new RateLimiter({ perSecond: 1, burst: 1 });
    await limiter.acquire();

    let resolved = false;
    limiter.acquire().then(() => {
      resolved = true;
    });

    // Advance 500ms — only half a token refilled, not enough
    jest.advanceTimersByTime(500);
    // Flush microtasks
    await Promise.resolve();

    expect(resolved).toBe(false);
  });

  test("refill is capped at burst — 6th acquire blocks after full refill", async () => {
    const limiter = new RateLimiter({ perSecond: 10, burst: 5 });

    // Drain all 5 tokens
    for (let i = 0; i < 5; i++) {
      await limiter.acquire();
    }

    // Advance 500ms: 10/s * 0.5s = 5 tokens refilled, capped at burst=5
    jest.advanceTimersByTime(500);

    // 5 more should succeed
    for (let i = 0; i < 5; i++) {
      await limiter.acquire();
    }

    // The 6th should block — proves cap at burst, not unlimited refill
    let sixthResolved = false;
    limiter.acquire().then(() => {
      sixthResolved = true;
    });
    await Promise.resolve();
    expect(sixthResolved).toBe(false);
  });

  test("partial refill allows partial acquire then blocks", async () => {
    const limiter = new RateLimiter({ perSecond: 2, burst: 2 });

    await limiter.acquire();
    await limiter.acquire();

    // 500ms: 2/s * 0.5s = 1 token refilled
    jest.advanceTimersByTime(500);

    await limiter.acquire();

    let resolved = false;
    const promise = limiter.acquire().then(() => {
      resolved = true;
    });
    expect(resolved).toBe(false);

    jest.advanceTimersByTime(500);
    await promise;
    expect(resolved).toBe(true);
  });

  test("concurrent acquires both eventually resolve", async () => {
    const limiter = new RateLimiter({ perSecond: 1, burst: 1 });
    await limiter.acquire(); // drain the single token

    let firstResolved = false;
    let secondResolved = false;

    const p1 = limiter.acquire().then(() => {
      firstResolved = true;
    });
    const p2 = limiter.acquire().then(() => {
      secondResolved = true;
    });

    // Neither should have resolved yet
    await Promise.resolve();
    expect(firstResolved).toBe(false);
    expect(secondResolved).toBe(false);

    // Advance 1s — enough for 1 token. First waiter resolves.
    jest.advanceTimersByTime(1000);
    await p1;
    expect(firstResolved).toBe(true);

    // Second is still waiting (first consumed the refilled token)
    // It needs another full second
    jest.advanceTimersByTime(1000);
    await p2;
    expect(secondResolved).toBe(true);
  });
});
