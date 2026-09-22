# bsky-bots

Bluesky の日次集計 Bot をまとめたリポジトリ。

| Bot | アカウント | 内容 |
| --- | --- | --- |
| skyhigh | [@skyhigh.bsky.social](https://bsky.app/profile/skyhigh.bsky.social) | フォロワーの前日投稿数ランキングを毎日投稿する |
| skylog | [@skylog.bsky.social](https://bsky.app/profile/skylog.bsky.social) | フォロワーごとの前日の活動ログ（投稿 / リプ / リポスト）を毎日投稿する |

もとは `ShinoharaTa/bsky-skyhigh` と `ShinoharaTa/bsky-skylog` の 2 リポジトリだった。
どちらもコードの大半が同一だったため、共通部分を 1 箇所にまとめるために統合した。
旧リポジトリの履歴は `legacy/` 以下に subtree として取り込んである。

## ドキュメント

- [docs/findings.md](docs/findings.md) — 統合前の実測調査（稼働状況・依存の破壊的変更・重複の洗い出し）
- [docs/design.md](docs/design.md) — 統合設計

## 状態

統合作業中。両 Bot は統合前のコードで稼働を継続している。
