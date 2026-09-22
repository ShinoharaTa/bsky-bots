import type {
  AppBskyFeedDefs,
  AppBskyFeedGetAuthorFeed,
  AtpAgent,
} from "@atproto/api";
import moment from "moment-timezone";
import { type DateBounds, TIMEZONE } from "./date.js";

export function isRepost(item: AppBskyFeedDefs.FeedViewPost): boolean {
  return item.reason?.$type === "app.bsky.feed.defs#reasonRepost";
}

export function inDateBounds(
  item: AppBskyFeedDefs.FeedViewPost,
  bounds: DateBounds,
): boolean {
  const itemDate = moment(item.post.indexedAt).tz(TIMEZONE);
  return (
    itemDate.isSameOrAfter(bounds.prevDay) && itemDate.isBefore(bounds.today)
  );
}

/**
 * author feed をページングで取得し、生の FeedViewPost をそのまま返す。
 * 数えるのは Bot 側（aggregate.ts）。
 */
export async function getFeed(
  agent: AtpAgent,
  actor: string,
  bounds: DateBounds,
  maxPages: number,
): Promise<AppBskyFeedDefs.FeedViewPost[]> {
  let cursor: string | null = null;
  let items: AppBskyFeedDefs.FeedViewPost[] = [];
  for (let index = 0; index < maxPages; index++) {
    const request: AppBskyFeedGetAuthorFeed.QueryParams = {
      actor: actor,
      limit: 100,
    };
    if (cursor) {
      request.cursor = cursor;
    }
    const { data } = await agent.app.bsky.feed.getAuthorFeed(request);
    items = items.concat(data.feed);
    const filterd = data.feed.filter(
      (item) => inDateBounds(item, bounds) && !isRepost(item),
    );
    if (data.cursor) {
      cursor = data.cursor;
    } else {
      break;
    }
    // 打ち切り判定。filterd は prevDay 以降しか含まないので end は常に
    // undefined になり、実際には打ち切られない（既知のバグ。Phase 5 で直す）。
    // ここでは出力を変えないため現行の挙動をそのまま移す。
    const end = filterd.find((item) => {
      const itemDate = moment(item.post.indexedAt).tz(TIMEZONE);
      return itemDate.isBefore(bounds.prevDay) && !isRepost(item);
    });
    if (end) break;
  }
  return items;
}
