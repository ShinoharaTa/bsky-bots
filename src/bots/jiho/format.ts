import moment from "moment-timezone";
import { TIMEZONE } from "../../core/date.js";

const TIME_FORMAT = "YYYY/MM/DD HH:mm:ss";

/**
 * 時報の本文。`なう(YYYY/MM/DD HH:mm:ss)`（JST・ゼロ埋め）。
 * 時刻は起点（:27 / :57）ではなく投稿直前の現在時刻を渡す。
 */
export function formatJiho(now: moment.MomentInput): string {
  return `なう(${moment(now).tz(TIMEZONE).format(TIME_FORMAT)})`;
}
