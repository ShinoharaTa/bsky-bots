import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Cron } from "croner";
import { formatJstDateTime } from "../core/date.js";
import { buildCodeBlockMessage, postWebhook } from "../core/discord.js";
import { ConfigError, loadConfig, type SchedulerConfig } from "./config.js";
import { JOB_TIMEZONE, type JobDefinition } from "./jobs.js";
import {
  credentialFingerprint,
  defaultLogin,
  LOGIN_CHECK_COOLDOWN_MS,
  type LoginFn,
} from "./login-check.js";
import {
  childLevel,
  createRedactor,
  type Fields,
  formatJsonLine,
  formatSchedulerLine,
  formatSchedulerMsg,
  isLevelEnabled,
  type LogFormat,
  type LogLevel,
  type Redactor,
  schedulerLevel,
} from "./logline.js";
import { isFailure, type RunResult, runJob, type SpawnFn } from "./runner.js";
import {
  type JobState,
  type LoginState,
  readState,
  type SchedulerState,
  statePath,
  writeState,
} from "./state.js";

/**
 * Bot を定期実行する常駐プロセス（Coolify 用）。
 * 設定を検証し、ジョブを登録し、状態ファイルを書き始めたら ready。
 * 各回は `node dist/main.js <bot> [--live]` を子プロセスとして起動する。
 * usage: node dist/scheduler/main.js
 */

/** 状態ファイルの書き込み間隔。 */
export const STATE_INTERVAL_MS = 30_000;

export interface SchedulerDeps {
  env: NodeJS.ProcessEnv;
  spawn: SpawnFn;
  /** 改行込みの文字列を受け取る。 */
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  now: () => number;
  /** jitter 用。[0, 1) */
  random: () => number;
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  /** 子プロセスの cwd（アプリのルート）。 */
  cwd: string;
  /** 起動時のログイン確認。 */
  login: LoginFn;
}

export interface Scheduler {
  readonly config: SchedulerConfig;
  /** 状態ファイルに書く内容。 */
  snapshot(): SchedulerState;
  /** 新しい起動を止め、実行中の子の終了を待つ。終了コードを返す。 */
  shutdown(signal: string): Promise<number>;
}

interface JobEntry {
  job: JobDefinition;
  cron: Cron;
  state: JobState;
}

function lastExitOf(result: RunResult): number | string | null {
  if (result.spawnError !== null) return "spawn_error";
  if (result.timedOut) return "timeout";
  if (result.signal !== null) return result.signal;
  return result.exit;
}

function failureMessage(
  config: SchedulerConfig,
  job: JobDefinition,
  runId: string,
  startedAt: number,
  result: RunResult,
): string {
  const header = [
    `**${config.serviceName}: ${job.name} failed**`,
    `env: ${config.appEnv}`,
    `run_id: ${runId}`,
    `time: ${formatJstDateTime(startedAt)} JST`,
    resultLine(result),
  ];
  if (result.spawnError !== null) {
    header.push(`spawn error: ${result.spawnError}`);
  }
  return buildCodeBlockMessage(header.join("\n"), result.stderrTail.join("\n"));
}

function loginFailureMessage(
  config: SchedulerConfig,
  job: JobDefinition,
  checkedAt: number,
  reason: string,
): string {
  const header = [
    `**${config.serviceName}: ${job.name} login check failed**`,
    `env: ${config.appEnv}`,
    `time: ${formatJstDateTime(checkedAt)} JST`,
    `mode: ${config.mode}`,
  ];
  return buildCodeBlockMessage(header.join("\n"), reason);
}

/** 前回の確認を使い回せるか（同じ認証情報で、10 分以内に ok / failed が出ている）。 */
function reusableLogin(
  previous: LoginState | undefined,
  fp: string,
  now: number,
): previous is LoginState & { at: string } {
  if (!previous || previous.fp !== fp || previous.at === null) return false;
  if (previous.result !== "ok" && previous.result !== "failed") return false;
  const checkedAt = Date.parse(previous.at);
  return (
    Number.isFinite(checkedAt) && now - checkedAt < LOGIN_CHECK_COOLDOWN_MS
  );
}

