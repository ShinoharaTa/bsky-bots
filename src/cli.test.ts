import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseArgs, runCli } from "./cli.js";
import { DEFAULT_ABORT_POLICY, FailureTracker } from "./core/abort.js";
import { DEFAULT_FEED_LIMITS } from "./core/feed.js";
import type { Poster } from "./core/poster.js";
import { guardRun } from "./core/run.js";
import type {
  AggregateBotDefinition,
  PostContext,
  SimpleBotDefinition,
} from "./core/types.js";

/** 投稿経路が壊れている Poster。notifyError も失敗する。 */
const brokenPoster: Poster = {
  post: async () => {
    throw new Error("post route is broken");
  },
  reply: async () => {
    throw new Error("post route is broken");
  },
};

function fakeBot(run: AggregateBotDefinition["run"]): AggregateBotDefinition {
  return {
    kind: "aggregate",
    name: "fake",
    defaultHandle: "fake.test",
    errorNotifyHandle: "@shino3.net",
    followersMaxPages: 1,
    feedLimits: DEFAULT_FEED_LIMITS,
    abortPolicy: DEFAULT_ABORT_POLICY,
    run,
  };
}

/** 単発投稿 Bot。poster だけ受け取る。 */
function simpleBot(run: SimpleBotDefinition["run"]): SimpleBotDefinition {
  return { kind: "simple", name: "simple", run };
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
    // Bot 名より前に書いてもよい。
    expect(parseArgs(["--limit-followers=5", "skylog"])?.limitFollowers).toBe(
      5,
    );
  });

  it("--limit-followers の不正値を拒否する", () => {
    expect(parseArgs(["skyhigh", "--limit-followers=abc"])).toBeNull();
    expect(parseArgs(["skylog", "--limit-followers=0"])).toBeNull();
    expect(parseArgs(["skylog", "--limit-followers=-1"])).toBeNull();
    expect(parseArgs(["skylog", "--limit-followers=1.5"])).toBeNull();
    expect(errors.join("\n")).toContain(
      "invalid --limit-followers: --limit-followers=abc",
    );
  });

  it("知らない引数・Bot・2 つ目の Bot 名を拒否する", () => {
    expect(parseArgs(["skyhigh", "--dry-run"])).toBeNull();
    expect(parseArgs(["nobot"])).toBeNull();
    expect(parseArgs(["skyhigh", "skylog"])).toBeNull();
    expect(parseArgs([])).toBeNull();
    const log = errors.join("\n");
    expect(log).toContain("unknown argument for skyhigh: --dry-run");
    expect(log).toContain("unknown bot: nobot");
    expect(log).toContain("unknown argument: skylog");
  });

  it("単発投稿 Bot は --live だけ受け付け、--limit-followers を拒否する", () => {
    const bots = [simpleBot(async () => {})];
    expect(parseArgs(["simple"], bots)).toEqual({
      bot: bots[0],
      live: false,
    });
    expect(parseArgs(["simple", "--live"], bots)?.live).toBe(true);
    expect(parseArgs(["simple", "--limit-followers=1"], bots)).toBeNull();
    expect(parseArgs(["--limit-followers=abc", "simple"], bots)).toBeNull();
    expect(errors.join("\n")).toContain(
      "unknown argument for simple: --limit-followers=1",
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

  it("単発投稿 Bot には poster だけ渡す", async () => {
    let received: PostContext | undefined;
    const bot = simpleBot(async (ctx) => {
      received = ctx;
    });
    expect(await runCli(["simple"], [bot])).toBe(0);
    expect(received && Object.keys(received)).toEqual(["poster"]);
  });

  it("単発投稿 Bot への --live --limit-followers も認証情報を読む前に止まる", async () => {
    const bot = simpleBot(async () => {});
    expect(
      await runCli(["simple", "--live", "--limit-followers=1"], [bot]),
    ).toBe(1);
    const log = errors.join("\n");
    expect(log).toContain("unknown argument for simple");
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
