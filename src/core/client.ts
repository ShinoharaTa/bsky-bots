import { AtpAgent, type ComAtprotoServerCreateSession } from "@atproto/api";
import type { BotCredentials } from "./config.js";

/** 投稿するときだけ叩くエンドポイント。 */
export const LIVE_SERVICE = "https://bsky.social";
/** 読み取り専用。認証不要で getFollowers / getAuthorFeed を叩ける。 */
export const PUBLIC_SERVICE = "https://public.api.bsky.app";

export function createAgent(live: boolean): AtpAgent {
  return new AtpAgent({ service: live ? LIVE_SERVICE : PUBLIC_SERVICE });
}

/** login は --live のときだけ呼ぶ。失敗したら null。 */
export async function login(
  agent: AtpAgent,
  credentials: BotCredentials,
): Promise<ComAtprotoServerCreateSession.OutputSchema | null> {
  try {
    const { success, data } = await agent.login({
      identifier: credentials.identifier,
      password: credentials.password,
    });
    return success ? data : null;
  } catch {
    return null;
  }
}
