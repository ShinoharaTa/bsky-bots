import type { Poster } from "./poster.js";

/** エラー時の通知投稿。宛先ハンドルは Bot 設定から渡す。 */
export async function notifyError(
  poster: Poster,
  errorNotifyHandle: string,
): Promise<void> {
  let text = `${errorNotifyHandle} \n`;
  text += "\n";
  text += "エラーが起きて動いてないよっ！！\n";
  text += "助けてーーー（>__<）\n";
  await poster.post(text);
}
