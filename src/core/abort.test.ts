import { describe, expect, it } from "vitest";
import {
  type AbortPolicy,
  DEFAULT_ABORT_POLICY,
  FailureTracker,
  RunAborted,
} from "./abort.js";

const policy: AbortPolicy = DEFAULT_ABORT_POLICY;

describe("FailureTracker", () => {
  it("取得失敗が連続 10 人でアボート。9 人までは続ける", () => {
    const tracker = new FailureTracker(policy);
    for (let i = 0; i < 9; i++) tracker.recordFetchFailure();
    expect(() => tracker.recordFetchFailure()).toThrow(RunAborted);
    expect(tracker.fetchFailures).toBe(10);
  });

  it("成功を挟めば連続はリセットされる", () => {
    const tracker = new FailureTracker(policy);
    for (let i = 0; i < 9; i++) tracker.recordFetchFailure();
    tracker.recordFetchSuccess(false);
    // 率の判定が始まる 20 人未満なので、連続さえ切れていれば続く。
    for (let i = 0; i < 9; i++) tracker.recordFetchFailure();
    expect(tracker.processed).toBe(19);
  });

  it("処理済み 20 人以上で失敗率が 20% を超えたらアボート", () => {
    const tracker = new FailureTracker(policy);
    // 16 成功 + 4 失敗 = 20 人で 20%（超えていない）
    for (let i = 0; i < 16; i++) tracker.recordFetchSuccess(false);
    for (let i = 0; i < 4; i++) tracker.recordFetchFailure();
    expect(tracker.processed).toBe(20);
    // 21 人目で 5/21 ≒ 23.8%
    expect(() => tracker.recordFetchFailure()).toThrow(/failure rate 5\/21/);
  });

  it("処理済み 20 人未満では失敗率を見ない", () => {
    const tracker = new FailureTracker(policy);
    tracker.recordFetchSuccess(false);
    for (let i = 0; i < 5; i++) {
      tracker.recordFetchFailure();
      tracker.recordFetchFailure();
      tracker.recordFetchSuccess(false);
    }
    // 16 人中 10 失敗でも、連続 10 に届かず 20 人未満なら続ける。
    expect(tracker.processed).toBe(16);
  });

  it("投稿失敗が連続 3 回でアボート。成功を挟めばリセット", () => {
    const tracker = new FailureTracker(policy);
    tracker.recordPostFailure();
    tracker.recordPostFailure();
    tracker.recordPostSuccess();
    tracker.recordPostFailure();
    tracker.recordPostFailure();
    expect(() => tracker.recordPostFailure()).toThrow(/post failed 3 times/);
    expect(tracker.postFailures).toBe(5);
  });

  it("取得成功が 0 人ならアボート。1 人でも成功・0 人処理なら続ける", () => {
    const allFailed = new FailureTracker(policy);
    for (let i = 0; i < 5; i++) allFailed.recordFetchFailure();
    expect(() => allFailed.assertAnyFetched()).toThrow(
      /fetch failed for all 5 users/,
    );

    const oneOk = new FailureTracker(policy);
    for (let i = 0; i < 4; i++) oneOk.recordFetchFailure();
    oneOk.recordFetchSuccess(false);
    expect(() => oneOk.assertAnyFetched()).not.toThrow();

    expect(() => new FailureTracker(policy).assertAnyFetched()).not.toThrow();
  });

  it("サマリは 1 行で件数と所要秒を出す", () => {
    let now = 1000;
    const tracker = new FailureTracker(policy, () => now);
    tracker.recordFetchSuccess(true);
    tracker.recordFetchSuccess(false);
    tracker.recordFetchFailure();
    tracker.recordPostFailure();
    now = 13500;
    expect(tracker.summary("skylog", "ok")).toBe(
      "[skylog] summary: status=ok processed=3 fetch_failed=1 post_failed=1 fallback=1 elapsed=12.5s",
    );
    expect(tracker.summary("skylog", "aborted", "boom")).toContain(
      'status=aborted processed=3 fetch_failed=1 post_failed=1 fallback=1 elapsed=12.5s reason="boom"',
    );
  });
});
