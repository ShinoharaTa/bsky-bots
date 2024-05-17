import { BskyAgent, RichText } from "@atproto/api";
import dotenv from "dotenv";
import moment from "moment-timezone";
dotenv.config();
let self;
const agent = new BskyAgent({ service: "https://bsky.social" });
const prevDay = moment().tz("Asia/Tokyo").subtract(1, "days").startOf("day");
const today = moment().tz("Asia/Tokyo").startOf("day");
const login = async () => {
    try {
        const { success, data } = await agent.login({
            identifier: process.env.AUTHOR ?? "",
            password: process.env.PASSWORD ?? "",
        });
        self = data;
        return success ? data : null;
    }
    catch {
        return null;
    }
};
const post = async (text) => {
    // return await agent.api.app.bsky.feed.post.create(
    //   { repo: self.handle },
    //   {
    //     text: text,
    //     createdAt: new Date().toISOString(),
    //   },
    // );
    console.log(text);
};
const getFollowers = async (user_name) => {
    let cursor = null;
    let users = [];
    for (let index = 0; index < 20; index++) {
        const request = {
            actor: user_name,
            limit: 100,
        };
        if (cursor) {
            request.cursor = cursor;
        }
        const { data } = await agent.api.app.bsky.graph.getFollowers(request);
        console.log(data.followers.length);
        const getUsers = data.followers.map((item) => {
            return {
                handle: item.handle,
                name: item.displayName,
            };
        });
        users = users.concat(getUsers);
        if (data.cursor) {
            cursor = data.cursor;
        }
        else {
            break;
        }
    }
    return users;
};
const getPosts = async (user_name) => {
    let posts = 0;
    let replys = 0;
    let reposts = 0;
    let cursor = null;
    try {
        for (let index = 0; index < 15; index++) {
            const request = {
                actor: user_name,
                limit: 100,
            };
            if (cursor) {
                request.cursor = cursor;
            }
            const { data } = await agent.api.app.bsky.feed.getAuthorFeed(request);
            const filterd = data.feed.filter((item) => {
                const itemDate = moment(item.post.indexedAt).tz("Asia/Tokyo");
                return (itemDate.isSameOrAfter(prevDay) &&
                    itemDate.isBefore(today) &&
                    item.reason?.$type !== "app.bsky.feed.defs#reasonRepost");
            });
            posts += filterd.length;
            const filterdReplys = data.feed.filter((item) => {
                const itemDate = moment(item.post.indexedAt).tz("Asia/Tokyo");
                return (itemDate.isSameOrAfter(prevDay) &&
                    itemDate.isBefore(today) &&
                    !!item.reply);
            });
            replys += filterdReplys.length;
            const filterdReposts = data.feed.filter((item) => {
                const itemDate = moment(item.post.indexedAt).tz("Asia/Tokyo");
                return (itemDate.isSameOrAfter(prevDay) &&
                    itemDate.isBefore(today) &&
                    item.reason?.$type === "app.bsky.feed.defs#reasonRepost");
            });
            reposts += filterdReposts.length;
            if (data.cursor) {
                cursor = data.cursor;
            }
            else {
                break;
            }
            const end = filterd.find((item) => {
                const itemDate = moment(item.post.indexedAt).tz("Asia/Tokyo");
                return (itemDate.isBefore(prevDay) &&
                    item.reason?.$type !== "app.bsky.feed.defs#reasonRepost");
            });
            if (end)
                break;
            // console.log(data);
        }
    }
    catch (ex) {
        console.log(ex);
    }
    return { posts, reposts, replys };
};
const result = await login();
console.log(result);
if (result) {
    try {
        let time = moment().tz("Asia/Tokyo").format("YYYY/MM/DD HH:mm:ss");
        await post(`集計開始：${time}`);
        const users = await getFollowers(process.env.AUTHOR ?? "");
        let text = "ソラログは一日の活動ログをお届けします\n\n";
        text += "1. @skylog.bsky.social をフォローしている\n";
        text += "2. 一日で通常のポストが10件以上\n";
        text += "3. 一日あたり最大1000投稿まで集計します\n";
        text += "4. 感謝のピザを、Shino3に奢ることができる\n";
        const rt = new RichText({ text });
        await rt.detectFacets(agent);
        // const firstPost = await agent.post({
        //   $type: "app.bsky.feed.post",
        //   text: rt.text,
        //   facets: rt.facets,
        // });
        console.log(text);
        for (const user of users) {
            try {
                const { posts, reposts, replys } = await getPosts(user.handle);
                if (posts < 10)
                    continue;
                let text = `@${user.handle}さんの集計データ\n`;
                text += `${prevDay.format("YYYY/MM/DD")}#skylog\n`;
                text += "\n";
                text += `今日の累計　　：${posts + reposts}\n`;
                text += "-------- 内訳 --------\n";
                text += `投稿　　　　　：${posts - replys}\n`;
                text += `リプ　　　　　：${replys}\n`;
                text += `リポスト　　　：${reposts}\n`;
                // console.log(text);
                const rt = new RichText({ text });
                await rt.detectFacets(agent);
                // await agent.post({
                //   $type: "app.bsky.feed.post",
                //   text: rt.text,
                //   facets: rt.facets,
                //   reply: { parent: firstPost, root: firstPost },
                // });
            }
            catch (ex) {
                console.log(ex);
                // let text = `@${user.handle}さんの集計データ\n`;
                // text += `${prevDay.format("YYYY/MM/DD")}#skylog\n`;
                // text += "\n";
                // text += "取得に失敗しました\n";
                // const rt = new RichText({ text });
                // await rt.detectFacets(agent);
                // await agent.post({
                //   $type: "app.bsky.feed.post",
                //   text: rt.text,
                //   facets: rt.facets,
                //   reply: { parent: firstPost, root: firstPost },
                // });
            }
            // await sleep(1000);
        }
        time = moment().tz("Asia/Tokyo").format("YYYY/MM/DD HH:mm:ss");
        post(`集計終了：${time}`);
    }
    catch (ex) {
        console.log(ex);
        let text = "@shino3.bsky.social \n";
        text += "\n";
        text += "エラーが起きて動いてないよっ！！\n";
        text += "助けてーーー（>__<）\n";
        const rt = new RichText({ text });
        await rt.detectFacets(agent);
        // const log = await agent.post({
        //   $type: "app.bsky.feed.post",
        //   text: rt.text,
        //   facets: rt.facets,
        // });
    }
}
//# sourceMappingURL=index.js.map