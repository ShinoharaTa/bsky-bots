import { describe, expect, it } from "vitest";
import {
  createDateBounds,
  formatJstDate,
  formatJstDateTime,
  JST_OFFSET_MS,
  parseJstDate,
  startOfJstDay,
} from "./date.js";

const DAY_MS = 86_400_000;

// 期待値は置き換え前の実装（tz データ 2025b）で生成した値。
// getUTC* だけで組み立てるので process.env.TZ を変えて試す必要は無い。
const CASES: [string, number, number, string][] = [
  [
    "2026-09-21T14:59:59.999Z",
    1789830000000,
    1789916400000,
    "2026/09/21 23:59:59",
  ],
  [
    "2026-09-21T15:00:00.000Z",
    1789916400000,
    1790002800000,
    "2026/09/22 00:00:00",
  ],
  [
    "2026-09-22T00:00:00.000Z",
    1789916400000,
    1790002800000,
    "2026/09/22 09:00:00",
  ],
  [
    "2026-12-31T14:59:59.999Z",
    1798556400000,
    1798642800000,
    "2026/12/31 23:59:59",
  ],
  [
    "2026-12-31T15:00:00.000Z",
    1798642800000,
    1798729200000,
    "2027/01/01 00:00:00",
  ],
  [
    "2028-02-28T15:00:00.000Z",
    1835276400000,
    1835362800000,
    "2028/02/29 00:00:00",
  ],
  [
    "2028-02-29T14:59:59.999Z",
    1835276400000,
    1835362800000,
    "2028/02/29 23:59:59",
  ],
  [
    "2026-03-01T14:59:59.999Z",
    1772204400000,
    1772290800000,
    "2026/03/01 23:59:59",
  ],
  [
    "2026-10-22T03:34:56.000Z",
    1792508400000,
    1792594800000,
    "2026/10/22 12:34:56",
  ],
  ["1970-01-01T00:00:00.000Z", -118800000, -32400000, "1970/01/01 09:00:00"],
];

describe("createDateBounds", () => {
  it.each(CASES)("%s の前日 00:00 と当日 00:00（JST）", (iso, prev, today) => {
    const bounds = createDateBounds(new Date(iso));
    expect(bounds.prevDay.getTime()).toBe(prev);
    expect(bounds.today.getTime()).toBe(today);
    // epoch ms でも同じ。
    expect(createDateBounds(Date.parse(iso)).today.getTime()).toBe(today);
  });

  it("前日と当日の差は 1 日で、前日は JST の 00:00", () => {
    for (const [iso] of CASES) {
      const { prevDay, today } = createDateBounds(new Date(iso));
      expect(today.getTime() - prevDay.getTime()).toBe(DAY_MS);
      // 1970 年より前は負になるので剰余を正に寄せる（-0 を避ける）。
      const offset = (prevDay.getTime() + JST_OFFSET_MS) % DAY_MS;
      expect((offset + DAY_MS) % DAY_MS).toBe(0);
    }
  });

  it("startOfJstDay は当日 00:00 と同じ", () => {
    for (const [iso, , today] of CASES) {
      expect(startOfJstDay(new Date(iso)).getTime()).toBe(today);
    }
  });
});

describe("formatJstDateTime / formatJstDate", () => {
  it.each(CASES)("%s", (iso, _prev, _today, expected) => {
    expect(formatJstDateTime(new Date(iso))).toBe(expected);
    expect(formatJstDateTime(Date.parse(iso))).toBe(expected);
    expect(formatJstDate(new Date(iso))).toBe(expected.slice(0, 10));
  });
});

describe("parseJstDate", () => {
  it("YYYY-MM-DD を JST 00:00 として読む", () => {
    expect(parseJstDate("2026-09-21")?.getTime()).toBe(1789916400000);
  });

  it("形式違い・実在しない日付は null", () => {
    expect(parseJstDate("2026-02-30")).toBeNull();
    expect(parseJstDate("2026/09/21")).toBeNull();
    expect(parseJstDate("2026-13-01")).toBeNull();
  });
});
