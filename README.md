# bsky-bots

Bluesky の日次集計 Bot をまとめたリポジトリ。

| Bot | アカウント | 内容 |
| --- | --- | --- |
| skyhigh | [@skyhigh.bsky.social](https://bsky.app/profile/skyhigh.bsky.social) | フォロワーの前日投稿数ランキングを毎日投稿する |
| skylog | [@skylog.bsky.social](https://bsky.app/profile/skylog.bsky.social) | フォロワーごとの前日の活動ログ（投稿 / リプ / リポスト）を毎日投稿する |

もとは `ShinoharaTa/bsky-skyhigh` と `ShinoharaTa/bsky-skylog` の 2 リポジトリだった。
どちらもコードの大半が同一だったため、共通部分を 1 箇所にまとめるために統合した。
旧リポジトリの履歴は `legacy/` 以下に subtree として取り込んである。

## 使い方

```bash
npm install
npm run build

# dry-run（既定）。ログインせず、投稿する内容を stdout に JSON Lines で出す
node dist/main.js skyhigh
node dist/main.js skylog

# フォロワーを先頭 N 人に絞って試す
node dist/main.js skylog --limit-followers=3

# 実際に投稿する（.env の認証情報が必要）
node dist/main.js skyhigh --live
```

- **既定は dry-run。`--live` を明示したときだけ投稿する。**
- dry-run は**ログインしない**。読み取り（`getFollowers` / `getAuthorFeed`）は
  `https://public.api.bsky.app` の公開エンドポイントを使う。`--live` のときだけ
  `https://bsky.social` に login する。
- dry-run の出力は 1 行 1 JSON。`{"seq","kind","text","langs","replyTo","facets","createdAt"}`。
  `createdAt` は実行のたびに変わるので新旧の diff 対象から外すこと。
- 進捗・エラーなどのログは stderr に出す（stdout を JSON Lines 専用にするため）。

認証情報は `.env`（`.env.sample` を参照）。Bot ごとに
`SKYHIGH_IDENTIFIER` / `SKYHIGH_APP_PASSWORD` / `SKYLOG_IDENTIFIER` / `SKYLOG_APP_PASSWORD`。
**`AUTHOR` / `PASSWORD` へのフォールバックは持たない**（2 Bot が 1 つの .env を共有するため、
片方の認証情報でもう片方が投稿する事故を防ぐ）。変数が無ければ起動時に落とす。

## 旧実装との差分

統合時点では**出力を変えない**方針だが、1 点だけ許容した差分がある。

- 旧 skylog の「集計開始 / 集計終了」投稿だけが `agent.api.app.bsky.feed.post.create()` を
  直接使っており、`langs` も `facets` も付いていなかった（ランキング本体は `agent.post()`）。
  共通の `Poster` に寄せたことで、**この 2 投稿に `langs: ["ja"]` と facets が付く。**

## ドキュメント

- [docs/findings.md](docs/findings.md) — 統合前の実測調査（稼働状況・依存の破壊的変更・重複の洗い出し）
- [docs/design.md](docs/design.md) — 統合設計

## 状態

統合作業中。両 Bot は統合前のコード（`legacy/`）で稼働を継続している。
