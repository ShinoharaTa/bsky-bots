import { afterEach, describe, expect, it, vi } from "vitest";
import { POST_RETRY, retryOnRateLimit } from "./retry.js";

/** XRPCError と同じく status と headers を持った例外。 */
function xrpcError(status: number, headers: Record<string, string> = {}) {
  return Object.assign(new Error(`xrpc ${status}`), { status, headers });
}

describe("retryOnRateLimit", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("429 は Retry-After を待って投げ直す", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const waits: number[] = [];
    let calls = 0;
    const result = await retryOnRateLimit(
      async () => {
        calls += 1;
        if (calls === 1) throw xrpcError(429, { "retry-after": "7" });
        return "ok";
      },
      POST_RETRY,
      async (ms) => {
        waits.push(ms);
      },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(2);
    expect(waits).toEqual([7000]);
  });

  it("429 のリトライは最大 2 回（計 3 回）で諦める", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const waits: number[] = [];
    let calls = 0;
    await expect(
      retryOnRateLimit(
        async () => {
          calls += 1;
          throw xrpcError(429);
        },
        POST_RETRY,
        async (ms) => {
          waits.push(ms);
        },
      ),
    ).rejects.toThrow("xrpc 429");
    expect(calls).toBe(3);
    // Retry-After が無ければ指数バックオフ。
    expect(waits).toEqual([1000, 2000]);
  });

  it("5xx はリトライしない（二重投稿を避ける）", async () => {
    let calls = 0;
    await expect(
      retryOnRateLimit(
        async () => {
          calls += 1;
          throw xrpcError(502);
        },
        POST_RETRY,
        async () => {},
      ),
    ).rejects.toThrow("xrpc 502");
    expect(calls).toBe(1);
  });
});
