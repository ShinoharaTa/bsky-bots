import type { AtpAgent } from "@atproto/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../../cli.js";
import { DryRunPoster, LivePoster, type Poster } from "../../core/poster.js";
import { retryOnRateLimit } from "../../core/retry.js";
import { buildFacets } from "../../core/richtext.js";
import { jiho } from "./index.js";

/** XRPCError と同じく status と headers を持った例外。 */
function xrpcError(status: number, headers: Record<string, string> = {}) {
  return Object.assign(new Error(`xrpc ${status}`), { status, headers });
}

/** agent.post に渡ったレコードを記録する。メンション・リンクの無い本文なら他は呼ばれない。 */
function fakeAgent(
  post: (record: Record<string, unknown>) => Promise<unknown> = async () => ok,
): AtpAgent {
  return { post } as unknown as AtpAgent;
}

const ok = { uri: "at://did/app.bsky.feed.post/1", cid: "cid" };

const retry = jiho.posterOptions?.retry;
if (!retry) throw new Error("jiho.posterOptions.retry is not set");

let errors: string[];
let lines: string[];

beforeEach(() => {
  errors = [];
  lines = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    lines.push(String(line));
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("jiho.run", () => {
  it("投稿直前の JST 現在時刻で 1 回だけ投稿する", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-22T14:59:59.500Z"));
    const texts: string[] = [];
    const poster: Poster = {
      post: async (content) => {
        texts.push(typeof content === "string" ? content : content.text);
        return ok;
      },
      reply: async () => {
        throw new Error("reply must not be called");
      },
    };
    await jiho.run({ poster });
    expect(texts).toEqual(["なう(2026/10/22 23:59:59)"]);
  });

  it("投稿に失敗したら原因を出して例外を投げ直す", async () => {
    const failure = new Error("post failed");
    const poster: Poster = {
      post: async () => {
        throw failure;
      },
      reply: async () => ok,
    };
    await expect(jiho.run({ poster })).rejects.toBe(failure);
    expect(errors.join("\n")).toContain("[jiho] failed: post failed");
  });
});

describe("jiho の投稿レコード", () => {
  const text = "なう(2026/10/22 23:59:59)";

  it("本文から facets が検出されない", async () => {
    expect(await buildFacets(fakeAgent(), { text })).toBeUndefined();
  });

  it("dry-run の出力に langs キーが無く、facets は空", async () => {
    const poster = new DryRunPoster(fakeAgent(), jiho.posterOptions);
    await poster.post(text);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed).not.toHaveProperty("langs");
    expect(parsed.text).toBe(text);
    expect(parsed.facets).toEqual([]);
  });

  it("live で agent に渡るレコードに langs も facets も無い", async () => {
    const records: Record<string, unknown>[] = [];
    const poster = new LivePoster(
      fakeAgent(async (record) => {
        records.push(record);
        return ok;
      }),
      jiho.posterOptions,
    );
    await poster.post(text);
    expect(records).toHaveLength(1);
    const sent = JSON.parse(JSON.stringify(records[0]));
    expect(sent).toEqual({ $type: "app.bsky.feed.post", text });
  });
});

describe("jiho の 429 リトライ", () => {
  it("Retry-After が 3 分ちょうどなら頭打ちにせず待って投げ直す", async () => {
    const waits: number[] = [];
    let calls = 0;
    const result = await retryOnRateLimit(
      async () => {
        calls += 1;
        if (calls === 1) throw xrpcError(429, { "retry-after": "180" });
        return "ok";
      },
      retry,
      async (ms) => {
        waits.push(ms);
      },
    );
    expect(result).toBe("ok");
    expect(waits).toEqual([180000]);
  });

  it("合計 3 分を超える待ちが要るなら待たずに失敗する", async () => {
    const waits: number[] = [];
    let calls = 0;
    await expect(
      retryOnRateLimit(
        async () => {
          calls += 1;
          throw xrpcError(429, { "retry-after": "120" });
        },
        retry,
        async (ms) => {
          waits.push(ms);
        },
      ),
    ).rejects.toThrow("xrpc 429");
    // 1 回目の 120 秒は待つが、2 回目を待つと 240 秒になるので待たない。
    expect(calls).toBe(2);
    expect(waits).toEqual([120000]);
  });

  it("最初の Retry-After が 3 分を超えるなら 1 回も待たない（LivePoster 経由）", async () => {
    let calls = 0;
    const poster = new LivePoster(
      fakeAgent(async () => {
        calls += 1;
        throw xrpcError(429, { "retry-after": "181" });
      }),
      jiho.posterOptions,
    );
    await expect(poster.post("なう")).rejects.toThrow("xrpc 429");
    expect(calls).toBe(1);
  });

  it("5xx はリトライしない", async () => {
    let calls = 0;
    const poster = new LivePoster(
      fakeAgent(async () => {
        calls += 1;
        throw xrpcError(502);
      }),
      jiho.posterOptions,
    );
    await expect(poster.post("なう")).rejects.toThrow("xrpc 502");
    expect(calls).toBe(1);
  });
});

describe("jiho の CLI", () => {
  it("dry-run で 1 行だけ出して exit 0", async () => {
    expect(await runCli(["jiho"])).toBe(0);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).text).toMatch(
      /^なう\(\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}\)$/,
    );
  });

  it("--limit-followers は受け付けず exit 1", async () => {
    expect(await runCli(["jiho", "--limit-followers=1"])).toBe(1);
    expect(errors.join("\n")).toContain(
      "unknown argument for jiho: --limit-followers=1",
    );
    expect(lines).toHaveLength(0);
  });

  it("投稿に失敗したら exit 1", async () => {
    vi.spyOn(DryRunPoster.prototype, "post").mockRejectedValue(
      new Error("post failed"),
    );
    expect(await runCli(["jiho"])).toBe(1);
    expect(errors.join("\n")).toContain("[jiho] failed: post failed");
  });
});
