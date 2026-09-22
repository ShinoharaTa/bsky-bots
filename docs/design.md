# bsky-skyhigh / bsky-skylog 統合設計案

作成 2026-09-22 / 前提資料: 同ディレクトリの `findings.md`（実測済み事実）

## 0. この設計の目的

コピペで増殖した 2 つの Bluesky Bot を 1 リポジトリに統合し、
**共通部分を 1 箇所で直せる状態にする。** 副次的に、findings 4章の
バグ（打ち切り判定・`@handle.invalid`・await 漏れ）を直す土台を作る。

**非目標**: 機能追加、Bot の出力文言の変更、性能改善（別フェーズ）。
統合時点では**出力を 1 バイトも変えない**のが原則。

---

## A. 統合案

### 前提となる構造の理解

findings 5章の結論がすべて。Bot 固有なのは実質 2 つだけ。

- **集計**: 取得した feed をどう数えるか
- **整形**: 数えた結果をどう文章にするか

それ以外（クライアント生成・ログイン・フォロワー全件取得・feed ページング・
JST 日付境界・RichText 投稿・スレッド返信・エラー通知・設定読み込み）は
**全部共通化できる**。したがって「core をどう切るか」は既に決まっていて、
残る論点は**パッケージ分割をどこまで形式化するか**だけ。

### 案1: 単一パッケージ + `src/bots/` ディレクトリ（ワークスペース無し）

```
bsky-bots/
├── package.json            # 1 個だけ
├── tsconfig.json           # 1 個だけ
├── biome.json              # 1 個だけ
├── .env.sample
├── .gitignore
├── README.md
├── docs/
│   └── adr/0001-typescript-over-rust.md
├── deploy/
│   ├── bsky-skyhigh.service / .timer
│   └── bsky-skylog.service  / .timer
├── legacy/                 # subtree で引いた旧コード（凍結・ビルド対象外）
│   ├── skyhigh/
│   └── skylog/
└── src/
    ├── main.ts             # CLI エントリ: node dist/main.js <bot> [--live]
    ├── core/
    │   ├── client.ts       # AtpAgent 生成 + login + セッション保持
    │   ├── config.ts       # .env 読み込み + Bot 設定の型
    │   ├── date.ts         # prevDay / today（Asia/Tokyo）
    │   ├── followers.ts    # フォロワー全件取得（ページング）
    │   ├── feed.ts         # author feed 取得 + 日付フィルタ + 打ち切り
    │   ├── poster.ts       # Poster interface / LivePoster / DryRunPoster
    │   ├── notify.ts       # エラー通知投稿
    │   ├── retry.ts        # レート制限リトライ + sleep
    │   └── types.ts        # BotDefinition / BotContext
    └── bots/
        ├── skyhigh/
        │   ├── index.ts    # BotDefinition
        │   ├── aggregate.ts
        │   └── format.ts
        └── skylog/
            ├── index.ts
            ├── aggregate.ts
            └── format.ts
```

| | |
|---|---|
| メリット | 依存が 1 セット。`tsc` 1 回・`biome check` 1 回で全部。package.json が 1 個なので依存更新が 1 箇所。npm workspaces の癖（hoisting・`--workspace` フラグ）を覚えなくていい |
| デメリット | Bot ごとに依存を分離できない。将来 Bot が増えて依存が分岐すると窮屈。`core` が公開 API として強制されないので、Bot から core の内部に手が伸びやすい |
| 実装コスト | 低 |
| 運用コスト | 最低 |

### 案2: npm workspaces モノレポ（`packages/*`）

```
bsky-bots/
├── package.json            # private:true, workspaces:["packages/*"]
├── tsconfig.base.json
├── biome.json
├── deploy/ legacy/ docs/
└── packages/
    ├── core/
    │   ├── package.json    # name: @bsky-bots/core
    │   ├── tsconfig.json
    │   └── src/ （案1 の core/ と同じ中身）
    ├── skyhigh/
    │   ├── package.json    # deps: @bsky-bots/core
    │   └── src/index.ts, aggregate.ts, format.ts
    └── skylog/
        └── （同上）
```

| | |
|---|---|
| メリット | core の API 境界が package の壁で強制される。Bot ごとに依存を足せる。将来 3 個目以降を足すときに形が決まっている |
| デメリット | package.json が 3 個 → 依存更新が 3 箇所。TS の参照に project references かビルド順管理が要る。**2 Bot・テスト 0・CI 0 の規模では境界の恩恵より管理コストが上回る** |
| 実装コスト | 中 |
| 運用コスト | 中 |

### 案3: pnpm + Turborepo

| | |
|---|---|
| メリット | タスクキャッシュ、並列ビルド |
| デメリット | ビルド対象が実質 TS ファイル十数本。**キャッシュする価値のあるビルドが存在しない。** pnpm を新規に入れると nvm 管理下のツールが 1 つ増える |
| 判定 | **過剰。却下。** |

### 比較表

| 観点 | 案1 単一 | 案2 workspaces | 案3 Turborepo |
|---|---|---|---|
| 1 人保守の負荷 | ◎ | △ | ✗ |
| 初回統合の速さ | ◎ | ○ | △ |
| 依存更新の手間 | ◎ | △ | △ |
| core の境界の明確さ | ○ | ◎ | ◎ |
| Bot 追加時の拡張性 | ○ | ◎ | ◎ |
| ビルドの単純さ | ◎ | ○ | △ |
| **総合** | **◎** | ○ | ✗ |

### 推薦: **案1（単一パッケージ + `src/bots/`）**

理由:
1. Bot 固有コードは 2 ファイル × 2 Bot 程度。package に分ける量がない
2. 両 Bot の依存は完全に同一（findings 5章）。分離する動機がゼロ
3. 案2 への移行は後からできる。`src/core/` → `packages/core/src/` の `git mv` と
   package.json 追加だけ。**先に払う必要のないコスト**
