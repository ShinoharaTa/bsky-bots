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
npm test

# dry-run（既定）。ログインせず、投稿する内容を stdout に JSON Lines で出す
node dist/main.js skyhigh
node dist/main.js skylog

# フォロワーを先頭 N 人に絞って試す
node dist/main.js skylog --limit-followers=3

# 実際に投稿する（.env の認証情報が必要）
node dist/main.js skyhigh --live
```

```bash
# 1 アカウントぶんの取得結果を検証する（読み取り専用・投稿しない）
node dist/tools/probe.js fuwayukarin.bsky.social
node dist/tools/probe.js did:plc:bomm4rqxhepvv7uc6nm5zyyp 2026-02-14
```

- **既定は dry-run。`--live` を明示したときだけ投稿する。**
- dry-run は**ログインしない**。読み取りは認証不要のエンドポイントだけを使う。
  `--live` のときだけ `https://bsky.social` に login する（投稿のためだけ）。
- dry-run の出力は 1 行 1 JSON。`{"seq","kind","text","langs","replyTo","facets","createdAt"}`。
  `createdAt` は実行のたびに変わるので新旧の diff 対象から外すこと。
- 進捗・エラーなどのログは stderr に出す（stdout を JSON Lines 専用にするため）。

認証情報は `.env`（`.env.sample` を参照）。Bot ごとに
`SKYHIGH_IDENTIFIER` / `SKYHIGH_APP_PASSWORD` / `SKYLOG_IDENTIFIER` / `SKYLOG_APP_PASSWORD`。
**`AUTHOR` / `PASSWORD` へのフォールバックは持たない**（2 Bot が 1 つの .env を共有するため、
片方の認証情報でもう片方が投稿する事故を防ぐ）。変数が無ければ起動時に落とす。

## 投稿の取得経路

投稿は**各ユーザーの PDS を直接読む**（`com.atproto.repo.listRecords`・認証不要）。

1. フォロワー取得で `did` を保持する（以降の API 呼び出しは全部 did。`handle` は表示用）
2. `did` -> PDS エンドポイントを `https://plc.directory/<did>` で解決する（プロセス内キャッシュ）
3. その PDS の `app.bsky.feed.post` を読む。rkey は TID（マイクロ秒タイムスタンプ）なので
   **レコードを読まずに rkey だけで日付境界を判定して打ち切れる**
4. skylog はリポストも数えるので `app.bsky.feed.repost` も読む。
   skyhigh は `app.bsky.feed.post` だけ（このコレクションにリポストは構造的に入らない）

PDS は任意のホストなので落ちていることがある（実例: `at.soverth.blue` は TLS ハンドシェイクで失敗）。

- per-host タイムアウト 10 秒 + 429/5xx の指数バックオフ（`core/retry.ts`。`Retry-After` を尊重）
- PDS が駄目なら AppView（`getAuthorFeed`）にフォールバック
- どちらも駄目ならそのユーザーだけスキップして stderr に出す。**失敗を投稿しない**

## 旧実装との差分

統合時点では**出力を変えない**方針だが、1 点だけ許容した差分がある。

- 旧 skylog の「集計開始 / 集計終了」投稿だけが `agent.api.app.bsky.feed.post.create()` を
  直接使っており、`langs` も `facets` も付いていなかった（ランキング本体は `agent.post()`）。
  共通の `Poster` に寄せたことで、**この 2 投稿に `langs: ["ja"]` と facets が付く。**

PDS 直読みに切り替えた時点（Phase 3）で、以下は**意図して出力が変わる**。

- ハンドルが未解決（`handle.invalid`）のユーザーが集計対象に入る（skyhigh 9 人 / skylog 5 人）。
  このユーザーへの skylog のメンションは、解決できないハンドルを本文に書かないよう
  **表示テキストを displayName にして mention facet を did で組み立てる**。
  displayName が空（空白・制御文字だけを含む）なら did をそのまま表示する。
  ハンドルが解決できるユーザーの出力は従来どおり変わらない
- skylog のリポスト数は「リポストした時刻」で数える。
  旧実装は AppView の `post.indexedAt`（= **元投稿**が索引された時刻）で数えていた
- skylog の「リプ」は自分のリプライ投稿だけを数える。
  旧実装は `FeedViewPost.reply` を見ていたので、**リプライのリポスト**もリプに数えていた
- skylog の「取得に失敗しました」投稿は無くなる（stderr のログだけになる）

## ドキュメント

- [docs/findings.md](docs/findings.md) — 統合前の実測調査（稼働状況・依存の破壊的変更・重複の洗い出し）
- [docs/design.md](docs/design.md) — 統合設計

## 状態

統合作業中。両 Bot は統合前のコード（`legacy/`）で稼働を継続している。
