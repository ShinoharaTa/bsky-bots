# bsky-nodecron 突き合わせ結果（2026-10-22）

対象: `ShinoharaTa/bsky-nodecron`（public, main `8556246`, 最終 push 2024-05-17）
置き場所: `~/workspace/bsky-bots/bsky-nodecron/`（`.git/info/exclude` で bsky-bots の追跡対象外にしてある。コミットはしていない）
方針: **移植ではなく作り直し**。nodecron のコードは要件の出典としてのみ扱う。

調査は読み取りのみ（公開 API・公開 JSON の GET）。本番アカウントへの投稿、認証情報の作成・コミット、issue/PR/commit はしていない。

---

## 0. 結論

1. **nodecron は skyhigh / skylog とは別の Bot を 3 つ動かしている。** 機能（集計ロジック）は重複していない。
   重複は基盤（ログイン・投稿・定時実行・.env の持ち方）だけ。
2. **bsky-bots の設計・実装・docs には 3 つとも一切出てこない**（`grep` で 0 件）。統合の対象として漏れていた。
3. **時報 Bot（`jiho.bsky.social`）は今も本番稼働中**。GCP 上で動いていると推定される（後述）。
   bsky-bots の切り替え手順（`docs/deploy.md` 8 章）どおりに **GCP を撤去すると時報も止まる**。
4. WN Live Bot（`shino5.bsky.social`）は **2024-03-30 にオーナー自身が停止を告知済み**。コード上はまだスケジュールされている。
5. 起動通知（system）は、systemd timer の one-shot 構成では意味を持たない。Discord 失敗通知で代替できる。

---

## 1. nodecron の中身

### 構成

| ファイル | 役割 |
| --- | --- |
| `src/cron.ts` | エントリ。常駐プロセス。起動時に system を 1 回実行し、node-cron で 3 ジョブを登録 |
| `src/common/bsky.ts` | `BskyUtils`: BskyAgent 生成・login・RichText 付き post。**例外は全部 catch して console.error するだけ** |
| `src/jiho/jiho.ts` | 時報 |
| `src/wnlive-schedule/wnlive.ts` + `casters.ts` | ウェザーニュースLiVE 番組表 |
| `src/system/system.ts` | 起動通知 |
| `src/index.ts` | 全行コメントアウト（未使用） |

依存は skyhigh / skylog と同じ世代の問題を抱えている: `@atproto/api ^0.12.10`、`"biome": "^0.2.2"`（別物のパッケージ）、`@babel/*`（未使用）、`moment-timezone`、`node-cron`、`axios`。

### スケジュール（`src/cron.ts:19-21`）

```ts
cron.schedule("45 18 * * *", wn.process);       // WN Live 18:45
cron.schedule("25 8 * * *",  wn.process);       // WN Live 08:25
cron.schedule("57,27 * * * *", jh.process);     // 時報 毎時 27 分・57 分
```

- **`timezone` オプションを渡していない**ので、サーバのローカル TZ で動く。
  WN Live の実投稿が 08:25 / 18:45 JST に出ていたので、実行ホストの TZ は JST だったと推定（確認済みは投稿時刻のみ）。
- 起動時に `sys.process()` を 1 回だけ実行（`cron.ts:16-17`）。

### アカウント（`.env.sample`）

`SYSTEM_AUTHOR/PASSWORD`、`WNLIVE_AUTHOR/PASSWORD`、`JIHO_AUTHOR/PASSWORD` の 3 組。実アカウントは公開情報から次のように特定した:

| Bot | アカウント | 根拠 | 現状 |
| --- | --- | --- | --- |
| 時報 | `jiho.bsky.social`（割と正確な時報さん, did:plc:kyahghqq3o2mujxdx76wqs5y） | 投稿文面 `なう(YYYY/MM/DD HH:mm:ss)` が一致 | **稼働中**。総投稿 61,705、直近 2026-10-22 16:01 |
| WN Live | `shino5.bsky.social`（WeatherNews Live Schedule, did:plc:whmzww6zz4anzgwc7ts6ls75） | 投稿文面 `■ これからのスケジュールをお知らせします。` が一致 | **2024-03-30 停止**（本人が「さやっちの卒業を持ちまして、スケジュールカレンダーの自動投稿を停止します。」と投稿） |
| system | 不明 | 文面 `system: batch startup` を持つ投稿を公開 API で見つけられなかった（searchPosts は 403） | 不明（**要確認**） |

