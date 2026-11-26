import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const agent = vi.hoisted(() => ({
  options: [] as unknown[],
  login: vi.fn(),
  logout: vi.fn(),
}));

vi.mock("@atproto/api", () => ({
  AtpAgent: class {
    constructor(options: unknown) {
      agent.options.push(options);
    }
    login = agent.login;
    logout = agent.logout;
  },
}));

import {
  credentialFingerprint,
  defaultLogin,
  LOGIN_TIMEOUT_MS,
} from "./login-check.js";

describe("credentialFingerprint", () => {
  it("16 桁の hex。入力が違えば変わる", () => {
    const fp = credentialFingerprint("jiho.test", "abcd-efgh-ijkl-mnop");
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
    expect(credentialFingerprint("jiho.test", "abcd-efgh-ijkl-mnop")).toBe(fp);
    expect(credentialFingerprint("jiho.test", "other")).not.toBe(fp);
    expect(credentialFingerprint("other.test", "abcd-efgh-ijkl-mnop")).not.toBe(
      fp,
    );
    // 区切りがあるので、境界をずらしても同じにならない。
    expect(credentialFingerprint("ab", "c")).not.toBe(
      credentialFingerprint("a", "bc"),
    );
  });
});

describe("defaultLogin", () => {
  beforeEach(() => {
    agent.options.length = 0;
    agent.login.mockReset();
    agent.logout.mockReset();
    agent.logout.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("bsky.social に login し、通ったら logout する", async () => {
    agent.login.mockResolvedValue({ success: true, data: {} });
    await expect(defaultLogin("jiho.test", "pw")).resolves.toEqual({
      ok: true,
    });
    expect(agent.options).toEqual([{ service: "https://bsky.social" }]);
    expect(agent.login).toHaveBeenCalledWith({
      identifier: "jiho.test",
      password: "pw",
    });
    expect(agent.logout).toHaveBeenCalledTimes(1);
  });

  it("logout の失敗は無視する", async () => {
    agent.login.mockResolvedValue({ success: true, data: {} });
    agent.logout.mockRejectedValue(new Error("network"));
    await expect(defaultLogin("jiho.test", "pw")).resolves.toEqual({
      ok: true,
    });
  });

  it("例外なら message を reason にする。logout しない", async () => {
    agent.login.mockRejectedValue(new Error("Invalid identifier or password"));
    await expect(defaultLogin("jiho.test", "pw")).resolves.toEqual({
      ok: false,
      reason: "Invalid identifier or password",
    });
    expect(agent.logout).not.toHaveBeenCalled();
  });

  it("success=false や message の無い例外は login failed", async () => {
    agent.login.mockResolvedValue({ success: false, data: {} });
    await expect(defaultLogin("jiho.test", "pw")).resolves.toEqual({
      ok: false,
      reason: "login failed",
    });
    agent.login.mockRejectedValue(new Error(""));
    await expect(defaultLogin("jiho.test", "pw")).resolves.toEqual({
      ok: false,
      reason: "login failed",
    });
  });

  it("15 秒で timeout", async () => {
    vi.useFakeTimers();
    agent.login.mockReturnValue(new Promise(() => {}));
    const result = defaultLogin("jiho.test", "pw");
    await vi.advanceTimersByTimeAsync(LOGIN_TIMEOUT_MS - 1);
    let settled = false;
    void result.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toEqual({ ok: false, reason: "timeout" });
    expect(LOGIN_TIMEOUT_MS).toBe(15_000);
  });
});
