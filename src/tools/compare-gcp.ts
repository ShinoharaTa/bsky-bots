import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import moment from "moment-timezone";
import { PUBLIC_SERVICE } from "../core/client.js";
import { TIMEZONE } from "../core/date.js";
import { fetchJson } from "../core/retry.js";

/**
 * 読み取り専用の比較ツール。投稿処理は持たない。
 * GCP（旧実装）が実際に投稿した内容を公開 API から取り、
 * 新実装の dry-run 出力（JSON Lines）と突き合わせる。
 *
 * usage: node dist/tools/compare-gcp.js <skyhigh|skylog> <dry-run.jsonl> [YYYY-MM-DD(対象日 JST, 既定=前日)]
 *
 * 差分を「説明のつくもの」と「要確認」に分けて出す。
 * 要確認のユーザーは probe.js の出力を見て人が判断する（docs/deploy.md 4 章）。
 */

const BOT_HANDLES = {
  skyhigh: "skyhigh.bsky.social",
  skylog: "skylog.bsky.social",
} as const;
type BotName = keyof typeof BOT_HANDLES;

/** 公開 API を遡る上限。1 ページ 100 件。 */
const MAX_FEED_PAGES = 40;
const MAX_FOLLOWER_PAGES = 30;
const MENTION_TYPE = "app.bsky.richtext.facet#mention";

interface Facet {
  index?: { byteStart?: number; byteEnd?: number };
  features?: { $type?: string; did?: string }[];
}

interface Post {
  text: string;
  facets: Facet[];
}

export interface SkylogCounts {
  /** 集計の対象を表すキー。メンションの did、無ければ本文の先頭行。 */
  key: string;
  mention: string;
  total: number;
  posts: number;
  replies: number;
  reposts: number;
}

export interface RankEntry {
  name: string;
  /** 999+ は 1000 として扱う。 */
  count: number;
}

interface FollowerInfo {
  did: string;
  handle: string;
  displayName: string | undefined;
}

// ---------------------------------------------------------------- parse

function mentionDid(facets: Facet[]): string | null {
  for (const facet of facets) {
    if (facet.index?.byteStart !== 0) continue;
    for (const feature of facet.features ?? []) {
      if (feature.$type === MENTION_TYPE && feature.did) return feature.did;
    }
  }
  return null;
}

/**
 * 旧実装はリプライのリポストもリプに数えていたので、投稿が負になることがある
 * （実例: 2026/09/22 の @okadaic.bsky.social が「投稿：-4」）。
 */
function numberAfter(text: string, label: string): number | null {
  const match = text.match(new RegExp(`${label}[\\s　]*：(-?\\d+)`));
  return match ? Number(match[1]) : null;
}

/** skylog のユーザーごとの投稿を読む。対象日の投稿でなければ null。 */
export function parseSkylogPost(post: Post, day: string): SkylogCounts | null {
  const lines = post.text.split("\n");
  if (lines[1] !== `${day}#skylog`) return null;
  const mention = lines[0].replace(/さんの集計データ$/, "");
  const total = numberAfter(post.text, "今日の累計");
  const posts = numberAfter(post.text, "投稿");
  const replies = numberAfter(post.text, "リプ");
  const reposts = numberAfter(post.text, "リポスト");
  if (total === null || posts === null || replies === null || reposts === null)
    return null;
  return {
    key: mentionDid(post.facets) ?? mention,
    mention,
    total,
    posts,
    replies,
    reposts,
  };
}

/** skyhigh のランキング投稿を読む。対象日のランキングでなければ null。 */
export function parseRanking(text: string, day: string): RankEntry[] | null {
  const lines = text.split("\n");
  if (!lines[0].startsWith(`【すか廃ランキング ${day}】`)) return null;
  const entries: RankEntry[] = [];
  for (const line of lines.slice(1)) {
    const match = line.match(/^(?:👑|\d+位)：(999\+|\d+) (.*)$/u);
    if (!match) continue;
    entries.push({
      name: match[2],
      count: match[1] === "999+" ? 1000 : Number(match[1]),
    });
  }
  return entries;
}

/** 新実装の dry-run 出力（JSON Lines）。 */
export function readDryRun(content: string): Post[] {
  return content
    .split("\n")
    .filter((line) => line.trim().startsWith("{"))
    .map((line) => JSON.parse(line) as Post)
    .map((item) => ({ text: item.text, facets: item.facets ?? [] }));
}

// ---------------------------------------------------------------- compare

export interface SkylogDiff {
  key: string;
  mention: string;
  old: SkylogCounts | null;
  new: SkylogCounts | null;
  /** 説明がつくならその理由。null は要確認。 */
  reason: string | null;
}

/**
 * 不変条件: 非リポスト総数（投稿＋リプ）はユーザーごとに一致する。
 * 投稿／リプの内訳とリポスト数の差は仕様変更で説明がつく。
 */