4. core の境界は **lint ルール** で担保する。biome の `noRestrictedImports` で
   「`src/bots/**` から `src/core/*/internal` を import 禁止」程度を入れれば十分

### findings 5章「重複している実装」の行き先対応

| findings の行 | 行き先 | 備考 |
|---|---|---|
| dotenv 読み込み | `core/config.ts` | `AUTHOR`/`PASSWORD` → `<BOT>_IDENTIFIER`/`<BOT>_APP_PASSWORD` |
| Agent 生成 | `core/client.ts` | `BskyAgent` → `AtpAgent` |
| `login()` | `core/client.ts` | 戻り型を `ComAtprotoServerCreateSession.OutputSchema` に（findings 3章3） |
| 日付境界 prevDay/today | `core/date.ts` | 引数で基準時刻を注入可能に（テスト用） |
| `getFollowers()` | `core/followers.ts` | ページ上限を引数化 + `--limit-followers` 対応 |
| `getPosts()` の骨格 | `core/feed.ts` | **生の `FeedViewPost[]` を返す**。数えるのは Bot 側 |
| 投稿処理（RichText→detectFacets→post） | `core/poster.ts` | `Poster` interface 経由に |
| スレッド返信（reply: parent/root） | `core/poster.ts` | `poster.reply(root, text)` |
| エラー時の通知投稿 | `core/notify.ts` | 宛先ハンドルを Bot 設定に（`.net` / `.bsky.social` のバラつき解消） |
| スケジューラ | **持たない** | 外部 systemd timer（C 参照）。`node-cron` は依存から削除 |
| 設定ファイル形式 | `core/config.ts` | .env（秘密）+ TS オブジェクト（非秘密） |
| tsconfig | ルート 1 本 | `moduleResolution: "bundler"` |
| biome.json | ルート 1 本 | `@biomejs/biome` 2.5.14 |

**Bot 側に残るもの（これだけ）**

| Bot | 集計 (`aggregate.ts`) | 整形 (`format.ts`) |
|---|---|---|
| skyhigh | 前日の非リポスト投稿数を 1 本でカウント | 上位 10 件ランキング（300 字制限付き）+ 定型文 + 開始/終了 |
| skylog | posts / replys / reposts の 3 本立て | 親投稿 + 10 件以上のユーザーごとにスレッド返信 |

**共通化の追加効果**: 両 Bot が同じ「フォロワー全件 × 前日 feed」を別々に取得している。
`core/feed.ts` を共通化しておけば、将来 1 回の取得を 2 Bot で共有する余地が残る
（今は実行時刻が違うので統合しない）。

### ビルド・型・リンタの構成

**リンタ（biome）** — findings 4章の「一度も動いていない」を解消する。

1. `biome: ^0.2.2` を **削除**（別物のパッケージ。環境変数管理ツール）
2. `@biomejs/biome@2.5.14` を devDependencies に追加
3. `npx @biomejs/biome migrate --write` を実行
   → `$schema` 1.5.1 → 2.5.14、`organizeImports` は 2.x で
   `assist.actions.source.organizeImports` に移動するので migrate が書き換える
4. `npx @biomejs/biome check --write .` で初回フォーマット適用
   → **一度も動いていないので全ファイルが差分になる。これは独立した 1 コミットにする**
   （core 抽出のコミットに混ざるとレビュー不能になる）
5. `package.json` に `"lint": "biome check ."` / `"format": "biome check --write ."`

**型（tsconfig）** — ルート 1 本。

| 設定 | 値 | 理由 |
|---|---|---|
| `target` / `module` | `esnext` のまま | 現状維持 |
| `moduleResolution` | `node` → **`bundler`** | findings 3章1。@atproto/api 0.20 の exports マップ対応。**必須** |
| `outDir` | `dist` | 現状維持 |
| `strict` | Phase 2 では `false`、Phase 5 で `true` へ | `let self: OutputSchema` の未代入使用等が引っかかる。段階的に |
| `noUncheckedIndexedAccess` | 入れない | ランキングの配列アクセスが全部煩雑になる。費用対効果が合わない |

**依存の整理**

| パッケージ | 処置 |
|---|---|
| `@atproto/api` ^0.12.10 | → 最新（0.20.44）。deep import 4 種をルート namespace に書き換え（findings 3章2） |
| `biome` ^0.2.2 | **削除**（別物） |
| `@biomejs/biome` | 追加 2.5.14（dev） |
| `node-cron` / `@types/node-cron` | **削除**（未使用。スケジューラは systemd） |
| `axios` | **削除**（未使用） |
| `@babel/*`（skylog のみ） | **削除**（tsc でビルドしている。`.babelrc` も削除） |
| `moment-timezone` | Phase 2 では据え置き、Phase 5 で `date-fns-tz` or `Temporal` 検討 |
| `dotenv` | 残す（Node 20.6+ の `--env-file` でも可。Phase 5 で検討） |
| `typescript` / `@types/node` | 最新へ |
| `vitest` | 追加（dev）。純関数のみ対象 |

**`BskyAgent` / `agent.api` の非推奨対応**（findings 3章「型は通るが要注意」）:
core に閉じ込めるので、`core/client.ts` と `core/poster.ts` の 2 ファイルを直すだけで済む。
これが統合の直接的な見返り。

**テスト**（最小限）
対象は純関数のみ。API を叩く層はテストしない（モック維持コストが見合わない）。
- `core/date.ts`: 固定時刻を渡して prevDay/today の境界
- `bots/*/aggregate.ts`: 固定の `FeedViewPost[]` を渡してカウント
- `bots/*/format.ts`: 固定の集計結果を渡して出力文字列（**300 字制限の境界を必ず含める**）

