/** 本文に書いても解決されないハンドル。did ベース化で集計対象に入ってくる。 */
export function isResolvableHandle(handle: string): boolean {
  return handle.length > 0 && !handle.endsWith(".invalid");
}

/**
 * 見える文字が残るか。空白と制御文字しか無い displayName が実在する
 * （did:plc:u2422q7nqnd3x3mn4ed56uxx は U+0081 の 1 文字だけ）。
 */
export function hasVisibleText(text: string): boolean {
  return text.replace(/[\p{C}\p{Z}]/gu, "").length > 0;
}
