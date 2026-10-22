import type { AtpAgent } from "@atproto/api";
import type { AbortPolicy } from "./abort.js";
import type { DateBounds } from "./date.js";
import type { FeedLimits } from "./feed.js";
import type { Poster, PosterOptions } from "./poster.js";

/** 全 Bot に渡す。単発投稿 Bot はこれだけ受け取る。 */
export interface PostContext {
  poster: Poster;
}

/** 集計 Bot に渡す。フォロワーを読んで前日分を集計するための材料。 */
export interface AggregateContext extends PostContext {
  /** 読み取り（フォロワー取得）用。live でも公開エンドポイント。投稿は poster が持つ。 */
  agent: AtpAgent;
  /** フォロワー取得の対象アカウント。live では .env の identifier。 */
  actor: string;
  bounds: DateBounds;
  /** --limit-followers=N。未指定なら全件。 */
  limitFollowers?: number;
}

/** 全 Bot 共通。認証情報は name から `<NAME>_IDENTIFIER` / `<NAME>_APP_PASSWORD` を読む。 */
interface BotBase {
  name: string;
  /** 投稿の langs・429 リトライの設定。省略時は Poster の既定（langs: ["ja"]）。 */
  posterOptions?: PosterOptions;
}

/** 単発投稿 Bot。poster だけ受け取り、CLI 引数は --live だけ。 */
export interface SimpleBotDefinition extends BotBase {
  kind: "simple";
  run(ctx: PostContext): Promise<void>;
}

/** フォロワーの前日投稿を集計する Bot。--limit-followers を受け付ける。 */
export interface AggregateBotDefinition extends BotBase {
  kind: "aggregate";
  /** .env が無い dry-run でフォロワー取得に使う既定のハンドル。 */
  defaultHandle: string;
  /** エラー通知の宛先。両 Bot とも @shino3.net。 */
  errorNotifyHandle: string;
  /** 停止条件。取得失敗・投稿失敗が続いたら投稿をやめて非 0 で終わる。 */
  abortPolicy: AbortPolicy;
  /** フォロワー取得のページ上限。 */
  followersMaxPages: number;
  /** 投稿取得のページ上限。PDS 直読みとフォールバックで別に持つ。 */
  feedLimits: FeedLimits;
  run(ctx: AggregateContext): Promise<void>;
}

export type BotDefinition = SimpleBotDefinition | AggregateBotDefinition;
