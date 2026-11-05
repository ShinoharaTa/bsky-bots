import moment from "moment-timezone";
import { describe, expect, it } from "vitest";
import { createDateBounds, formatJstDate, formatJstDateTime } from "./date.js";

/**
 * 一時テスト。moment-timezone を外す前に、新しい date.ts が moment と
 * 全件一致することを確かめる。moment と一緒に次のコミットで削除する。
 */
const FROM = Date.parse("2015-01-01T00:00:00Z");
const TO = Date.parse("2040-01-01T00:00:00Z");
const STEP_MS = (17 * 60 + 1) * 1000;

describe("date.ts と moment-timezone の突き合わせ", () => {
  it("2015〜2040 を 17 分 + 1 秒刻みで全件一致する", () => {
    let samples = 0;
    const mismatches: string[] = [];
    for (let ms = FROM; ms < TO; ms += STEP_MS) {
      const base = moment(ms).tz("Asia/Tokyo");
      const expectedPrev = base
        .clone()
        .subtract(1, "days")
        .startOf("day")
        .valueOf();
      const expectedToday = base.clone().startOf("day").valueOf();
      const expectedDate = base.format("YYYY/MM/DD");
      const expectedDateTime = base.format("YYYY/MM/DD HH:mm:ss");
      const bounds = createDateBounds(ms);
      if (
        bounds.prevDay.getTime() !== expectedPrev ||
        bounds.today.getTime() !== expectedToday ||
        formatJstDate(ms) !== expectedDate ||
        formatJstDateTime(ms) !== expectedDateTime
      ) {
        mismatches.push(new Date(ms).toISOString());
      }
      samples++;
    }
    console.log(
      `crosscheck: samples=${samples} mismatches=${mismatches.length}`,
    );
    expect(mismatches.slice(0, 10)).toEqual([]);
    expect(samples).toBeGreaterThan(770_000);
  }, 120_000);
});
