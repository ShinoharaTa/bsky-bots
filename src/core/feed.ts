import { AppBskyFeedDefs, type AppBskyFeedGetAuthorFeed } from "@atproto/api";
import { PUBLIC_SERVICE } from "./client.js";
import type { DateBounds } from "./date.js";
import { resolvePds } from "./identity.js";
import {
  DEFAULT_RETRY,
  describeError,
  fetchJson,
  type RetryOptions,
} from "./retry.js";

export const POST_COLLECTION = "app.bsky.feed.post";
export const REPOST_COLLECTION = "app.bsky.feed.repost";

/** TID の base32-sortable。rkey はこの 13 文字。 */
const TID_ALPHABET = "234567abcdefghijklmnopqrstuvwxyz";

export type FeedSource = "pds" | "appview";

/**
 * 取得のページ上限。listRecords / getAuthorFeed とも 1 ページ 100 件なので
 * 30 ページ = 3000 投稿。PDS 直読みは rkey で打ち切れるので上限を上げても
 * 実在する分しか取りに行かないが、AppView フォールバックは 1 ページが重く
 * 打ち切りも効きにくいので別の上限を持つ。
 */
export interface FeedLimits {
  /** PDS 直読みのページ上限。 */
  maxPages: number;
  /** AppView フォールバックのページ上限。 */
  fallbackMaxPages: number;
}

/** 集計上限 3000 投稿。フォールバックは据え置きの 20 ページ。 */
export const DEFAULT_FEED_LIMITS: FeedLimits = {
  maxPages: 30,
  fallbackMaxPages: 20,
};

/**
 * 数えるのに必要な情報だけに落とした 1 件。
 * PDS 直読みと AppView フォールバックで同じ形にする。
 */
export interface FeedItem {
  /** 日付判定に使う時刻 (UTC ms)。PDS 経由は rkey(TID)、AppView 経由は createdAt。 */
  timestampMs: number;
  /** AppView 経由のときだけ入る。新旧の基準を比べる probe 用。 */
  indexedAtMs: number | null;
  isRepost: boolean;
  isReply: boolean;
}

/** 取得の内訳。probe が件数以外（ページ数・転送量・打ち切り理由）を出すために返す。 */
export interface FeedFetch {
  items: FeedItem[];
  source: FeedSource;
  /** 投げた HTTP リクエスト数。 */
  requests: number;
  /** レスポンス本文の合計バイト数。 */
  bytes: number;
  /** 取得を止めた理由。 */
  stopped: string;
}

export interface FeedOptions {
  /** リポスト（app.bsky.feed.repost）も数えるか。skylog だけ true。 */
  includeReposts: boolean;
  retry?: RetryOptions;
}

/**
 * rkey (TID) を UTC ミリ秒に戻す。TID はマイクロ秒 + 10bit の clock id。
 * TID でなければ null。
 */
export function decodeTid(rkey: string): number | null {
  if (rkey.length !== 13) return null;
  let value = 0n;
  for (const char of rkey) {
    const index = TID_ALPHABET.indexOf(char);
    if (index < 0) return null;
    value = value * 32n + BigInt(index);
  }
  return Number(value >> 10n) / 1000;
}

/**
 * UTC ミリ秒を TID にする（decodeTid の逆）。listRecords の開始カーソル用。
 * clock id は 0。同じマイクロ秒の TID の中で最小の値になる。
 */
export function encodeTid(timestampMs: number, clockId = 0): string {
  let value = (BigInt(Math.round(timestampMs * 1000)) << 10n) | BigInt(clockId);
  let tid = "";
  for (let index = 0; index < 13; index++) {
    tid = TID_ALPHABET[Number(value % 32n)] + tid;
    value /= 32n;
  }
  return tid;
}

export function isRepost(item: FeedItem): boolean {
  return item.isRepost;
}

export function inDateBounds(item: FeedItem, bounds: DateBounds): boolean {
  return (
    item.timestampMs >= bounds.prevDay.valueOf() &&
    item.timestampMs < bounds.today.valueOf()
  );
}

interface ListRecordsResponse {
  records: { uri: string; value?: { createdAt?: unknown; reply?: unknown } }[];
  cursor?: string;
}

