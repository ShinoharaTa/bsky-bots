/**
 * ログ行の整形と伏字。
 * 子の行は伏字だけ適用してそのまま流す。スケジューラ自身の行は
 * `[scheduler] <msg> key=value ...` の形にする。
 */

const JWT_PATTERN = /eyJ[\w-]+\.[\w-]+\.[\w-]+/g;
const REDACTED = "<redacted>";

export type Redactor = (text: string) => string;

/** secrets の値と JWT 形式の文字列を `<redacted>` に置き換える関数を作る。 */
export function createRedactor(secrets: readonly string[]): Redactor {
  // 長いものから置き換える（短い値が長い値の一部だった場合に取りこぼさない）。
  const values = [...new Set(secrets.filter((value) => value !== ""))].sort(
    (a, b) => b.length - a.length,
  );
  return (text) => {
    let result = text;
    for (const value of values) result = result.split(value).join(REDACTED);
    return result.replace(JWT_PATTERN, REDACTED);
  };
}

export type Fields = Record<string, string | number | boolean | null>;

/** `[scheduler] <msg> key=value ...`。null は `none` にする。 */
export function formatSchedulerLine(msg: string, fields: Fields = {}): string {
  const parts = [`[scheduler] ${msg}`];
  for (const [key, value] of Object.entries(fields)) {
    parts.push(`${key}=${value ?? "none"}`);
  }
  return parts.join(" ");
}
