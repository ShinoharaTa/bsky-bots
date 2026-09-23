import moment from "moment-timezone";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DateBounds } from "../../core/date.js";
import {
  encodeTid,
  fetchFromAppView,
  POST_COLLECTION,
  REPOST_COLLECTION,
  scanPdsCollection,
} from "../../core/feed.js";
import { countActivity } from "./aggregate.js";

const NO_RETRY = {
  maxRetries: 0,
  baseDelayMs: 0,
  maxDelayMs: 0,
  timeoutMs: 1000,
};

/** 対象日 2026-09-21 (JST)。 */
const bounds: DateBounds = {
  prevDay: moment.tz("2026-09-21", "Asia/Tokyo"),
  today: moment.tz("2026-09-22", "Asia/Tokyo"),
};

const DID = "did:plc:me";
const at = (hhmm: string) => `2026-09-21T${hhmm}:00.000+09:00`;
const parentRef = {
  root: { uri: "at://did:plc:other/app.bsky.feed.post/a", cid: "c" },
  parent: { uri: "at://did:plc:other/app.bsky.feed.post/a", cid: "c" },
};

/**
 * 対象日に: 通常投稿 1 / 自分のリプ 1 / 通常投稿のリポスト 1 / リプライのリポスト 1。
 * 期待値は posts=2, replys=1, reposts=2（リプライのリポストはリプに数えない）。
 */
const pdsPosts = [
  {
    rkey: encodeTid(Date.parse(at("10:00"))),
    value: { createdAt: at("10:00") },
  },
  {
    rkey: encodeTid(Date.parse(at("11:00"))),
    value: { createdAt: at("11:00"), reply: parentRef },
  },
];
const pdsReposts = [
  {
    rkey: encodeTid(Date.parse(at("12:00"))),
    value: { createdAt: at("12:00") },
  },
  {
    rkey: encodeTid(Date.parse(at("13:00"))),
    value: { createdAt: at("13:00") },
  },
];

function iso(hhmm: string): string {
  return new Date(Date.parse(at(hhmm))).toISOString();
}

const author = { did: "did:plc:other", handle: "other.bsky.social" };
const replyView = {
  root: { $type: "app.bsky.feed.defs#postView", uri: "x", cid: "c", author },
  parent: { $type: "app.bsky.feed.defs#postView", uri: "x", cid: "c", author },
};
const appViewFeed = [
  {
    post: { indexedAt: iso("13:00"), record: { createdAt: at("09:00") } },
    reply: replyView,
    reason: {
      $type: "app.bsky.feed.defs#reasonRepost",
      by: author,
      indexedAt: iso("13:00"),
    },
  },
  {
    post: { indexedAt: iso("12:00"), record: { createdAt: at("08:00") } },
    reason: {
      $type: "app.bsky.feed.defs#reasonRepost",
      by: author,
      indexedAt: iso("12:00"),
    },
  },
  {
    post: { indexedAt: iso("11:00"), record: { createdAt: at("11:00") } },
    reply: replyView,
  },
  { post: { indexedAt: iso("10:00"), record: { createdAt: at("10:00") } } },
];

function stubFetch(): void {
  vi.stubGlobal("fetch", async (input: URL) => {
    const url = new URL(input);
    if (url.pathname.endsWith("com.atproto.repo.listRecords")) {
      const collection = url.searchParams.get("collection");
      const records = collection === POST_COLLECTION ? pdsPosts : pdsReposts;
      return new Response(
        JSON.stringify({
          records: records.toReversed().map(({ rkey, value }) => ({
            uri: `at://${DID}/${collection}/${rkey}`,
            value,
          })),
        }),
      );
    }
    return new Response(JSON.stringify({ feed: appViewFeed }));
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("countActivity", () => {
  it("PDS 直読みと AppView 経由で同じ数になる（リプライのリポストはリプに数えない）", async () => {
    stubFetch();
    const pds = [
      ...(
        await scanPdsCollection(
          "https://pds.example",
          DID,
          POST_COLLECTION,
          bounds,
          30,
          NO_RETRY,
        )
      ).items,
      ...(
        await scanPdsCollection(
          "https://pds.example",
          DID,
          REPOST_COLLECTION,
          bounds,
          30,
          NO_RETRY,
        )
      ).items,
    ];
    const appView = (
      await fetchFromAppView(DID, bounds, 20, {
        includeReposts: true,
        retry: NO_RETRY,
      })
    ).items;

    const expected = { posts: 2, replys: 1, reposts: 2 };
    expect(countActivity(pds, bounds)).toEqual(expected);
    expect(countActivity(appView, bounds)).toEqual(expected);
  });
});
