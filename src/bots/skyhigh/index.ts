import { nowJst } from "../../core/date.js";
import { getFeed } from "../../core/feed.js";
import { type Follower, getFollowers } from "../../core/followers.js";
import { notifyError } from "../../core/notify.js";
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
): Promise<UserPosts | null> => {
  let posts: number;
  try {
    const items = await getFeed(user.did, ctx.bounds, skyhigh.feedMaxPages, {
      // app.bsky.feed.post にリポストは入らないので読む必要が無い。
      includeReposts: false,
    });
    posts = countPosts(items, ctx.bounds);
  } catch (ex) {
    // PDS も AppView も駄目だったユーザー。集計から外してログにだけ残す。
    console.error(`skip ${user.did} (${user.handle}): ${ex}`);
    return null;
  }
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
  feedMaxPages: 20,
  run: async (ctx: BotContext): Promise<void> => {
    const { poster, bounds } = ctx;
    try {
      let time = nowJst().format(TIME_FORMAT);
      const users = await getFollowers(
        ctx.agent,
        ctx.actor,
        skyhigh.followersMaxPages,
        ctx.limitFollowers,
      );
      await poster.post(formatStart(time, users.length));
      const posts: UserPosts[] = [];

      for (const user of users) {
        const userPosts = await getUserPosts(ctx, user);
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
    } catch (ex) {
      await notifyError(poster, skyhigh.errorNotifyHandle);
      console.error(ex);
    }
  },
};
