/**
 * ログ行の整形と伏字。
 * text（既定）: 子の行は伏字だけ適用してそのまま流す。スケジューラ自身の行は
 * `[scheduler] <msg> key=value ...` の形にする。
 * json: すべての行を 1 行 1 JSON にする（出力先はすべて stdout）。
 */

const JWT_PATTERN = /eyJ[\w-]+\.[\w-]+\.[\w-]+/g;
const REDACTED = "<redacted>";

export type Redactor = (text: string) => string;

/** secrets の値と JWT 形式の文字列を `<redacted>` に置き換える関数を作る。 */
export function createRedactor(secrets: readonly string[]): Redactor {
  // 長いものから置き換える（短い値が長い値の一部だった場合に取りこぼさない）。
  const values = [...new Set(secrets.filter((value) => value !== ""))].sort(
    (a, b) => b.length - a.length,
  );
  return (text) => {
    let result = text;
    for (const value of values) result = result.split(value).join(REDACTED);
    return result.replace(JWT_PATTERN, REDACTED);
  };
}

export type Fields = Record<string, string | number | boolean | null>;

/** `[scheduler] <msg> key=value ...`。null は `none` にする。 */
export function formatSchedulerLine(msg: string, fields: Fields = {}): string {
  const parts = [`[scheduler] ${msg}`];
  for (const [key, value] of Object.entries(fields)) {
    parts.push(`${key}=${value ?? "none"}`);
  }
  return parts.join(" ");
}

export type LogFormat = "text" | "json";
export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/** level の行を、LOG_LEVEL=minLevel のときに出すか。 */
export function isLevelEnabled(level: LogLevel, minLevel: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[minLevel];
}

/**
 * スケジューラ自身の行の level。msg の接頭辞（`debug: ` `warn: ` `error: `
 * `spawn failed:`）で決める。
 */
export function schedulerLevel(msg: string): LogLevel {
  if (msg.startsWith("debug: ")) return "debug";
  if (msg.startsWith("warn: ")) return "warn";
  if (msg.startsWith("error: ") || msg.startsWith("spawn failed:")) {
    return "error";
  }
  return "info";
}

const SUMMARY_PATTERN = / summary: status=(\S+)/;

/**
 * 子の行の level。`[<bot>] failed:` を含めば error、
 * ` summary: status=` の status が ok 以外なら warn、それ以外は info。
 */
export function childLevel(job: string, line: string): LogLevel {
  if (line.includes(`[${job}] failed:`)) return "error";
  const status = SUMMARY_PATTERN.exec(line)?.[1];
  if (status !== undefined && status !== "ok") return "warn";
  return "info";
}

export interface JsonLine {
  ts: number;
  level: LogLevel;
  service: string;
  env: string;
  job?: string;
  run_id?: string;
  stream: "stdout" | "stderr" | "scheduler";
  msg: string;
}

/** 1 行の JSON（改行なし）。job / run_id は値があるときだけ入れる。 */
export function formatJsonLine(line: JsonLine): string {
  return JSON.stringify({
    ts: new Date(line.ts).toISOString(),
    level: line.level,
    service: line.service,
    env: line.env,
    ...(line.job === undefined ? {} : { job: line.job }),
    ...(line.run_id === undefined ? {} : { run_id: line.run_id }),
    stream: line.stream,
    msg: line.msg,
  });
}

/**
 * json の msg にするスケジューラ自身の行。level と重なる接頭辞を外し、
 * job / run_id 以外の fields を `key=value` で後ろに付ける。
 */
export function formatSchedulerMsg(msg: string, fields: Fields = {}): string {
  const body = msg.replace(/^(debug|warn|error): /, "");
  const parts = [body];
  for (const [key, value] of Object.entries(fields)) {
    if (key === "job" || key === "run_id") continue;
    parts.push(`${key}=${value ?? "none"}`);
  }
  return parts.join(" ");
}
