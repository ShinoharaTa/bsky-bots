/**
 * Discord webhook への送信。本文の組み立て・秘密の伏字・POST を持つ。
 *
 * webhook URL は秘密情報なので、stdout / stderr のどこにも出さない。
 */

/** Discord のメッセージ本文の上限（文字数）。 */
export const DISCORD_MAX_LENGTH = 2000;
/** 1 リクエストのタイムアウト。 */
const REQUEST_TIMEOUT_MS = 15_000;
/** 429 の Retry-After をこれ以上は待たない（unit の TimeoutStartSec に収める）。 */
const MAX_RETRY_AFTER_MS = 60_000;

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

/** postWebhook が使う外部依存。テストから差し替える。 */
export interface WebhookDeps {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  stderr: (line: string) => void;
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

function retryAfterMs(response: Response): number {
  const seconds = Number(response.headers.get("retry-after"));
  if (!Number.isFinite(seconds) || seconds < 0) return 1000;
  return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
}

/** webhook に POST する。429 のときだけ Retry-After を 1 回だけ待ってやり直す。 */
export async function postWebhook(
  url: string,
  content: string,
  deps: WebhookDeps,
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
