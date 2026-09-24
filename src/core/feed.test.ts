import moment from "moment-timezone";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DateBounds } from "./date.js";
import {
  decodeTid,
  encodeTid,
  POST_COLLECTION,
  scanPdsCollection,
} from "./feed.js";

const NO_RETRY = {
  maxRetries: 0,
  baseDelayMs: 0,
  maxDelayMs: 0,
  timeoutMs: 1000,
};

/** 対象日 2026-09-21 (JST)。 */
const bounds: DateBounds = {
  prevDay: moment.tz("2026-09-21", "Asia/Tokyo"),
  today: moment.tz("2026-09-22", "Asia/Tokyo"),
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("encodeTid", () => {
  it("issue #16 で検証したカーソルと一致する", () => {
    expect(encodeTid(Date.parse("2026-09-22T00:00:00+09:00"))).toBe(
      "3mvzy2koz2222",
    );
  });

  it("decodeTid と往復する（時刻 → TID → 時刻）", () => {
    for (const iso of [
      "2023-04-01T00:00:00.000Z",
      "2026-09-21T14:59:59.999Z",
      "2026-09-22T00:00:00.001+09:00",
      "2030-12-31T23:59:59.123Z",
    ]) {
      const ms = Date.parse(iso);
      const tid = encodeTid(ms);
      expect(tid).toHaveLength(13);
      expect(decodeTid(tid)).toBe(ms);
    }
  });

  it("decodeTid と往復する（TID → 時刻 → TID、clock id 0 でマイクロ秒あり）", () => {
    // 実在の rkey 形式。末尾 2 文字が clock id 0 のもの。
    for (const tid of ["3mvzy2koz2222", "3lbqwxc7e4k22", "3kz7j5q2zyc22"]) {
      const ms = decodeTid(tid);
      expect(ms).not.toBeNull();
      expect(encodeTid(ms as number)).toBe(tid);
    }
  });

  it("clock id を入れられ、時刻の順と文字列の順が一致する", () => {
    const ms = Date.parse("2026-09-21T15:00:00Z");
    expect(decodeTid(encodeTid(ms, 1023))).toBe(ms);
    expect(encodeTid(ms) < encodeTid(ms, 1)).toBe(true);
    expect(encodeTid(ms - 1, 1023) < encodeTid(ms)).toBe(true);
  });
});

describe("scanPdsCollection", () => {
  it("初回の cursor に対象日の終端（today 00:00 JST）の TID を渡す", async () => {
    const urls: URL[] = [];
    vi.stubGlobal("fetch", async (url: URL) => {
      urls.push(new URL(url));
      const rkey = encodeTid(Date.parse("2026-09-21T23:59:00+09:00"));
      const old = encodeTid(Date.parse("2026-09-20T12:00:00+09:00"));
      return new Response(
        JSON.stringify({
          records: [
            { uri: `at://did:plc:x/${POST_COLLECTION}/${rkey}`, value: {} },
            { uri: `at://did:plc:x/${POST_COLLECTION}/${old}`, value: {} },
          ],
          cursor: old,
        }),
      );
    });
    const result = await scanPdsCollection(
      "https://pds.example",
      "did:plc:x",
      POST_COLLECTION,
      bounds,
      30,
      NO_RETRY,
    );
    expect(urls).toHaveLength(1);
    expect(urls[0].searchParams.get("cursor")).toBe("3mvzy2koz2222");
    expect(result.items).toHaveLength(1);
  });
});
