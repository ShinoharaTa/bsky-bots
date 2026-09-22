import moment from "moment-timezone";
import { describe, expect, it } from "vitest";
import type { Follower } from "../../core/followers.js";
import { utf8Length } from "../../core/richtext.js";
import type { ActivityCounts } from "./aggregate.js";
import { formatUser } from "./format.js";

const prevDay = moment.tz("2026-09-21", "Asia/Tokyo");
const counts: ActivityCounts = { posts: 147, reposts: 37, replys: 48 };

function follower(over: Partial<Follower>): Follower {
  return {
    did: "did:plc:ymdqgzoop3puhkbwrd7njbke",
    handle: "handle.invalid",
    name: undefined,
    ...over,
  };
}

/** 先頭のメンション facet。無ければ undefined。 */
function mentionOf(facets: ReturnType<typeof formatUser>["facets"]) {
  return facets?.[0];
}

describe("formatUser", () => {
  it("解決できるハンドルは従来どおり @handle をテキストに書き facet を作らない", () => {
    const content = formatUser(
      follower({ handle: "meliza.bsky.social", name: "めりざ" }),
      prevDay,
      counts,
    );
    expect(content.text).toBe(
      "@meliza.bsky.socialさんの集計データ\n" +
        "2026/09/21#skylog\n" +
        "\n" +
        "今日の累計　　：184\n" +
        "-------- 内訳 --------\n" +
        "投稿　　　　　：99\n" +
        "リプ　　　　　：48\n" +
        "リポスト　　　：37\n",
    );
    // detectFacets に任せる経路。手組みの facet は付けない。
    expect(content.facets).toBeUndefined();
  });

  it("handle.invalid は表示名 + did のメンションになる", () => {
    const content = formatUser(follower({ name: "高校生" }), prevDay, counts);
    expect(content.text.startsWith("@高校生さんの集計データ\n")).toBe(true);
    expect(mentionOf(content.facets)).toEqual({
      $type: "app.bsky.richtext.facet",
      // "@" 1 バイト + "高校生" 9 バイト。UTF-16 の 4 文字ではない。
      index: { byteStart: 0, byteEnd: 10 },
      features: [
        {
          $type: "app.bsky.richtext.facet#mention",
          did: "did:plc:ymdqgzoop3puhkbwrd7njbke",
        },
      ],
    });
  });

  it("絵文字入りの表示名でも byteEnd が UTF-8 バイト数になる", () => {
    const content = formatUser(follower({ name: "Toya🐒" }), prevDay, counts);
    // "@Toya🐒" = 1 + 4 + 4 バイト。UTF-16 の文字数は 7。
    expect("@Toya🐒".length).toBe(7);
    expect(mentionOf(content.facets)?.index).toEqual({
      byteStart: 0,
      byteEnd: 9,
    });
    expect(utf8Length("@Toya🐒")).toBe(9);
  });

  it("表示名が空なら did に落として空メンションを作らない", () => {
    const did = "did:plc:u2422q7nqnd3x3mn4ed56uxx";
    // "\u0081" は did:plc:u2422q7nqnd3x3mn4ed56uxx の実際の displayName。
    for (const name of [undefined, "", "   ", "\u0081", "​"]) {
      const content = formatUser(follower({ did, name }), prevDay, counts);
      expect(content.text.startsWith(`@${did}さんの集計データ\n`)).toBe(true);
      const facet = mentionOf(content.facets);
      expect(facet?.index).toEqual({
        byteStart: 0,
        byteEnd: 1 + did.length,
      });
      expect(facet?.features[0]).toEqual({
        $type: "app.bsky.richtext.facet#mention",
        did: did,
      });
      // 表示テキストが空になっていないこと。
      expect(content.text.startsWith("@さん")).toBe(false);
    }
  });

  it("メンション以外の本文は解決可否で変わらない", () => {
    const resolvable = formatUser(
      follower({ handle: "meliza.bsky.social" }),
      prevDay,
      counts,
    );
    const invalid = formatUser(follower({ name: "高校生" }), prevDay, counts);
    const body = (text: string) => text.slice(text.indexOf("\n"));
    expect(body(invalid.text)).toBe(body(resolvable.text));
  });
});
