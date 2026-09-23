import { DEFAULT_ABORT_POLICY, FailureTracker } from "../../core/abort.js";
import { nowJst } from "../../core/date.js";
import { DEFAULT_FEED_LIMITS, fetchFeed } from "../../core/feed.js";
import { type Follower, getFollowers } from "../../core/followers.js";
import { describeError } from "../../core/retry.js";
import { guardRun } from "../../core/run.js";
import type { BotContext, BotDefinition } from "../../core/types.js";
import { countPosts } from "./aggregate.js";
import {
  formatEnd,
  formatNotice,
  formatRanking,
  formatStart,
  type UserPosts,
} from "./format.js";

const TIME_FORMAT = "YYYY/MM/DD HH:mm:ss";

const getUserPosts = async (
  ctx: BotContext,
  user: Follower,
  tracker: FailureTracker,
): Promise<UserPosts | null> => {
  let posts: number;
  let fallback: boolean;
  try {
    const { items, source } = await fetchFeed(
      user.did,
      ctx.bounds,
      skyhigh.feedLimits,
      {
        // app.bsky.feed.post にリポストは入らないので読む必要が無い。
        includeReposts: false,
      },
    );
    posts = countPosts(items, ctx.bounds);
    fallback = source === "appview";
  } catch (ex) {
    // PDS も AppView も駄目だったユーザー。集計から外してログにだけ残す。
    console.error(`skip ${user.did} (${user.handle}): ${describeError(ex)}`);
    // 停止条件に当たったらここで投げる（ランキングは投稿しない）。
    tracker.recordFetchFailure();
    return null;
  }
  tracker.recordFetchSuccess(fallback);
  return {
    name: user.name,
    handle: user.handle ?? "",
    posts: posts,
  };
};

export const skyhigh: BotDefinition = {
  name: "skyhigh",
  defaultHandle: "skyhigh.bsky.social",
  errorNotifyHandle: "@shino3.net",
  followersMaxPages: 20,
  feedLimits: DEFAULT_FEED_LIMITS,
  abortPolicy: DEFAULT_ABORT_POLICY,
  run: async (ctx: BotContext): Promise<void> => {
    const { poster, bounds } = ctx;
    const tracker = new FailureTracker(skyhigh.abortPolicy);
    await guardRun(
      {
        bot: skyhigh.name,
        poster,
        errorNotifyHandle: skyhigh.errorNotifyHandle,
        tracker,
      },
      async () => {
        let time = nowJst().format(TIME_FORMAT);
        const users = await getFollowers(
          ctx.agent,
          ctx.actor,
          skyhigh.followersMaxPages,
          ctx.limitFollowers,
        );
        await poster.post(formatStart(time, users.length));
        const posts: UserPosts[] = [];

        // 全員分を取得してからランキングを投稿する。
        // アボートはこのループの中で投げるので、ランキング投稿より前に効く。
        for (const user of users) {
          const userPosts = await getUserPosts(ctx, user, tracker);
          if (userPosts) posts.push(userPosts);
        }
        const sorted = posts
          .filter((item) => item.posts !== 0)
          .sort((a, b) => b.posts - a.posts);
        await poster.post(formatRanking(sorted, bounds.prevDay));

        // 投稿後の定型文投稿
        await poster.post(formatNotice());

        time = nowJst().format(TIME_FORMAT);
        await poster.post(formatEnd(time));

        const missing = posts.filter((item) => item.posts === 0);
        console.error(missing);
      },
    );
  },
};