### 実行場所

- この N100 サーバには crontab・systemd timer・node プロセスとも無い（bsky-bots 調査時と同じ）。
- skyhigh / skylog と同じ GCP ホストで動いている可能性が高い（**推測**。同じ作者・同時期・同じ `node-docker` 系の構成）。

---

## 2. 各ジョブの詳細仕様（実装から抽出）

### 2-1. 時報（jiho）

| 項目 | nodecron の挙動 | 出典 |
| --- | --- | --- |
| 起動 | 毎時 :27 と :57（サーバ TZ） | `cron.ts:21` |
| ゆらぎ | `Math.random() * 360000` ms の setTimeout。**コメントは「5分」だが実装は 0〜6 分** | `jiho.ts:11` |
| 本文 | `なう(${YYYY/MM/DD HH:mm:ss})`。時刻は**ゆらぎ待ちの後**の JST 現在時刻 | `jiho.ts:14,17` |
| facets / langs | detectFacets は通すが該当なし。**langs なし** | `bsky.ts:30-36`、実投稿で確認 |
| ログイン | **毎回 login**（1 日 48 回） | `jiho.ts:16` |
| 失敗時 | login 失敗も post 失敗も `console.error` のみ。後続の post は未ログインで失敗して null を返す。**通知なし・リトライなし** | `bsky.ts:21-23,42-44` |

**実測（直近 3,000 件、2026-08-21〜10-22）**

| 項目 | 値 |
| --- | --- |
| スロットからの遅れ | 0〜5 分台がほぼ均等（各 485〜522 件）、6 分台 12 件、8 分台 1 件 |
| 30 分枠 3,006 のうち投稿 0 の枠 | **8 枠（0.3%）**。黙って欠落している（通知なし） |
| 二重投稿 | 0 |
| `なう(...)` 以外の投稿 | 0（system 通知は時報アカウントからは出ていない） |

欠落した枠: 2026-08-24 05:27 / 09-04 14:27 / 09-17 07:57 / 09-22 10:27 / 10-02 04:27 / 10-07 20:57 / 10-16 00:27 / 10-19 19:27（JST、スロット起点）

### 2-2. WN Live 番組表（wnlive）

| 項目 | nodecron の挙動 | 出典 |
| --- | --- | --- |
| 起動 | 毎日 08:25 と 18:45（サーバ TZ） | `cron.ts:19-20` |
| 取得元 | `http://smtgvs.weathernews.jp/a/solive_timetable/timetable.json`（**http**、タイムアウト指定なし、axios） | `wnlive.ts:12-14` |
| 本文 | `■ これからのスケジュールをお知らせします。\n\n` + 各枠 `${hour}～ （${caster}）\n` | `wnlive.ts:18,33` |
| 枠の除外 | `title` から `ウェザーニュースLiVE` を除いて空になる枠（＝無印の放送待機枠）は出さない | `wnlive.ts:32` |
| キャスター名 | `casters.ts` の ID→氏名表（11 人）。**表に無い ID は ID のまま表示**。空なら `公式チャンネル` | `wnlive.ts:20-30` |
| 末尾処理 | `/\n\n$/` を削るが、本文は単一 `\n` で終わるので**実質効いていない** | `wnlive.ts:36` |
| 300 字 | **チェックなし**。2023-06-08 に「文字数オーバー修正」として 1 枠 2 行→1 行に短縮した経緯あり | `7e54b9a` |
| 失敗時 | axios の例外は node-cron が `task-failed` イベントに流すだけ（誰も購読していない）→ **黙って欠落**。プロセスは落ちない | node-cron 3.0.3 `task.js:18-25` で確認 |

**現状確認**

- API は**今も生きている**（http / https とも 200、JSON 配列 `{hour, title, caster}`）。
- 2026-10-22 時点の API に `matsumoto2025` という**表に無い ID** が含まれる。旧投稿にも `okamoto2023`・`aohara2023` が ID のまま出ていた → **氏名表の陳腐化は実害として既に出ていた**。
- アカウントは 2024-03-30 に停止告知済み。以後投稿なし。
  ただしコードは今もスケジュールしている。投稿が出ていないのは、認証情報を外した・無効にした等のためと推定（**推測**。login 失敗は黙殺される実装なので外からは区別できない）。

