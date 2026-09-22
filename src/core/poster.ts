import type { AtpAgent } from "@atproto/api";
import { buildFacets, type PostContent } from "./richtext.js";

/** 投稿した結果の参照。スレッド返信の root / parent に使う。 */
export interface PostRef {
  uri: string;
  cid: string;
}

export interface Poster {
  post(content: string | PostContent): Promise<PostRef>;
  reply(root: PostRef, content: string | PostContent): Promise<PostRef>;
}

function toContent(content: string | PostContent): PostContent {
  return typeof content === "string" ? { text: content } : content;
}

/** 実際に投稿する。--live のときだけ使う。 */
export class LivePoster implements Poster {
  private readonly agent: AtpAgent;

  constructor(agent: AtpAgent) {
    this.agent = agent;
  }

  async post(content: string | PostContent): Promise<PostRef> {
    const { text, facets } = await this.resolve(content);
    return await this.agent.post({
      $type: "app.bsky.feed.post",
      text: text,
      facets: facets,
      langs: ["ja"],
    });
  }

  async reply(root: PostRef, content: string | PostContent): Promise<PostRef> {
    const { text, facets } = await this.resolve(content);
    return await this.agent.post({
      $type: "app.bsky.feed.post",
      text: text,
      facets: facets,
      reply: { parent: root, root: root },
      langs: ["ja"],
    });
  }

  private async resolve(content: string | PostContent) {
    const item = toContent(content);
    return { text: item.text, facets: await buildFacets(this.agent, item) };
  }
}

/**
 * 投稿せずに stdout へ 1 行 1 JSON で吐く。既定はこちら。
 * createdAt は実行のたびに変わるので新旧の diff 対象から外すこと。
 */
export class DryRunPoster implements Poster {
  private readonly agent: AtpAgent;
  private seq = 0;
  private readonly seqOf = new Map<string, number>();

  constructor(agent: AtpAgent) {
    this.agent = agent;
  }

  async post(content: string | PostContent): Promise<PostRef> {
    return await this.emit("post", content, null);
  }

  async reply(root: PostRef, content: string | PostContent): Promise<PostRef> {
    return await this.emit("reply", content, this.seqOf.get(root.uri) ?? null);
  }

  private async emit(
    kind: "post" | "reply",
    content: string | PostContent,
    replyTo: number | null,
  ): Promise<PostRef> {
    const item = toContent(content);
    const facets = await buildFacets(this.agent, item);
    this.seq += 1;
    const seq = this.seq;
    console.log(
      JSON.stringify({
        seq,
        kind,
        text: item.text,
        langs: ["ja"],
        replyTo,
        facets: facets ?? [],
        createdAt: new Date().toISOString(),
      }),
    );
    const ref: PostRef = {
      uri: `at://dry-run/app.bsky.feed.post/${seq}`,
      cid: `dry-run-${seq}`,
    };
    this.seqOf.set(ref.uri, seq);
    return ref;
  }
}
