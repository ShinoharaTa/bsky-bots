import type moment from "moment-timezone";
import type { Follower } from "../../core/followers.js";
import {
  mentionFacet,
  type PostContent,
  utf8Length,
} from "../../core/richtext.js";
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

/** 本文に書いても解決されないハンドル。did ベース化で集計対象に入ってくる。 */
function isResolvableHandle(handle: string): boolean {
  return handle.length > 0 && !handle.endsWith(".invalid");
}

/**
 * 見える文字が残るか。空白と制御文字しか無い displayName が実在する
 * （did:plc:u2422q7nqnd3x3mn4ed56uxx は U+0081 の 1 文字だけ）。
 */
function hasVisibleText(text: string): boolean {
  return text.replace(/[\p{C}\p{Z}]/gu, "").length > 0;
}

/**
 * ハンドルが使えないユーザーの表示テキスト。
 * displayName が空のユーザーが実在するので did に落とす。空文字は作らない。
 */
function displayTextOf(user: Follower): string {
  const name = user.name?.trim() ?? "";
  return hasVisibleText(name) ? name : user.did;
}

export function formatUser(
  user: Follower,
  prevDay: moment.Moment,
  counts: ActivityCounts,
): PostContent {
  const { posts, reposts, replys } = counts;
  const resolvable = isResolvableHandle(user.handle);
  const mention = `@${resolvable ? user.handle : displayTextOf(user)}`;
  let text = `${mention}さんの集計データ\n`;
  text += `${prevDay.format("YYYY/MM/DD")}#skylog\n`;
  text += "\n";
  text += `今日の累計　　：${posts + reposts}\n`;
  text += "-------- 内訳 --------\n";
  text += `投稿　　　　　：${posts - replys}\n`;
  text += `リプ　　　　　：${replys}\n`;
  text += `リポスト　　　：${reposts}\n`;
  // 解決できるハンドルは detectFacets に任せる。従来と同じ出力になる。
  if (resolvable) return { text };
  // メンションは本文の先頭なので byteStart は 0。
  return { text, facets: [mentionFacet(user.did, 0, utf8Length(mention))] };
}

export function formatEnd(time: string): string {
  return `集計終了：${time}`;
}
