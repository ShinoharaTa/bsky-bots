import { describe, expect, it, vi } from "vitest";
import {
  buildMessage,
  type Deps,
  DISCORD_MAX_LENGTH,
  main,
  parseShow,
} from "./notify-failure.js";

/** 実在しない URL。テストは fetch を差し替えるので送信はしない。 */
const WEBHOOK = "https://discord.example/api/webhooks/123/secret-token-xyz";

const SHOW = [
  "Result=exit-code",
  "ExecMainStatus=1",
  "InvocationID=abc123",
].join("\n");

function makeDeps(overrides: Partial<Deps> = {}) {
  const lines: string[] = [];
  const run = vi.fn(async (file: string, args: string[]) => {
    if (file === "systemctl") return SHOW;
    if (args.includes("_SYSTEMD_INVOCATION_ID=abc123")) {
      return "fetch failed\nskyhigh: 3 users skipped\n";
    }
    return "";
  });
  const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
  const deps: Deps = {
    env: { DISCORD_WEBHOOK_URL: WEBHOOK },
    fetch: fetchMock as unknown as typeof fetch,
    run,
    sleep: vi.fn(async () => {}),
    stderr: (line) => lines.push(line),
    host: () => "n100",
    now: () => "2026/09/23 08:50:12",
    ...overrides,
  };
  return { deps, lines, run, fetchMock };
}

function sentContent(fetchMock: ReturnType<typeof vi.fn>, call = 0): string {
  const init = fetchMock.mock.calls[call][1] as RequestInit;
  return JSON.parse(init.body as string).content;
}

describe("parseShow", () => {
  it("systemctl show の Key=Value を読む", () => {
    expect(parseShow(SHOW)).toEqual({
      result: "exit-code",
      execMainStatus: "1",
      invocationId: "abc123",
    });
  });
});

describe("buildMessage", () => {
  const base = {
    unit: "bsky-skyhigh.service",
    host: "n100",
    time: "2026/09/23 08:50:12",
    status: { result: "exit-code", execMainStatus: "1", invocationId: "x" },
  };

  it("unit 名・ホスト・時刻・Result・ログをコードブロックで含む", () => {
    const text = buildMessage({ ...base, log: "line1\nline2\n" });
    expect(text).toBe(
      [
        "**bsky-skyhigh.service failed**",
        "host: n100",
        "time: 2026/09/23 08:50:12 JST",
        "Result=exit-code / ExecMainStatus=1",
        "```",
        "line1",
        "line2",
        "```",
      ].join("\n"),
    );
  });

  it("2000 文字を超えるログは先頭側を削って末尾を残す", () => {
    const log = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
    const text = buildMessage({ ...base, log });
    expect(text.length).toBeLessThanOrEqual(DISCORD_MAX_LENGTH);
    expect(text).toContain("...(truncated)");
    expect(text).toContain("line 499");
    expect(text).not.toContain("line 0\n");
    expect(text.endsWith("```")).toBe(true);
  });

  it("ログ中の ``` でコードブロックが閉じない", () => {
    const text = buildMessage({ ...base, log: "a```b" });
    expect(text.match(/```/g)).toHaveLength(2);
  });
});

describe("main", () => {
  it("最後の起動分のログを付けて webhook に POST する", async () => {
    const { deps, run, fetchMock } = makeDeps();
    expect(await main(["bsky-skyhigh.service"], deps)).toBe(0);
    expect(run).toHaveBeenCalledWith("journalctl", [
      "--user",
      "-n",
      "30",
      "--no-pager",
      "-o",
      "cat",
      "_SYSTEMD_INVOCATION_ID=abc123",
      "+",
      "USER_INVOCATION_ID=abc123",
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(WEBHOOK);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string).allowed_mentions).toEqual({
      parse: [],
    });
    const content = sentContent(fetchMock);
    expect(content).toContain("**bsky-skyhigh.service failed**");
    expect(content).toContain("Result=exit-code / ExecMainStatus=1");
    expect(content).toContain("skyhigh: 3 users skipped");
  });

  it("InvocationID で何も取れなければ unit の直近分に落とす", async () => {
    const { deps, fetchMock } = makeDeps({
      run: vi.fn(async (file: string, args: string[]) => {
        if (file === "systemctl") return SHOW;
        if (args.some((arg) => arg.startsWith("_SYSTEMD_INVOCATION_ID=")))
          return "";
        return "fallback log\n";
      }),
    });
    expect(await main(["bsky-skylog.service"], deps)).toBe(0);
    expect(deps.run).toHaveBeenLastCalledWith("journalctl", [
      "--user",
      "-u",
      "bsky-skylog.service",
      "-n",
      "30",
      "--no-pager",
      "-o",
      "cat",
    ]);
    expect(sentContent(fetchMock)).toContain("fallback log");
  });

  it("DISCORD_WEBHOOK_URL が無ければ stderr に出して 1 を返す", async () => {
    const { deps, lines, fetchMock } = makeDeps({ env: {} });
    expect(await main(["bsky-skyhigh.service"], deps)).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(lines.join("\n")).toContain("DISCORD_WEBHOOK_URL is not set");
    expect(lines.join("\n")).toContain("bsky-skyhigh.service");
  });

  it("unit 名が無ければ 1 を返す", async () => {
    const { deps, fetchMock } = makeDeps();
    expect(await main([], deps)).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("429 は Retry-After を 1 回だけ待ってやり直す", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, { status: 429, headers: { "Retry-After": "2" } }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const { deps } = makeDeps({ fetch: fetchMock as unknown as typeof fetch });
    expect(await main(["bsky-skyhigh.service"], deps)).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(deps.sleep).toHaveBeenCalledWith(2000);
  });

  it("429 が続いたら 2 回で諦めて 1 を返す", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(null, { status: 429, headers: { "Retry-After": "1" } }),
    );
    const { deps, lines } = makeDeps({
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(await main(["bsky-skyhigh.service"], deps)).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(lines.join("\n")).toContain("HTTP 429");
  });

  it("送信失敗を stderr に出し、どの出力にも webhook URL を含めない", async () => {
    for (const fetchImpl of [
      async () => new Response("bad", { status: 500 }),
      async () => {
        throw new TypeError(`fetch failed: ${WEBHOOK}`);
      },
    ]) {
      const { deps, lines } = makeDeps({
        fetch: vi.fn(fetchImpl) as unknown as typeof fetch,
      });
      expect(await main(["bsky-skyhigh.service"], deps)).toBe(1);
      const output = lines.join("\n");
      expect(output).toMatch(/discord webhook (failed|request failed)/);
      expect(output).not.toContain(WEBHOOK);
      expect(output).not.toContain("secret-token-xyz");
    }
  });

  it("成功時の出力にも webhook URL を含めない", async () => {
    const { deps, lines, fetchMock } = makeDeps();
    expect(await main(["bsky-skyhigh.service"], deps)).toBe(0);
    expect(lines.join("\n")).not.toContain("secret-token-xyz");
    expect(sentContent(fetchMock)).not.toContain("secret-token-xyz");
  });
});
