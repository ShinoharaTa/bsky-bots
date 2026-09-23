import type { AtpAgent } from "@atproto/api";
import { describe, expect, it } from "vitest";
import { getFollowers } from "./followers.js";

/** getFollowers だけを差し替えた agent。pages を順に返す。 */
function agentOf(pages: string[][]): AtpAgent {
  return {
    app: {
      bsky: {
        graph: {
          getFollowers: async ({ cursor }: { cursor?: string }) => {
            const index = cursor ? Number(cursor) : 0;
            return {
              data: {
                followers: pages[index].map((did) => ({
                  did,
                  handle: `${did.slice(8)}.bsky.social`,
                })),
                cursor:
                  index + 1 < pages.length ? String(index + 1) : undefined,
              },
            };
          },
        },
      },
    },
  } as unknown as AtpAgent;
}

describe("getFollowers", () => {
  it("ページをまたいで同じ did が出ても 1 人として数える", async () => {
    // 2 ページ目の取得前にフォロワーが増え、b がずれて 2 回出たケース。
    const agent = agentOf([
      ["did:plc:a", "did:plc:b"],
      ["did:plc:b", "did:plc:c"],
    ]);
    const users = await getFollowers(agent, "actor", 20);
    expect(users.map((user) => user.did)).toEqual([
      "did:plc:a",
      "did:plc:b",
      "did:plc:c",
    ]);
  });

  it("limit は重複を除いた人数で数える", async () => {
    const agent = agentOf([
      ["did:plc:a", "did:plc:a", "did:plc:b"],
      ["did:plc:b", "did:plc:c", "did:plc:d"],
    ]);
    const users = await getFollowers(agent, "actor", 20, 3);
    expect(users.map((user) => user.did)).toEqual([
      "did:plc:a",
      "did:plc:b",
      "did:plc:c",
    ]);
  });
});
