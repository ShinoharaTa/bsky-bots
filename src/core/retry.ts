/**
 * 任意ホスト（各ユーザーの PDS）に繋ぐので、リトライは控えめにする。
 * 相手は個人のセルフホストであることもある。連打しない。
 */
export interface RetryOptions {
  /** 最大リトライ回数（初回試行は含まない）。 */
  maxRetries: number;
  /** 最初の待ち時間 (ms)。以降 2 倍ずつ伸ばす。 */
  baseDelayMs: number;
  /** 待ち時間の上限 (ms)。Retry-After もここで頭打ちにする。 */
  maxDelayMs: number;
  /** 1 リクエストあたりのタイムアウト (ms)。 */
  timeoutMs: number;
}

export const DEFAULT_RETRY: RetryOptions = {
  maxRetries: 2,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  timeoutMs: 10000,
};

/** HTTP のステータスを持ったまま投げるためのエラー。 */
export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, url: string, body: string) {
    super(`${status} ${body.slice(0, 200)} <- ${url}`);
    this.name = "HttpError";
    this.status = status;
  }
}

export interface FetchResult {
  status: number;
  body: string;
}

/**
 * ログ用に例外を 1 行にする。fetch の TypeError は cause を見ないと
 * 理由（TLS 失敗・名前解決失敗）が分からない。
 */
export function describeError(ex: unknown): string {
  if (!(ex instanceof Error)) return String(ex);
  const cause = ex.cause;
  if (cause instanceof Error) {
    const code = (cause as NodeJS.ErrnoException).code;
    return `${ex.message}: ${code ? `${code} ` : ""}${cause.message}`;
  }
  return ex.message;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 429 / 5xx だけリトライする。4xx はリトライしても結果が変わらない。 */
function isRetriableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * Retry-After を ms に直す。秒数形式と HTTP-date 形式の両方。
 * 解釈できなければ null（指数バックオフに任せる）。
 */
export function parseRetryAfter(
  header: string | null,
  now: number = Date.now(),
): number | null {
  if (!header) return null;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds)) {
    return seconds > 0 ? seconds * 1000 : 0;
  }
  const date = Date.parse(header);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - now);
}

/**
 * fetch + タイムアウト + 指数バックオフ。
 * 2xx 以外は HttpError、通信そのものが失敗したら元の例外を投げる。
 * 本文を文字列で返すのは、呼び出し側で転送量を数えたいため（probe 用）。
 */
export async function fetchWithRetry(
  url: string | URL,
  options: RetryOptions = DEFAULT_RETRY,
): Promise<FetchResult> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
    // 指数バックオフ。Retry-After が来ていればそちらを優先する。
    let wait = Math.min(options.baseDelayMs * 2 ** attempt, options.maxDelayMs);
    let response: Response;
    try {
      response = await fetch(url, {
        signal: AbortSignal.timeout(options.timeoutMs),
      });
      if (response.ok) {
        return { status: response.status, body: await response.text() };
      }
      const body = await response.text();
      const error = new HttpError(response.status, String(url), body);
      if (!isRetriableStatus(response.status)) throw error;
      lastError = error;
      const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
      if (retryAfter !== null) wait = Math.min(retryAfter, options.maxDelayMs);
    } catch (ex) {
      // TLS ハンドシェイク失敗・名前解決失敗・タイムアウトなど。
      if (ex instanceof HttpError && !isRetriableStatus(ex.status)) throw ex;
      lastError = ex;
    }
    if (attempt < options.maxRetries) await sleep(wait);
  }
  throw lastError;
}

/** fetchWithRetry + JSON パース。転送量も返す。 */
export async function fetchJson<T>(
  url: string | URL,
  options: RetryOptions = DEFAULT_RETRY,
): Promise<{ data: T; bytes: number }> {
  const { body } = await fetchWithRetry(url, options);
  return { data: JSON.parse(body) as T, bytes: body.length };
}

/** 投稿のリトライ設定。タイムアウトは @atproto/api 側に任せる。 */
export type PostRetryOptions = Omit<RetryOptions, "timeoutMs">;

/**
 * 投稿（createRecord）のリトライ。429 のときだけ最大 2 回。
 * 5xx はリトライしない。サーバ側では受理済みでレスポンスだけ落ちたのかもしれず、
 * 投げ直すと同じ内容を二重投稿してしまう。429 は受理前に弾かれているので安全。
 */
export const POST_RETRY: PostRetryOptions = {
  maxRetries: 2,
  baseDelayMs: 1000,
  maxDelayMs: 60000,
};

/**
 * 429 なら Retry-After ヘッダ（無ければ null）、429 以外なら undefined。
 * @atproto/api は status と headers を持った XRPCError を投げる。
 */
function retryAfterOf(ex: unknown): string | null | undefined {
  if (!(ex instanceof Error)) return undefined;
  const { status, headers } = ex as Error & {
    status?: unknown;
    headers?: Record<string, string | undefined>;
  };
  if (status !== 429) return undefined;
  return headers?.["retry-after"] ?? null;
}

/** fn を実行し、429 のときだけ Retry-After（無ければ指数バックオフ）を待って投げ直す。 */
export async function retryOnRateLimit<T>(
  fn: () => Promise<T>,
  options: PostRetryOptions = POST_RETRY,
  wait: (ms: number) => Promise<void> = sleep,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (ex) {
      const retryAfter = retryAfterOf(ex);
      if (retryAfter === undefined || attempt >= options.maxRetries) throw ex;
      const backoff = options.baseDelayMs * 2 ** attempt;
      const delay = Math.min(
        parseRetryAfter(retryAfter) ?? backoff,
        options.maxDelayMs,
      );
      console.error(`post rate limited, retrying in ${delay}ms`);
      await wait(delay);
    }
  }
}
