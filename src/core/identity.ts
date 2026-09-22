import { PUBLIC_SERVICE } from "./client.js";
import { DEFAULT_RETRY, fetchJson } from "./retry.js";

const PLC_DIRECTORY = "https://plc.directory";
const PDS_SERVICE_TYPE = "AtprotoPersonalDataServer";

/** plc.directory / did:web の DID ドキュメントのうち、使う部分だけ。 */
export interface DidDocument {
  alsoKnownAs?: string[];
  service?: { id?: string; type?: string; serviceEndpoint?: string }[];
}

/**
 * did -> PDS エンドポイントのプロセス内キャッシュ。
 * フォロワー数ぶん plc.directory を叩くので、同じ did は一度しか引かない。
 * 失敗も含めてキャッシュする（one-shot 実行なので再試行は次回起動に任せる）。
 */
const pdsCache = new Map<string, Promise<string>>();

/** did:web:example.com -> https://example.com/.well-known/did.json */
function didWebUrl(did: string): string {
  const rest = did.slice("did:web:".length);
  if (!rest) throw new Error(`invalid did:web: ${did}`);
  const [host, ...path] = rest.split(":");
  const decodedHost = decodeURIComponent(host);
  if (path.length === 0) {
    return `https://${decodedHost}/.well-known/did.json`;
  }
  return `https://${decodedHost}/${path.map(decodeURIComponent).join("/")}/did.json`;
}

function didDocumentUrl(did: string): string {
  // plc.directory が引けるのは did:plc: だけ。did:web: は本人のホストに聞く。
  if (did.startsWith("did:plc:")) return `${PLC_DIRECTORY}/${did}`;
  if (did.startsWith("did:web:")) return didWebUrl(did);
  throw new Error(`unsupported did method: ${did}`);
}

function pickPdsEndpoint(doc: DidDocument, did: string): string {
  const endpoint = doc.service?.find(
    (item) => item.type === PDS_SERVICE_TYPE,
  )?.serviceEndpoint;
  if (!endpoint) throw new Error(`no ${PDS_SERVICE_TYPE} in did doc: ${did}`);
  // 末尾のスラッシュを落としておく。xrpc のパスを繋ぐときに // にならないように。
  return endpoint.replace(/\/+$/, "");
}

/** did -> PDS エンドポイント。解決できなければ投げる。 */
export function resolvePds(did: string): Promise<string> {
  const cached = pdsCache.get(did);
  if (cached) return cached;
  const resolving = (async () => {
    const { data } = await fetchJson<DidDocument>(didDocumentUrl(did));
    return pickPdsEndpoint(data, did);
  })();
  pdsCache.set(did, resolving);
  return resolving;
}

/** handle -> did。probe が handle を受け取れるようにするためだけに使う。 */
export async function resolveHandle(handle: string): Promise<string> {
  const url = new URL(
    `${PUBLIC_SERVICE}/xrpc/com.atproto.identity.resolveHandle`,
  );
  url.searchParams.set("handle", handle);
  const { data } = await fetchJson<{ did: string }>(url, DEFAULT_RETRY);
  return data.did;
}

/** did:... ならそのまま、そうでなければハンドルとして解決する。 */
export async function toDid(actor: string): Promise<string> {
  return actor.startsWith("did:") ? actor : await resolveHandle(actor);
}

/** DID ドキュメント全体が要るのは probe の表示だけ。 */
export async function fetchDidDocument(did: string): Promise<DidDocument> {
  const { data } = await fetchJson<DidDocument>(didDocumentUrl(did));
  return data;
}
