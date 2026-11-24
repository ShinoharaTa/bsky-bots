import type { ChildProcess } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRedactor } from "./logline.js";
import { KILL_GRACE_MS, runJob } from "./runner.js";

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

function setup(timeoutMs = 60_000, secrets: string[] = []) {
  const child = new FakeChild();
  const spawn = vi.fn(() => child as unknown as ChildProcess);
  const out: string[] = [];
  const err: string[] = [];
  const promise = runJob({
    args: ["skyhigh"],
    cwd: "/app",
    timeoutMs,
    spawn,
    redact: createRedactor(secrets),
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    now: () => Date.now(),
  });
  return { child, spawn, out, err, promise };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("runJob", () => {
  it("node dist/main.js <args> をアプリのルートで起動する", async () => {
    const { child, spawn, promise } = setup();
    await child.close(0);
    const result = await promise;
    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      ["dist/main.js", "skyhigh"],
      expect.objectContaining({ cwd: "/app" }),
    );
    expect(result).toMatchObject({
      exit: 0,
      signal: null,
      timedOut: false,
      spawnError: null,
    });
  });

  it("子の stdout / stderr をバイト単位でそのまま流す", async () => {
    const { child, out, err, promise } = setup();
    const stderrText =
      "skip alice.test: fetch failed\r\n\ttab  and  spaces \n" +
      "日本語の行🎌\n[skyhigh] summary: status=ok processed=3\nno newline at end";
    const stdoutText = '{"text":"投稿本文\\n2 行目"}\n';
    const stderrBytes = Buffer.from(stderrText);
    // マルチバイト文字の途中でチャンクを切る。
    const cut = stderrBytes.indexOf(Buffer.from("語")) + 1;
    child.stderr.write(stderrBytes.subarray(0, cut));
    child.stderr.write(stderrBytes.subarray(cut));
    child.stdout.write(Buffer.from(stdoutText));
    await child.close(0);
    await promise;
    expect(Buffer.from(err.join(""))).toEqual(stderrBytes);
    expect(out.join("")).toBe(stdoutText);
  });

  it("秘密の値と JWT は伏せる。stderr の末尾 30 行を返す", async () => {
    const { child, err, promise } = setup(60_000, ["hunter2-pass"]);
    for (let i = 1; i <= 40; i++) {
      child.stderr.write(`line ${i} hunter2-pass eyJhbGc.eyJzdWIi.c2lnbmF0\n`);
    }
    await child.close(1);
    const result = await promise;
    expect(err.join("")).not.toContain("hunter2-pass");
    expect(err.join("")).not.toContain("eyJ");
    expect(err[0]).toBe("line 1 <redacted> <redacted>\n");
    expect(result.exit).toBe(1);
    expect(result.stderrTail).toHaveLength(30);
    expect(result.stderrTail[0]).toBe("line 11 <redacted> <redacted>");
    expect(result.stderrTail[29]).toBe("line 40 <redacted> <redacted>");
  });

  it("timeout で SIGTERM、その 10 秒後に SIGKILL を送り、timeout として返す", async () => {
    vi.useFakeTimers();
    const { child, promise } = setup(5_000);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenLastCalledWith("SIGTERM");
    await vi.advanceTimersByTimeAsync(KILL_GRACE_MS - 1);
    expect(child.kill).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(child.kill).toHaveBeenLastCalledWith("SIGKILL");
    await child.close(null, "SIGKILL");
    const result = await promise;
    expect(result).toMatchObject({ timedOut: true, signal: "SIGKILL" });
  });

  it("SIGTERM で終われば SIGKILL は送らない", async () => {
    vi.useFakeTimers();
    const { child, promise } = setup(5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    await child.close(null, "SIGTERM");
    await vi.advanceTimersByTimeAsync(KILL_GRACE_MS * 2);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect((await promise).timedOut).toBe(true);
  });

  it("spawn に失敗したら spawnError を返す", async () => {
    const child = new FakeChild();
    child.pid = undefined;
    const promise = runJob({
      args: ["skyhigh"],
      cwd: "/app",
      timeoutMs: 60_000,
      spawn: () => child as unknown as ChildProcess,
      redact: (text) => text,
      stdout: () => {},
      stderr: () => {},
      now: () => 0,
    });
    child.emit("error", new Error("spawn ENOENT"));
    const result = await promise;
    expect(result.spawnError).toContain("ENOENT");
  });
});
