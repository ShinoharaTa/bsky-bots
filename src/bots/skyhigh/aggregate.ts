import type { AppBskyFeedDefs } from "@atproto/api";
import type { DateBounds } from "../../core/date.js";
import { inDateBounds, isRepost } from "../../core/feed.js";

/** 前日のリポストを除いた投稿数。 */
export function countPosts(
  items: AppBskyFeedDefs.FeedViewPost[],
  bounds: DateBounds,
): number {
  return items.filter((item) => inDateBounds(item, bounds) && !isRepost(item))
    .length;
}