### 2-3. 起動通知（system）

| 項目 | nodecron の挙動 | 出典 |
| --- | --- | --- |
| 起動 | プロセス起動時に 1 回 | `cron.ts:16-17` |
| 本文 | `@shino3.bsky.social\nsystem: batch startup` | `system.ts:11` |
| 宛先 | **`@shino3.bsky.social`（旧ハンドル）**。現在このハンドルは「My handle name is now @shino3.net」と書かれた**別アカウント**で、メインの `@shino3.net` には通知が届かない | 公開プロフィールで確認 |
| 失敗時 | 黙殺 | `bsky.ts` |

---

## 3. 対応表: nodecron の機能 → bsky-bots

凡例: **対応済** = bsky-bots の実装（main `9d058f1`）で満たしている / **未対応** = 新実装の要件として追加が必要 / **不要** = 作り直しでは持たない（理由付き） / **要判断** = ユーザーの判断が要る

### 3-1. Bot（機能）

| # | nodecron の機能 | bsky-bots | 備考 |
| --- | --- | --- | --- |
| F1 | 時報 `なう(...)` を毎時 :27 / :57 に投稿 | **未対応** | 稼働中の Bot。GCP 撤去で止まる。要件 R1 |
| F2 | 時報の 0〜6 分のランダム遅延 | **未対応** | systemd の `RandomizedDelaySec=` で置き換え可能。要件 R1 |
| F3 | WN Live 番組表を毎日 08:25 / 18:45 に投稿 | **要判断（推奨: 不要）** | 2024-03-30 に本人が停止告知済み。復活させるなら要件 R2 |
| F4 | WN Live のキャスター ID→氏名変換 | **要判断** | F3 を復活させる場合のみ。表が陳腐化済み（`matsumoto2025` 等） |
| F5 | 起動通知 `system: batch startup` | **不要** | one-shot + timer 構成では「起動」が毎回発生し意味を持たない。異常検知は Discord 失敗通知（PR #14）で代替。宛先も旧ハンドルで既に機能していなかった |

### 3-2. 基盤（共通部分）

| # | nodecron の機能 | bsky-bots | 備考 |
| --- | --- | --- | --- |
| C1 | Bot ごとの認証情報（`<BOT>_AUTHOR` / `_PASSWORD`） | **対応済（形式は変更）** | bsky-bots は `<BOT>_IDENTIFIER` / `<BOT>_APP_PASSWORD`。時報を足すなら `JIHO_*` を追加 |
| C2 | BskyAgent + login + RichText 付き post | **対応済** | `core/client.ts`・`core/poster.ts`。AtpAgent・429 リトライ付き |
| C3 | 定時実行（node-cron 常駐） | **対応済（方式は変更）** | systemd --user timer の one-shot。分単位・毎時のスケジュールも書ける |
| C4 | タイムゾーン（サーバローカル依存） | **対応済（改善）** | timer に `Asia/Tokyo` を明記。本文の時刻も JST で生成 |
| C5 | 失敗時は console.error して黙殺 | **対応済（改善）** | exit 1 → OnFailure → Discord。ただし**高頻度ジョブでの通知の扱いが未定義**（要件 R3） |
| C6 | 1 プロセスで全 Bot | **不要** | Bot ごとに別プロセス（片方の障害が他方を巻き込まない）。nodecron は 1 プロセス停止で時報も WN も同時に止まる構成だった |
| C7 | 外部 HTTP（axios, http, タイムアウトなし） | **一部対応** | `core/retry.ts` に fetch + タイムアウト + 429/5xx リトライがある。PDS/AppView 向けの作りなので、任意の外部 JSON 取得に使えるかは要確認（R2 を作る場合のみ） |
| C8 | dry-run | **対応済（nodecron には無い）** | `--live` 無しでは投稿しない。時報にもそのまま効く |

### 3-3. bsky-bots の core が非集計 Bot を想定していない点

時報を載せるには、今の core を一般化する必要がある（**未対応**）。

