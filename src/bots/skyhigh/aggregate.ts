import type { DateBounds } from "../../core/date.js";
import { type FeedItem, inDateBounds, isRepost } from "../../core/feed.js";

/** 前日のリポストを除いた投稿数。 */
export function countPosts(items: FeedItem[], bounds: DateBounds): number {
  return items.filter((item) => inDateBounds(item, bounds) && !isRepost(item))
    .length;
}
