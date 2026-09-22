import {
  type AppBskyRichtextFacet,
  type AtpAgent,
  RichText,
} from "@atproto/api";

export type Facet = AppBskyRichtextFacet.Main;

/**
 * 投稿の本文。facets を渡すと detectFacets の結果にマージする。
 * ハンドルが解決できないユーザーへのメンションは detectFacets では作れないので
 * did から手で組み立てて渡す。
 */
export interface PostContent {
  text: string;
  facets?: Facet[];
}

/** facet の index は UTF-16 の文字数ではなく UTF-8 のバイト数。 */
export function utf8Length(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/**
 * did を指すメンション facet。表示テキストは何でもよい（ハンドルでなくてよい）。
 * byteStart / byteEnd は本文先頭からの UTF-8 バイトオフセット。
 */
export function mentionFacet(
  did: string,
  byteStart: number,
  byteEnd: number,
): Facet {
  return {
    $type: "app.bsky.richtext.facet",
    index: { byteStart, byteEnd },
    features: [{ $type: "app.bsky.richtext.facet#mention", did }],
  };
}

function overlaps(a: Facet, b: Facet): boolean {
  return (
    a.index.byteStart < b.index.byteEnd && b.index.byteStart < a.index.byteEnd
  );
}

/**
 * detectFacets の結果と手組みの facet をマージする。
 * detectFacets は facets を丸ごと上書きするので、渡す前に混ぜることはできない。
 * 範囲が重なった自動検出分は手組みを優先して落とす。
 */
export async function buildFacets(
  agent: AtpAgent,
  content: PostContent,
): Promise<Facet[] | undefined> {
  const rt = new RichText({ text: content.text });
  await rt.detectFacets(agent);
  const manual = content.facets ?? [];
  if (manual.length === 0) return rt.facets;
  const detected = (rt.facets ?? []).filter(
    (facet) => !manual.some((item) => overlaps(facet, item)),
  );
  return [...detected, ...manual].sort(
    (a, b) => a.index.byteStart - b.index.byteStart,
  );
}
