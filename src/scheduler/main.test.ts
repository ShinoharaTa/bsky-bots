import type { ChildProcess } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkHealth } from "./healthcheck.js";
import { credentialFingerprint, type LoginFn } from "./login-check.js";
import { type Scheduler, type SchedulerDeps, startScheduler } from "./main.js";
import { readState, type SchedulerState, statePath } from "./state.js";

/** 実在しない URL。fetch を差し替えるので送信はしない。 */
const WEBHOOK = "https://discord.example/api/webhooks/123/secret-token-xyz";
const PASSWORD = "abcd-efgh-ijkl-mnop";

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid: number | undefined = 4242;
  kill = vi.fn((_signal?: NodeJS.Signals) => true);

  async close(code: number | null, signal: NodeJS.Signals | null = null) {
    const ended = Promise.all([
      once(this.stdout, "end"),
      once(this.stderr, "end"),
    ]);
    this.stdout.end();
    this.stderr.end();
    await ended;
    this.emit("close", code, signal);
  }
}

let stateDir: string;
const started: Scheduler[] = [];

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "scheduler-test-"));
  // 2026-11-24 09:00:00 JST
  vi.useFakeTimers({ now: new Date("2026-11-24T00:00:00Z") });
});

afterEach(() => {
  for (const scheduler of started.splice(0)) void scheduler.shutdown("test");
  vi.clearAllTimers();
  vi.useRealTimers();
  rmSync(stateDir, { recursive: true, force: true });
});

function setup(
  env: NodeJS.ProcessEnv,
  random = () => 0,
  login = vi.fn<LoginFn>(async () => ({ ok: true })),
) {
  const children: FakeChild[] = [];
  const spawn = vi.fn(
    (_command: string, _args: readonly string[], _options: object) => {
      const child = new FakeChild();
      children.push(child);
      return child as unknown as ChildProcess;
    },
  );
  const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
  const sleep = vi.fn(
    (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  );
  const out: string[] = [];
  const err: string[] = [];
  const deps: SchedulerDeps = {
    env: { STATE_DIR: stateDir, ...env },
    spawn,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    now: () => Date.now(),
    random,
    fetch: fetchMock as unknown as typeof fetch,
    sleep,
    cwd: "/app",
    login,
  };
  const scheduler = startScheduler(deps);
  if (scheduler) started.push(scheduler);
  const log = () => err.join("");
  /** 送った Discord 本文。 */
  const contents = () =>
    fetchMock.mock.calls.map(
      (call) =>
        JSON.parse((call as unknown as [string, RequestInit])[1].body as string)
          .content as string,
    );
  return {
    scheduler,
    spawn,
    children,
    fetchMock,
    sleep,
    out,
    err,
    log,
    contents,
    login,
  };
}

/** 毎秒起動する設定（dry-run 用の上書き）。 */
function everySecond(job: string): NodeJS.ProcessEnv {
  const name = job.toUpperCase();
  return {
    BOT_JOBS: job,
    [`JOB_CRON_${name}`]: "* * * * * *",
    [`JOB_JITTER_${name}`]: "0",
  };
}

describe("起動時の検証", () => {
  it("BOT_MODE 未設定なら dry-run。子は --live 無しで起動する", async () => {
    const { scheduler, spawn, log } = setup(everySecond("skyhigh"));
    expect(scheduler).not.toBeNull();
    expect(log()).toContain(
      "[scheduler] start mode=dry-run jobs=skyhigh service=bsky-bots env=production\n",
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0][0]).toBe(process.execPath);
    expect(spawn.mock.calls[0][1]).toEqual(["dist/main.js", "skyhigh"]);
    expect(spawn.mock.calls[0][2]).toMatchObject({ cwd: "/app" });
  });

  it("BOT_MODE=live なら --live を付け、MODE=LIVE の行を出す", async () => {
    // 2026-11-24 09:26:59 JST。上書きは使えないので本来の枠（:27）を待つ。
    vi.setSystemTime(new Date("2026-11-24T00:26:59Z"));
    const { scheduler, spawn, log } = setup({
      BOT_MODE: "live",
      BOT_JOBS: "jiho",
      JIHO_IDENTIFIER: "jiho.test",
      JIHO_APP_PASSWORD: PASSWORD,
    });
    expect(scheduler).not.toBeNull();
    expect(log()).toContain("[scheduler] MODE=LIVE jobs=jiho\n");
    await vi.advanceTimersByTimeAsync(1000);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0][1]).toEqual(["dist/main.js", "jiho", "--live"]);
  });

  it("live で JOB_* の上書きがあれば起動しない", () => {
    const { scheduler, log } = setup({
      BOT_MODE: "live",
      BOT_JOBS: "jiho",
      JIHO_IDENTIFIER: "jiho.test",
      JIHO_APP_PASSWORD: PASSWORD,
      JOB_CRON_JIHO: "* * * * *",
    });
    expect(scheduler).toBeNull();
    expect(log()).toContain("JOB_CRON_JIHO");
  });

  it("未知のジョブ名があれば起動しない", () => {
    const { scheduler, log } = setup({ BOT_JOBS: "jiho,foo" });
    expect(scheduler).toBeNull();
    expect(log()).toContain("unknown job in BOT_JOBS: foo");
  });

  it("BOT_MODE が dry-run / live 以外なら起動しない", () => {
    expect(setup({ BOT_MODE: "production" }).scheduler).toBeNull();
  });

  it("live で認証情報が欠けていれば起動しない", () => {
    const { scheduler, log } = setup({
      BOT_MODE: "live",
      BOT_JOBS: "skyhigh",
      SKYHIGH_IDENTIFIER: "skyhigh.test",
    });
    expect(scheduler).toBeNull();
    expect(log()).toContain("SKYHIGH_APP_PASSWORD is not set");
  });

  it("STATE_DIR に書けなければ起動しない", () => {
    const { scheduler } = setup({
      BOT_JOBS: "jiho",
      STATE_DIR: join(stateDir, "missing"),
    });
    expect(scheduler).toBeNull();
  });

  it("BOT_JOBS が空なら何も登録せず WARN を出して ready になる", () => {
    const { scheduler, log } = setup({});
    expect(scheduler).not.toBeNull();
    expect(log()).toContain("warn: BOT_JOBS is empty");
    expect(readState(stateDir)).toMatchObject({ ready: true, jobs: [] });
  });

  it("webhook が未設定なら、通知するジョブがあるときだけ WARN を出す", () => {
    expect(setup({ BOT_JOBS: "jiho" }).log()).not.toContain(
      "DISCORD_WEBHOOK_URL",
    );
    expect(setup({ BOT_JOBS: "skylog" }).log()).toContain(
      "warn: DISCORD_WEBHOOK_URL is not set",
    );
  });
});

