import { JOBS, type JobDefinition } from "./jobs.js";
import type { LogFormat, LogLevel } from "./logline.js";

/**
 * 環境変数の読み取りと検証。不正な値は ConfigError を投げ、起動させない。
 * live の判定は BOT_MODE だけで行う（APP_ENV はラベル）。
 */

export type BotMode = "dry-run" | "live";

export interface SchedulerConfig {
  mode: BotMode;
  /** 有効なジョブ。上書きを反映済み。 */
  jobs: JobDefinition[];
  stateDir: string;
  serviceName: string;
  appEnv: string;
  /** 未設定なら空文字。 */
  webhookUrl: string;
  notifyInDryRun: boolean;
  /** 伏字にする値（*_APP_PASSWORD と DISCORD_WEBHOOK_URL）。 */
  secrets: string[];
  logFormat: LogFormat;
  /** スケジューラ自身の行にだけ効かせる。子の出力は落とさない。 */
  logLevel: LogLevel;
}

export class ConfigError extends Error {}

const OVERRIDE_PATTERN = /^JOB_(CRON|JITTER|TIMEOUT)_/;

function parseMode(value: string | undefined): BotMode {
  if (value === undefined || value === "" || value === "dry-run") {
    return "dry-run";
  }
  if (value === "live") return "live";
  throw new ConfigError(`invalid BOT_MODE: ${value} (dry-run or live)`);
}

export function parseLogFormat(value: string | undefined): LogFormat {
  if (value === undefined || value === "" || value === "text") return "text";
  if (value === "json") return "json";
  throw new ConfigError(`invalid LOG_FORMAT: ${value} (text or json)`);
}

function parseLogLevel(value: string | undefined): LogLevel {
  if (value === undefined || value === "") return "info";
  if (value === "debug" || value === "info" || value === "warn") return value;
  throw new ConfigError(`invalid LOG_LEVEL: ${value} (debug, info or warn)`);
}

function parseJobNames(value: string | undefined): string[] {
  const names = (value ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
  for (const name of names) {
    if (!JOBS.some((job) => job.name === name)) {
      throw new ConfigError(`unknown job in BOT_JOBS: ${name}`);
    }
  }
  return [...new Set(names)];
}

/** 秒数の上書き。0 以上の整数（timeout は 1 以上）。 */
function parseSeconds(key: string, value: string, min: number): number {
  const seconds = Number(value);
  if (!/^\d+$/.test(value) || seconds < min) {
    throw new ConfigError(`invalid ${key}: ${value}`);
  }
  return seconds;
}

/** JOB_CRON_<BOT> などのテスト用の上書きを反映する。 */
function applyOverrides(
  job: JobDefinition,
  env: NodeJS.ProcessEnv,
): JobDefinition {
  const suffix = job.name.toUpperCase();
  const cron = env[`JOB_CRON_${suffix}`];
  const jitter = env[`JOB_JITTER_${suffix}`];
  const timeout = env[`JOB_TIMEOUT_${suffix}`];
  return {
    ...job,
    cron: cron ?? job.cron,
    jitterSec:
      jitter === undefined
        ? job.jitterSec
        : parseSeconds(`JOB_JITTER_${suffix}`, jitter, 0),
    timeoutSec:
      timeout === undefined
        ? job.timeoutSec
        : parseSeconds(`JOB_TIMEOUT_${suffix}`, timeout, 1),
  };
}

function collectSecrets(env: NodeJS.ProcessEnv): string[] {
  const secrets: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (!value) continue;
    if (key.endsWith("_APP_PASSWORD") || key === "DISCORD_WEBHOOK_URL") {
      secrets.push(value);
    }
  }
  return secrets;
}

export function loadConfig(env: NodeJS.ProcessEnv): SchedulerConfig {
  const logFormat = parseLogFormat(env.LOG_FORMAT);
  const logLevel = parseLogLevel(env.LOG_LEVEL);
  const mode = parseMode(env.BOT_MODE);
  const names = parseJobNames(env.BOT_JOBS);

  if (mode === "live") {
    // 上書きはテスト用。本番に紛れ込んだら起動しない。
    const overrides = Object.keys(env).filter((key) =>
      OVERRIDE_PATTERN.test(key),
    );
    if (overrides.length > 0) {
      throw new ConfigError(
        `job overrides are not allowed in live mode: ${overrides.join(", ")}`,
      );
    }
    for (const name of names) {
      for (const suffix of ["IDENTIFIER", "APP_PASSWORD"]) {
        const key = `${name.toUpperCase()}_${suffix}`;
        if (!env[key]) throw new ConfigError(`${key} is not set`);
      }
    }
  }

  const jobs = JOBS.filter((job) => names.includes(job.name)).map((job) =>
    applyOverrides(job, env),
  );

  return {
    mode,
    jobs,
    stateDir: env.STATE_DIR || "/data",
    serviceName: env.SERVICE_NAME || "bsky-bots",
    appEnv: env.APP_ENV || "production",
    webhookUrl: env.DISCORD_WEBHOOK_URL ?? "",
    notifyInDryRun: env.NOTIFY_IN_DRY_RUN === "true",
    secrets: collectSecrets(env),
    logFormat,
    logLevel,
  };
}
