import { DEFAULT_ABORT_POLICY, FailureTracker } from "../../core/abort.js";
import { nowJst } from "../../core/date.js";
import { DEFAULT_FEED_LIMITS, fetchFeed } from "../../core/feed.js";
import { getFollowers } from "../../core/followers.js";
import { describeError } from "../../core/retry.js";
import { guardRun } from "../../core/run.js";
import type { BotContext, BotDefinition } from "../../core/types.js";
import { type ActivityCounts, countActivity } from "./aggregate.js";
import { formatEnd, formatIntro, formatStart, formatUser } from "./format.js";

const TIME_FORMAT = "YYYY/MM/DD HH:mm:ss";
/** この件数未満の投稿しかないユーザーは投稿しない。 */
const MIN_POSTS = 10;

export const skylog: BotDefinition = {
  name: "skylog",
  defaultHandle: "skylog.bsky.social",
  errorNotifyHandle: "@shino3.net",
  followersMaxPages: 20,
  feedLimits: DEFAULT_FEED_LIMITS,
  abortPolicy: DEFAULT_ABORT_POLICY,
  run: async (ctx: BotContext): Promise<void> => {
    const { poster, bounds } = ctx;
    const tracker = new FailureTracker(skylog.abortPolicy);
    await guardRun(
      {
        bot: skylog.name,
        poster,
        errorNotifyHandle: skylog.errorNotifyHandle,
        tracker,
      },
      async () => {
        let time = nowJst().format(TIME_FORMAT);
        await poster.post(formatStart(time));
        const users = await getFollowers(
          ctx.agent,
          ctx.actor,
          skylog.followersMaxPages,
          ctx.limitFollowers,
        );

        const firstPost = await poster.post(formatIntro());

        for (const user of users) {
          // 取得と集計だけを try で包む。返信の失敗は投稿失敗として別に数える。
          let counts: ActivityCounts;
          try {
            const { items, source } = await fetchFeed(
              user.did,
              bounds,
              skylog.feedLimits,
              {
                // リポストも数えるので app.bsky.feed.repost も読む。
                includeReposts: true,
              },
            );
            counts = countActivity(items, bounds);
            tracker.recordFetchSuccess(source === "appview");
          } catch (ex) {
            // PDS も AppView も駄目だったユーザー。投稿せずログにだけ残す。
            console.error(
              `skip ${user.did} (${user.handle}): ${describeError(ex)}`,
            );
            // 停止条件に当たったらここで投げる（以降の返信・集計終了は出さない）。
            tracker.recordFetchFailure();
            continue;
          }
          if (counts.posts < MIN_POSTS) continue;
          try {
            await poster.reply(
              firstPost,
              formatUser(user, bounds.prevDay, counts),
            );
          } catch (ex) {
            console.error(
              `reply failed ${user.did} (${user.handle}): ${describeError(ex)}`,
            );
            // 連続して失敗したらここで投げる。
            tracker.recordPostFailure();
            continue;
          }
          tracker.recordPostSuccess();
          // await sleep(1000);
        }
        // 全員の取得に失敗したら集計終了を投稿せずに止める。
        // 閾値未満で返信しなかった人も取得には成功しているので成功に数える。
        tracker.assertAnyFetched();

        time = nowJst().format(TIME_FORMAT);
        await poster.post(formatEnd(time));
      },
    );
  },
};
