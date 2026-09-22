import { type AtpAgent, RichText } from "@atproto/api";

/** 投稿した結果の参照。スレッド返信の root / parent に使う。 */
export interface PostRef {
  uri: string;
  cid: string;
}

export interface Poster {
  post(text: string): Promise<PostRef>;
  reply(root: PostRef, text: string): Promise<PostRef>;
}

/** 実際に投稿する。--live のときだけ使う。 */
export class LivePoster implements Poster {
  private readonly agent: AtpAgent;

  constructor(agent: AtpAgent) {
    this.agent = agent;
  }

  async post(text: string): Promise<PostRef> {
    const rt = new RichText({ text });
    await rt.detectFacets(this.agent);
    return await this.agent.post({
      $type: "app.bsky.feed.post",
      text: rt.text,
      facets: rt.facets,
      langs: ["ja"],
    });
  }

  async reply(root: PostRef, text: string): Promise<PostRef> {
    const rt = new RichText({ text });
    await rt.detectFacets(this.agent);
    return await this.agent.post({
      $type: "app.bsky.feed.post",
      text: rt.text,
      facets: rt.facets,
      reply: { parent: root, root: root },
      langs: ["ja"],
    });
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

  async post(text: string): Promise<PostRef> {
    return await this.emit("post", text, null);
  }

  async reply(root: PostRef, text: string): Promise<PostRef> {
    return await this.emit("reply", text, this.seqOf.get(root.uri) ?? null);
  }

  private async emit(
    kind: "post" | "reply",
    text: string,
    replyTo: number | null,
  ): Promise<PostRef> {
    const rt = new RichText({ text });
    await rt.detectFacets(this.agent);
    this.seq += 1;
    const seq = this.seq;
    console.log(
      JSON.stringify({
        seq,
        kind,
        text: rt.text,
        langs: ["ja"],
        replyTo,
        facets: rt.facets ?? [],
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