describe("スケジュール", () => {
  for (const tz of ["UTC", "America/New_York"]) {
    it(`次回は JST 08:45 / 00:20 / :27（TZ=${tz} でも同じ UTC 時刻）`, () => {
      const saved = process.env.TZ;
      process.env.TZ = tz;
      try {
        const { scheduler } = setup({ BOT_JOBS: "skyhigh,skylog,jiho" });
        const next = Object.fromEntries(
          scheduler?.snapshot().jobs.map((job) => [job.name, job.next]) ?? [],
        );
        expect(next).toEqual({
          skyhigh: "2026-11-24T23:45:00.000Z",
          skylog: "2026-11-24T15:20:00.000Z",
          jiho: "2026-11-24T00:27:00.000Z",
        });
      } finally {
        if (saved === undefined) delete process.env.TZ;
        else process.env.TZ = saved;
      }
    });
  }

  it("jiho は :57 にも起動する", () => {
    vi.setSystemTime(new Date("2026-11-24T00:30:00Z"));
    const { scheduler } = setup({ BOT_JOBS: "jiho" });
    expect(scheduler?.snapshot().jobs[0].next).toBe("2026-11-24T00:57:00.000Z");
  });

  it("jiho の遅延は 0〜360 秒（乱数を注入）", async () => {
    vi.setSystemTime(new Date("2026-11-24T00:26:59Z"));
    const { spawn, sleep } = setup({ BOT_JOBS: "jiho" }, () => 0.999999);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sleep).toHaveBeenCalledTimes(1);
    const delay = sleep.mock.calls[0][0];
    expect(delay).toBeGreaterThanOrEqual(0);
    expect(delay).toBeLessThanOrEqual(360_000);
    expect(spawn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(delay);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("jiho の遅延は乱数 0.5 で 180 秒", async () => {
    vi.setSystemTime(new Date("2026-11-24T00:26:59Z"));
    const { sleep } = setup({ BOT_JOBS: "jiho" }, () => 0.5);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sleep).toHaveBeenCalledWith(180_000);
  });

  it("前回が実行中なら次の枠は起動せず skipped reason=overlap を出す", async () => {
    const { spawn, children, log } = setup(everySecond("skyhigh"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(spawn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1500);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(log()).toContain("[scheduler] skipped job=skyhigh reason=overlap\n");
    await children[0].close(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("run / done の行に job と run_id を付ける", async () => {
    const { children, log } = setup(everySecond("skyhigh"));
    await vi.advanceTimersByTimeAsync(1000);
    await children[0].close(0);
    await vi.advanceTimersByTimeAsync(0);
    const runId = "skyhigh-2026-11-24T00:00:01.000Z";
    expect(log()).toContain(`[scheduler] run job=skyhigh run_id=${runId}\n`);
    expect(log()).toContain(
      `[scheduler] done job=skyhigh run_id=${runId} exit=0 signal=none timeout=false elapsed=0.0s login=unset\n`,
    );
  });
});

describe("失敗の通知", () => {
  const notifyEnv = {
    DISCORD_WEBHOOK_URL: WEBHOOK,
    NOTIFY_IN_DRY_RUN: "true",
    SKYHIGH_APP_PASSWORD: PASSWORD,
  };

  it("timeout なら SIGTERM → 10 秒後に SIGKILL。通知に stderr の末尾が入る", async () => {
    const { children, fetchMock, contents, log } = setup({
      ...everySecond("skyhigh"),
      ...notifyEnv,
      JOB_TIMEOUT_SKYHIGH: "5",
    });
    await vi.advanceTimersByTimeAsync(1000);
    children[0].stderr.write("still fetching followers\n");
    await vi.advanceTimersByTimeAsync(5000);
    expect(children[0].kill).toHaveBeenLastCalledWith("SIGTERM");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(children[0].kill).toHaveBeenLastCalledWith("SIGKILL");
    await children[0].close(null, "SIGKILL");
    await vi.advanceTimersByTimeAsync(0);
    expect(log()).toMatch(/done job=skyhigh .* timeout=true /);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(contents()[0]).toContain("timeout=true");
    expect(contents()[0]).toContain("still fetching followers");
  });

  it("exit 1 なら exit=1 と stderr の末尾 30 行を送る。App Password は含めない", async () => {
    const { children, fetchMock, contents } = setup({
      ...everySecond("skyhigh"),
      ...notifyEnv,
    });
    await vi.advanceTimersByTimeAsync(1000);
    for (let i = 1; i <= 40; i++) {
      children[0].stderr.write(`err line ${i} password=${PASSWORD}\n`);
    }
    await children[0].close(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]).toContain(WEBHOOK);
    const content = contents()[0];
    expect(content).toContain("**bsky-bots: skyhigh failed**");
    expect(content).toContain("run_id: skyhigh-2026-11-24T00:00:01.000Z");
    expect(content).toContain("time: 2026/11/24 09:00:01 JST");
    expect(content).toContain("exit=1");
    expect(content).toContain("err line 11 ");
    expect(content).toContain("err line 40 ");
    expect(content).not.toContain("err line 10 ");
    expect(content).not.toContain(PASSWORD);
  });

  it("dry-run では送らず would notify を出す", async () => {
    const { children, fetchMock, log } = setup({
      ...everySecond("skyhigh"),
      DISCORD_WEBHOOK_URL: WEBHOOK,
    });
    await vi.advanceTimersByTimeAsync(1000);
    await children[0].close(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(log()).toMatch(
      /\[scheduler\] would notify job=skyhigh run_id=skyhigh-\S+\n/,
    );
    expect(log()).not.toContain(WEBHOOK);
  });

  it("jiho の失敗は通知しない", async () => {
    const { children, fetchMock, log } = setup({
      ...everySecond("jiho"),
      ...notifyEnv,
    });
    await vi.advanceTimersByTimeAsync(1000);
    await children[0].close(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(log()).not.toContain("would notify");
  });

  it("成功なら通知しない", async () => {
    const { children, fetchMock } = setup({
      ...everySecond("skyhigh"),
      ...notifyEnv,
    });
    await vi.advanceTimersByTimeAsync(1000);
    await children[0].close(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("SIGTERM", () => {
  it("子がいなければすぐ 0 で終わる", async () => {
    const { scheduler } = setup(everySecond("skyhigh"));
    await expect(scheduler?.shutdown("SIGTERM")).resolves.toBe(0);
  });

  it("子がいれば、シグナルを転送せず終了を待つ。その間は新しく起動しない", async () => {
    const { scheduler, spawn, children } = setup(everySecond("skyhigh"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(spawn).toHaveBeenCalledTimes(1);
    let code: number | undefined;
    void scheduler?.shutdown("SIGTERM").then((value) => {
      code = value;
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(code).toBeUndefined();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(children[0].kill).not.toHaveBeenCalled();
    await children[0].close(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(code).toBe(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("jitter の待ち中に止めたら、待ち明けに起動しない", async () => {
    vi.setSystemTime(new Date("2026-11-24T00:26:59Z"));
    const { scheduler, spawn } = setup({ BOT_JOBS: "jiho" }, () => 0.5);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(scheduler?.shutdown("SIGTERM")).resolves.toBe(0);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe("状態ファイルと healthcheck", () => {
  it("30 秒ごとに更新され、新しければ healthy。120 秒古ければ unhealthy", async () => {
    setup(everySecond("skyhigh"));
    const first = readState(stateDir);
    expect(first).toMatchObject({ ready: true, mode: "dry-run" });
    await vi.advanceTimersByTimeAsync(30_000);
    const second = readState(stateDir);
    expect(second?.ts).toBe(Date.now());
    expect(second?.ts).toBeGreaterThan(first?.ts ?? 0);
    expect(second?.jobs[0]).toMatchObject({
      name: "skyhigh",
      running: true,
      lastRunAt: "2026-11-24T00:00:01.000Z",
    });
    expect(checkHealth(stateDir, Date.now())).toBe(true);
    expect(checkHealth(stateDir, (second?.ts ?? 0) + 120_000)).toBe(false);
  });

  it("状態ファイルが無ければ unhealthy", () => {
    expect(checkHealth(stateDir, Date.now())).toBe(false);
  });
});

describe("ログの形式", () => {
  /** 同じ入力（起動 → 子の出力 → 失敗 → 停止）を流し、出力を集める。 */
  async function scenario(env: NodeJS.ProcessEnv) {
    const { scheduler, children, out, err } = setup({
      ...everySecond("skyhigh"),
      SKYHIGH_APP_PASSWORD: PASSWORD,
      ...env,
    });
    await vi.advanceTimersByTimeAsync(1000);
    const child = children[0];
    child.stdout.write('{"text":"hello","langs":["ja"]}\n');
    child.stderr.write(`[skyhigh] login password=${PASSWORD}\n`);
    child.stderr.write("token eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl\n");
    // 実行中に次の枠が来る（skipped）。
    await vi.advanceTimersByTimeAsync(1500);
    child.stderr.write("[skyhigh] failed: boom\n");
    child.stderr.write(
      "[skyhigh] summary: status=aborted processed=1 fetch_failed=1\n",
    );
    child.stdout.write("tail without newline");
    await child.close(1);
    await vi.advanceTimersByTimeAsync(0);
    await scheduler?.shutdown("SIGTERM");
    return { out: out.join(""), err: err.join("") };
  }

  it("text（既定）", async () => {
    const { out, err } = await scenario({});
    expect(out).toMatchInlineSnapshot(`
      "{"text":"hello","langs":["ja"]}
      tail without newline"
    `);
    expect(err).toMatchInlineSnapshot(`
      "[scheduler] start mode=dry-run jobs=skyhigh service=bsky-bots env=production
      [scheduler] warn: DISCORD_WEBHOOK_URL is not set; failures will not be notified
      [scheduler] login check job=skyhigh result=unset reason=SKYHIGH_IDENTIFIER is not set
      [scheduler] run job=skyhigh run_id=skyhigh-2026-11-24T00:00:01.000Z
      [skyhigh] login password=<redacted>
      token <redacted>
      [scheduler] skipped job=skyhigh reason=overlap
      [skyhigh] failed: boom
      [skyhigh] summary: status=aborted processed=1 fetch_failed=1
      [scheduler] done job=skyhigh run_id=skyhigh-2026-11-24T00:00:01.000Z exit=1 signal=none timeout=false elapsed=1.5s login=unset
      [scheduler] would notify job=skyhigh run_id=skyhigh-2026-11-24T00:00:01.000Z
      [scheduler] stopping signal=SIGTERM running=none
      [scheduler] stopped
      "
    `);
  });

  it("json: すべての行を stdout に 1 行 1 JSON で出す", async () => {
    const { out, err } = await scenario({ LOG_FORMAT: "json" });
    expect(err).toBe("");
    expect(out).toMatchInlineSnapshot(`
      "{"ts":"2026-11-24T00:00:00.000Z","level":"info","service":"bsky-bots","env":"production","stream":"scheduler","msg":"start mode=dry-run jobs=skyhigh service=bsky-bots env=production"}
      {"ts":"2026-11-24T00:00:00.000Z","level":"warn","service":"bsky-bots","env":"production","stream":"scheduler","msg":"DISCORD_WEBHOOK_URL is not set; failures will not be notified"}
      {"ts":"2026-11-24T00:00:00.000Z","level":"warn","service":"bsky-bots","env":"production","job":"skyhigh","stream":"scheduler","msg":"login check result=unset reason=SKYHIGH_IDENTIFIER is not set"}
      {"ts":"2026-11-24T00:00:01.000Z","level":"info","service":"bsky-bots","env":"production","job":"skyhigh","run_id":"skyhigh-2026-11-24T00:00:01.000Z","stream":"scheduler","msg":"run"}
      {"ts":"2026-11-24T00:00:01.000Z","level":"info","service":"bsky-bots","env":"production","job":"skyhigh","run_id":"skyhigh-2026-11-24T00:00:01.000Z","stream":"stdout","msg":"{\\"text\\":\\"hello\\",\\"langs\\":[\\"ja\\"]}"}
      {"ts":"2026-11-24T00:00:01.000Z","level":"info","service":"bsky-bots","env":"production","job":"skyhigh","run_id":"skyhigh-2026-11-24T00:00:01.000Z","stream":"stderr","msg":"[skyhigh] login password=<redacted>"}
      {"ts":"2026-11-24T00:00:01.000Z","level":"info","service":"bsky-bots","env":"production","job":"skyhigh","run_id":"skyhigh-2026-11-24T00:00:01.000Z","stream":"stderr","msg":"token <redacted>"}
      {"ts":"2026-11-24T00:00:02.001Z","level":"info","service":"bsky-bots","env":"production","job":"skyhigh","stream":"scheduler","msg":"skipped reason=overlap"}
      {"ts":"2026-11-24T00:00:02.500Z","level":"error","service":"bsky-bots","env":"production","job":"skyhigh","run_id":"skyhigh-2026-11-24T00:00:01.000Z","stream":"stderr","msg":"[skyhigh] failed: boom"}
      {"ts":"2026-11-24T00:00:02.500Z","level":"warn","service":"bsky-bots","env":"production","job":"skyhigh","run_id":"skyhigh-2026-11-24T00:00:01.000Z","stream":"stderr","msg":"[skyhigh] summary: status=aborted processed=1 fetch_failed=1"}
      {"ts":"2026-11-24T00:00:02.500Z","level":"info","service":"bsky-bots","env":"production","job":"skyhigh","run_id":"skyhigh-2026-11-24T00:00:01.000Z","stream":"stdout","msg":"tail without newline"}
      {"ts":"2026-11-24T00:00:02.500Z","level":"info","service":"bsky-bots","env":"production","job":"skyhigh","run_id":"skyhigh-2026-11-24T00:00:01.000Z","stream":"scheduler","msg":"done exit=1 signal=none timeout=false elapsed=1.5s login=unset"}
      {"ts":"2026-11-24T00:00:02.500Z","level":"info","service":"bsky-bots","env":"production","job":"skyhigh","run_id":"skyhigh-2026-11-24T00:00:01.000Z","stream":"scheduler","msg":"would notify"}
      {"ts":"2026-11-24T00:00:02.500Z","level":"info","service":"bsky-bots","env":"production","stream":"scheduler","msg":"stopping signal=SIGTERM running=none"}
      {"ts":"2026-11-24T00:00:02.500Z","level":"info","service":"bsky-bots","env":"production","stream":"scheduler","msg":"stopped"}
      "
    `);
    const lines = out.trimEnd().split("\n");
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
    // 子の stdout はパースせず文字列のまま入れる。
    expect(JSON.parse(lines[4]).msg).toBe('{"text":"hello","langs":["ja"]}');
    expect(out).not.toContain(PASSWORD);
  });

  it("LOG_FORMAT が text / json 以外なら起動しない", () => {
    const { scheduler, log } = setup({ LOG_FORMAT: "yaml" });
    expect(scheduler).toBeNull();
    expect(log()).toBe(
      "[scheduler] error: invalid LOG_FORMAT: yaml (text or json)\n",
    );
  });

  it("json では設定のエラーも stdout に json で出す", () => {
    const { scheduler, out, err } = setup({
      LOG_FORMAT: "json",
      BOT_JOBS: "foo",
    });
    expect(scheduler).toBeNull();
    expect(err).toEqual([]);
    expect(JSON.parse(out.join(""))).toEqual({
      ts: "2026-11-24T00:00:00.000Z",
      level: "error",
      service: "bsky-bots",
      env: "production",
      stream: "scheduler",
      msg: "unknown job in BOT_JOBS: foo",
    });
  });

  it("LOG_LEVEL が debug / info / warn 以外なら起動しない", () => {
    const { scheduler, log } = setup({ LOG_LEVEL: "trace" });
    expect(scheduler).toBeNull();
    expect(log()).toContain("invalid LOG_LEVEL: trace");
  });

  it("LOG_LEVEL=warn はスケジューラの info を落とし、子の出力は落とさない", async () => {
    const { out, err } = await scenario({ LOG_LEVEL: "warn" });
    expect(out).toBe('{"text":"hello","langs":["ja"]}\ntail without newline');
    expect(err).toMatchInlineSnapshot(`
      "[scheduler] start mode=dry-run jobs=skyhigh service=bsky-bots env=production
      [scheduler] warn: DISCORD_WEBHOOK_URL is not set; failures will not be notified
      [scheduler] login check job=skyhigh result=unset reason=SKYHIGH_IDENTIFIER is not set
      [skyhigh] login password=<redacted>
      token <redacted>
      [skyhigh] failed: boom
      [skyhigh] summary: status=aborted processed=1 fetch_failed=1
      "
    `);
  });

  it("LOG_LEVEL=debug は tick・jitter・状態ファイルの書き込みも出す", async () => {
    vi.setSystemTime(new Date("2026-11-24T00:26:59Z"));
    const { log } = setup({ BOT_JOBS: "jiho", LOG_LEVEL: "debug" }, () => 0.5);
    expect(log()).toContain(
      `[scheduler] debug: state written path=${join(stateDir, "scheduler-state.json")}\n`,
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(log()).toContain("[scheduler] debug: tick job=jiho jitter=180.0s\n");
  });

  it("LOG_LEVEL=info（既定）では debug の行を出さない", async () => {
    vi.setSystemTime(new Date("2026-11-24T00:26:59Z"));
    const { log } = setup({ BOT_JOBS: "jiho" }, () => 0.5);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(log()).not.toContain("debug:");
  });
});

describe("起動時のログイン確認", () => {
  const IDENTIFIER = "jiho.test";
  const credentials = {
    JIHO_IDENTIFIER: IDENTIFIER,
    JIHO_APP_PASSWORD: PASSWORD,
  };

  /** 前回の起動が残した状態ファイル。 */
  function writePrevious(login: object, name = "jiho") {
    const state: SchedulerState = {
      ts: Date.now(),
      ready: true,
      mode: "dry-run",
      pid: 1,
      jobs: [
        {
          name,
          next: null,
          running: false,
          lastExit: null,
          lastRunAt: null,
          ...login,
        },
      ],
    };
    writeFileSync(statePath(stateDir), `${JSON.stringify(state)}\n`);
  }

  it("両方あれば 1 回 login し、result=ok を出して状態ファイルに残す", async () => {
    const { login, log } = setup({ BOT_JOBS: "jiho", ...credentials });
    // 起動直後（ready の時点）はまだ確認していない。
    expect(readState(stateDir)?.jobs[0].login).toEqual({
      result: "pending",
      at: null,
      fp: null,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(login).toHaveBeenCalledTimes(1);
    expect(login).toHaveBeenCalledWith(IDENTIFIER, PASSWORD);
    expect(log()).toContain("[scheduler] login check job=jiho result=ok\n");
    expect(readState(stateDir)?.jobs[0].login).toEqual({
      result: "ok",
      at: "2026-11-24T00:00:00.000Z",
      fp: credentialFingerprint(IDENTIFIER, PASSWORD),
    });
    expect(log()).not.toContain(PASSWORD);
    expect(log()).not.toContain(credentialFingerprint(IDENTIFIER, PASSWORD));
  });

  it("各回の done の行に login の結果を付ける", async () => {
    const { children, log } = setup({
      ...everySecond("jiho"),
      ...credentials,
    });
    await vi.advanceTimersByTimeAsync(1000);
    await children[0].close(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(log()).toMatch(
      /\[scheduler\] done job=jiho .* elapsed=\S+ login=ok\n/,
    );
  });

  it("確かめる前に終わった回は login=pending", async () => {
    // login が返らないまま 1 回目が終わる。
    const login = vi.fn<LoginFn>(() => new Promise(() => {}));
    const { children, log } = setup(
      { ...everySecond("jiho"), ...credentials },
      undefined,
      login,
    );
    await vi.advanceTimersByTimeAsync(1000);
    await children[0].close(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(log()).toMatch(/\[scheduler\] done job=jiho .* login=pending\n/);
  });

  it("失敗なら error の行を出す。reason の秘密は伏せ、起動したまま", async () => {
    const login = vi.fn<LoginFn>(async (_id, password) => ({
      ok: false,
      reason: `Invalid identifier or password (${password})`,
    }));
    const { scheduler, log } = setup(
      { BOT_JOBS: "jiho", ...credentials },
      undefined,
      login,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(scheduler).not.toBeNull();
    expect(log()).toContain(
      "[scheduler] login check job=jiho result=failed reason=Invalid identifier or password (<redacted>)\n",
    );
    expect(log()).not.toContain(PASSWORD);
    const state = readState(stateDir);
    expect(state?.ready).toBe(true);
    expect(state?.jobs[0].login).toMatchObject({
      result: "failed",
      reason: "Invalid identifier or password (<redacted>)",
    });
    expect(checkHealth(stateDir, Date.now())).toBe(true);
  });

  it("login が例外を投げても落とさない", async () => {
    const login = vi.fn<LoginFn>(async () => {
      throw new Error("boom");
    });
    const { scheduler, log } = setup(
      { BOT_JOBS: "jiho", ...credentials },
      undefined,
      login,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(scheduler).not.toBeNull();
    expect(log()).toContain(
      "[scheduler] error: login check failed: Error: boom\n",
    );
    expect(readState(stateDir)?.ready).toBe(true);
  });

  for (const [label, env, reason] of [
    [
      "片方無し",
      { JIHO_IDENTIFIER: IDENTIFIER },
      "JIHO_APP_PASSWORD is not set",
    ],
    [
      "空文字",
      { JIHO_IDENTIFIER: "", JIHO_APP_PASSWORD: "" },
      "JIHO_IDENTIFIER, JIHO_APP_PASSWORD is not set",
    ],
  ] as const) {
    it(`${label}なら login せず unset の warn を出す`, async () => {
      const { login, log } = setup({ BOT_JOBS: "jiho", ...env });
      await vi.advanceTimersByTimeAsync(0);
      expect(login).not.toHaveBeenCalled();
      expect(log()).toContain(
        `[scheduler] login check job=jiho result=unset reason=${reason}\n`,
      );
      expect(readState(stateDir)?.jobs[0].login).toEqual({
        result: "unset",
        at: null,
        fp: null,
      });
    });
  }

  it("同じ認証情報で 10 分以内に確かめていれば login せず skipped", async () => {
    const previous = {
      result: "failed",
      at: "2026-11-23T23:50:00.001Z",
      fp: credentialFingerprint(IDENTIFIER, PASSWORD),
      reason: "Invalid identifier or password",
    };
    writePrevious({ login: previous });
    const { login, log } = setup({ BOT_JOBS: "jiho", ...credentials });
    await vi.advanceTimersByTimeAsync(0);
    expect(login).not.toHaveBeenCalled();
    expect(log()).toContain(
      "[scheduler] login check job=jiho result=skipped previous=failed checked_at=2026-11-23T23:50:00.001Z\n",
    );
    expect(readState(stateDir)?.jobs[0].login).toEqual(previous);
  });

  it("認証情報が変わっていれば 10 分以内でも login する", async () => {
    writePrevious({
      login: {
        result: "failed",
        at: "2026-11-23T23:59:00.000Z",
        fp: credentialFingerprint(IDENTIFIER, "old-password"),
      },
    });
    const { login, log } = setup({ BOT_JOBS: "jiho", ...credentials });
    await vi.advanceTimersByTimeAsync(0);
    expect(login).toHaveBeenCalledTimes(1);
    expect(log()).toContain("[scheduler] login check job=jiho result=ok\n");
  });

  it("前回が 10 分以上前なら login する", async () => {
    writePrevious({
      login: {
        result: "ok",
        at: "2026-11-23T23:50:00.000Z",
        fp: credentialFingerprint(IDENTIFIER, PASSWORD),
      },
    });
    const { login } = setup({ BOT_JOBS: "jiho", ...credentials });
    await vi.advanceTimersByTimeAsync(0);
    expect(login).toHaveBeenCalledTimes(1);
  });

  it("ジョブごとに直列で確かめ、それぞれの結果を残す", async () => {
    const { login, log } = setup({
      BOT_JOBS: "skyhigh,jiho",
      SKYHIGH_IDENTIFIER: "skyhigh.test",
      SKYHIGH_APP_PASSWORD: "skyhigh-password",
      ...credentials,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(login.mock.calls).toEqual([
      ["skyhigh.test", "skyhigh-password"],
      [IDENTIFIER, PASSWORD],
    ]);
    expect(log()).toContain("login check job=skyhigh result=ok\n");
    expect(log()).toContain("login check job=jiho result=ok\n");
    expect(readState(stateDir)?.jobs.map((job) => job.login?.result)).toEqual([
      "ok",
      "ok",
    ]);
  });

  describe("失敗の通知", () => {
    const failing = () =>
      vi.fn<LoginFn>(async () => ({
        ok: false,
        reason: "AuthFactorTokenRequired",
      }));
    const skyhigh = {
      BOT_JOBS: "skyhigh",
      SKYHIGH_IDENTIFIER: "skyhigh.test",
      SKYHIGH_APP_PASSWORD: PASSWORD,
      DISCORD_WEBHOOK_URL: WEBHOOK,
    };

    it("dry-run（NOTIFY_IN_DRY_RUN なし）では送らず would notify を出す", async () => {
      const { fetchMock, log } = setup(skyhigh, undefined, failing());
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(log()).toContain("[scheduler] would notify job=skyhigh\n");
    });

    it("live で webhook があれば 1 回送る", async () => {
      const { fetchMock, contents } = setup(
        { ...skyhigh, BOT_MODE: "live" },
        undefined,
        failing(),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]).toContain(WEBHOOK);
      expect(contents()[0]).toBe(
        [
          "**bsky-bots: skyhigh login check failed**",
          "env: production",
          "time: 2026/11/24 09:00:00 JST",
          "mode: live",
          "```",
          "AuthFactorTokenRequired",
          "```",
        ].join("\n"),
      );
    });

    it("jiho（discord なし）は送らない", async () => {
      const { fetchMock, log } = setup(
        {
          BOT_MODE: "live",
          BOT_JOBS: "jiho",
          ...credentials,
          DISCORD_WEBHOOK_URL: WEBHOOK,
        },
        undefined,
        failing(),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(log()).toContain("login check job=jiho result=failed");
      expect(fetchMock).not.toHaveBeenCalled();
      expect(log()).not.toContain("would notify");
    });
  });

  it("json では 1 行の JSON で、job が入る", async () => {
    const { out } = setup({
      BOT_JOBS: "jiho",
      LOG_FORMAT: "json",
      ...credentials,
    });
    await vi.advanceTimersByTimeAsync(0);
    const lines = out
      .join("")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines.filter((line) => line.msg.startsWith("login check"))).toEqual([
      {
        ts: "2026-11-24T00:00:00.000Z",
        level: "info",
        service: "bsky-bots",
        env: "production",
        job: "jiho",
        stream: "scheduler",
        msg: "login check result=ok",
      },
    ]);
  });

  it("shutdown の後に終わった確認は状態ファイルに書かない", async () => {
    let finish: (value: { ok: true }) => void = () => {};
    const login = vi.fn<LoginFn>(
      () => new Promise((resolve) => (finish = resolve)),
    );
    const { scheduler } = setup(
      { BOT_JOBS: "jiho", ...credentials },
      undefined,
      login,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(login).toHaveBeenCalledTimes(1);
    await expect(scheduler?.shutdown("SIGTERM")).resolves.toBe(0);
    finish({ ok: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(readState(stateDir)?.jobs[0].login?.result).toBe("pending");
  });
});