export function compareSkylog(
  oldItems: SkylogCounts[],
  newItems: SkylogCounts[],
  invalidDids: Set<string>,
): SkylogDiff[] {
  const oldMap = new Map(oldItems.map((item) => [item.key, item]));
  const newMap = new Map(newItems.map((item) => [item.key, item]));
  const keys = [...new Set([...oldMap.keys(), ...newMap.keys()])];
  const diffs: SkylogDiff[] = [];
  for (const key of keys) {
    const before = oldMap.get(key) ?? null;
    const after = newMap.get(key) ?? null;
    const mention = (after ?? before)?.mention ?? key;
    if (before && after) {
      const same =
        before.posts === after.posts &&
        before.replies === after.replies &&
        before.reposts === after.reposts;
      if (same) continue;
      let reason: string | null = null;
      if (before.posts + before.replies === after.posts + after.replies) {
        reason =
          before.reposts !== after.reposts
            ? "リポスト時刻基準 / リプライのリポストの扱い"
            : "リプライのリポストの扱い（投稿／リプの内訳のみ）";
      }
      diffs.push({ key, mention, old: before, new: after, reason });
      continue;
    }
    if (after && invalidDids.has(key)) {
      diffs.push({
        key,
        mention,
        old: null,
        new: after,
        reason: "handle.invalid",
      });
      continue;
    }
    diffs.push({ key, mention, old: before, new: after, reason: null });
  }
  return diffs;
}

export interface RankDiff {
  name: string;
  old: number | null;
  new: number | null;
}

export function compareRanking(
  oldItems: RankEntry[],
  newItems: RankEntry[],
): RankDiff[] {
  const oldMap = new Map(oldItems.map((item) => [item.name, item.count]));
  const newMap = new Map(newItems.map((item) => [item.name, item.count]));
  const names = [...new Set([...oldMap.keys(), ...newMap.keys()])];
  return names
    .map((name) => ({
      name,
      old: oldMap.get(name) ?? null,
      new: newMap.get(name) ?? null,
    }))
    .filter((item) => item.old !== item.new);
}

// ---------------------------------------------------------------- fetch

interface FeedResponse {
  feed: {
    post: {
      author: { did: string; handle: string };
      record: { text?: string; createdAt?: string; facets?: Facet[] };
    };
    reason?: unknown;
  }[];
  cursor?: string;
}

interface FollowersResponse {
  followers: { did: string; handle: string; displayName?: string }[];
  cursor?: string;
}

/** 対象日の翌日（JST）以降に Bot が投稿したものを新しい順に遡る。 */
async function fetchBotPosts(
  bot: BotName,
  since: moment.Moment,
  filter: "posts_no_replies" | "posts_with_replies",
): Promise<Post[]> {
  const posts: Post[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_FEED_PAGES; page++) {
    const url = new URL(`${PUBLIC_SERVICE}/xrpc/app.bsky.feed.getAuthorFeed`);
    url.searchParams.set("actor", BOT_HANDLES[bot]);
    url.searchParams.set("filter", filter);
    url.searchParams.set("limit", "100");
    if (cursor) url.searchParams.set("cursor", cursor);
    const { data } = await fetchJson<FeedResponse>(url);
    let reachedOlder = false;
    for (const item of data.feed) {
      if (item.reason) continue;
      if (item.post.author.handle !== BOT_HANDLES[bot]) continue;
      const createdAt = Date.parse(item.post.record.createdAt ?? "");
      if (createdAt < since.valueOf()) {
        reachedOlder = true;
        continue;
      }
      posts.push({
        text: item.post.record.text ?? "",
        facets: item.post.record.facets ?? [],
      });
    }
    if (reachedOlder || !data.cursor) return posts;
    cursor = data.cursor;
  }
  console.error(`warning: ${MAX_FEED_PAGES} ページで打ち切った`);
  return posts;
}

async function fetchFollowers(bot: BotName): Promise<FollowerInfo[]> {
  const followers: FollowerInfo[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_FOLLOWER_PAGES; page++) {
    const url = new URL(`${PUBLIC_SERVICE}/xrpc/app.bsky.graph.getFollowers`);
    url.searchParams.set("actor", BOT_HANDLES[bot]);
    url.searchParams.set("limit", "100");
    if (cursor) url.searchParams.set("cursor", cursor);
    const { data } = await fetchJson<FollowersResponse>(url);
    for (const item of data.followers) {
      followers.push({
        did: item.did,
        handle: item.handle,
        displayName: item.displayName,
      });
    }
    if (!data.cursor) break;
    cursor = data.cursor;
  }
  return followers;
}

// ---------------------------------------------------------------- report

function fmtSkylog(counts: SkylogCounts | null): string {
  if (!counts) return "(なし)";
  return `累計${counts.total} 投稿${counts.posts} リプ${counts.replies} RP${counts.reposts} 非RP${counts.posts + counts.replies}`;
}

function probeCommand(did: string, day: string): string {
  return `node dist/tools/probe.js ${did} ${day.replaceAll("/", "-")}`;
}

