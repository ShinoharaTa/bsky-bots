/**
 * スケジューラが起動するジョブの定義。
 * cron は常に Asia/Tokyo で読む（サーバーの TZ は UTC。TZ 環境変数には頼らない）。
 */
export const JOB_TIMEZONE = "Asia/Tokyo";

export interface JobDefinition {
  /** dist/main.js に渡す Bot 名。 */
  name: string;
  cron: string;
  /** 起点からの遅延の上限（秒）。0〜この値の一様乱数だけ遅らせる。 */
  jitterSec: number;
  /** これを過ぎたら SIGTERM（秒）。 */
  timeoutSec: number;
  /** 失敗を Discord に知らせるか。 */
  discord: boolean;
}

export const JOBS: readonly JobDefinition[] = [
  {
    name: "skyhigh",
    cron: "45 8 * * *",
    jitterSec: 0,
    timeoutSec: 1800,
    discord: true,
  },
  {
    name: "skylog",
    cron: "20 0 * * *",
    jitterSec: 0,
    timeoutSec: 3600,
    discord: true,
  },
  // 時報は欠けても埋めないので通知しない（systemd 版と同じ）。
  {
    name: "jiho",
    cron: "27,57 * * * *",
    jitterSec: 360,
    timeoutSec: 600,
    discord: false,
  },
];
