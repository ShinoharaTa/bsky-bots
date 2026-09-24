import { skyhigh } from "./bots/skyhigh/index.js";
import { skylog } from "./bots/skylog/index.js";
import { createAgent, login } from "./core/client.js";
import { loadCredentials, resolveActor } from "./core/config.js";
import { createDateBounds } from "./core/date.js";
import { DryRunPoster, LivePoster, type Poster } from "./core/poster.js";
import type { BotDefinition } from "./core/types.js";

export const BOTS: BotDefinition[] = [skyhigh, skylog];

export interface Options {
  bot: BotDefinition;
  live: boolean;
  limitFollowers?: number;
}

function usage(bots: BotDefinition[]): void {
  console.error(
    "Usage: node dist/main.js <bot> [--live] [--limit-followers=N]",
  );
  console.error(`Available bots: ${bots.map((bot) => bot.name).join(", ")}`);
}

export function parseArgs(
  argv: string[],
  bots: BotDefinition[] = BOTS,
): Options | null {
  let bot: BotDefinition | undefined;
  let live = false;
  let limitFollowers: number | undefined;
  for (const arg of argv) {
    if (arg === "--live") {
      live = true;
      continue;
    }
    if (arg.startsWith("--limit-followers=")) {
      const value = Number(arg.slice("--limit-followers=".length));
      if (!Number.isInteger(value) || value <= 0) {
        console.error(`invalid --limit-followers: ${arg}`);
        return null;
      }
      limitFollowers = value;
      continue;
    }
    if (arg.startsWith("-") || bot) {
      console.error(`unknown argument: ${arg}`);
      return null;
    }
    bot = bots.find((item) => item.name === arg);
    if (!bot) {
      console.error(`unknown bot: ${arg}`);
      return null;
    }
  }
  if (!bot) return null;
  // 部分集計のまま本番に投稿しないように。
  if (live && limitFollowers !== undefined) {
    console.error("--live and --limit-followers cannot be used together");
    return null;
  }
  return { bot, live, limitFollowers };
}

/**
 * 引数を読んで Bot を 1 回走らせ、終了コードを返す。
 * Bot が失敗したら 1（原因のログと通知は Bot 側で済んでいる）。
 */
export async function runCli(
  argv: string[],
  bots: BotDefinition[] = BOTS,
): Promise<number> {
  // 併用チェックは認証情報の読み込みより前にここで済ませる。
  const options = parseArgs(argv, bots);
  if (!options) {
    usage(bots);
    return 1;
  }
  const { bot, live, limitFollowers } = options;
  const agent = createAgent(live);
  let poster: Poster;
  if (live) {
    // 認証情報を要求するのは --live のときだけ。
    const session = await login(agent, loadCredentials(bot));
    if (!session) {
      console.error(`login failed: ${bot.name}`);
      return 1;
    }
    // 旧実装はセッションをそのまま console.log していたが accessJwt が
    // ログに残るので handle だけにする。
    console.error(`logged in as ${session.handle}`);
    poster = new LivePoster(agent);
  } else {
    poster = new DryRunPoster(agent);
  }
  try {
    await bot.run({
      agent,
      poster,
      actor: resolveActor(bot),
      bounds: createDateBounds(),
      limitFollowers,
    });
  } catch {
    return 1;
  }
  return 0;
}
