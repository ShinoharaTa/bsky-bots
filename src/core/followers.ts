import type { AppBskyGraphGetFollowers, AtpAgent } from "@atproto/api";

export interface Follower {
  handle: string;
  name: string | undefined;
}

/**
 * フォロワーをページングで取得する。
 * limit を渡すと先頭 limit 人で打ち切る（--limit-followers 用）。
 */
export async function getFollowers(
  agent: AtpAgent,
  actor: string,
  maxPages: number,
  limit?: number,
): Promise<Follower[]> {
  let cursor: string | null = null;
  let users: Follower[] = [];
  for (let index = 0; index < maxPages; index++) {
    const request: AppBskyGraphGetFollowers.QueryParams = {
      actor: actor,
      limit: 100,
    };
    if (cursor) {
      request.cursor = cursor;
    }
    const { data } = await agent.app.bsky.graph.getFollowers(request);
    console.error(data.followers.length);
    const getUsers = data.followers.map((item) => {
      return {
        handle: item.handle,
        name: item.displayName,
      };
    });
    users = users.concat(getUsers);
    if (limit !== undefined && users.length >= limit) {
      users = users.slice(0, limit);
      break;
    }
    if (data.cursor) {
      cursor = data.cursor;
    } else {
      break;
    }
  }
  return users;
}
