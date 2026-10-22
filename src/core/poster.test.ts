import type { AtpAgent } from "@atproto/api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DryRunPoster, LivePoster } from "./poster.js";
import { POST_RETRY } from "./retry.js";

/** XRPCError と同じく status と headers を持った例外。 */
function xrpcError(status: number, headers: Record<string, string> = {}) {
  return Object.assign(new Error(`xrpc ${status}`), { status, headers });
}

/** agent.post に渡ったレコードを記録する。メンション・リンクの無い本文なら他は呼ばれない。 */
function fakeAgent(
  post: (record: Record<string, unknown>) => Promise<unknown>,
): AtpAgent {
  return { post } as unknown as AtpAgent;
}

const ok = { uri: "at://did/app.bsky.feed.post/1", cid: "cid" };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("LivePoster", () => {
  it('既定は langs: ["ja"] を付ける', async () => {
    const records: Record<string, unknown>[] = [];
    const poster = new LivePoster(
      fakeAgent(async (record) => {
        records.push(record);
        return ok;
      }),
    );
    await poster.post("なう");
    await poster.reply(ok, "返信");
    expect(records.map((record) => record.langs)).toEqual([["ja"], ["ja"]]);
  });

  it("langs: null なら langs を付けない", async () => {
    const records: Record<string, unknown>[] = [];
    const poster = new LivePoster(
      fakeAgent(async (record) => {
        records.push(record);
        return ok;
      }),
      { langs: null },
    );
    await poster.post("なう");
    await poster.reply(ok, "返信");
    expect(records).toHaveLength(2);
    for (const record of records) {
      expect(record.langs).toBeUndefined();
      // JSON にしたときにキーごと消えること。
      expect(JSON.parse(JSON.stringify(record))).not.toHaveProperty("langs");
    }
  });

  it("retry の合計待ち上限を超えるなら待たずに投げる", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let calls = 0;
    const poster = new LivePoster(
      fakeAgent(async () => {
        calls += 1;
        throw xrpcError(429, { "retry-after": "600" });
      }),
      { retry: { ...POST_RETRY, maxTotalWaitMs: 1000 } },
    );
    await expect(poster.post("なう")).rejects.toThrow("xrpc 429");
    expect(calls).toBe(1);
  });
});

describe("DryRunPoster", () => {
  function captureStdout(): string[] {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    return lines;
  }

  it('既定は従来どおり langs: ["ja"] を同じ位置に出す', async () => {
    const lines = captureStdout();
    const poster = new DryRunPoster(fakeAgent(async () => ok));
    await poster.post("なう");
    const parsed = JSON.parse(lines[0]);
    expect(Object.keys(parsed)).toEqual([
      "seq",
      "kind",
      "text",
      "langs",
      "replyTo",
      "facets",
      "createdAt",
    ]);
    expect(parsed.langs).toEqual(["ja"]);
  });

  it("langs: null なら langs キーを出さない", async () => {
    const lines = captureStdout();
    const poster = new DryRunPoster(
      fakeAgent(async () => ok),
      {
        langs: null,
      },
    );
    await poster.post("なう");
    const parsed = JSON.parse(lines[0]);
    expect(parsed).not.toHaveProperty("langs");
    expect(parsed.text).toBe("なう");
  });
});
