import { pathToFileURL } from "node:url";
import { readState } from "./state.js";

/**
 * Docker の HEALTHCHECK から呼ばれる。exit 0 = healthy。
 * 状態ファイルが読めて、90 秒以内に書かれていて、ready なら healthy。
 */

/** 状態ファイルの書き込み間隔（30 秒）の 3 回分。 */
export const MAX_AGE_MS = 90_000;

export function checkHealth(stateDir: string, now: number): boolean {
  const state = readState(stateDir);
  if (!state || typeof state.ts !== "number") return false;
  return now - state.ts < MAX_AGE_MS && state.ready === true;
}

// テストから import したときは実行しない。
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = checkHealth(process.env.STATE_DIR || "/data", Date.now())
    ? 0
    : 1;
}
