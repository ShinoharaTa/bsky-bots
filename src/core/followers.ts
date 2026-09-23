import type { AppBskyGraphGetFollowers, AtpAgent } from "@atproto/api";

export interface Follower {
  /** 以降の API 呼び出しは全部これを使う。handle は表示用。 */
  did: string;
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
  const seen = new Set<string>();
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
    const getUsers: Follower[] = [];
    for (const item of data.followers) {
      // ページングの途中でフォロワーが増減すると同じ人が 2 ページに出ることがある。
      // 二重に数えないよう did で重複を除く（先に出た方を残す）。
      if (seen.has(item.did)) continue;
      seen.add(item.did);
      getUsers.push({
        did: item.did,
        handle: item.handle,
        name: item.displayName,
      });
    }
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
