import moment from "moment-timezone";
import { type DateBounds, TIMEZONE } from "../core/date.js";
import {
  DEFAULT_FEED_LIMITS,
  type FeedFetch,
  type FeedItem,
  fetchFromAppView,
  inDateBounds,
  POST_COLLECTION,
  REPOST_COLLECTION,
  scanPdsCollection,
} from "../core/feed.js";
import { fetchDidDocument, resolvePds, toDid } from "../core/identity.js";
import { describeError } from "../core/retry.js";

/**
 * 読み取り専用の検証ツール。投稿処理は持たない。
 * usage: node dist/tools/probe.js <handle|did> [YYYY-MM-DD(JST, 既定=前日)]
 */
const TIME_FORMAT = "YYYY/MM/DD HH:mm:ss";

function usage(): void {
  console.error(
    "Usage: node dist/tools/probe.js <handle|did> [YYYY-MM-DD(JST)]",
  );
}

/** 対象日（JST）の 00:00 以上 翌 00:00 未満。 */
function boundsForDay(day: string | undefined): DateBounds {
  const base = day
    ? moment.tz(day, "YYYY-MM-DD", TIMEZONE)
    : moment().tz(TIMEZONE).subtract(1, "days");
  if (!base.isValid()) throw new Error(`invalid date: ${day}`);
  const prevDay = base.clone().startOf("day");
  return { prevDay, today: prevDay.clone().add(1, "days") };
}

function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)}KB`;
}

function inBounds(fetched: FeedFetch, bounds: DateBounds): FeedItem[] {
  return fetched.items.filter((item) => inDateBounds(item, bounds));
}

/** indexedAt を基準にした件数。現行実装の基準との差を見るため。 */
function countByIndexedAt(fetched: FeedFetch, bounds: DateBounds): number {
  return fetched.items.filter(
    (item) =>
      !item.isRepost &&
      item.indexedAtMs !== null &&
      item.indexedAtMs >= bounds.prevDay.valueOf() &&
      item.indexedAtMs < bounds.today.valueOf(),
  ).length;
}

async function main(): Promise<void> {
  const actor = process.argv[2];
  if (!actor || actor.startsWith("-")) {
    usage();
    process.exit(1);
  }
  const bounds = boundsForDay(process.argv[3]);
  console.log(
    `対象日(JST): ${bounds.prevDay.format(TIME_FORMAT)} 〜 ${bounds.today.format(TIME_FORMAT)}`,
  );

  const did = await toDid(actor);
  console.log(`did = ${did}`);
  let pds: string | null = null;
  try {
    pds = await resolvePds(did);
    const doc = await fetchDidDocument(did);
    console.log(`pds = ${pds}   (aka ${doc.alsoKnownAs?.join(",") ?? "-"})`);
  } catch (ex) {
    console.log(`pds = (解決できず) ${describeError(ex)}`);
  }

  console.log("\n--- PDS 直読み (com.atproto.repo.listRecords) ---");
  let pdsPosts: FeedFetch | null = null;
  let pdsReposts: FeedFetch | null = null;
  if (pds) {
    for (const collection of [POST_COLLECTION, REPOST_COLLECTION]) {
      try {
        const fetched = await scanPdsCollection(
          pds,
          did,
          collection,
          bounds,
          DEFAULT_FEED_LIMITS.maxPages,
        );
        if (collection === POST_COLLECTION) pdsPosts = fetched;
        else pdsReposts = fetched;
        const hit = inBounds(fetched, bounds);
        const replies = hit.filter((item) => item.isReply).length;
        console.log(
          `${collection.padEnd(20)}: ${hit.length} 件  (${fetched.requests}リクエスト / ${kb(fetched.bytes)})  打ち切り: ${fetched.stopped}`,
        );
        if (collection === POST_COLLECTION) {
          console.log(`  └ うちリプライ     : ${replies}`);
          console.log(`  └ 通常ポスト       : ${hit.length - replies}`);
        }
      } catch (ex) {
        console.log(`${collection.padEnd(20)}: 失敗 ${describeError(ex)}`);
      }
    }
  }
  if (!pdsPosts) {
    console.log("→ PDS からは取得できなかった。AppView へフォールバックする。");
  }

  console.log("\n--- AppView (app.bsky.feed.getAuthorFeed) ---");
  let appView: FeedFetch | null = null;
  try {
    appView = await fetchFromAppView(
      did,
      bounds,
      DEFAULT_FEED_LIMITS.fallbackMaxPages,
      {
        includeReposts: true,
      },
    );
    const hit = inBounds(appView, bounds);
    const posts = hit.filter((item) => !item.isRepost);
    const reposts = hit.length - posts.length;
    console.log(
      `非リポスト: ${posts.length} 件   リポスト: ${reposts} 件  (${appView.requests}リクエスト / ${kb(appView.bytes)})  打ち切り: ${appView.stopped}`,
    );
    console.log(`  createdAt 基準 : ${posts.length} 件`);
    console.log(
      `  indexedAt 基準 : ${countByIndexedAt(appView, bounds)} 件   ← 現行実装の基準`,
    );
  } catch (ex) {
    console.log(`失敗 ${describeError(ex)}`);
  }

  console.log("\n--- 差分 ---");
  const pdsCount = pdsPosts ? inBounds(pdsPosts, bounds).length : null;
  const appViewCount = appView
    ? inBounds(appView, bounds).filter((item) => !item.isRepost).length
    : null;
  const indexedCount = appView ? countByIndexedAt(appView, bounds) : null;
  if (pdsCount === null || appViewCount === null) {
    console.log(
      `非リポスト: PDS=${pdsCount ?? "取得失敗"}  AppView=${appViewCount ?? "取得失敗"}  → 比較できず`,
    );
  } else {
    const diff = pdsCount - appViewCount;
    console.log(
      `非リポスト: PDS=${pdsCount}  AppView(createdAt)=${appViewCount}  → ${diff === 0 ? "一致" : `★不一致 ${diff > 0 ? "+" : ""}${diff}`}`,
    );
    console.log(
      `現行基準比: PDS=${pdsCount}  AppView(indexedAt)=${indexedCount}  → ${
        pdsCount === indexedCount
          ? "一致"
          : `★不一致 ${pdsCount - (indexedCount ?? 0) > 0 ? "+" : ""}${pdsCount - (indexedCount ?? 0)}`
      }`,
    );
  }
  const pdsRequests =
    (pdsPosts?.requests ?? 0) + (pdsReposts?.requests ?? 0) || null;
  const pdsBytes = (pdsPosts?.bytes ?? 0) + (pdsReposts?.bytes ?? 0);
  console.log(
    `リクエスト数: PDS=${pdsRequests ?? "-"}  AppView=${appView?.requests ?? "-"}`,
  );
  console.log(
    `転送量:       PDS=${pdsRequests ? kb(pdsBytes) : "-"}  AppView=${appView ? kb(appView.bytes) : "-"}`,
  );
}

await main();
