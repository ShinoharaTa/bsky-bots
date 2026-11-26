import { createHash } from "node:crypto";
import { AtpAgent } from "@atproto/api";
import { LIVE_SERVICE } from "../core/client.js";

/**
 * 起動時のログイン確認。各 Bot の認証情報で 1 回だけ login して、通るかを見る。
 * 投稿はしない。結果は状態ファイルとログに残すだけで、失敗しても落とさない。
 */

export type LoginResult = { ok: true } | { ok: false; reason: string };

export type LoginFn = (
  identifier: string,
  password: string,
) => Promise<LoginResult>;

/** 1 回の login のタイムアウト。 */
export const LOGIN_TIMEOUT_MS = 15_000;

/** 同じ認証情報をこの間隔より短く試さない（createSession の回数制限に配慮）。 */
export const LOGIN_CHECK_COOLDOWN_MS = 10 * 60_000;

/** 認証情報の短いハッシュ。値そのものは状態ファイルに残さない。 */
export function credentialFingerprint(
  identifier: string,
  password: string,
): string {
  return createHash("sha256")
    .update(`${identifier}\0${password}`)
    .digest("hex")
    .slice(0, 16);
}

/** bsky.social に login し、通ったら logout する（logout の失敗は無視）。 */
export async function defaultLogin(
  identifier: string,
  password: string,
): Promise<LoginResult> {
  const agent = new AtpAgent({ service: LIVE_SERVICE });
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<LoginResult>((resolve) => {
    timer = setTimeout(
      () => resolve({ ok: false, reason: "timeout" }),
      LOGIN_TIMEOUT_MS,
    );
  });
  const attempt = (async (): Promise<LoginResult> => {
    try {
      const { success } = await agent.login({ identifier, password });
      return success ? { ok: true } : { ok: false, reason: "login failed" };
    } catch (ex) {
      const message = ex instanceof Error ? ex.message : "";
      return { ok: false, reason: message || "login failed" };
    }
  })();
  let result: LoginResult;
  try {
    result = await Promise.race([attempt, timeout]);
  } finally {
    clearTimeout(timer);
  }
  if (result.ok) {
    // 作ったセッションを消す。待たない（遅くても確認の結果は変わらない）。
    agent.logout().catch(() => {});
  }
  return result;
}
