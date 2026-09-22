import moment from "moment-timezone";

export const TIMEZONE = "Asia/Tokyo";

/** 集計対象の日付境界。前日 00:00 以上 当日 00:00 未満。 */
export interface DateBounds {
  prevDay: moment.Moment;
  today: moment.Moment;
}

/**
 * 日付境界を作る。基準時刻を省略すると現在時刻。
 * テストから固定時刻を注入できるように引数で受ける。
 */
export function createDateBounds(now?: moment.MomentInput): DateBounds {
  const base = moment(now).tz(TIMEZONE);
  return {
    prevDay: base.clone().subtract(1, "days").startOf("day"),
    today: base.clone().startOf("day"),
  };
}

/** 投稿文に埋める現在時刻（JST）。 */
export function nowJst(): moment.Moment {
  return moment().tz(TIMEZONE);
}
