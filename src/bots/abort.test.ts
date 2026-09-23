import type { AtpAgent } from "@atproto/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunAborted } from "../core/abort.js";
import { createDateBounds } from "../core/date.js";
import type { Poster, PostRef } from "../core/poster.js";
import type { PostContent } from "../core/richtext.js";
import type { BotContext } from "../core/types.js";
import { skyhigh } from "./skyhigh/index.js";
import { skylog } from "./skylog/index.js";

/** 投稿を記録するだけの Poster。reply を失敗させられる。 */
class FakePoster implements Poster {
  readonly calls: { kind: "post" | "reply"; text: string }[] = [];
  failReply = false;

  async post(content: string | PostContent): Promise<PostRef> {
    return this.record("post", content);
  }

  async reply(_root: PostRef, content: string | PostContent): Promise<PostRef> {
    if (this.failReply) throw new Error("createRecord failed");
    return this.record("reply", content);
  }

  private record(kind: "post" | "reply", content: string | PostContent) {
    const text = typeof content === "string" ? content : content.text;
    this.calls.push({ kind, text });
    const seq = this.calls.length;
    return { uri: `at://fake/app.bsky.feed.post/${seq}`, cid: `fake-${seq}` };
  }
}

/** getFollowers だけを差し替えた agent。 */
function fakeAgent(prefix: string, count: number): AtpAgent {
  const followers = Array.from({ length: count }, (_, index) => ({
    did: `did:plc:${prefix}${index}`,
    handle: `${prefix}${index}.test`,
    displayName: `${prefix}${index}`,
  }));
  return {
    app: {
      bsky: {
        graph: {
          getFollowers: async () => ({ data: { followers } }),
        },
      },
    },
  } as unknown as AtpAgent;
}

const bounds = createDateBounds("2026-09-22T12:00:00+09:00");

function context(agent: AtpAgent, poster: Poster): BotContext {
  return { agent, poster, actor: "bot.test", bounds };
}

/** 取得先が全部壊れている（plc.directory も AppView も 400）。 */
function brokenFetch() {
  return vi.fn(async () => new Response("broken", { status: 400 }));
}

/** 全員が PDS から前日 12 件取れる。 */
function healthyFetch() {
  return vi.fn(async (input: string | URL) => {
    const url = new URL(String(input));
    if (url.hostname === "plc.directory") {
      return Response.json({
        service: [
          {
            type: "AtprotoPersonalDataServer",
            serviceEndpoint: "https://pds.test",
          },
        ],
      });
    }
    const collection = url.searchParams.get("collection");
    const records =
      collection === "app.bsky.feed.post"
        ? Array.from({ length: 12 }, (_, index) => ({
            uri: `at://did/app.bsky.feed.post/x${index}`,
            value: { createdAt: "2026-09-21T03:00:00.000Z" },
          }))
        : [];
    return Response.json({ records });
  });
}

let errors: string[];

beforeEach(() => {
  errors = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const NOTIFY =
  "@shino3.net \n\nエラーが起きて動いてないよっ！！\n助けてーーー（>__<）\n";

describe("取得先が壊れているとき", () => {
  it("skyhigh はランキングを投稿せずアボートする", async () => {
    vi.stubGlobal("fetch", brokenFetch());
    const poster = new FakePoster();
    await expect(
      skyhigh.run(context(fakeAgent("hi", 30), poster)),
    ).rejects.toBeInstanceOf(RunAborted);
    // 取得前の「集計開始」と、エラー通知だけ。ランキング以降は出ない。
    expect(poster.calls.map((call) => call.kind)).toEqual(["post", "post"]);
    expect(poster.calls[1].text).toBe(NOTIFY);
    expect(errors.join("\n")).toMatch(
      /\[skyhigh\] summary: status=aborted processed=10 fetch_failed=10 post_failed=0 fallback=0 .*in a row/,
    );
  });

  it("skylog は返信も集計終了も出さずアボートする", async () => {
    vi.stubGlobal("fetch", brokenFetch());
    const poster = new FakePoster();
    await expect(
      skylog.run(context(fakeAgent("log", 30), poster)),
    ).rejects.toBeInstanceOf(RunAborted);
    // 取得前の「集計開始」「説明」と、エラー通知だけ。
    expect(poster.calls.map((call) => call.kind)).toEqual([
      "post",
      "post",
      "post",
    ]);
    expect(poster.calls[2].text).toBe(NOTIFY);
    expect(errors.join("\n")).toMatch(
      /\[skylog\] summary: status=aborted processed=10 fetch_failed=10/,
    );
  });
});

describe("skylog の投稿失敗", () => {
  it("返信の失敗は skip ではなく reply failed として数え、連続 3 回でアボート", async () => {
    vi.stubGlobal("fetch", healthyFetch());
    const poster = new FakePoster();
    poster.failReply = true;
    await expect(
      skylog.run(context(fakeAgent("rep", 5), poster)),
    ).rejects.toThrow(/post failed 3 times in a row/);
    const log = errors.join("\n");
    expect(log).toContain("reply failed did:plc:rep0");
    expect(log).not.toContain("skip did:plc:rep");
    expect(log).toMatch(
      /\[skylog\] summary: status=aborted processed=3 fetch_failed=0 post_failed=3/,
    );
    // 集計終了は出さない（開始・説明・エラー通知だけ）。
    expect(poster.calls).toHaveLength(3);
  });

  it("正常なら全員に返信して集計終了まで出し、サマリは ok", async () => {
    vi.stubGlobal("fetch", healthyFetch());
    const poster = new FakePoster();
    await skylog.run(context(fakeAgent("ok", 4), poster));
    expect(poster.calls.map((call) => call.kind)).toEqual([
      "post",
      "post",
      "reply",
      "reply",
      "reply",
      "reply",
      "post",
    ]);
    expect(errors.join("\n")).toMatch(
      /\[skylog\] summary: status=ok processed=4 fetch_failed=0 post_failed=0 fallback=0/,
    );
  });
});