### 工数感（段階分け）

| Phase | 内容 | 目安 | ブロッカー |
|---|---|---|---|
| **0** | 実行場所の特定（ユーザー作業） | - | **これが C・D のブロッカー** |
| **1** | 箱を作る: git 統合（B）+ ディレクトリ + biome/tsconfig 一本化 + ビルド通す | 半日 | なし |
| **2** | core 抽出 + 2 Bot を core 上に載せ替え。**出力文字列は変えない** | 1 日 | なし |
| **3** | @atproto/api 最新化 + deep import 除去 + dry-run 実装 + 新旧出力の突き合わせ | 半日 | なし |
| **4** | systemd --user timer 整備 + 切り替え（D） | 半日 + 観察 2 週 | **Phase 0** |
| **5** | バグ修正（打ち切り判定 / `@handle.invalid` / await 漏れ / 並列化 / 定型文の数値不一致） | 1 日 | Phase 4 完了後 |

**Phase 1〜3 は実行場所が不明でも全部進められる。** 止まるのは Phase 4 だけ。

---

## B. git 履歴の扱い

### 選択肢

| 案 | 内容 | 判定 |
|---|---|---|
| (1) 新規リポジトリ・履歴を捨てる | 新規 init して現行コードをコピー | △ コストは低いが「なぜこの定型文なのか」を追えなくなる |
| (2) subtree で両方の履歴を引く | `git subtree add` で 2 本の歴史を取り込む | **◎ 推薦** |
| (3) skyhigh を rename して土台にする | 片方の履歴だけ自然に残る。もう片方は subtree | △ 非対称。skyhigh が主で skylog が従、という誤った印象が残る |

### 推薦: **(2) subtree で履歴を残す**

理由:
- 合計コミット数が skyhigh 19 + skylog js_mode 数十。**軽い**
- コマンド 6 行で終わる。捨てるコストに対してリターンが大きい
- 出力文言・閾値（10 件、300 字、20 ページ）の由来を `git log` で追える

**引くのは skylog の `js_mode` だけ。`main`（Rust）は引かない。**

根拠:
- `main` と `js_mode` は **53e971c で分岐した別系統**（merge-base = 53e971c、2023-04-30 で確認済み）
- 同一 prefix に 2 つの無関係な木を subtree add することはできない
  （2 回目が「既に存在する prefix」で失敗する）。別 prefix にすると
  `legacy/skylog-rust/` という使われない木がリポジトリに残る
- `main` の資産（Cargo.toml / src/main.rs / filters.yaml）は放棄された実験（E 参照）
- **`main` の履歴は archive された旧リポジトリに残り続ける。** 消えない。必要なら参照可能

### 実際に叩けるコマンド列

```bash
# ---- 0. 事前確認（どちらも read-only） ----
git -C ~/workspace/bsky-bots/bsky-skyhigh fetch origin
git -C ~/workspace/bsky-bots/bsky-skylog  fetch origin
git -C ~/workspace/bsky-bots/bsky-skylog  merge-base main js_mode
#   -> 53e971cf1d0f6bda800c3440a477de09c2855d31 （別系統であることの確認）

# ---- 1. 新リポジトリをローカルに作る ----
mkdir -p ~/workspace/bsky-bots/bsky-bots
cd ~/workspace/bsky-bots/bsky-bots
git init -b main
printf '# bsky-bots\n\nBluesky bots monorepo (skyhigh / skylog).\n' > README.md
git add README.md
git commit -m "chore: initialize monorepo"

# ---- 2. skyhigh の main を legacy/skyhigh/ に取り込む ----
git remote add skyhigh-origin https://github.com/ShinoharaTa/bsky-skyhigh.git
git fetch skyhigh-origin main
git subtree add --prefix=legacy/skyhigh skyhigh-origin main

# ---- 3. skylog の js_mode を legacy/skylog/ に取り込む（main=Rust は引かない） ----
git remote add skylog-origin https://github.com/ShinoharaTa/bsky-skylog.git
git fetch skylog-origin js_mode
git subtree add --prefix=legacy/skylog skylog-origin js_mode

# ---- 4. 履歴が繋がっていることを確認 ----
git log --oneline --graph | head -40
git log --oneline -- legacy/skyhigh/src/index.ts   # skyhigh の 19 commits が見えること
git log --oneline -- legacy/skylog/src/index.ts    # js_mode 系の commits が見えること

# ---- 5. 取り込み用リモートを外す（以後不要） ----
git remote remove skyhigh-origin
git remote remove skylog-origin

# ---- 6. 統合先リモートを設定（リポジトリ作成はユーザー判断で） ----
# gh repo create ShinoharaTa/bsky-bots --public --source=. --remote=origin
```

**なぜ一旦 `legacy/` に入れるのか**

`git subtree add` は**旧リポジトリのルート丸ごと**を prefix 下に置く。
つまり `package.json` / `tsconfig.json` / `biome.json` / `package-lock.json` /
`.babelrc` / `.vscode/` / `README.md` が全部付いてくる。
これを直接 `src/bots/skyhigh` に入れると `src/bots/skyhigh/src/index.ts` という
二重構造になる。`legacy/` に置いてから必要なファイルだけ `git mv` する方が、
「何を持ってきて何を捨てたか」が履歴に残る。`git log --follow` も繋がる。

**`legacy/` は削除せずに残す。** ビルド対象からは外す（tsconfig の `exclude`、
biome の `files.includes` で除外）。理由は D のロールバック（レベル2）。
Phase 5 完了 + 1 ヶ月安定してから削除を検討。

### 旧リポジトリの扱い