| 箇所 | 現状 | 問題 |
| --- | --- | --- |
| `core/types.ts` `BotDefinition` | `defaultHandle`・`followersMaxPages`・`feedLimits`・`abortPolicy` が**必須** | 時報には意味がない値を埋めることになる |
| `core/types.ts` `BotContext` | `actor`・`bounds`・`limitFollowers` を常に渡す | 同上 |
| `cli.ts` | 引数は `--limit-followers` 前提、usage も集計 Bot 向け | 時報では無意味 |
| `core/config.ts` `resolveActor` | dry-run でも `<BOT>_IDENTIFIER` かフォロワー取得先を要求 | 時報は誰のフォロワーも読まない |
| `docs/deploy.md` | 受け入れ条件 A〜E が「集計結果の突き合わせ」前提 | 時報向けの受け入れ条件が無い |
| `abortPolicy` | 「取得失敗が続く」判定 | 時報は 1 回 1 投稿。**実行をまたいだ連続失敗**で判定する必要がある（R3） |

---

## 4. 新実装の要件（漏れていた分）

### R1. 時報 Bot（必須。稼働中のため）

**機能**
- R1-1. 毎時 :27 と :57（JST）を起点に、**0〜6 分のランダムな遅延**の後に投稿する。
  - 現行の実測（遅れ 0〜5 分台がほぼ均等）を維持する。コメントの「5 分」と実装の「6 分」の食い違いは、**実装（6 分）に合わせる**のを推奨（利用者から見える挙動を変えない）。要判断。
- R1-2. 本文は `なう(YYYY/MM/DD HH:mm:ss)`。**時刻は投稿直前の JST 現在時刻**（スロット時刻ではない）。
- R1-3. langs・facets は付けない（現行の実投稿と一致させる）。
  - bsky-bots の `Poster` は langs `["ja"]` を付ける作りなので、**langs を付けない投稿ができるようにする**か、付けてよいかを決める。要判断（付けても見た目は変わらない）。
- R1-4. アカウントは `jiho.bsky.social`。認証情報は `JIHO_IDENTIFIER` / `JIHO_APP_PASSWORD`。App Password は **新規発行**（bsky-bots の #8 と同じ方針）。

**実行方式**
- R1-5. systemd --user timer の one-shot。
  - `OnCalendar=*-*-* *:27,57:00 Asia/Tokyo`
  - `RandomizedDelaySec=360`（systemd がランダム遅延を入れる。プロセス内で sleep しない）
  - `AccuracySec=1s`
  - `Persistent=false`（取り返し実行で時刻のずれた「なう」を出さない）
- R1-6. 毎回ログインする（1 日 48 回）。Bluesky の createSession のレート制限内に収まるかを確認する（**未確認**。超えるならセッションを保存して resumeSession する）。
- R1-7. dry-run（既定）では投稿しない。`--live` は unit にだけ書く。

**失敗時（現行は 0.3% の枠が黙って欠落）**
- R1-8. 投稿失敗は exit 1。429 は bsky-bots の既存方針どおり Retry-After を尊重してリトライ（ただし**次のスロットにはみ出さない**よう上限を短くする）。
- R1-9. 二重投稿を避けるため、5xx はリトライしない（bsky-bots と同じ方針）。

### R2. WN Live 番組表（復活させる場合のみ）

- R2-1. 毎日 08:25 / 18:45 JST。
- R2-2. 取得元は **https** で、タイムアウト付き。失敗したら投稿せず exit 1。
- R2-3. 本文の形式は現行どおり（`■ これからのスケジュールをお知らせします。` + `HH:MM～ （氏名）`）。無印の放送待機枠は出さない。キャスター空は `公式チャンネル`。
- R2-4. **氏名表に無い ID が来たときの扱いを決める**（現行は ID をそのまま出していて、実際に `okamoto2023` 等が出ていた）。案: ID を出さず `出演者未登録` 等にする／氏名表を設定ファイル化して更新しやすくする。要判断。
- R2-5. 300 grapheme を超えたら末尾の枠から削る（現行はチェックなし）。
- R2-6. 末尾の改行処理は現行バグ（効いていない）を再現しない。

### R3. 高頻度ジョブの失敗通知ポリシー（時報を載せるなら必須）

- R3-1. bsky-bots の Discord 失敗通知は「1 回失敗 = 1 通知」。時報は 1 日 48 回動くので、Bluesky 障害時に**最大 48 通/日**の通知になる。
- R3-2. 要件案: **連続 N 回（例 3 回 = 約 1.5 時間）失敗したときだけ通知**し、復旧したら 1 回だけ「復旧」を通知する。連続失敗回数は状態ファイル（例 `~/.local/state/bsky-bots/jiho.json`）に持つ。要判断。
- R3-3. 単発の欠落（現行 0.3%）は通知しない。journal には残す。

