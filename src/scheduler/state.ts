import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 状態ファイル。healthcheck が読む。
 * tmp に書いてから rename する（読み手が書きかけを読まないように）。
 */

export const STATE_FILE = "scheduler-state.json";

export interface JobState {
  name: string;
  /** 次回の起点（ISO）。 */
  next: string | null;
  running: boolean;
  /** 前回の終了コード。シグナル・timeout・spawn 失敗のときは、その種別の文字列。 */
  lastExit: number | string | null;
  /** 前回の起動時刻（ISO）。 */
  lastRunAt: string | null;
  /** 起動時のログイン確認の結果。healthcheck は見ない。 */
  login?: LoginState;
}

export interface LoginState {
  /** pending: 未確認。unset: 認証情報が無い。 */
  result: "pending" | "ok" | "failed" | "unset";
  /** 確認した時刻（ISO）。 */
  at: string | null;
  /** 認証情報の短いハッシュ（credentialFingerprint）。値ではない。 */
  fp: string | null;
  reason?: string;
}

export interface SchedulerState {
  /** 書き込んだ時刻（epoch ms）。 */
  ts: number;
  ready: boolean;
  mode: string;
  pid: number;
  jobs: JobState[];
}

export function statePath(stateDir: string): string {
  return join(stateDir, STATE_FILE);
}

/** 書けなければ例外を投げる。 */
export function writeState(stateDir: string, state: SchedulerState): void {
  const path = statePath(stateDir);
  const tmp = `${path}.${state.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state)}\n`);
  renameSync(tmp, path);
}

/** 読めない・壊れているときは null。 */
export function readState(stateDir: string): SchedulerState | null {
  try {
    return JSON.parse(readFileSync(statePath(stateDir), "utf8"));
  } catch {
    return null;
  }
}
