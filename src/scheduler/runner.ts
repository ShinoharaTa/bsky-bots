import type { ChildProcess, SpawnOptions } from "node:child_process";
import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import type { Redactor } from "./logline.js";

/**
 * ジョブ 1 回分の実行。子プロセスを起動し、出力を行単位で親に流し、
 * 終了コードと timeout をまとめて返す。
 */

/** SIGTERM を送ってから SIGKILL を送るまでの猶予。 */
export const KILL_GRACE_MS = 10_000;
/** 失敗通知に載せる stderr の行数。 */
export const STDERR_TAIL_LINES = 30;

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export interface RunOptions {
  /** dist/main.js に渡す引数（Bot 名と --live）。 */
  args: string[];
  cwd: string;
  timeoutMs: number;
  spawn: SpawnFn;
  redact: Redactor;
  /** 子の stdout / stderr の転送先。改行込みの文字列を受け取る。 */
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  now: () => number;
}

export interface RunResult {
  exit: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  /** spawn に失敗したときの理由。 */
  spawnError: string | null;
  elapsedMs: number;
  /** stderr の末尾（伏字済み・改行なし）。 */
  stderrTail: string[];
}

export function isFailure(result: RunResult): boolean {
  return (
    result.exit !== 0 ||
    result.signal !== null ||
    result.timedOut ||
    result.spawnError !== null
  );
}

/**
 * ストリームを行に分けて転送する。行の中身は伏字以外いじらない。
 * 最後に改行の無い行が残ったら、改行を足さずにそのまま流す。
 */
function pipeLines(
  stream: Readable | null,
  redact: Redactor,
  write: (text: string) => void,
  onLine: (line: string) => void,
): () => void {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let flushed = false;
  const emit = (text: string) => {
    let start = 0;
    for (;;) {
      const index = text.indexOf("\n", start);
      if (index < 0) break;
      const line = redact(text.slice(start, index));
      write(`${line}\n`);
      onLine(line);
      start = index + 1;
    }
    return text.slice(start);
  };
  const flush = () => {
    if (flushed) return;
    flushed = true;
    pending = emit(pending + decoder.end());
    if (pending !== "") {
      const line = redact(pending);
      write(line);
      onLine(line);
      pending = "";
    }
  };
  stream?.on("data", (chunk: Buffer | string) => {
    pending = emit(
      pending + (typeof chunk === "string" ? chunk : decoder.write(chunk)),
    );
  });
  stream?.on("end", flush);
  return flush;
}

export function runJob(options: RunOptions): Promise<RunResult> {
  const startedAt = options.now();
  const stderrTail: string[] = [];
  return new Promise((resolve) => {
    let child: ChildProcess;
    let settled = false;
    let timedOut = false;
    let termTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    const finish = (
      exit: number | null,
      signal: NodeJS.Signals | null,
      spawnError: string | null,
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(termTimer);
      clearTimeout(killTimer);
      resolve({
        exit,
        signal,
        timedOut,
        spawnError,
        elapsedMs: options.now() - startedAt,
        stderrTail,
      });
    };
    try {
      child = options.spawn(
        process.execPath,
        ["dist/main.js", ...options.args],
        {
          cwd: options.cwd,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    } catch (ex) {
      finish(null, null, String(ex));
      return;
    }
    const flushStdout = pipeLines(
      child.stdout,
      options.redact,
      options.stdout,
      () => {},
    );
    const flushStderr = pipeLines(
      child.stderr,
      options.redact,
      options.stderr,
      (line) => {
        stderrTail.push(line);
        if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift();
      },
    );
    termTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
    }, options.timeoutMs);
    child.on("error", (ex) => {
      // 起動できなかったときだけ結果にする。起動後の error は close を待つ。
      if (child.pid === undefined) {
        finish(null, null, options.redact(String(ex)));
      }
    });
    child.on("close", (code, signal) => {
      flushStdout();
      flushStderr();
      finish(code, signal, null);
    });
  });
}
