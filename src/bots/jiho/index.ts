import { describeError, POST_RETRY } from "../../core/retry.js";
import type { PostContext, SimpleBotDefinition } from "../../core/types.js";
import { formatJiho } from "./format.js";

/**
 * 時報。毎時 :27 / :57 起点で 0〜6 分遅れて 1 回投稿する。
 * 遅延は systemd の RandomizedDelaySec が入れるので、プロセス内では待たない。
 * 失敗は通知しない（exit 1 で journal に残すだけ）。欠けた回も埋めない。
 */
export const jiho: SimpleBotDefinition = {
  kind: "simple",
  name: "jiho",
  posterOptions: {
    // 旧実装の実投稿と同じく langs を付けない。
    langs: null,
    retry: {
      ...POST_RETRY,
      // Retry-After を頭打ちにしない（短く切り詰めて投げ直しても 429 が続くだけ）。
      // 長すぎる待ちは下の合計上限で待たずに諦める。
      maxDelayMs: Number.POSITIVE_INFINITY,
      // 待ちは合計 3 分まで。次の起点（30 分後）にはみ出さないように。
      maxTotalWaitMs: 180000,
    },
  },
  run: async ({ poster }: PostContext): Promise<void> => {
    try {
      // 時刻は投稿の直前に取る。
      await poster.post(formatJiho(Date.now()));
    } catch (ex) {
      // CLI は原因を出さずに exit 1 にするので、ここで残す。
      console.error(`[jiho] failed: ${describeError(ex)}`);
      throw ex;
    }
  },
};
