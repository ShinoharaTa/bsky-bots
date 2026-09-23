/**
 * 停止条件（アボート）。取得先の障害（plc.directory / AppView など）で
 * 大半のユーザーが取れないまま集計を投稿してしまうのを防ぐ。
 * アボートしたらそれ以降は一切投稿せず、非 0 で終わる。
 */
export interface AbortPolicy {
  /** 取得失敗がこの人数だけ連続したらアボート。 */
  maxConsecutiveFetchFailures: number;
  /** 失敗率の判定を始める処理済み人数。これ未満では率を見ない。 */
  fetchFailureRateMinProcessed: number;
  /** 取得失敗率（0〜1）。これを超えたらアボート。 */
  maxFetchFailureRate: number;
  /** 投稿失敗がこの回数だけ連続したらアボート。 */
  maxConsecutivePostFailures: number;
}

export const DEFAULT_ABORT_POLICY: AbortPolicy = {
  maxConsecutiveFetchFailures: 10,
  fetchFailureRateMinProcessed: 20,
  maxFetchFailureRate: 0.2,
  maxConsecutivePostFailures: 3,
};

/** 停止条件に当たったときに投げる。 */
export class RunAborted extends Error {
  constructor(reason: string) {
    super(`aborted: ${reason}`);
    this.name = "RunAborted";
  }
}

/**
 * 処理件数と失敗件数を数え、停止条件に当たったら RunAborted を投げる。
 * record* の直後に判定するので、呼び出し側は record* を呼ぶだけでよい。
 */
export class FailureTracker {
  private readonly policy: AbortPolicy;
  private readonly startedAt: number;
  private readonly now: () => number;
  /** 取得を試みた人数（成功 + 失敗）。 */
  processed = 0;
  fetchFailures = 0;
  postFailures = 0;
  /** PDS 直読みに失敗して AppView から取れた人数。 */
  fallbacks = 0;
  private consecutiveFetchFailures = 0;
  private consecutivePostFailures = 0;

  constructor(policy: AbortPolicy, now: () => number = Date.now) {
    this.policy = policy;
    this.now = now;
    this.startedAt = now();
  }

  recordFetchSuccess(fallback: boolean): void {
    this.processed += 1;
    if (fallback) this.fallbacks += 1;
    this.consecutiveFetchFailures = 0;
  }

  recordFetchFailure(): void {
    this.processed += 1;
    this.fetchFailures += 1;
    this.consecutiveFetchFailures += 1;
    const { policy } = this;
    if (this.consecutiveFetchFailures >= policy.maxConsecutiveFetchFailures) {
      throw new RunAborted(
        `fetch failed ${this.consecutiveFetchFailures} times in a row`,
      );
    }
    if (
      this.processed >= policy.fetchFailureRateMinProcessed &&
      this.fetchFailures / this.processed > policy.maxFetchFailureRate
    ) {
      throw new RunAborted(
        `fetch failure rate ${this.fetchFailures}/${this.processed} exceeds ${policy.maxFetchFailureRate * 100}%`,
      );
    }
  }

  recordPostSuccess(): void {
    this.consecutivePostFailures = 0;
  }

  recordPostFailure(): void {
    this.postFailures += 1;
    this.consecutivePostFailures += 1;
    if (
      this.consecutivePostFailures >= this.policy.maxConsecutivePostFailures
    ) {
      throw new RunAborted(
        `post failed ${this.consecutivePostFailures} times in a row`,
      );
    }
  }

  /** 運用で見るための 1 行サマリ。正常終了・異常終了とも stderr に出す。 */
  summary(
    bot: string,
    status: "ok" | "aborted" | "error",
    reason?: string,
  ): string {
    const elapsed = ((this.now() - this.startedAt) / 1000).toFixed(1);
    return (
      `[${bot}] summary: status=${status} processed=${this.processed}` +
      ` fetch_failed=${this.fetchFailures} post_failed=${this.postFailures}` +
      ` fallback=${this.fallbacks} elapsed=${elapsed}s` +
      (reason ? ` reason=${JSON.stringify(reason)}` : "")
    );
  }
}
