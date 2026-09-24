import { execFile } from "node:child_process";
import { hostname } from "node:os";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { nowJst } from "../core/date.js";

/**
 * Bot の unit が失敗したことを Discord webhook に知らせる。
 * deploy/bsky-bots-failure@.service（OnFailure=）から起動される。
 * usage: node dist/tools/notify-failure.js <unit名>
 *
 * webhook URL は秘密情報なので、stdout / stderr のどこにも出さない。
 */

/** Discord のメッセージ本文の上限（文字数）。 */
export const DISCORD_MAX_LENGTH = 2000;
/** journal から拾う行数。 */
const LOG_LINES = 30;
/** 1 リクエストのタイムアウト。 */
const REQUEST_TIMEOUT_MS = 15_000;
/** 429 の Retry-After をこれ以上は待たない（unit の TimeoutStartSec に収める）。 */
const MAX_RETRY_AFTER_MS = 60_000;
const TIME_FORMAT = "YYYY/MM/DD HH:mm:ss";

export interface UnitStatus {
  result: string;
  execMainStatus: string;
  invocationId: string;
}

export interface FailureReport {
  unit: string;
  host: string;
  /** JST の表示用文字列。 */
  time: string;
  status: UnitStatus;
  /** journal の末尾。取れなかったときは理由を入れる。 */
  log: string;
}

export type RunCommand = (file: string, args: string[]) => Promise<string>;

export interface Deps {
  env: NodeJS.ProcessEnv;
  fetch: typeof fetch;
  run: RunCommand;
  sleep: (ms: number) => Promise<void>;
  stderr: (line: string) => void;
  host: () => string;
  now: () => string;
}

/** `systemctl show` の Key=Value 出力を読む。 */
export function parseShow(output: string): UnitStatus {
  const values = new Map<string, string>();
  for (const line of output.split("\n")) {
    const index = line.indexOf("=");
    if (index > 0) values.set(line.slice(0, index), line.slice(index + 1));
  }
  return {
    result: values.get("Result") ?? "",
    execMainStatus: values.get("ExecMainStatus") ?? "",
    invocationId: values.get("InvocationID") ?? "",
  };
}

/** ログ中の ``` でコードブロックが閉じないよう、1 文字目の後にゼロ幅スペースを挟む。 */
function escapeFence(text: string): string {
  return text.replace(/```/g, "`​``");
}

/**
 * Discord に送る本文を組み立てる。
 * 上限を超えるときはログの**先頭側**を削る（原因は末尾にあることが多い）。
 */
export function buildMessage(report: FailureReport): string {
  const status = `Result=${report.status.result || "?"} / ExecMainStatus=${report.status.execMainStatus || "?"}`;
  const header = [
    `**${report.unit} failed**`,
    `host: ${report.host}`,
    `time: ${report.time} JST`,
    status,
  ].join("\n");
  const open = "\n```\n";
  const close = "\n```";
  const marker = "...(truncated)\n";
  let log = escapeFence(report.log.trimEnd()) || "(no log)";
  const budget =
    DISCORD_MAX_LENGTH - header.length - open.length - close.length;
  if (log.length > budget) {
    log = marker + log.slice(log.length - (budget - marker.length));
  }
  return `${header}${open}${log}${close}`.slice(0, DISCORD_MAX_LENGTH);
}

/** 文字列に含まれる webhook URL を伏せる。エラーメッセージに紛れた場合の保険。 */
export function redact(text: string, secret: string): string {
  return secret ? text.split(secret).join("<redacted>") : text;
}

async function readUnitStatus(unit: string, deps: Deps): Promise<UnitStatus> {
  try {
    const output = await deps.run("systemctl", [
      "--user",
      "show",
      unit,
      "--property=Result",
      "--property=ExecMainStatus",
      "--property=InvocationID",
    ]);
    return parseShow(output);
  } catch (ex) {
    deps.stderr(`systemctl show failed: ${ex}`);
    return { result: "", execMainStatus: "", invocationId: "" };
  }
}

/**
 * 最後の起動分のログ。InvocationID で絞れなければ unit の直近分に落とす。
 * プロセスの出力は _SYSTEMD_INVOCATION_ID、systemd 自身の
 * 「Failed with result ...」は USER_INVOCATION_ID に付くので両方を拾う。
 */
async function readLog(
  unit: string,
  invocationId: string,
  deps: Deps,
): Promise<string> {
  const options = ["-n", String(LOG_LINES), "--no-pager", "-o", "cat"];
  try {
    if (invocationId) {
      const log = await deps.run("journalctl", [
        "--user",
        ...options,
        `_SYSTEMD_INVOCATION_ID=${invocationId}`,
        "+",
        `USER_INVOCATION_ID=${invocationId}`,
      ]);
      if (log.trim()) return log;
    }
    return await deps.run("journalctl", ["--user", "-u", unit, ...options]);
  } catch (ex) {
    return `(journalctl failed: ${ex})`;
  }
}

function retryAfterMs(response: Response): number {
  const seconds = Number(response.headers.get("retry-after"));
  if (!Number.isFinite(seconds) || seconds < 0) return 1000;
  return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
}

/** webhook に POST する。429 のときだけ Retry-After を 1 回だけ待ってやり直す。 */
export async function postWebhook(
  url: string,
  content: string,
  deps: Deps,
): Promise<boolean> {
  const body = JSON.stringify({
    content,
    // ログに @everyone などが含まれていても通知を飛ばさない。
    allowed_mentions: { parse: [] },
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    let response: Response;
    try {
      response = await deps.fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (ex) {
      deps.stderr(`discord webhook request failed: ${redact(String(ex), url)}`);
      return false;
    }
    if (response.ok) return true;
    if (response.status === 429 && attempt === 0) {
      const wait = retryAfterMs(response);
      deps.stderr(`discord webhook rate limited, retry after ${wait}ms`);
      await deps.sleep(wait);
      continue;
    }
    deps.stderr(`discord webhook failed: HTTP ${response.status}`);
    return false;
  }
  return false;
}

/** 終了コードを返す。0 = 送信できた。 */
export async function main(argv: string[], deps: Deps): Promise<number> {
  const unit = argv[0];
  if (!unit || unit.startsWith("-")) {
    deps.stderr("Usage: node dist/tools/notify-failure.js <unit>");
    return 1;
  }
  const url = deps.env.DISCORD_WEBHOOK_URL ?? "";
  if (!url) {
    // journal に残るよう stderr に出す。
    deps.stderr(
      `DISCORD_WEBHOOK_URL is not set; cannot notify failure of ${unit}`,
    );
    return 1;
  }
  const status = await readUnitStatus(unit, deps);
  const log = await readLog(unit, status.invocationId, deps);
  const content = buildMessage({
    unit,
    host: deps.host(),
    time: deps.now(),
    status,
    log,
  });
  const sent = await postWebhook(url, content, deps);
  if (!sent) return 1;
  deps.stderr(`notified failure of ${unit} to discord`);
  return 0;
}

const execFileAsync = promisify(execFile);

const defaultDeps: Deps = {
  env: process.env,
  fetch: (input, init) => fetch(input, init),
  run: async (file, args) => (await execFileAsync(file, args)).stdout,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  stderr: (line) => console.error(line),
  host: () => hostname(),
  now: () => nowJst().format(TIME_FORMAT),
};

// テストから import したときは実行しない。
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = await main(process.argv.slice(2), defaultDeps);
}