/**
 * PDS の com.atproto.repo.listRecords を直接読む（認証不要）。
 * レコードは rkey の降順で返るので、対象日より古い rkey が出た時点で打ち切る。
 *
 * 初回の cursor は対象日の終端（bounds.today）の TID にする。listRecords は
 * 「cursor の rkey より古いもの」を返すので、当日分を読まずに 1 ページ目から
 * 対象日に入れる。実行時刻（当日分の件数）で結果が変わらなくなる。
 * 境界: cursor は today 00:00:00.000000 で clock id 0 の TID = その時刻の TID の最小値。
 * rkey < cursor はちょうど「timestampMs < today」と同じなので、対象日の最後の
 * 1 件は漏れず、today ちょうど以降の投稿は入らない（cursor 自身も返らない）。
 * rkey が TID でないレコードは rkey の並びでしか位置が決まらないので、
 * cursor より後ろに並ぶものは読まれない（app.bsky.feed.post / repost は TID なので実害は無い）。
 */
export async function scanPdsCollection(
  pds: string,
  did: string,
  collection: string,
  bounds: DateBounds,
  maxPages: number,
  retry: RetryOptions = DEFAULT_RETRY,
): Promise<FeedFetch> {
  const from = bounds.prevDay.valueOf();
  let cursor: string | undefined = encodeTid(bounds.today.valueOf());
  let requests = 0;
  let bytes = 0;
  let stopped = "ページ上限";
  const items: FeedItem[] = [];
  for (let page = 0; page < maxPages; page++) {
    const url = new URL(`${pds}/xrpc/com.atproto.repo.listRecords`);
    url.searchParams.set("repo", did);
    url.searchParams.set("collection", collection);
    url.searchParams.set("limit", "100");
    if (cursor) url.searchParams.set("cursor", cursor);
    const { data, bytes: pageBytes } = await fetchJson<ListRecordsResponse>(
      url,
      retry,
    );
    requests += 1;
    bytes += pageBytes;
    let reachedBoundary = false;
    for (const record of data.records) {
      const rkey = record.uri.split("/").pop() ?? "";
      const createdAt =
        typeof record.value?.createdAt === "string"
          ? Date.parse(record.value.createdAt)
          : Number.NaN;
      // rkey が TID でないレコードだけ createdAt に落とす。
      const timestampMs = decodeTid(rkey) ?? createdAt;
      if (Number.isNaN(timestampMs)) continue;
      if (timestampMs < from) {
        reachedBoundary = true;
        stopped = `rkey が対象日より古くなった (${page + 1}ページ目)`;
        break;
      }
      items.push({
        timestampMs,
        indexedAtMs: null,
        isRepost: collection === REPOST_COLLECTION,
        isReply: !!record.value?.reply,
      });
    }
    if (reachedBoundary) break;
    if (!data.cursor) {
      stopped = "cursor 尽き";
      break;
    }
    cursor = data.cursor;
  }
  return { items, source: "pds", requests, bytes, stopped };
}

/** PDS 直読み。skylog はリポストのコレクションも読む。 */
export async function fetchFromPds(
  did: string,
  bounds: DateBounds,
  maxPages: number,
  options: FeedOptions,
): Promise<FeedFetch> {
  const retry = options.retry ?? DEFAULT_RETRY;
  const pds = await resolvePds(did);
  const collections = options.includeReposts
    ? [POST_COLLECTION, REPOST_COLLECTION]
    : [POST_COLLECTION];
  const results: FeedFetch[] = [];
  for (const collection of collections) {
    results.push(
      await scanPdsCollection(pds, did, collection, bounds, maxPages, retry),
    );
  }
  return {
    items: results.flatMap((result) => result.items),
    source: "pds",
    requests: results.reduce((sum, result) => sum + result.requests, 0),
    bytes: results.reduce((sum, result) => sum + result.bytes, 0),
    stopped: results
      .map((result, index) => `${collections[index]}: ${result.stopped}`)
      .join(" / "),
  };
}