function resultFields(result: RunResult): Fields {
  return {
    exit: result.exit,
    signal: result.signal,
    timeout: result.timedOut,
    elapsed: `${(result.elapsedMs / 1000).toFixed(1)}s`,
  };
}

function resultLine(result: RunResult): string {
  return Object.entries(resultFields(result))
    .map(([key, value]) => `${key}=${value ?? "none"}`)
    .join(" ");
}

/** 起動に失敗したら null（理由は stderr に出してある）。 */
export function startScheduler(deps: SchedulerDeps): Scheduler | null {
  let redact: Redactor = createRedactor([]);
  // 設定を読むまでの行（設定のエラー）は、LOG_FORMAT=json のときだけ json にする。
  let format: LogFormat = deps.env.LOG_FORMAT === "json" ? "json" : "text";
  let minLevel: LogLevel = "info";
  let service = deps.env.SERVICE_NAME || "bsky-bots";
  let appEnv = deps.env.APP_ENV || "production";

  /** スケジューラ自身の行。text は stderr、json は stdout。 */
  const log = (
    msg: string,
    fields?: Fields,
    level: LogLevel = schedulerLevel(msg),
  ) => {
    if (!isLevelEnabled(level, minLevel)) return;
    if (format === "text") {
      deps.stderr(`${redact(formatSchedulerLine(msg, fields))}\n`);
      return;
    }
    const job = fields?.job;
    const runId = fields?.run_id;
    const line = formatJsonLine({
      ts: deps.now(),
      level,
      service,
      env: appEnv,
      job: job === undefined || job === null ? undefined : String(job),
      run_id: runId === undefined || runId === null ? undefined : String(runId),
      stream: "scheduler",
      msg: redact(formatSchedulerMsg(msg, fields)),
    });
    deps.stdout(`${line}\n`);
  };

  /**
   * json のときの子の行の転送先。runner は 1 回の呼び出しで 1 行
   * （伏字済み。最後の行だけ改行が無いことがある）を渡してくる。
   */
  const childJson =
    (stream: "stdout" | "stderr", job: string, runId: string) =>
    (text: string) => {
      const msg = text.endsWith("\n") ? text.slice(0, -1) : text;
      const line = formatJsonLine({
        ts: deps.now(),
        level: childLevel(job, msg),
        service,
        env: appEnv,
        job,
        run_id: runId,
        stream,
        msg,
      });
      deps.stdout(`${line}\n`);
    };

  let config: SchedulerConfig;
  try {
    config = loadConfig(deps.env);
  } catch (ex) {
    if (!(ex instanceof ConfigError)) throw ex;
    log(`error: ${ex.message}`);
    return null;
  }
  redact = createRedactor(config.secrets);
  format = config.logFormat;
  service = config.serviceName;
  appEnv = config.appEnv;
  const live = config.mode === "live";
  const jobNames = config.jobs.map((job) => job.name).join(",") || "none";

  if (live) {
    log("MODE=LIVE", { jobs: jobNames });
  } else {
    log("start", {
      mode: config.mode,
      jobs: jobNames,
      service: config.serviceName,
      env: config.appEnv,
    });
  }
  // 起動行（MODE=LIVE の監査に使う）は LOG_LEVEL に関わらず出し、ここから絞る。
  minLevel = config.logLevel;
  if (config.jobs.length === 0) {
    log("warn: BOT_JOBS is empty; no jobs are scheduled");
  }
  if (!config.webhookUrl && config.jobs.some((job) => job.discord)) {
    log("warn: DISCORD_WEBHOOK_URL is not set; failures will not be notified");
  }

  let stopping = false;
  /** 実行中の回（子の起動から通知まで）。shutdown はこれを待つ。 */
  const active = new Set<Promise<void>>();
  const entries: JobEntry[] = [];

  /** Discord に送る。fields は would notify と送信失敗の行に付ける。 */
  const sendNotice = async (
    job: JobDefinition,
    fields: Fields,
    content: () => string,
  ) => {
    if (!job.discord) return;
    if (!live && !config.notifyInDryRun) {
      log("would notify", fields);
      return;
    }
    if (!config.webhookUrl) return;
    await postWebhook(config.webhookUrl, redact(content()), {
      fetch: deps.fetch,
      sleep: deps.sleep,
      stderr: (line) => log(line, fields, "warn"),
    });
  };

  const notify = (
    job: JobDefinition,
    runId: string,
    startedAt: number,
    result: RunResult,
  ) =>
    sendNotice(job, { job: job.name, run_id: runId }, () =>
      failureMessage(config, job, runId, startedAt, result),
    );

  const execute = async (entry: JobEntry) => {
    const { job, state } = entry;
    const startedAt = deps.now();
    const runId = `${job.name}-${new Date(startedAt).toISOString()}`;
    state.running = true;
    state.lastRunAt = new Date(startedAt).toISOString();
    log("run", { job: job.name, run_id: runId });
    const result = await runJob({
      args: [job.name, ...(live ? ["--live"] : [])],
      cwd: deps.cwd,
      timeoutMs: job.timeoutSec * 1000,
      spawn: deps.spawn,
      redact,
      stdout:
        format === "json" ? childJson("stdout", job.name, runId) : deps.stdout,
      stderr:
        format === "json" ? childJson("stderr", job.name, runId) : deps.stderr,
      now: deps.now,
    });
    state.running = false;
    state.lastExit = lastExitOf(result);
    if (result.spawnError !== null) {
      log(`spawn failed: ${result.spawnError}`, {
        job: job.name,
        run_id: runId,
      });
    }
    log("done", { job: job.name, run_id: runId, ...resultFields(result) });
    if (isFailure(result)) await notify(job, runId, startedAt, result);
  };

  const tick = async (entry: JobEntry) => {
    const delayMs = Math.floor(deps.random() * entry.job.jitterSec * 1000);
    log("debug: tick", {
      job: entry.job.name,
      jitter: `${(delayMs / 1000).toFixed(1)}s`,
    });
    if (delayMs > 0) await deps.sleep(delayMs);
    if (stopping) return;
    const run = execute(entry);
    active.add(run);
    try {
      await run;
    } finally {
      active.delete(run);
    }
  };

  // 前回の状態（ログイン確認の使い回し用）。最初の書き込みで上書きされる前に読む。
  const previousState = readState(config.stateDir);

  try {
    for (const job of config.jobs) {
      const entry = {
        job,
        state: {
          name: job.name,
          next: null,
          running: false,
          lastExit: null,
          lastRunAt: null,
          login: { result: "pending", at: null, fp: null },
        },
      } as JobEntry;
      entry.cron = new Cron(
        job.cron,
        {
          timezone: JOB_TIMEZONE,
          // 前回が終わっていなければ起動しない。過ぎた枠は後から実行しない。
          protect: () => log("skipped", { job: job.name, reason: "overlap" }),
          catch: (ex) => log(`error: ${ex}`, { job: job.name }),
        },
        () => tick(entry),
      );
      entries.push(entry);
    }
  } catch (ex) {
    for (const entry of entries) entry.cron.stop();
    log(`error: invalid job schedule: ${ex}`);
    return null;
  }

  const snapshot = (): SchedulerState => ({
    ts: deps.now(),
    ready: true,
    mode: config.mode,
    pid: process.pid,
    jobs: entries.map((entry) => ({
      ...entry.state,
      next: entry.cron.nextRun()?.toISOString() ?? null,
    })),
  });

  const saveState = () => {
    writeState(config.stateDir, snapshot());
    log("debug: state written", { path: statePath(config.stateDir) });
  };

  try {
    saveState();
  } catch (ex) {
    for (const entry of entries) entry.cron.stop();
    log(`error: cannot write state to ${config.stateDir}: ${ex}`);
    return null;
  }
  const stateTimer = setInterval(() => {
    try {
      saveState();
    } catch (ex) {
      log(`error: cannot write state to ${config.stateDir}: ${ex}`);
    }
  }, STATE_INTERVAL_MS);

  /** 1 ジョブ分のログイン確認。結果を entry.state.login に入れる。 */
  const checkLogin = async (entry: JobEntry) => {
    const { job, state } = entry;
    const prefix = job.name.toUpperCase();
    const keys = [`${prefix}_IDENTIFIER`, `${prefix}_APP_PASSWORD`];
    const [identifier, password] = keys.map((key) => deps.env[key] || "");
    const missing = keys.filter((key) => !deps.env[key]);
    if (missing.length > 0) {
      state.login = { result: "unset", at: null, fp: null };
      log(
        "login check",
        {
          job: job.name,
          result: "unset",
          reason: `${missing.join(", ")} is not set`,
        },
        "warn",
      );
      return;
    }
    const fp = credentialFingerprint(identifier, password);
    const previous = Array.isArray(previousState?.jobs)
      ? previousState.jobs.find((saved) => saved?.name === job.name)?.login
      : undefined;
    if (reusableLogin(previous, fp, deps.now())) {
      state.login = { ...previous };
      log(
        "login check",
        {
          job: job.name,
          result: "skipped",
          previous: previous.result,
          checked_at: previous.at,
        },
        "info",
      );
      return;
    }
    const checkedAt = deps.now();
    const result = await deps.login(identifier, password);
    const at = new Date(checkedAt).toISOString();
    if (result.ok) {
      state.login = { result: "ok", at, fp };
      log("login check", { job: job.name, result: "ok" }, "info");
      return;
    }
    // 状態ファイルにも秘密を残さない。
    state.login = { result: "failed", at, fp, reason: redact(result.reason) };
    log(
      "login check",
      { job: job.name, result: "failed", reason: result.reason },
      "error",
    );
    await sendNotice(job, { job: job.name }, () =>
      loginFailureMessage(config, job, checkedAt, result.reason),
    );
  };

  /** 起動時のログイン確認。ジョブごとに直列。shutdown は待たない。 */
  const checkLogins = async () => {
    for (const entry of entries) {
      if (stopping) return;
      await checkLogin(entry);
      if (stopping) return;
      try {
        saveState();
      } catch (ex) {
        log(`error: cannot write state to ${config.stateDir}: ${ex}`);
      }
    }
  };

  let shuttingDown: Promise<number> | undefined;
  const shutdown = (signal: string): Promise<number> => {
    shuttingDown ??= (async () => {
      stopping = true;
      for (const entry of entries) entry.cron.stop();
      const running = entries
        .filter((entry) => entry.state.running)
        .map((entry) => entry.job.name);
      log("stopping", { signal, running: running.join(",") || "none" });
      // 子にはシグナルを転送しない。終わるまで待つ。
      while (active.size > 0) await Promise.allSettled([...active]);
      clearInterval(stateTimer);
      log("stopped");
      return 0;
    })();
    return shuttingDown;
  };

  // ready を待たせない。例外はここで止める。
  void Promise.resolve()
    .then(checkLogins)
    .catch((ex) => log(`error: login check failed: ${ex}`));

  return { config, snapshot, shutdown };
}

const defaultDeps: SchedulerDeps = {
  env: process.env,
  spawn: (command, args, options) => spawn(command, args, options),
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  now: () => Date.now(),
  random: () => Math.random(),
  fetch: (input, init) => fetch(input, init),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  // dist/scheduler/main.js から見たアプリのルート。
  cwd: fileURLToPath(new URL("../..", import.meta.url)),
  login: defaultLogin,
};

// テストから import したときは実行しない。
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const scheduler = startScheduler(defaultDeps);
  if (!scheduler) {
    process.exitCode = 1;
  } else {
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      process.on(signal, () => {
        // jitter の待ちが残っていても終わらせるため exit する。
        scheduler.shutdown(signal).then((code) => process.exit(code));
      });
    }
  }
}
