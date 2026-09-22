# bsky-skyhigh / bsky-skylog 調査結果（事実のみ。2026-09-22 実測）

## 0. 最重要：両方とも「本番稼働中」

public.api.bsky.app への読み取り専用問い合わせで確認（投稿は一切していない）。

| | skyhigh.bsky.social | skylog.bsky.social |
|---|---|---|
| DID | did:plc:oscs3opb4ibxdy6h7jxgu33a | did:plc:w3xllhhb2fwejnvyg3z2qilk |
| 表示名 | すか廃！投稿数ランキング | ソラログｯ!!! |
| フォロワー | 410 | 252 |
| 総投稿数 | 4,847 | 59,590 |
| 毎日の開始 | 08:45:03 JST（秒までブレなし） | 00:20:04 JST |
| 毎日の終了 | 09:41〜10:21 JST（所要 56〜96分） | 00:52〜00:56 JST（所要 32〜36分） |
| 直近実行 | 2026-09-22 08:45 開始・09:49 終了 | 2026-09-22 00:20 開始・00:52 終了 |

- 「skylog は未完成」はリポジトリの main（Rust）の話で、**実際に動いているのは TypeScript 版**。
  skylog の投稿レコードに `langs:["ja"]` が入っている → `langs` を付けているのは **js_mode ブランチだけ**
  （main の backup/src/index.ts には無い）。つまり **js_mode が本番コード**。
- skyhigh の開始投稿が `集計開始：... users: 374` 形式 → `users:` を付けたのは main の最終コミット
  67d60d3 (2024-06-29)。つまり **skyhigh は main が本番コード**。
- **どこで動いているかは不明。** このサーバーには crontab 無し / systemd --user timer 無し / node プロセス無し。
  両リポジトリとも GitHub Actions の run 履歴ゼロ（`gh run list` が空）。
  skyhigh の .github/workflows/main.yml は 2023-04-16 の commit 16d78a0 で削除済み
  （cron '55 23 * * *' / working-directory: app / secrets AUTHOR・PASSWORD）。
  開始時刻が秒までブレない（08:45:02〜03）ので GitHub Actions ではなく**どこかのホストの cron**。
  README が参照する ShinoharaTa/node-docker（2023-04-27 で更新停止）が実行基盤だった可能性。
  → **統合設計の前に「今どこで動いているか」をユーザーに確認する必要がある。**

## 1. リポジトリの中身

### bsky-skyhigh（main のみ、ブランチ1本）
- ファイル: package.json / tsconfig.json / biome.json / .env.sample / src/index.ts（176行、1ファイル）
- 履歴: 2023-04-14 init 〜 2024-06-29 最終 commit。19 commits。
- 実装: dotenv → BskyAgent.login → getFollowers（cursor で最大20ページ=2000人）→
  各フォロワーの getAuthorFeed を**直列**で回して前日分の投稿をカウント（最大20ページ=2000投稿）→
  降順ソートして上位10件を1投稿にまとめて投稿 → 定型文投稿 → 終了時刻投稿。
  例外時は @shino3.net 宛にエラー投稿。
- **スケジューラはコードに無い。一発実行のスクリプト。** 外部の cron 前提。
- 所要 56〜96分はここが原因: 370人 × 直列 getAuthorFeed。

### bsky-skylog
3つの版が同居している。

- **main（Rust / 未完成）** — 2024-02-23〜27、最終 commit「投稿取得まで実装」
  - src/main.rs 71行。config.json 読み込み → aerostream の Client でログイン →
    get_all_followers（ページング）→ `com_atproto_repo_listrecords` を**自分の DID で1回叩いて println!** →
    `for follower in followers { /* 空 */ }`。
  - **集計も投稿もスケジューラも無い。着手率でいうと 2〜3割。**
  - 警告レベルの残骸: `let getRecord`（snake_case 違反）、空の for ループ、未使用の `did`。
  - `aerostream = "*"`（Cargo.lock 上は 0.14.3）。aerostream は 2024-05 で更新停止。
  - filters.yaml（firehose のフィルタ定義。All のみ）が残っているが main.rs から読まれていない
    ＝ firehose 購読は**着手すらしていない**。
  - **このマシンに Rust ツールチェインが入っていない**（cargo/rustc 無し）。ビルド検証は未実施。
- **main の backup/ ディレクトリ（TypeScript / 旧版）** — 2024-02-26 時点のもの。
  commit aea5ac7「全ファイルのパスをバックアップに移動」で Rust 化のために退避された。
  @atproto/api ^0.9.6。`langs` 無し。
