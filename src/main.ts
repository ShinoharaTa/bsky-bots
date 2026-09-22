import { skyhigh } from "./bots/skyhigh/index.js";
import { skylog } from "./bots/skylog/index.js";
import { createAgent, login } from "./core/client.js";
import { loadCredentials, resolveActor } from "./core/config.js";
import { createDateBounds } from "./core/date.js";
import { DryRunPoster, LivePoster, type Poster } from "./core/poster.js";
import type { BotDefinition } from "./core/types.js";

const BOTS: BotDefinition[] = [skyhigh, skylog];

interface Options {
  bot: BotDefinition;
  live: boolean;
  limitFollowers?: number;
}

function usage(): void {
  console.error(
    "Usage: node dist/main.js <bot> [--live] [--limit-followers=N]",
  );
  console.error(`Available bots: ${BOTS.map((bot) => bot.name).join(", ")}`);
}

function parseArgs(argv: string[]): Options | null {
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
    bot = BOTS.find((item) => item.name === arg);
    if (!bot) {
      console.error(`unknown bot: ${arg}`);
      return null;
    }
  }
  if (!bot) return null;
  return { bot, live, limitFollowers };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!options) {
    usage();
    process.exit(1);
  }
  const { bot, live, limitFollowers } = options;
  const agent = createAgent(live);
  let poster: Poster;
  if (live) {
    // 認証情報を要求するのは --live のときだけ。
    const session = await login(agent, loadCredentials(bot));
    if (!session) {
      console.error(`login failed: ${bot.name}`);
      process.exit(1);
    }
    // 旧実装はセッションをそのまま console.log していたが accessJwt が
    // ログに残るので handle だけにする。
    console.error(`logged in as ${session.handle}`);
    poster = new LivePoster(agent);
  } else {
    poster = new DryRunPoster(agent);
  }
  await bot.run({
    agent,
    poster,
    actor: resolveActor(bot),
    bounds: createDateBounds(),
    limitFollowers,
  });
}

await main();
