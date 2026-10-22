import { skyhigh } from "./bots/skyhigh/index.js";
import { skylog } from "./bots/skylog/index.js";
import { createAgent, createReadAgent, login } from "./core/client.js";
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
  console.error("Usage: node dist/main.js <bot> [--live] [bot options]");
  const aggregates = bots.filter((bot) => bot.kind === "aggregate");
  if (aggregates.length > 0) {
    console.error(
      `  --limit-followers=N  ${aggregates.map((bot) => bot.name).join(", ")} only`,
    );
  }
  console.error(`Available bots: ${bots.map((bot) => bot.name).join(", ")}`);
}

/**
 * Bot 固有の引数を 1 つ読む。読めたら true、Bot が受け付けない引数なら false。
 * 値が不正なら null（エラーはここで出す）。
 */
function parseBotArg(
  bot: BotDefinition,
  arg: string,
  options: Options,
): boolean | null {
  // --limit-followers は集計 Bot だけ。
  if (bot.kind === "aggregate" && arg.startsWith("--limit-followers=")) {
    const value = Number(arg.slice("--limit-followers=".length));
    if (!Number.isInteger(value) || value <= 0) {
      console.error(`invalid --limit-followers: ${arg}`);
      return null;
    }
    options.limitFollowers = value;
    return true;
  }
  return false;
}

export function parseArgs(
  argv: string[],
  bots: BotDefinition[] = BOTS,
): Options | null {
  // Bot 名は引数のどこにあってもよいので、先に Bot を決めてからフラグを読む。
  let bot: BotDefinition | undefined;
  for (const arg of argv) {
    if (arg.startsWith("-")) continue;
    if (bot) {
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
  const options: Options = { bot, live: false };
  for (const arg of argv) {
    if (!arg.startsWith("-")) continue;
    // --live（と既定の dry-run）は全 Bot 共通。
    if (arg === "--live") {
      options.live = true;
      continue;
    }
    const parsed = parseBotArg(bot, arg, options);
    if (parsed === null) return null;
    if (!parsed) {
      console.error(`unknown argument for ${bot.name}: ${arg}`);
      return null;
    }
  }
  // 部分集計のまま本番に投稿しないように。
  if (options.live && options.limitFollowers !== undefined) {
    console.error("--live and --limit-followers cannot be used together");
    return null;
  }
  return options;
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
    poster = new LivePoster(agent, bot.posterOptions);
  } else {
    poster = new DryRunPoster(agent, bot.posterOptions);
  }
  try {
    if (bot.kind === "aggregate") {
      await bot.run({
        // フォロワー取得は投稿用の agent と分け、常に公開エンドポイントから読む。
        agent: createReadAgent(),
        poster,
        actor: resolveActor(bot),
        bounds: createDateBounds(),
        limitFollowers,
      });
    } else {
      await bot.run({ poster });
    }
  } catch {
    return 1;
  }
  return 0;
}
