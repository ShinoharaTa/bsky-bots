import { nowJst } from "../../core/date.js";
import { getFeed } from "../../core/feed.js";
import { getFollowers } from "../../core/followers.js";
import { notifyError } from "../../core/notify.js";
import type { BotContext, BotDefinition } from "../../core/types.js";
import { countActivity } from "./aggregate.js";
import { formatEnd, formatIntro, formatStart, formatUser } from "./format.js";

const TIME_FORMAT = "YYYY/MM/DD HH:mm:ss";
/** この件数未満の投稿しかないユーザーは投稿しない。 */
const MIN_POSTS = 10;

export const skylog: BotDefinition = {
  name: "skylog",
  defaultHandle: "skylog.bsky.social",
  errorNotifyHandle: "@shino3.bsky.social",
  followersMaxPages: 20,
  feedMaxPages: 15,
  run: async (ctx: BotContext): Promise<void> => {
    const { poster, bounds } = ctx;
    try {
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
        try {
          const items = await getFeed(user.did, bounds, skylog.feedMaxPages, {
            // リポストも数えるので app.bsky.feed.repost も読む。
            includeReposts: true,
          });
          const counts = countActivity(items, bounds);
          if (counts.posts < MIN_POSTS) continue;
          await poster.reply(
            firstPost,
            formatUser(user.handle, bounds.prevDay, counts),
          );
        } catch (ex) {
          // PDS も AppView も駄目だったユーザー。投稿せずログにだけ残す。
          console.error(`skip ${user.did} (${user.handle}): ${ex}`);
        }
        // await sleep(1000);
      }

      time = nowJst().format(TIME_FORMAT);
      await poster.post(formatEnd(time));
    } catch (ex) {
      await notifyError(poster, skylog.errorNotifyHandle);
      console.error(ex);
    }
  },
};
