import type { AtpAgent } from "@atproto/api";
import { describe, expect, it } from "vitest";
import { buildFacets, mentionFacet, utf8Length } from "./richtext.js";

/** detectFacets が叩く resolveHandle だけを差し替える。ネットワークは使わない。 */
const agent = {
  com: {
    atproto: {
      identity: {
        resolveHandle: async ({ handle }: { handle: string }) => ({
          data: { did: `did:plc:resolved-${handle}` },
        }),
      },
    },
  },
} as unknown as AtpAgent;

describe("utf8Length", () => {
  it("UTF-16 の文字数ではなく UTF-8 のバイト数を返す", () => {
    expect(utf8Length("@高校生")).toBe(10);
    expect(utf8Length("@Toya🐒")).toBe(9);
    expect(utf8Length("さんの集計データ")).toBe(24);
  });
});

describe("buildFacets", () => {
  it("手組みが無ければ detectFacets の結果をそのまま返す", async () => {
    const facets = await buildFacets(agent, {
      text: "@meliza.bsky.socialさんの集計データ",
    });
    expect(facets).toEqual([
      {
        $type: "app.bsky.richtext.facet",
        index: { byteStart: 0, byteEnd: 19 },
        features: [
          {
            $type: "app.bsky.richtext.facet#mention",
            did: "did:plc:resolved-meliza.bsky.social",
          },
        ],
      },
    ]);
  });

  it("自動検出分とマージして byteStart 順に並べる", async () => {
    const text = "@高校生さんの集計データ #skylog";
    const facets = await buildFacets(agent, {
      text,
      facets: [mentionFacet("did:plc:ymdqgzoop3puhkbwrd7njbke", 0, 10)],
    });
    expect(facets).toHaveLength(2);
    expect(facets?.[0].index).toEqual({ byteStart: 0, byteEnd: 10 });
    // 日本語のぶんだけ後ろにずれた位置にタグが来る。
    const tagStart = utf8Length("@高校生さんの集計データ ");
    expect(facets?.[1].index).toEqual({
      byteStart: tagStart,
      byteEnd: tagStart + utf8Length("#skylog"),
    });
    expect(facets?.[1].features[0]).toEqual({
      $type: "app.bsky.richtext.facet#tag",
      tag: "skylog",
    });
  });

  it("手組みと範囲が重なった自動検出分は落とす", async () => {
    // 表示名がドメインに見えるとリンクとして検出されてしまう。
    const text = "@shino3.netさんの集計データ";
    const facets = await buildFacets(agent, {
      text,
      facets: [mentionFacet("did:plc:u2422q7nqnd3x3mn4ed56uxx", 0, 11)],
    });
    expect(facets).toEqual([
      mentionFacet("did:plc:u2422q7nqnd3x3mn4ed56uxx", 0, 11),
    ]);
  });
});
