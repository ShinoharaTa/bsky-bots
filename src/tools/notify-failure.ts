import { execFile } from "node:child_process";
import { hostname } from "node:os";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { formatJstDateTime } from "../core/date.js";
import {
  buildMessage,
  postWebhook,
  type UnitStatus,
  type WebhookDeps,
} from "../core/discord.js";

// 既存の呼び出し元・テストのために、移した分をここからも export する。
export {
  buildMessage,
  DISCORD_MAX_LENGTH,
  type FailureReport,
  postWebhook,
  redact,
  type UnitStatus,
} from "../core/discord.js";

/**
 * Bot の unit が失敗したことを Discord webhook に知らせる。
 * deploy/system/bsky-bots-failure@.service（OnFailure=）から起動される。
 * usage: node dist/tools/notify-failure.js <unit名>
 *
 * 環境変数 BSKY_SYSTEMD_SCOPE=system のときは OS の systemd の unit として扱い、
 * systemctl / journalctl に --user を付けない。未設定のときは従来どおり --user。
 *
 * webhook URL は秘密情報なので、stdout / stderr のどこにも出さない。
 */

/** journal から拾う行数。 */
const LOG_LINES = 30;

export type RunCommand = (file: string, args: string[]) => Promise<string>;

export interface Deps extends WebhookDeps {
  env: NodeJS.ProcessEnv;
  run: RunCommand;
  host: () => string;
  now: () => string;
}

/** systemd のどちらの manager の unit か。 */
export type SystemdScope = "system" | "user";

export function systemdScope(env: NodeJS.ProcessEnv): SystemdScope {
  return env.BSKY_SYSTEMD_SCOPE === "system" ? "system" : "user";
}

/** systemctl / journalctl に付ける scope の引数。 */
function scopeArgs(scope: SystemdScope): string[] {
  return scope === "user" ? ["--user"] : [];
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

async function readUnitStatus(
  unit: string,
  scope: SystemdScope,
  deps: Deps,
): Promise<UnitStatus> {
  try {
    const output = await deps.run("systemctl", [
      ...scopeArgs(scope),
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
 * 「Failed with result ...」は manager 側のフィールドに付くので両方を拾う。
 * そのフィールドは user manager なら USER_INVOCATION_ID、
 * system manager（PID 1）なら INVOCATION_ID。
 */
async function readLog(
  unit: string,
  invocationId: string,
  scope: SystemdScope,
  deps: Deps,
): Promise<string> {
  const options = ["-n", String(LOG_LINES), "--no-pager", "-o", "cat"];
  const managerField =
    scope === "user" ? "USER_INVOCATION_ID" : "INVOCATION_ID";
  try {
    if (invocationId) {
      const log = await deps.run("journalctl", [
        ...scopeArgs(scope),
        ...options,
        `_SYSTEMD_INVOCATION_ID=${invocationId}`,
        "+",
        `${managerField}=${invocationId}`,
      ]);
      if (log.trim()) return log;
    }
    return await deps.run("journalctl", [
      ...scopeArgs(scope),
      "-u",
      unit,
      ...options,
    ]);
  } catch (ex) {
    return `(journalctl failed: ${ex})`;
  }
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
  const scope = systemdScope(deps.env);
  const status = await readUnitStatus(unit, scope, deps);
  const log = await readLog(unit, status.invocationId, scope, deps);
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
  now: () => formatJstDateTime(Date.now()),
};

// テストから import したときは実行しない。
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = await main(process.argv.slice(2), defaultDeps);
}
