import moment from "moment-timezone";
import { describe, expect, it } from "vitest";
import { formatRanking, rankingNameOf, type UserPosts } from "./format.js";

const prevDay = moment.tz("2026-09-21", "Asia/Tokyo");

function user(over: Partial<UserPosts>): UserPosts {
  return {
    did: "did:plc:ymdqgzoop3puhkbwrd7njbke",
    handle: "meliza.bsky.social",
    name: "めりざ",
    posts: 10,
    ...over,
  };
}

describe("rankingNameOf", () => {
  it("表示名があればそのまま使う（前後の空白も残す）", () => {
    expect(rankingNameOf(user({}))).toBe("めりざ");
    expect(rankingNameOf(user({ name: " めりざ " }))).toBe(" めりざ ");
  });

  it("表示名が無い・実質空ならハンドル", () => {
    expect(rankingNameOf(user({ name: undefined }))).toBe("meliza.bsky.social");
    expect(rankingNameOf(user({ name: "" }))).toBe("meliza.bsky.social");
    expect(rankingNameOf(user({ name: "\u0081" }))).toBe("meliza.bsky.social");
    expect(rankingNameOf(user({ name: " 　" }))).toBe("meliza.bsky.social");
  });

  it("ハンドルも使えなければ did", () => {
    expect(
      rankingNameOf(user({ name: undefined, handle: "handle.invalid" })),
    ).toBe("did:plc:ymdqgzoop3puhkbwrd7njbke");
    expect(rankingNameOf(user({ name: undefined, handle: "" }))).toBe(
      "did:plc:ymdqgzoop3puhkbwrd7njbke",
    );
  });
});

describe("formatRanking", () => {
  it("表示名が無いユーザーを undefined と書かない", () => {
    const text = formatRanking(
      [user({ posts: 20 }), user({ name: undefined, posts: 10 })],
      prevDay,
    );
    expect(text).toBe(
      "【すか廃ランキング 2026/09/21】#skyhighrank\n" +
        "👑：20 めりざ\n" +
        "2位：10 meliza.bsky.social\n",
    );
  });
});
