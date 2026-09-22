import type { DateBounds } from "../../core/date.js";
import { type FeedItem, inDateBounds, isRepost } from "../../core/feed.js";

export interface ActivityCounts {
  posts: number;
  reposts: number;
  replys: number;
}

/** 前日の 投稿 / リプ / リポスト を数える。 */
export function countActivity(
  items: FeedItem[],
  bounds: DateBounds,
): ActivityCounts {
  const posts = items.filter(
    (item) => inDateBounds(item, bounds) && !isRepost(item),
  ).length;
  // リプはリポストを除外していない（現行どおり）。
  const replys = items.filter(
    (item) => inDateBounds(item, bounds) && item.isReply,
  ).length;
  const reposts = items.filter(
    (item) => inDateBounds(item, bounds) && isRepost(item),
  ).length;
  return { posts, reposts, replys };
}
