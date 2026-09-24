import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseArgs, runCli } from "./cli.js";
import { DEFAULT_ABORT_POLICY, FailureTracker } from "./core/abort.js";
import { DEFAULT_FEED_LIMITS } from "./core/feed.js";
import type { Poster } from "./core/poster.js";
import { guardRun } from "./core/run.js";
import type { BotDefinition } from "./core/types.js";

/** 投稿経路が壊れている Poster。notifyError も失敗する。 */
const brokenPoster: Poster = {
  post: async () => {
    throw new Error("post route is broken");
  },
  reply: async () => {
    throw new Error("post route is broken");
  },
};

function fakeBot(run: BotDefinition["run"]): BotDefinition {
  return {
    name: "fake",
    defaultHandle: "fake.test",
    errorNotifyHandle: "@shino3.net",
    followersMaxPages: 1,
    feedLimits: DEFAULT_FEED_LIMITS,
    abortPolicy: DEFAULT_ABORT_POLICY,
    run,
  };
}

let errors: string[];

beforeEach(() => {
  errors = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("parseArgs", () => {
  it("--live と --limit-followers の併用を拒否する", () => {
    expect(parseArgs(["skyhigh", "--live", "--limit-followers=1"])).toBeNull();
    expect(parseArgs(["--limit-followers=1", "skylog", "--live"])).toBeNull();
    expect(errors.join("\n")).toContain(
      "--live and --limit-followers cannot be used together",
    );
  });

  it("どちらか片方なら受け付ける", () => {
    expect(parseArgs(["skyhigh", "--live"])?.live).toBe(true);
    expect(parseArgs(["skylog", "--limit-followers=5"])?.limitFollowers).toBe(
      5,
    );
  });
});

describe("runCli", () => {
  it("併用は認証情報を読む前に exit 1 で止まる", async () => {
    // 認証情報が揃っていても読みに行かないこと（ログインまで進まない）。
    vi.stubEnv("SKYHIGH_IDENTIFIER", "");
    vi.stubEnv("SKYHIGH_APP_PASSWORD", "");
    expect(await runCli(["skyhigh", "--live", "--limit-followers=1"])).toBe(1);
    const log = errors.join("\n");
    expect(log).toContain("cannot be used together");
    expect(log).not.toContain("is not set");
    expect(log).not.toContain("login failed");
  });

  it("正常終了なら 0", async () => {
    const bot = fakeBot(async () => {});
    expect(await runCli(["fake"], [bot])).toBe(0);
  });

  it("notifyError が throw しても元の例外で exit 1 になる", async () => {
    const original = new Error("original failure");
    let rejected: unknown;
    const bot = fakeBot(async () => {
      try {
        await guardRun(
          {
            bot: "fake",
            poster: brokenPoster,
            errorNotifyHandle: "@shino3.net",
            tracker: new FailureTracker(DEFAULT_ABORT_POLICY),
          },
          async () => {
            throw original;
          },
        );
      } catch (ex) {
        rejected = ex;
        throw ex;
      }
    });
    expect(await runCli(["fake"], [bot])).toBe(1);
    expect(rejected).toBe(original);
    const log = errors.join("\n");
    // 原因が通知より先に出ていること。
    const causeAt = log.indexOf("[fake] failed: original failure");
    const notifyAt = log.indexOf(
      "[fake] notifyError failed: post route is broken",
    );
    expect(causeAt).toBeGreaterThanOrEqual(0);
    expect(notifyAt).toBeGreaterThan(causeAt);
    expect(log).toMatch(/\[fake\] summary: status=error .*original failure/);
  });
});
