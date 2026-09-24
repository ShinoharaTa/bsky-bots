import type moment from "moment-timezone";
import { hasVisibleText, isResolvableHandle } from "../../core/display.js";

export interface UserPosts {
  did: string;
  name: string | undefined;
  handle: string;
  posts: number;
}

/**
 * ランキングに出す名前。表示名 → ハンドル（解決できるものだけ）→ did の順。
 * 表示名があればそのまま使う（従来の出力を変えないので trim もしない）。
 */
export function rankingNameOf(user: UserPosts): string {
  if (user.name !== undefined && hasVisibleText(user.name)) return user.name;
  return isResolvableHandle(user.handle) ? user.handle : user.did;
}

export function formatStart(time: string, userCount: number): string {
  return `集計開始：${time} users: ${userCount}`;
}

export function formatRanking(
  sorted: UserPosts[],
  prevDay: moment.Moment,
): string {
  let text = `【すか廃ランキング ${prevDay.format(
    "YYYY/MM/DD",
  )}】#skyhighrank\n`;
  for (let index = 0; index < sorted.length; index++) {
    if (index >= 10) break;
    let record = index === 0 ? "👑：" : `${index + 1}位：`;
    record += `${sorted[index].posts > 999 ? "999+" : sorted[index].posts} ${rankingNameOf(sorted[index])}\n`;
    if (text.length + record.length > 300) {
      break;
    }
    text += record;
  }
  return text;
}

/** 投稿後の定型文投稿。 */
export function formatNotice(): string {
  let text = "廃人ランキングの集計条件は以下のとおりです。\n\n";
  text += "1. @skyhigh.bsky.social をフォローしている\n";
  text += "2. リポストは含まない\n";
  text += "3. リプはカウント対象内\n";
  text += "4. 集計時点から3000投稿まで集計\n";
  text += "5. しのさんに感謝のコーラを奢ることができる\n";
  return text;
}

export function formatEnd(time: string): string {
  return `集計終了：${time}`;
}
