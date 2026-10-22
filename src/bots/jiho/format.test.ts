import { describe, expect, it } from "vitest";
import { formatJiho } from "./format.js";

describe("formatJiho", () => {
  it("JST の現在時刻を なう(YYYY/MM/DD HH:mm:ss) で出す", () => {
    expect(formatJiho("2026-10-22T12:34:56+09:00")).toBe(
      "なう(2026/10/22 12:34:56)",
    );
    // Date でも epoch ms でも同じ。
    const at = new Date("2026-10-22T03:34:56Z");
    expect(formatJiho(at)).toBe("なう(2026/10/22 12:34:56)");
    expect(formatJiho(at.getTime())).toBe("なう(2026/10/22 12:34:56)");
  });

  it("月日時分秒をゼロ埋めする", () => {
    expect(formatJiho("2027-01-01T00:00:05+09:00")).toBe(
      "なう(2027/01/01 00:00:05)",
    );
    expect(formatJiho("2026-03-04T05:06:07+09:00")).toBe(
      "なう(2026/03/04 05:06:07)",
    );
  });

  it("UTC 15:00 で JST の日付が変わる", () => {
    expect(formatJiho("2026-10-22T14:59:59Z")).toBe(
      "なう(2026/10/22 23:59:59)",
    );
    expect(formatJiho("2026-10-22T15:00:00Z")).toBe(
      "なう(2026/10/23 00:00:00)",
    );
    // 年も跨ぐ。
    expect(formatJiho("2026-12-31T15:00:00Z")).toBe(
      "なう(2027/01/01 00:00:00)",
    );
  });

  it("ミリ秒は切り捨てる（繰り上げない）", () => {
    expect(formatJiho("2026-10-22T14:59:59.999Z")).toBe(
      "なう(2026/10/22 23:59:59)",
    );
  });
});
