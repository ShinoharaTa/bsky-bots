/**
 * JST の日付計算。Asia/Tokyo は 1951 年以降 DST も offset 変更も無いので、
 * 固定 +09:00 として素の Date 演算で扱う（日本が DST を導入したら直す）。
 * 組み立ては getUTC* だけで行うので、実行環境の TZ に依存しない。
 */
export const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

/** 集計対象の日付境界。前日 00:00 以上 当日 00:00 未満。 */
export interface DateBounds {
  prevDay: Date;
  today: Date;
}

function toMs(at: Date | number): number {
  return typeof at === "number" ? at : at.getTime();
}

function pad(value: number, length = 2): string {
  return String(value).padStart(length, "0");
}

/** `at` を含む JST の日の 00:00。 */
export function startOfJstDay(at: Date | number): Date {
  const ms = toMs(at);
  return new Date(
    Math.floor((ms + JST_OFFSET_MS) / DAY_MS) * DAY_MS - JST_OFFSET_MS,
  );
}

/**
 * 日付境界を作る。基準時刻を省略すると現在時刻。
 * テストから固定時刻を注入できるように引数で受ける。
 */
export function createDateBounds(now: Date | number = Date.now()): DateBounds {
  const today = startOfJstDay(now);
  return {
    prevDay: new Date(today.getTime() - DAY_MS),
    today,
  };
}

/** `YYYY/MM/DD`（JST）。 */
export function formatJstDate(at: Date | number): string {
  const jst = new Date(toMs(at) + JST_OFFSET_MS);
  return `${pad(jst.getUTCFullYear(), 4)}/${pad(jst.getUTCMonth() + 1)}/${pad(jst.getUTCDate())}`;
}

/** `YYYY/MM/DD HH:mm:ss`（JST・ミリ秒は切り捨て）。 */
export function formatJstDateTime(at: Date | number): string {
  const jst = new Date(toMs(at) + JST_OFFSET_MS);
  return `${formatJstDate(at)} ${pad(jst.getUTCHours())}:${pad(jst.getUTCMinutes())}:${pad(jst.getUTCSeconds())}`;
}

/** `YYYY-MM-DD` を JST の 00:00 として読む。形式違い・実在しない日付は null。 */
export function parseJstDate(day: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const ms = Date.parse(`${day}T00:00:00+09:00`);
  if (Number.isNaN(ms)) return null;
  // V8 は 2026-02-30 を 3/2 に丸めるので、書き戻して一致を確かめる。
  if (formatJstDate(ms) !== day.replaceAll("-", "/")) return null;
  return new Date(ms);
}
