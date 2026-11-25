import { afterEach, describe, expect, it } from "vitest";
import { resolveActor } from "./config.js";
import type { AggregateBotDefinition } from "./types.js";

// 実 Bot 名と被らない名前にして、.env の値に影響されないようにする。
const bot = {
  name: "configtestbot",
  defaultHandle: "default.example.com",
} as AggregateBotDefinition;
const KEY = "CONFIGTESTBOT_IDENTIFIER";

afterEach(() => {
  delete process.env[KEY];
});

describe("resolveActor", () => {
  it("環境変数があればそれを使う", () => {
    process.env[KEY] = "bot.example.com";
    expect(resolveActor(bot)).toBe("bot.example.com");
  });

  it("未設定なら既定ハンドル", () => {
    expect(resolveActor(bot)).toBe("default.example.com");
  });

  it("空文字も既定ハンドル", () => {
    process.env[KEY] = "";
    expect(resolveActor(bot)).toBe("default.example.com");
  });
});