### R4. core の一般化（R1 の前提）

- R4-1. `BotDefinition` を「集計 Bot 専用の設定」と「全 Bot 共通」に分ける（`followersMaxPages`・`feedLimits`・`abortPolicy`・`defaultHandle` を任意にするか、集計 Bot 用の型に移す）。
- R4-2. `cli.ts` の引数を Bot ごとに定義できるようにする（時報に `--limit-followers` は不要。`--live` と dry-run は共通）。
- R4-3. `docs/deploy.md` に時報の受け入れ条件を足す。案:
  - dry-run で本文の形式が `なう(YYYY/MM/DD HH:mm:ss)` と一致
  - `systemd-analyze calendar '*-*-* *:27,57:00 Asia/Tokyo'` の次回時刻が期待どおり
  - 切り替え後 24 時間で 48 件、二重 0、欠落の枠を数える

### R5. 切り替え手順への影響（必須）

- R5-1. **bsky-bots の `docs/deploy.md` 8 章「GCP 撤去」の前に、時報の移行を完了させる**こと。今の手順のまま GCP を撤去すると、時報が止まる。
- R5-2. 時報の移行は skyhigh / skylog と独立にできる（実行時刻が重ならない、アカウントも別）。
  切り替え当日の段取りは skyhigh と同じ「GCP 側の時報を止めた確認 → 新 timer 有効化」。
  - nodecron は 1 プロセスなので、**GCP 側で時報だけ止める手段があるか**を確認する必要がある（cron.ts に 3 ジョブが同居しているため、止めるならプロセスごと。system と WN も一緒に止まるが、どちらも実害なし）。
- R5-3. 時報の移行と同時に、nodecron 側の `WNLIVE_*`・`SYSTEM_*` の App Password も Revoke 対象に入れる（#8 と同じ扱い）。

---

## 5. ユーザーに確認したいこと

> **2026-10-22 回答済み**: WN Live は復活させない / 起動通知は廃止（アカウント特定不要、App Password は失効候補に載せるだけ）/ ゆらぎは 0〜6 分 / 時報の失敗通知は実装しない / 時報は bsky-bots に入れる。
> 以下の要件 R3（失敗通知）と R2（WN Live）は**取り下げ**。確定版の要件と手順は [jiho-migration-plan.md](jiho-migration-plan.md)。

1. **WN Live を復活させるか**（推奨: しない。2024-03-30 に停止告知済み）
2. **system の起動通知に使っていたアカウントはどれか**（公開情報からは特定できなかった。Revoke 対象の洗い出しに必要）
3. 時報のゆらぎは **0〜6 分（現行の実装）**でよいか、コメントどおり 0〜5 分にするか
4. 時報の失敗通知は「連続 3 回で通知・復旧時に 1 回」でよいか
5. 時報の投稿に `langs: ["ja"]` を付けてよいか（見た目は変わらない）
6. 時報を bsky-bots に入れるか、別リポジトリにするか（推奨: bsky-bots に入れる。基盤・デプロイ手順・失敗通知を共有できる）

---

## 6. 参考: 調べた方法

- nodecron: `git log --all`、全ソース・`.env.sample`・`package.json` を読んだ。`7e54b9a`（文字数オーバー修正）と `1b9c293`（投稿の有効化）の差分を確認。
- アカウント特定: `shino3.net` / `shino3.bsky.social` のフォロー・フォロワー計 1,932 アカウントのプロフィールを公開 API で走査し、文面の一致で確認。
- 時報の実測: `jiho.bsky.social` の公開フィード 3,000 件（2026-08-21〜10-22）を集計。
- WN Live API: `http://` と `https://` に GET（いずれも 200）。
- node-cron の例外処理: 3.0.3 の tarball を展開し `src/task.js` を確認（Promise の reject は `task-failed` に流され、プロセスは落ちない）。
- bsky-bots: main `9d058f1` の `src/core/types.ts`・`src/cli.ts`・`src/core/config.ts`・`deploy/`・`docs/` を確認。nodecron 関連の記述は 0 件。