function toFeedItem(item: AppBskyFeedDefs.FeedViewPost): FeedItem | null {
  if (AppBskyFeedDefs.isReasonRepost(item.reason)) {
    // リポストは「いつリポストしたか」で数える。post.indexedAt は元投稿の時刻。
    const timestampMs = Date.parse(item.reason.indexedAt);
    if (Number.isNaN(timestampMs)) return null;
    return {
      timestampMs,
      indexedAtMs: timestampMs,
      isRepost: true,
      isReply: !!item.reply,
    };
  }
  const record = item.post.record as { createdAt?: unknown } | undefined;
  const createdAtMs =
    typeof record?.createdAt === "string"
      ? Date.parse(record.createdAt)
      : Number.NaN;
  const indexedAtMs = Date.parse(item.post.indexedAt);
  // PDS 直読みと基準を揃えるため createdAt を使う。無ければ indexedAt。
  const timestampMs = Number.isNaN(createdAtMs) ? indexedAtMs : createdAtMs;
  if (Number.isNaN(timestampMs)) return null;
  return {
    timestampMs,
    indexedAtMs: Number.isNaN(indexedAtMs) ? null : indexedAtMs,
    isRepost: false,
    isReply: !!item.reply,
  };
}

/**
 * AppView (app.bsky.feed.getAuthorFeed) 経由。PDS が落ちているときの退避路。
 * 認証不要の公開エンドポイントを使う。
 *
 * getAuthorFeed の cursor は PDS の rkey ではないので、PDS 直読みのように
 * 対象日の終端から読み始めることはできない。当日分も先頭から読むので、
 * 多投稿ユーザーは fallbackMaxPages（20 ページ）に当たると対象日に届かないことがある。
 */
export async function fetchFromAppView(
  did: string,
  bounds: DateBounds,
  maxPages: number,
  options: FeedOptions,
): Promise<FeedFetch> {
  const retry = options.retry ?? DEFAULT_RETRY;
  const from = bounds.prevDay.valueOf();
  let cursor: string | undefined;
  let requests = 0;
  let bytes = 0;
  let stopped = "ページ上限";
  const items: FeedItem[] = [];
  for (let page = 0; page < maxPages; page++) {
    const url = new URL(`${PUBLIC_SERVICE}/xrpc/app.bsky.feed.getAuthorFeed`);
    url.searchParams.set("actor", did);
    url.searchParams.set("limit", "100");
    if (cursor) url.searchParams.set("cursor", cursor);
    const { data, bytes: pageBytes } =
      await fetchJson<AppBskyFeedGetAuthorFeed.OutputSchema>(url, retry);
    requests += 1;
    bytes += pageBytes;
    const pageItems = data.feed
      .map(toFeedItem)
      .filter((item): item is FeedItem => item !== null);
    items.push(...pageItems);
    if (!data.cursor) {
      stopped = "cursor 尽き";
      break;
    }
    cursor = data.cursor;
    // 打ち切り。ページ内の並びを信用せず、最後の 1 件が対象日より古いときだけ止める。
    const last = pageItems.at(-1);
    if (last && last.timestampMs < from) {
      stopped = `対象日より古くなった (${page + 1}ページ目)`;
      break;
    }
  }
  return { items, source: "appview", requests, bytes, stopped };
}

/**
 * PDS 直読み → 失敗したら AppView。どちらも失敗したら投げる。
 * 呼び出し側（Bot）はそのユーザーだけスキップしてログに残すこと。
 */
export async function fetchFeed(
  did: string,
  bounds: DateBounds,
  limits: FeedLimits,
  options: FeedOptions,
): Promise<FeedFetch> {
  try {
    return await fetchFromPds(did, bounds, limits.maxPages, options);
  } catch (ex) {
    console.error(
      `pds read failed, falling back to appview: ${did}: ${describeError(ex)}`,
    );
  }
  return await fetchFromAppView(did, bounds, limits.fallbackMaxPages, options);
}

/** 数えるのは Bot 側（aggregate.ts）。取得した全件をそのまま返す。 */
export async function getFeed(
  did: string,
  bounds: DateBounds,
  limits: FeedLimits,
  options: FeedOptions,
): Promise<FeedItem[]> {
  const { items } = await fetchFeed(did, bounds, limits, options);
  return items;
}
