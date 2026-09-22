import dotenv from "dotenv";
import type { BotDefinition } from "./types.js";

dotenv.config();

export interface BotCredentials {
  identifier: string;
  password: string;
}

function envName(bot: BotDefinition, suffix: string): string {
  return `${bot.name.toUpperCase()}_${suffix}`;
}

/**
 * 認証情報を読む。--live のときだけ呼ぶ。
 * AUTHOR / PASSWORD へのフォールバックは入れない。2 Bot が 1 つの .env を
 * 共有するので、片方の認証情報でもう片方の内容を投稿してしまう。
 */
export function loadCredentials(bot: BotDefinition): BotCredentials {
  const identifierKey = envName(bot, "IDENTIFIER");
  const passwordKey = envName(bot, "APP_PASSWORD");
  const identifier = process.env[identifierKey];
  const password = process.env[passwordKey];
  if (!identifier) {
    throw new Error(`${identifierKey} is not set`);
  }
  if (!password) {
    throw new Error(`${passwordKey} is not set`);
  }
  return { identifier, password };
}

/**
 * フォロワー取得の対象。dry-run は認証情報を要求しないので、
 * 環境変数が無ければ Bot 設定の既定ハンドルに落とす。
 */
export function resolveActor(bot: BotDefinition): string {
  return process.env[envName(bot, "IDENTIFIER")] ?? bot.defaultHandle;
}