推薦: **README を差し替えて push → GitHub で Archive**。削除はしない。

手順（**archive 後は push できないので順序が重要**）:

1. 両リポジトリの README 先頭に追記して push
   - skyhigh: `> このリポジトリは ShinoharaTa/bsky-bots に統合されました（2026-xx-xx）。`
   - skylog: 上記に加えて
     `> 本番で稼働していたのは main（Rust・未完成）ではなく js_mode ブランチ（TypeScript）です。`
     ← **これが無いと将来の自分が必ず同じ罠を踏む。必須。**
2. 新リポジトリの `docs/adr/0001-typescript-over-rust.md` から旧リポジトリの
   該当コミットへリンクを張る
3. GitHub で Archive（Settings → Archive this repository）

削除しない理由: public で star / fork があり得る。Bot のプロフィールや
過去投稿からリンクされている可能性。Archive なら read-only で残り、
新規 issue も立たない。

**default branch の変更は不要**（archive するので）。README の 1 行で足りる。

---

## C. 設定・認証情報・プロセス構成

### 認証情報と設定の持ち方

推薦: **秘密は .env 1 本（ルート）、非秘密は TS のオブジェクトリテラル。**
設定ファイル形式（YAML / JSON / TOML）を**増やさない**。

```
# .env （chmod 600 / .gitignore 済み）
SKYHIGH_IDENTIFIER=skyhigh.bsky.social
SKYHIGH_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx
SKYLOG_IDENTIFIER=skylog.bsky.social
SKYLOG_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx
```

| 論点 | 決定 | 理由 |
|---|---|---|
| .env は 1 本か Bot ごとか | **1 本** | systemd の `EnvironmentFile=` が 1 本で済む。分けると unit も設定箇所も増える。Bot 名プレフィックスで衝突しない |
| 変数名 | `AUTHOR` → `<BOT>_IDENTIFIER` | findings 6章。実態は identifier であって author ではない |
| 非秘密設定の置き場 | `src/bots/<name>/config.ts` | TS なら型が効く。値を変えたときに tsc が検査してくれる。YAML だと検査が効かない層ができる |
| 非秘密設定の中身 | エラー通知先ハンドル / フォロワー取得ページ上限 / feed 取得ページ上限 / 最低投稿数閾値 / ハッシュタグ / 定型文 / 投稿間 sleep ms | 現状ハードコードされている値を 1 箇所に集める |

**移行期の互換**: `core/config.ts` は `SKYHIGH_IDENTIFIER` が無ければ `AUTHOR` に
フォールバックする（警告ログ付き）。切り替え当日に環境変数名の typo で落ちる事故を防ぐ。
Phase 5 でフォールバックを削除。

**App Password について**: 本アカウントのパスワードではなく bsky.app の設定で発行するもの。
Bot ごとに別のものを 2 組。旧環境から回収できない場合は再発行（後述の未確定事項）。

### 1 プロセス vs Bot ごとに別プロセス

推薦: **Bot ごとに別プロセス（one-shot 実行）。**

| 観点 | 1 プロセスで両方 | Bot ごとに別プロセス |
|---|---|---|
| 実行時間帯 | 08:45 と 00:20 で重ならない → 常駐の必然性なし | ✓ |
| 障害分離 | 片方の例外が他方を巻き込むリスク | ✓ 完全に独立 |
| ログ | 混ざる | ✓ journalctl の unit で分かれる |
| **片方ずつ切り替えられるか** | ✗ できない | **◎ D の移行安全性の前提** |
| メモリ | 56〜96 分間掴み続ける | ✓ 実行中だけ |
| 実装 | ✗ 分岐が要る | ✓ 引数で切り替え |

**決め手は「片方ずつ切り替えられること」。** skyhigh を先に切り替えて 2 週間観察し、
問題なければ skylog、という段取り（D）が 1 プロセス構成では取れない。

**実装形**: 単一エントリ + 引数。

```
node dist/main.js skyhigh --live
node dist/main.js skylog  --live
```

unit ファイルが `ExecStart` の引数違いだけになる。Bot を足すときも
`src/bots/<name>/` と unit 1 組を足すだけ。

### スケジューラ

