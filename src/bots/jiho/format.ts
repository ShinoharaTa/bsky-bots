import { formatJstDateTime } from "../../core/date.js";

/**
 * 時報の本文。`なう(YYYY/MM/DD HH:mm:ss)`（JST・ゼロ埋め）。
 * 時刻は起点（:27 / :57）ではなく投稿直前の現在時刻を渡す。
 */
export function formatJiho(now: Date | number | string): string {
  return `なう(${formatJstDateTime(new Date(now))})`;
}
