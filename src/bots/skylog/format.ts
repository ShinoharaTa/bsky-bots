import type moment from "moment-timezone";
import type { ActivityCounts } from "./aggregate.js";

export function formatStart(time: string): string {
  return `集計開始：${time}`;
}

/** スレッドの親になる投稿。 */
export function formatIntro(): string {
  let text = "ソラログは一日の活動ログをお届けします\n\n";
  text += "1. @skylog.bsky.social をフォローしている\n";
  text += "2. 一日で通常のポストが10件以上\n";
  text += "3. 一日あたり最大1000投稿まで集計します\n";
  text += "4. 感謝のピザを、Shino3に奢ることができる\n";
  return text;
}

export function formatUser(
  handle: string,
  prevDay: moment.Moment,
  counts: ActivityCounts,
): string {
  const { posts, reposts, replys } = counts;
  let text = `@${handle}さんの集計データ\n`;
  text += `${prevDay.format("YYYY/MM/DD")}#skylog\n`;
  text += "\n";
  text += `今日の累計　　：${posts + reposts}\n`;
  text += "-------- 内訳 --------\n";
  text += `投稿　　　　　：${posts - replys}\n`;
  text += `リプ　　　　　：${replys}\n`;
  text += `リポスト　　　：${reposts}\n`;
  return text;
}

export function formatFailure(handle: string, prevDay: moment.Moment): string {
  let text = `@${handle}さんの集計データ\n`;
  text += `${prevDay.format("YYYY/MM/DD")}#skylog\n`;
  text += "\n";
  text += "取得に失敗しました\n";
  return text;
}

export function formatEnd(time: string): string {
  return `集計終了：${time}`;
}
