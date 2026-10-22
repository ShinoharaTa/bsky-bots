import type { AtpAgent } from "@atproto/api";
import {
  POST_RETRY,
  type PostRetryOptions,
  retryOnRateLimit,
} from "./retry.js";
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

/** Bot ごとの投稿設定。CLI が Poster を作るときに渡す。 */
export interface PosterOptions {
  /** 投稿に付ける langs。省略時は ["ja"]。null なら langs を付けない。 */
  langs?: string[] | null;
  /** 投稿（429）のリトライ設定。省略時は POST_RETRY。 */
  retry?: PostRetryOptions;
}

const DEFAULT_LANGS = ["ja"];

function langsOf(options: PosterOptions): string[] | undefined {
  if (options.langs === null) return undefined;
  return options.langs ?? DEFAULT_LANGS;
}

function toContent(content: string | PostContent): PostContent {
  return typeof content === "string" ? { text: content } : content;
}

/** 実際に投稿する。--live のときだけ使う。 */
export class LivePoster implements Poster {
  private readonly agent: AtpAgent;
  private readonly langs: string[] | undefined;
  private readonly retry: PostRetryOptions;

  constructor(agent: AtpAgent, options: PosterOptions = {}) {
    this.agent = agent;
    this.langs = langsOf(options);
    this.retry = options.retry ?? POST_RETRY;
  }

  async post(content: string | PostContent): Promise<PostRef> {
    const { text, facets } = await this.resolve(content);
    return await retryOnRateLimit(
      () =>
        this.agent.post({
          $type: "app.bsky.feed.post",
          text: text,
          facets: facets,
          langs: this.langs,
        }),
      this.retry,
    );
  }

  async reply(root: PostRef, content: string | PostContent): Promise<PostRef> {
    const { text, facets } = await this.resolve(content);
    return await retryOnRateLimit(
      () =>
        this.agent.post({
          $type: "app.bsky.feed.post",
          text: text,
          facets: facets,
          reply: { parent: root, root: root },
          langs: this.langs,
        }),
      this.retry,
    );
  }

  private async resolve(content: string | PostContent) {
    const item = toContent(content);
    return { text: item.text, facets: await buildFacets(this.agent, item) };
  }
}

/**
 * 投稿せずに stdout へ 1 行 1 JSON で吐く。既定はこちら。
 * createdAt は実行のたびに変わるので新旧の diff 対象から外すこと。
 * 投稿しないのでリトライ設定は使わない。
 */
export class DryRunPoster implements Poster {
  private readonly agent: AtpAgent;
  private readonly langs: string[] | undefined;
  private seq = 0;
  private readonly seqOf = new Map<string, number>();

  constructor(agent: AtpAgent, options: PosterOptions = {}) {
    this.agent = agent;
    this.langs = langsOf(options);
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
        // langs を付けない Bot ではキーごと出さない（undefined は JSON から落ちる）。
        langs: this.langs,
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
