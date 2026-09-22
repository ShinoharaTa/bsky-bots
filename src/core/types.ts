import type { AtpAgent } from "@atproto/api";
import type { DateBounds } from "./date.js";
import type { FeedLimits } from "./feed.js";
import type { Poster } from "./poster.js";

export interface BotContext {
  agent: AtpAgent;
  poster: Poster;
  /** フォロワー取得の対象アカウント。live では .env の identifier。 */
  actor: string;
  bounds: DateBounds;
  /** --limit-followers=N。未指定なら全件。 */
  limitFollowers?: number;
}

export interface BotDefinition {
  name: string;
  /** .env が無い dry-run でフォロワー取得に使う既定のハンドル。 */
  defaultHandle: string;
  /** エラー通知の宛先。Bot ごとに文字列が違うので統一しない。 */
  errorNotifyHandle: string;
  /** フォロワー取得のページ上限。 */
  followersMaxPages: number;
  /** 投稿取得のページ上限。PDS 直読みとフォールバックで別に持つ。 */
  feedLimits: FeedLimits;
  run(ctx: BotContext): Promise<void>;
}