- **js_mode ブランチ（TypeScript / これが本番）** — 2024-05-17〜18
  - main とは 53e971c(2023-04-30) で分岐した別系統。Rust 関連ファイルを全部削除し
    backup/ を root に戻した構成。@atproto/api ^0.12.10。
  - src/index.ts 202行。skyhigh とほぼ同じ骨格だが集計が posts/replys/reposts の3本立て、
    出力が「親投稿1件 + 10投稿以上のユーザーごとにスレッド返信」。
  - package.json に `node-cron` ^3.0.3 と `axios` ^1.6.8 が**入っているがコードで import されていない**
    （スケジューラ内蔵を試みて止めた痕跡）。`@types/node-cron` も同様。

### 経緯の読み取り（Rust vs TS）
2024-02-24〜27 に Rust で書き直そうとしたが「投稿取得まで実装」で止まり、
2024-05-17 に js_mode ブランチで TypeScript に戻して完成させ、そのまま本番投入。
**main（Rust）は放棄された実験で、js_mode が現役。** default branch が main のままなので
「未完成の Rust」が表に見えているだけ。

## 2. 実際に測ったビルド結果（scratchpad 上、投稿処理は一切実行していない）

Node v24.20.0 / npm 11.19.0。

| 対象 | 現行依存のまま `tsc --noEmit` |
|---|---|
| skyhigh main | **成功（エラー0）** |
| skylog js_mode | **成功（エラー0）** |

## 3. @atproto/api 0.12.10 → 0.20.44 で実際に壊れたもの（実測）

`npm i @atproto/api@latest` して tsc を回して確認した。**壊れるのは3種類だけで、全部機械的に直せる。**

1. **exports マップが `.` のみになった** → `moduleResolution: "node"`（node10）で解決不能。
   `TS2307: Cannot find module '@atproto/api'` + implicit any が連鎖。
   → tsconfig を `"moduleResolution": "bundler"`（or node16/nodenext）に変更で解消。
2. **deep import 全滅**。`@atproto/api/dist/client/types/app/bsky/...` はファイル自体は存在するが
   exports マップで塞がれている。両方のコードが 3〜5 本ずつこれを使っている。
   → ルートの namespace 経由に書き換え:
   - `AppBskyGraphGetFollowers.QueryParams`
   - `AppBskyFeedGetAuthorFeed.QueryParams`
   - `AppBskyActorDefs.ProfileView`
   - `AppBskyFeedDefs.FeedViewPost`
3. **`login()` の戻り値が `AppBskyActorGetProfile.OutputSchema` に代入できなくなった**。
   `TS2322: Types of property 'status' are incompatible` — getProfile 側の `status` が
   文字列 union から `StatusView` オブジェクトに変わったため（live status 機能の追加）。
   → `ComAtprotoServerCreateSession.OutputSchema` に型を変えれば解消。
   （skyhigh では `self` は現状どこからも使われていない死に変数。skylog では
   `post.create({repo: self.handle})` で使っている）

上の3点を直した状態で **skyhigh / skylog 両方 tsc エラー0 を確認済み**。

### 型は通るが要注意（deprecated / 実行時）
- `BskyAgent` は `@deprecated use AtpAgent instead`。まだ export されている（AtpAgent のサブクラス）。
- `agent.api` は `@deprecated use "this" instead`。`agent.api.app.bsky.feed.post.create(...)` は
  型は通るが非推奨。`agent.post()` / `agent.app.bsky...` に寄せるべき。
- `RichText.detectFacets(agent)` は健在。`agent.post({$type, text, facets, langs, reply})` も型OK。
- **実行時は未検証**（本番アカウントに投稿しないため）。getAuthorFeed のレート制限・
  `includePins`/`filter` パラメータのデフォルト変更などは実行しないと分からない。
- 依存の推移的変更: multiformats 9 → 13、zod ^3.23.8 と await-lock が新規に入る。

## 4. 明確なバグ / 品質上の問題（実測ベース）

- **`biome: ^0.2.2` は別物のパッケージ**。npm 上の `biome` は
  "A simple way to manage environment variables on a per-project basis"（最新 0.3.3）。
  正しくは `@biomejs/biome`（最新 **2.5.14**）。skyhigh・skylog(js_mode)・backup の3箇所すべてで同じ間違い。
  さらに biome.json の `$schema` が **1.5.1** を指しているので、2.x に上げると
  `biome migrate` によるスキーマ移行が必要。**現状リンタもフォーマッタも一度も動いていない。**
- **skylog が `@handle.invalid` 宛に投稿している**（2026-09-19〜21 の実ログで確認）。
  ハンドル未解決（deactivate / 移行中）のフォロワーをそのまま `@${user.handle}` でメンション文に
  埋めている。フィルタが必要。
- skyhigh の `getPosts`: `filterd`（= 前日分のみに絞った配列）から「前日より前の投稿」を探して
  打ち切り判定している（`end` の find）。**filterd には定義上そんな要素は入らないので打ち切りが効かない。**
  結果、常に20ページ（2000投稿）を最後まで取りに行く。所要時間が長い一因。skylog 側も同じ構造。
