import { describe, expect, it } from "vitest";
import {
  compareRanking,
  compareSkylog,
  parseRanking,
  parseSkylogPost,
  type SkylogCounts,
} from "./compare-gcp.js";

const DAY = "2026/09/22";

function skylogText(
  mention: string,
  posts: number,
  replies: number,
  reposts: number,
) {
  let text = `@${mention}さんの集計データ\n${DAY}#skylog\n\n`;
  text += `今日の累計　　：${posts + replies + reposts}\n`;
  text += "-------- 内訳 --------\n";
  text += `投稿　　　　　：${posts}\n`;
  text += `リプ　　　　　：${replies}\n`;
  text += `リポスト　　　：${reposts}\n`;
  return text;
}

function mention(did: string) {
  return [
    {
      index: { byteStart: 0, byteEnd: 5 },
      features: [{ $type: "app.bsky.richtext.facet#mention", did }],
    },
  ];
}

function counts(
  key: string,
  posts: number,
  replies: number,
  reposts: number,
): SkylogCounts {
  return {
    key,
    mention: `@${key}`,
    total: posts + replies + reposts,
    posts,
    replies,
    reposts,
  };
}

describe("parseSkylogPost", () => {
  it("内訳と先頭のメンションの did を読む", () => {
    const parsed = parseSkylogPost(
      { text: skylogText("a.bsky.social", 12, 3, 4), facets: mention("did:a") },
      DAY,
    );
    expect(parsed).toEqual({
      key: "did:a",
      mention: "@a.bsky.social",
      total: 19,
      posts: 12,
      replies: 3,
      reposts: 4,
    });
  });

  it("旧実装の負の投稿数も読む", () => {
    const parsed = parseSkylogPost(
      { text: skylogText("a.bsky.social", -4, 17, 12), facets: [] },
      DAY,
    );
    expect(parsed?.posts).toBe(-4);
    expect(parsed?.key).toBe("@a.bsky.social");
  });

  it("対象日が違えば null", () => {
    expect(
      parseSkylogPost(
        { text: skylogText("a.bsky.social", 12, 3, 4), facets: [] },
        "2026/09/21",
      ),
    ).toBeNull();
  });
});

describe("compareSkylog", () => {
  it("非リポスト総数が一致する差分は説明済み、違えば要確認", () => {
    const diffs = compareSkylog(
      [
        counts("did:same", 10, 2, 3),
        counts("did:rp", 10, 2, 3),
        counts("did:split", 10, 2, 3),
        counts("did:bad", 10, 2, 3),
        counts("did:gone", 10, 2, 3),
      ],
      [
        counts("did:same", 10, 2, 3),
        counts("did:rp", 10, 2, 5),
        counts("did:split", 11, 1, 3),
        counts("did:bad", 12, 2, 3),
        counts("did:invalid", 10, 0, 0),
      ],
      new Set(["did:invalid"]),
    );
    const byKey = new Map(diffs.map((item) => [item.key, item.reason]));
    expect(byKey.has("did:same")).toBe(false);
    expect(byKey.get("did:rp")).toContain("リポスト時刻基準");
    expect(byKey.get("did:split")).toContain("リプライのリポスト");
    expect(byKey.get("did:bad")).toBeNull();
    expect(byKey.get("did:gone")).toBeNull();
    expect(byKey.get("did:invalid")).toBe("handle.invalid");
  });
});

describe("parseRanking / compareRanking", () => {
  it("ランキングを読み、件数か顔ぶれが違う人だけ返す", () => {
    const old = parseRanking(
      `【すか廃ランキング ${DAY}】#skyhighrank\n👑：999+ Alice\n2位：120 Bob\n3位：50 undefined\n`,
      DAY,
    );
    const next = parseRanking(
      `【すか廃ランキング ${DAY}】#skyhighrank\n👑：999+ Alice\n2位：121 Bob\n3位：51 Carol\n`,
      DAY,
    );
    expect(old).toEqual([
      { name: "Alice", count: 1000 },
      { name: "Bob", count: 120 },
      { name: "undefined", count: 50 },
    ]);
    expect(compareRanking(old ?? [], next ?? [])).toEqual([
      { name: "Bob", old: 120, new: 121 },
      { name: "undefined", old: 50, new: null },
      { name: "Carol", old: null, new: 51 },
    ]);
  });
});