| 方式 | 向き | 不向き | このサーバーでの評価 |
|---|---|---|---|
| **(a) systemd --user timer + one-shot** | `signal-digest-backup.timer` という**前例が既にある**。linger 有効済み。`Persistent=true` で再起動をまたいだ取りこぼしを回復。`OnCalendar` に `Asia/Tokyo` を直接書ける。ログは `journalctl --user -u <unit>` に集約。**常駐メモリ 0**。`OnFailure=` で将来の失敗通知を刺せる | サーバーが落ちていると動かない（常時稼働機なので実質問題なし） | **◎** |
| (a') crontab | 最小の変更 | ログが自前。nvm の PATH を自前で書く必要。失敗通知なし。**このサーバーに crontab を使う前例がない**（signal-digest は全部 systemd） | ○ |
| (b) node-cron で常駐 | 実装が TS 内で完結 | **常駐プロセスが増える**（既に 5 サービス常駐）。落ちても誰も気づかない。再起動時の復帰に結局 systemd が要る → **systemd を使うなら timer で足り、node-cron は二重管理**。96 分の実行中もその後もメモリを掴む | △ |
| (c) GitHub Actions | サーバー不要。public リポジトリなら分数無料 | **実行 56〜96 分**。cron スケジュールは数分〜数十分の遅延あり（現状は秒までブレない運用）。App Password を GitHub Secrets に置く必要。共有 IP でレート制限を受ける。skyhigh の workflow は 2023-04 に自分で削除している（16d78a0）＝ 一度捨てた選択肢 | △ |

推薦: **(a) systemd --user timer + one-shot 実行。**

unit の雛形（`deploy/` に置いてから `~/.config/systemd/user/` へ symlink or copy）:

```ini
# bsky-skyhigh.service
[Unit]
Description=Bluesky bot skyhigh (daily ranking)

[Service]
Type=oneshot
WorkingDirectory=/home/shino3/workspace/bsky-bots
EnvironmentFile=/home/shino3/workspace/bsky-bots/.env
ExecStart=/home/shino3/.nvm/versions/node/v24.20.0/bin/node dist/main.js skyhigh --live
TimeoutStartSec=7200
```

```ini
# bsky-skyhigh.timer
[Unit]
Description=Run skyhigh daily at 08:45 JST

[Timer]
OnCalendar=*-*-* 08:45:00 Asia/Tokyo
Persistent=true
AccuracySec=1s

[Install]
WantedBy=timers.target
```

skylog は `OnCalendar=*-*-* 00:20:00 Asia/Tokyo` / `TimeoutStartSec=3600`。

**落とし穴（必ず設計に含めること）**:
- systemd --user は**シェルを経由しない**。`~/.nvm/nvm.sh` は読まれない。
  `ExecStart` には **node の絶対パスを書く**。
- nvm のバージョンを上げると絶対パスが変わり、**timer が無言で失敗する**。
  対策: `~/.local/bin/node` に symlink を張って unit はそれを指す、
  または Node 更新時に unit を直す運用を README に明記する。**前者を推奨。**
- `TimeoutStartSec` を明示しないと systemd の既定値で 96 分の実行が殺される。
- `.env` は `chmod 600`。`EnvironmentFile` の行に `"` を書かない（systemd は
  クォートをそのまま値に含めることがある）。

### 【重要】未確定事項: 今どこで動いているか

findings 0章のとおり、**現在の実行場所が不明**。このサーバーではなく
GitHub Actions でもない。開始が秒までブレないのでどこかのホストの cron。

#### 判明するまで決められないこと

| # | 決められないこと | 理由 |
|---|---|---|
| 1 | 切り替え日程 | 旧側を止める手段・権限が分からないと日程を置けない |
| 2 | 認証情報を再利用するか再発行するか | 旧環境の `.env` を回収できるかによる |
| 3 | 実行基盤を本当にこのサーバーにするか | 旧環境が今も健全なら、そこに新コードを置く選択肢もある |

#### 判明した場合の分岐

| 判明した場所 | 影響と対応 |
|---|---|
| **別ホスト（VPS / 旧 ShinoharaTa/node-docker 等）** | 最も可能性が高い。そのホストの cron / コンテナを止める手順が必要。**新旧の二重投稿が最大のリスク。** 旧ホストにログインできない場合、**旧を止められない＝統合を完了できない**ブロッカーになる（新旧が同時に投稿する） |
| **このサーバーの別コンテナ / 別経路** | `docker ps` / `podman ps` / 他ユーザーの crontab を確認。止め方は自明。統合は最も容易 |
| **クラウドの無料枠（Render / Railway / fly.io 等）** | ダッシュボードで停止。Secrets は回収できないことが多い → App Password 再発行。そのまま載せ替える選択肢も出る |
| **手元の PC / Raspberry Pi** | 秒精度でブレないので可能性あり。止めるのは容易。このサーバーへの移設は純粋な改善になる |

#### ユーザーに確認すべきこと（Phase 0）

1. 旧環境はどこか。ログインできるか
2. 旧環境の cron を止める手段があるか（止められないなら統合の前提が崩れる）
3. 旧環境の `.env`（App Password の実物）を取り出せるか
4. 旧環境には他のものも載っているか（撤去してよいか）

**Phase 1〜3 はこれを待たずに進められる。** 止まるのは Phase 4 の切り替えだけ。

---

## D. 移行の安全性

### dry-run を core に入れるべきか → **入れる。必須。**

理由:
1. 本番アカウントに投稿せずに新実装を検証する**唯一の手段**
2. これが無いと開発中に一度も実行できない（投稿事故を恐れて手が止まる）
3. 新旧の突き合わせ（後述）が dry-run 前提

**設計**:

- `core/poster.ts` に `Poster` interface を置き、実装を 2 つ。
  - `LivePoster` … `agent.post(...)`
  - `DryRunPoster` … JSON Lines を stdout / ファイルへ
- **選択は「投稿しない」を既定にする。** 環境変数 `DRY_RUN=1` ではなく
  **CLI フラグ `--live` を明示したときだけ投稿する。**

```
node dist/main.js skyhigh            # 投稿しない（dry-run）
node dist/main.js skyhigh --live     # 投稿する
```

  → **手で叩いたときは絶対に投稿しない。** `--live` は systemd unit の
  `ExecStart` にだけ書く。事故の方向を安全側に倒す設計。**これが一番効く安全装置。**
- `--limit-followers=N` を入れる。96 分待たずに試せるようにする（開発の実用性に直結）
- dry-run の出力形式（1 行 1 JSON）:

```json
{"seq":1,"kind":"post","text":"集計開始：2026/09/22 08:45:03 users: 374","langs":["ja"],"replyTo":null}
{"seq":2,"kind":"reply","text":"@foo.bsky.social さんの集計データ\n...","langs":["ja"],"replyTo":1}
```

  `facets` は検証対象に含める（`detectFacets` の挙動が @atproto/api 更新で
  変わり得るため）。`createdAt` は毎回変わるので出力するが **diff 対象から外す**。

### 新旧の出力を突き合わせる方法

**問題**: 旧実装をそのまま走らせると本番投稿してしまうので直接比較できない。

**方法 1（主）: 旧コードに dry-run を後付けした「参照実装」と diff する**

1. `legacy/skyhigh/src/index.ts` を scratchpad にコピー
2. `post()` / `agent.post()` / `agent.api.app.bsky.feed.post.create()` を
   **console.log（同じ JSON Lines 形式）に置換**する。**それ以外は 1 行も触らない**
3. 読み取り API（`getFollowers` / `getAuthorFeed`）は実際に叩く。**読み取りは安全**
4. 新実装と参照実装を**同じ日・同じアカウント・近接した時刻**で実行し、出力を `diff`
5. まず `--limit-followers=30` で回数を稼ぎ、最後に 1 回だけ全件

**これが一番確実。** 旧コードの「意図しない挙動」（findings 4章の打ち切りが効かない
問題など）も含めて再現されるので、Phase 2 の「出力を変えない」が検証できる。

**方法 2（補助）: 本番の実投稿と突き合わせる**

切り替え前日の本番投稿は public API で取得できる（**投稿は不要・完全に安全**）。
これと新実装の同日 dry-run を比較する。

注意: 実行時刻が違うと feed の内容がズレ得る（前日分でも削除・非公開化が起きる）。
**完全一致は期待しない。**

**差分が出てよい箇所 / ダメな箇所を先に決める**

| 項目 | 判定 |
|---|---|
| ランキングの順序・ハンドル・投稿数（skyhigh） | **完全一致を要求** |
| 返信対象ユーザーの集合と posts/replys/reposts（skylog） | **完全一致を要求** |
| 閾値 10 件の判定結果 | **完全一致を要求** |
| 300 字制限による打ち切り位置 | **完全一致を要求** |
| 集計開始 / 終了時刻の文字列 | 差分 OK |
| `createdAt` | 差分 OK（比較対象外） |
| `@handle.invalid` の除外 | **意図した修正。Phase 5 で入れる。Phase 2〜3 では入れない** |

### 受け入れ条件（テストできる形）

- [ ] `--live` 無しで実行したとき、`com.atproto.repo.createRecord` への
      リクエストが 0 件（HTTP トレース or DryRunPoster が `LivePoster` を
      一切生成しないことをユニットテストで保証）
- [ ] skyhigh: 新旧 dry-run のランキング行（👑 / 2位〜10位）が**完全一致する日が連続 3 日**
- [ ] skylog: 新旧 dry-run の返信対象ハンドル集合と各カウントが**完全一致する日が連続 3 日**
- [ ] `npx tsc --noEmit` エラー 0
- [ ] `npx @biomejs/biome check .` エラー 0
- [ ] `node dist/main.js skyhigh --limit-followers=30` が 3 分以内に完了する
- [ ] `systemd-analyze --user verify deploy/bsky-skyhigh.service` が警告 0
- [ ] `.env` が `git status` に現れない（`.gitignore` 済み）

### ロールバック手順

**前提（設計上の要点）**: 旧実行環境を**すぐに消さない**。最低 2 週間、
できれば 1 ヶ月は起動できる状態で残す。**これが守られないとロールバック手段が消える。**

| レベル | 状況 | 手順 | 所要 |
|---|---|---|---|
| **1** | 切り替え当日〜数日、新実装が動かない | `systemctl --user disable --now bsky-skyhigh.timer` → 旧環境の cron のコメントアウトを解除 | 数分 |
| **2** | 新 core にバグがあるが基盤は正常 | `legacy/skyhigh` の旧コードを新サーバー上で直接実行する経路を使う（`legacy/` を残す副次的メリット）。unit の `ExecStart` を旧コードに向ける | 30 分 |
| **3** | 認証情報が壊れた / ロックされた | bsky.app で App Password を再発行 → `.env` 差し替え → timer 再起動 | 15 分 |
| **4** | 二重投稿が起きた | **即座に両方止める**（新 timer disable + 旧 cron 停止）。重複投稿を手で削除。原因を特定するまで再開しない | 即時 |

レベル 4 が最悪ケース。これを防ぐために、当日の段取りで
**「旧を止めた確認」を「新を有効化」より前に置く**（下表）。

### 切り替え当日の段取り → **片方ずつ。同時にやらない。**

**順序の推薦: skyhigh が先、skylog が後。**

| | skyhigh | skylog |
|---|---|---|
| 1 回の投稿数 | **4 件** | 親 1 + 該当ユーザー分の返信（総 59,590 件の主因） |
| 事故時の被害 | 小 | **大**（ゴミ投稿がフォロワー分飛ぶ。既に `@handle.invalid` で実害が出ている） |
| 時間帯 | 08:45（目撃されやすい） | 00:20（深夜） |
| 実行時間 | 56〜96 分 | 32〜36 分 |

深夜で目立たないのは skylog だが、**失敗したときの被害が桁違いに大きい。**
被害の小ささを優先して skyhigh を先に切り替え、基盤（unit の書き方・nvm パス・
EnvironmentFile の権限）の想定外を 1 つ目で踏み切る。

**同時に切り替えない理由**: 基盤側の問題（systemd / PATH / 権限）が出た場合、
同時だと 2 Bot 同時に停止する。片方ずつなら片方は動き続ける。

#### skyhigh 切り替えの段取り

| 時点 | 作業 | 確認事項 |
|---|---|---|
| D-7 | Phase 3 完了。dry-run で毎日回し始める | - |
| D-3 〜 D-1 | 新旧 dry-run を毎日 diff | **3 日連続一致**が切り替えの必要条件 |
| D-1 昼 | `.env` を新サーバーに配置（`chmod 600`）。`--limit-followers=30 --live` は**やらない** | `.env` の権限、変数名 |
| D-1 夜 | unit を `~/.config/systemd/user/` に配置。**`enable` しない**。`systemd-analyze --user verify` | 旧環境の止め方を再確認・手順を紙に書く |
| **D 08:00** | **旧環境の cron を止める（コメントアウト）** | **止まったことを確認してから次へ進む。ここが最重要** |
| D 08:30 | `systemctl --user enable --now bsky-skyhigh.timer` → `systemctl --user list-timers` | 次回実行が **08:45** になっているか |
| D 08:45 | `journalctl --user -u bsky-skyhigh -f` で追跡 | ログイン成功、フォロワー数が 374 前後 |
| D 09:45 頃 | 完了確認 | `systemctl --user status`（`Result=success`）。public API で投稿 4 件と内容を確認 |
| D+1 〜 D+7 | 毎朝、投稿が出ているかだけ確認 | 所要時間の変化（@atproto/api 更新の影響） |
| **D+14** | 問題なければ **skylog を同じ手順で切り替え** | skylog は投稿数が多いので、当日は実行中ずっとログを見る |
| D+30 | 旧実行環境を撤去。旧リポジトリを Archive | - |

**skylog 固有の注意**: 投稿間に sleep が無い（`// await sleep(1000)` がコメントアウト）。
@atproto/api を新しくするとレート制限の挙動が変わる可能性がある
（findings 3章「実行時は未検証」）。**切り替え当日は実行中ずっとログを見る**、
かつ `core/retry.ts` に 429 のバックオフを入れておく。

---

## E. Rust をどうするか

### 結論: **TypeScript に寄せる。Rust 版（skylog main）は移行しない。**

### 判断根拠

| # | 根拠 | 内容 |
|---|---|---|
| 1 | **着手率が低い** | `src/main.rs` 71 行。フォロワー取得と自分の DID への `listRecords` を println! するだけ。**集計・投稿・スケジューラが全部未実装（2〜3 割）。** 残り 7 割を新規に書くコストが発生する |
| 2 | **依存が死んでいる** | `aerostream` は **2024-05 で更新停止**。`Cargo.toml` は `"*"` 指定（Cargo.lock 上 0.14.3）。AT Protocol の lexicon はその後も変化している（findings 3章の `status` 型変更が実例）。**更新停止したクライアントを本番に載せるのは負債** |
| 3 | **乗り換え先も実質ゼロから** | atrium-api 等に替えるにしても aerostream 前提のコードは使えず、書き直しになる |
| 4 | **動く TS 実装が既にある** | skyhigh は TS で 2 年以上本番稼働（4,847 投稿）。skylog も js_mode の TS で 59,590 投稿。**完成している方を捨てて未完成の方を完成させる合理性がない** |
| 5 | **保守者が 1 人** | 2 言語のツールチェイン・依存更新・型定義を維持するコストが、得られるものに見合わない |
| 6 | **この環境に Rust が無い** | cargo / rustc 未インストール。rustup はユーザー領域に入れられるが、**N100 ではビルドが重い**。sudo 不可の制約下で追加の面倒を背負う |
| 7 | **性能上の動機が存在しない** | **これが最も強い根拠。** 現状のボトルネックは CPU ではなく **ネットワーク待ち**（370 人 × 直列 `getAuthorFeed`）+ findings 4章の「打ち切り判定が効かず常に全 20 ページ取りに行く」バグ。**Rust にしても 1 秒も速くならない。** 並列化とページ打ち切り修正（Phase 5）で解決する問題であって、言語の問題ではない |

根拠 7 が決定的。もし Rust 化の動機が「速くしたい」だったのなら、
**その動機自体が診断ミス**だった。同じ問題は TS のまま Phase 5 で解決できる。

### Rust 版の資産と、将来 firehose が必要になったとき

`filters.yaml` は firehose のフィルタ定義だが中身は `All` のみで、`main.rs` から
**一度も読まれていない**（firehose 購読は着手すらしていない）。したがって
設計情報としての価値は実質ゼロで、コードとして持ち込む意味はない。ファイル自体は
Archive した旧リポジトリの `main` ブランチに残り続けるので**消えはしない**。
一方「firehose を購読したかった」という意図は記録に値するので、新リポジトリの
`docs/adr/0001-typescript-over-rust.md` に「2024-02 に Rust + aerostream で
firehose 購読を試み、投稿取得の段階で中断した」という経緯と、旧リポジトリの
該当コミット（`973d147`）へのリンクを文章で残す。将来 firehose が本当に必要に
なった場合（例: 日次ポーリングをやめてリアルタイムに投稿数を数える）は、
TypeScript の Jetstream 購読（`@skyware/jetstream` or 生 WebSocket）で実装する。
Jetstream は JSON を流すので **CAR / DAG-CBOR のデコードが不要**で、
Rust を持ち出す必然性がそもそもない。ただし firehose 購読は**常駐プロセス**を
要求するため、C で決めた「one-shot 実行 + systemd timer」の前提が崩れる。
その時点で改めて設計をやり直す（専用の `systemd --user` service を 1 本立て、
投稿数は DB or ファイルに蓄積し、日次の集計 Bot はそれを読むだけにする）。
**今は決めない。**

---

## F. 統合先リポジトリ名の候補

`ShinoharaTa/*` の既存: bsky-skyhigh, bsky-skylog, bsky-massdriver, skynow,
bsky-yearsummary2025, bsky-awesome-appview, awesome-bot。
**下記 5 件はすべて未使用を確認済み**（2026-09-22、`gh repo view` で 404）。

| 候補 | 理由 | 評価 |
|---|---|---|
| **`bsky-bots`** | 既存の `bsky-*` 命名（massdriver / yearsummary2025 / awesome-appview）に完全に揃う。中身がそのまま名前で説明が要らない。**ローカルの作業ディレクトリが既に `~/workspace/bsky-bots`** なので `c bsky-bots` がそのまま使える | **◎** |
| `skybots` | 両 Bot が `sky*` なので語感が合う。ただし `bsky-` prefix の並びから外れ、`skynow` と紛らわしい | ○ |
| `bsky-daily` | 両 Bot とも「前日分を日次集計」で機能を的確に表す。ただし将来 firehose 常駐や非日次の Bot を足すと名前が嘘になる | ○ |
| `bsky-suite` | Bot 以外（Web UI 等）を足しても嘘にならない。ただし 2 個で "suite" は大げさ | △ |
| `bsky-botbox` | 「箱」＝モノレポの含意。やや造語的で毎回説明が要る | △ |

### 推薦: **`bsky-bots`**

既存命名に揃い、ローカルディレクトリ名と一致し、説明不要。
`awesome-bot`（既存・別物）と紛らわしくないかは一応確認したが、
`bsky-` prefix があるので区別できる。

---

## 決定事項 / 未決事項

### 決定（この設計で確定してよいもの）

| # | 決定 | 根拠 |
|---|---|---|
| 1 | 構成は**案1（単一パッケージ + `src/bots/`）**。npm、workspaces なし | Bot 2 個・依存同一・1 人保守。案2 へは後から移行可 |
| 2 | git は **subtree で履歴を残す**。skylog は **js_mode のみ**、main（Rust）は引かない | 53e971c で分岐した別系統。Rust は放棄された実験。履歴は archive 側に残る |
| 3 | 旧リポジトリは **README 差し替え → push → Archive**。削除しない | push は archive 前にしかできない。skylog の README に「本番は js_mode」を必ず書く |
| 4 | 秘密は **.env 1 本**（Bot 名プレフィックス）、非秘密は **TS のオブジェクト** | 設定ファイル形式を増やさない。型が効く |
| 5 | **Bot ごとに別プロセス（one-shot）** | 片方ずつ切り替えられることが移行安全性の前提 |
| 6 | スケジューラは **systemd --user timer**。node-cron / axios は依存から削除 | 前例あり・常駐 0・ログ集約。node-cron は systemd との二重管理 |
| 7 | **dry-run を既定にする**（`--live` を明示したときだけ投稿） | 手で叩いて事故る経路を塞ぐ。最も効く安全装置 |
| 8 | 切り替えは **skyhigh → 2 週間 → skylog** | 事故時の被害が skyhigh の方が小さい |
| 9 | **Rust は移行しない。TS に寄せる** | 根拠 7 件（特に「ボトルネックは I/O なので Rust でも速くならない」） |
| 10 | リポジトリ名は **`bsky-bots`** | 既存命名に一致。未使用確認済み |
| 11 | `biome: ^0.2.2` を削除し `@biomejs/biome@2.5.14` + `biome migrate`。**初回フォーマットは独立コミット** | 別物のパッケージ。全ファイルが差分になるので分離必須 |
| 12 | Phase 2 では**出力を 1 バイトも変えない**。バグ修正は Phase 5 | 新旧 diff での検証を成立させるため |

### 未決（誰が決めるか付き）

| # | 未決事項 | 決める人 | いつまでに | ブロックするもの |
|---|---|---|---|---|
| **1** | **現在どこで Bot が動いているか** | **ユーザー**（調査で判明しなかった） | Phase 4 の前 | **Phase 4 全体。最重要** |
| 2 | 旧環境の cron を止める手段があるか | ユーザー | Phase 4 の前 | 止められない場合、**二重投稿が避けられず統合自体が成立しない** |
| 3 | 旧環境の App Password を回収できるか | ユーザー | Phase 4 の前 | 不可なら再発行（Bot 2 組） |
| 4 | Phase 5 のバグ修正をどこまでやるか（打ち切り判定 / 並列化 / `@handle.invalid` / 定型文の数値不一致） | ユーザー | Phase 4 完了後 | Phase 5 のみ |
| 5 | skyhigh の定型文「3000 投稿まで」を実装に合わせるか、実装を定型文に合わせるか | ユーザー（**出力の変更なので設計では決めない**） | Phase 5 | Phase 5 のみ |
| 6 | `strict: true` をいつ入れるか | 実装者の判断で可（Phase 5 推奨） | - | なし |
| 7 | `moment-timezone` を置き換えるか | 実装者の判断で可 | - | なし |

---

## 付録: 調査後に追加で気づいた事実（findings に無いもの）

| # | 事実 | 影響 |
|---|---|---|
| 1 | **skylog js_mode の `package.json` の `name` が `"skyhigh"`** | コピペの残骸。モノレポ化で自動的に解消 |
| 2 | **skylog の `getPosts` は 15 ページループ**（skyhigh は 20）。定型文は「1000 投稿まで」だが実装は 15×100 = **1500** | findings 4章の「表示と実装の不一致」が **skylog にも存在する**。未決事項 5 に skylog 分も含める |
| 3 | skylog の `post()` ヘルパーだけが `agent.api.app.bsky.feed.post.create({repo: self.handle})` を使い、`langs` も `facets` も付けない。一方ランキング本体は `agent.post()` を使う。**同一ファイル内で 2 系統の投稿方法が混在** | core の `Poster` に寄せれば解消。ただし**集計開始/終了投稿に `langs` が付く変化が起きる**ので、Phase 2 の「出力を変えない」に抵触。diff 時に許容差分として明示する |
| 4 | `signal-digest-backup.timer` が既に稼働中（`OnCalendar` で日次） | **systemd --user timer の前例が実在する**。C の推薦の裏付け |
| 5 | 現在メモリ空き 9.5 GB / 16 GB、常駐 5 サービス | one-shot 実行なら余裕。常駐を増やさない判断の裏付け |