- skyhigh の定型文が「3000投稿まで集計」と書いているが、実装は 20ページ×100 = **2000投稿**。表示と実装の不一致。
- skyhigh は集計開始・終了・ランキング・定型文で **1日4投稿**。skylog は
  親1 + 該当ユーザー分の返信（総投稿59,590件の主因）。skylog は投稿間に sleep が無い
  （`// await sleep(1000);` がコメントアウト済み）。
- `post()` の呼び出しが await されていない箇所が複数（skyhigh 130,152,161,164行 / skylog 191行）。
- skyhigh は例外時に `@shino3.net`、skylog は `@shino3.bsky.social` とハードコード先がバラバラ。
- 両方 `moment-timezone`（メンテナンスモード）。
- テスト 0。CI 0。

## 5. 重複している実装（行レベルで確認済み）

skyhigh/src/index.ts と skylog js_mode/src/index.ts は**ほぼコピー**。

| 機能 | skyhigh | skylog(js_mode) | 差分 |
|---|---|---|---|
| dotenv 読み込み | 8行目 | 10行目 | 完全同一（AUTHOR/PASSWORD の2変数） |
| Agent 生成 | `new BskyAgent({service:"https://bsky.social"})` | 同左 | **完全同一** |
| `login()` | 15-26行 | 17-28行 | **完全同一**（try/catch → self 代入 → success判定） |
| 日付境界（prevDay/today, Asia/Tokyo） | 12-13行 | 14-15行 | **完全同一** |
| `getFollowers()` | 39-66行 | 40-67行 | 型注釈の有無だけ。ロジック完全同一（20ページ上限） |
| `getPosts()` の骨格 | 68-104行 | 69-125行 | ページング・日付フィルタ・打ち切り判定が同一。 skylog は replys/reposts を追加集計 |
| 投稿処理 | `RichText`→`detectFacets`→`agent.post` | 親投稿は同じ / 返信は `reply:{parent,root}` 付き | **RichText 周りは同一** |
| エラー時の通知投稿 | 168-175行 | 192-205行 | 宛先ハンドルの文字列だけ違う |
| スケジューラ | **無し**（外部 cron） | **無し**（node-cron は未使用のまま dependencies に残存） | 両方とも未実装 |
| 設定ファイル形式 | .env（AUTHOR, PASSWORD） | .env（AUTHOR, PASSWORD） | 同一。※Rust版だけ config.json |
| tsconfig | target/module esnext, moduleResolution node, outDir dist | ほぼ同一（exclude の書き方だけ違う） | 実質同一 |
| biome.json | 同一（schema 1.5.1） | 同一 | **完全同一** |

共通化できるのは：**AT Protocol クライアント生成・ログイン・セッション保持・
フォロワー全件取得（ページング）・author feed 全件取得（ページング）・JST 日付境界の算出・
RichText 付き投稿・スレッド返信・エラー通知・設定読み込み・スケジューラ・レート制限/リトライ**。
Bot 固有なのは実質 **「取得した feed をどう数えるか」と「結果をどう文章にするか」の2つだけ。**

## 6. 必要な認証情報（実物は無い。列挙のみ）

- `AUTHOR` … Bot のハンドル（例 `skyhigh.bsky.social`）。※実態は identifier なので変数名として不適切
- `PASSWORD` … **App Password 推奨**（本アカウントのパスワードではなく bsky.app の設定で発行するもの）
- Rust 版のみ config.json の `handle` / `password`（同じ内容の別形式）
- .env / config.json の実物はリポジトリに存在しない（.gitignore 済み）。**新規に作る必要がある。**
- 統合するなら Bot ごとに別の認証情報が要る（skyhigh 用と skylog 用で2組）。

## 7. その他の文脈

- 保守者は1人（ShinoharaTa / shino3）。
- 同じ人の既存 Bluesky 関連リポジトリ: bsky-massdriver(Svelte), skynow(TS),
  bsky-yearsummary2025(TS), bsky-awesome-appview(Rust), awesome-bot(TS, "awesome bot system")。
  → **統合先の名前を決めるときに既存名と衝突しないこと。**
  `ShinoharaTa/bsky-bots` `sorabot` `skybots` `bsky-botbox` はいずれも**未使用**（確認済み）。
- 実行環境はヘッドレス Ubuntu 24.04 / N100 / RAM 16GB。sudo 不可。Node は nvm の v24.20.0
  （非対話シェルに PATH が通っていないので毎回 `source ~/.nvm/nvm.sh`）。
  systemctl --user は利用可（linger 有効済み）。このマシンには既に signal-digest 系の
  systemd --user サービスが5本常駐している。
- 両リポジトリとも public。skyhigh pushedAt 2024-06-29、skylog pushedAt 2024-05-17。
