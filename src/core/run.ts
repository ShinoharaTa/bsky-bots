import { type FailureTracker, RunAborted } from "./abort.js";
import { notifyError } from "./notify.js";
import type { Poster } from "./poster.js";
import { describeError } from "./retry.js";

export interface GuardOptions {
  bot: string;
  poster: Poster;
  errorNotifyHandle: string;
  tracker: FailureTracker;
}

/**
 * Bot 本体を包む。失敗したら
 * 1. 原因を stderr に出す（投稿経路が壊れていても原因が残るよう、通知より先に）
 * 2. エラー通知を試みる（通知の失敗は握りつぶしてログにだけ残す）
 * 3. サマリを出して元の例外を投げ直す（main で exit 1 にする。systemd の OnFailure 用）
 * 正常終了でもサマリは出す。
 */
export async function guardRun(
  options: GuardOptions,
  body: () => Promise<void>,
): Promise<void> {
  const { bot, poster, errorNotifyHandle, tracker } = options;
  try {
    await body();
  } catch (ex) {
    console.error(`[${bot}] failed: ${describeError(ex)}`);
    if (!(ex instanceof RunAborted)) console.error(ex);
    try {
      await notifyError(poster, errorNotifyHandle);
    } catch (notifyEx) {
      console.error(`[${bot}] notifyError failed: ${describeError(notifyEx)}`);
    }
    const status = ex instanceof RunAborted ? "aborted" : "error";
    console.error(tracker.summary(bot, status, describeError(ex)));
    throw ex;
  }
  console.error(tracker.summary(bot, "ok"));
}