async function runSkylog(file: string, day: string, since: moment.Moment) {
  const newItems = readDryRun(readFileSync(file, "utf8"))
    .map((post) => parseSkylogPost(post, day))
    .filter((item): item is SkylogCounts => item !== null);
  const oldItems = (await fetchBotPosts("skylog", since, "posts_with_replies"))
    .map((post) => parseSkylogPost(post, day))
    .filter((item): item is SkylogCounts => item !== null);
  const followers = await fetchFollowers("skylog");
  const invalid = new Set(
    followers
      .filter((item) => item.handle.endsWith(".invalid"))
      .map((item) => item.did),
  );
  const diffs = compareSkylog(oldItems, newItems, invalid);
  console.log(`対象日: ${day}`);
  console.log(
    `GCP(旧): ${oldItems.length} 人  新(dry-run): ${newItems.length} 人  差分: ${diffs.length} 人`,
  );
  const unexplained = diffs.filter((item) => item.reason === null);
  for (const item of diffs.filter((diff) => diff.reason !== null)) {
    console.log(`  [説明済] ${item.mention}  ${item.reason}`);
    console.log(`           旧 ${fmtSkylog(item.old)}`);
    console.log(`           新 ${fmtSkylog(item.new)}`);
  }
  for (const item of unexplained) {
    console.log(`  [要確認] ${item.mention}  (${item.key})`);
    console.log(`           旧 ${fmtSkylog(item.old)}`);
    console.log(`           新 ${fmtSkylog(item.new)}`);
    if (item.key.startsWith("did:")) {
      console.log(`           → ${probeCommand(item.key, day)}`);
    }
  }
  console.log(
    `要確認: ${unexplained.length} 人（上限到達 / 日付境界 / 取得失敗 / 10 件未満の境目 のどれかか probe で確かめる）`,
  );
}

async function runSkyhigh(file: string, day: string, since: moment.Moment) {
  const newRanking = readDryRun(readFileSync(file, "utf8"))
    .map((post) => parseRanking(post.text, day))
    .find((item) => item !== null);
  if (!newRanking) throw new Error(`dry-run に ${day} のランキングが無い`);
  const oldRanking = (await fetchBotPosts("skyhigh", since, "posts_no_replies"))
    .map((post) => parseRanking(post.text, day))
    .find((item) => item !== null);
  if (!oldRanking)
    throw new Error(`GCP の ${day} のランキング投稿が見つからない`);
  const followers = await fetchFollowers("skyhigh");
  console.log(`対象日: ${day}`);
  console.log("順位  旧(GCP)                 新(dry-run)");
  for (
    let index = 0;
    index < Math.max(oldRanking.length, newRanking.length);
    index++
  ) {
    const before = oldRanking[index];
    const after = newRanking[index];
    console.log(
      `${String(index + 1).padStart(2)}    ${before ? `${before.count} ${before.name}` : "-"}  |  ${after ? `${after.count} ${after.name}` : "-"}`,
    );
  }
  const diffs = compareRanking(oldRanking, newRanking);
  for (const item of diffs) {
    // 表示名しか出ないので、フォロワー一覧から did とハンドルを引く。
    // 本文は `${displayName}` なので未設定なら "undefined" になる（旧実装どおり）。
    const matched = followers.filter(
      (follower) => `${follower.displayName}` === item.name,
    );
    console.log(
      `  [要確認] ${item.name}  旧=${item.old ?? "圏外"} 新=${item.new ?? "圏外"}`,
    );
    for (const follower of matched) {
      const note = follower.handle.endsWith(".invalid")
        ? "  ← handle.invalid"
        : "";
      console.log(
        `           ${follower.handle} → ${probeCommand(follower.did, day)}${note}`,
      );
    }
  }
  console.log(
    `要確認: ${diffs.length} 人（handle.invalid / 旧上限 20 ページ / 日付境界 のどれかか probe で確かめる）`,
  );
}

function usage(): void {
  console.error(
    "Usage: node dist/tools/compare-gcp.js <skyhigh|skylog> <dry-run.jsonl> [YYYY-MM-DD(対象日 JST)]",
  );
}

async function main(): Promise<void> {
  const [bot, file, dayArg] = process.argv.slice(2);
  if ((bot !== "skyhigh" && bot !== "skylog") || !file) {
    usage();
    process.exit(1);
  }
  const target = dayArg
    ? moment.tz(dayArg, "YYYY-MM-DD", TIMEZONE)
    : moment().tz(TIMEZONE).subtract(1, "days");
  if (!target.isValid()) throw new Error(`invalid date: ${dayArg}`);
  const day = target.format("YYYY/MM/DD");
  // GCP は対象日の翌日に投稿する。
  const since = target.clone().startOf("day").add(1, "days");
  if (bot === "skylog") await runSkylog(file, day, since);
  else await runSkyhigh(file, day, since);
}

// テストから import したときは実行しない。
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
