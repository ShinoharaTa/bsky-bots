# 時報 Bot を bsky-bots に載せる: 要件と作業手順（2026-10-22）

前提資料: [nodecron-gap-analysis.md](nodecron-gap-analysis.md)
状態: **#20 / #21 / #22 で実装**

> **2026-10-22 更新**: デプロイは「全 Bot を止めてから一斉に稼働」、実行は OS の systemd（Ubuntu / Proxmox Debian LXC）に変更。
> 下記 2 章の **J3〜J7（配置・時報単独の切り替え・GCP 撤去）は [deploy.md](deploy.md) に置き換え**。
> 1 章の要件と J1・J2（実装）はそのまま有効。ただし J-R1 の「`~/deploy/bsky-bots` から動かす」は `/opt/bsky-bots` に読み替える。

---

## 0. 決定事項（2026-10-22 ユーザー回答）

| # | 論点 | 決定 |
| --- | --- | --- |
| D1 | WN Live 番組表 | **復活させない** |
| D2 | 起動通知（system） | **廃止**。通知は Discord に寄せる。使っていたアカウントの特定は不要。その App Password は**失効候補リストに載せるだけ** |
| D3 | 時報のゆらぎ | **0〜6 分**（現行の実装どおり） |
| D4 | 時報の失敗通知 | **実装しない**（Discord 通知も出さない） |
| D5 | 置き場所 | **bsky-bots に入れる** |

この文書で置いた前提（覆せる）:

- **P1. 時報の投稿に `langs` を付けない**。現行の実投稿と同じにする（見た目は変わらない）。
- **P2. 毎回ログインする**（1 日 48 回）。現行の nodecron が同じ頻度で 3 年以上ログインし続けており、実績上問題が出ていないため。

---

## 1. 要件

### 1-1. 機能（利用者から見える挙動。現行と同じにする）

| ID | 要件 | 現行の出典 |
| --- | --- | --- |
| J-F1 | 毎時 **:27 と :57（JST）**を起点に投稿する | `cron.ts:21` |
| J-F2 | 起点から **0〜6 分のランダムな遅延**の後に投稿する（一様分布） | `jiho.ts:11`（`Math.random() * 360000`） |
| J-F3 | 本文は `なう(YYYY/MM/DD HH:mm:ss)`。**時刻は投稿直前の JST 現在時刻**（起点の時刻ではない） | `jiho.ts:14,17` |
| J-F4 | `langs`・`facets` を付けない（P1） | 実投稿で確認 |
| J-F5 | アカウントは `jiho.bsky.social`（did:plc:kyahghqq3o2mujxdx76wqs5y） | 公開プロフィール |

現行の実測（2026-08-21〜10-22、3,000 件）: 遅れは 0〜5 分台がほぼ均等、30 分枠の欠落 0.3%（8 枠）、二重投稿 0。
**切り替え後もこの水準を下回らないこと**を受け入れの目安にする。

### 1-2. 実行方式

| ID | 要件 | 理由 |
| --- | --- | --- |
| J-R1 | systemd --user timer の one-shot。skyhigh / skylog と同じ本番ツリー `~/deploy/bsky-bots` から動かす | 既存の運用に揃える |
| J-R2 | `OnCalendar=*-*-* *:27,57:00 Asia/Tokyo`（**検証済み**: systemd 255 で :27 / :57 に毎時発火） | J-F1 |
| J-R3 | `RandomizedDelaySec=360`。**プロセス内で sleep しない** | J-F2。待ち時間をプロセスが抱えない |
| J-R4 | `AccuracySec=1s` | 既定の 1 分の丸めがゆらぎに上乗せされるのを防ぐ |
| J-R5 | `Persistent=false` | 停止明けの取り返し実行で、時刻のずれた「なう」を出さない |
| J-R6 | `TimeoutStartSec=600` 程度 | 次の起点（30 分後）より十分前に必ず終わらせる |
| J-R7 | **`OnFailure=` を付けない**（D4） | 失敗は journal に残るだけにする |
| J-R8 | 毎回ログインする（P2）。認証情報は `JIHO_IDENTIFIER` / `JIHO_APP_PASSWORD` | bsky-bots の .env 形式 |
| J-R9 | 既定は dry-run。`--live` は unit の `ExecStart` にだけ書く | bsky-bots の既存方針 |

### 1-3. 失敗時

| ID | 要件 |
| --- | --- |
| J-E1 | 投稿・ログインに失敗したら **exit 1**（journal で後から欠落を追えるようにする。通知はしない） |
| J-E2 | 429 は Retry-After を尊重してリトライ。ただし**合計待ち時間に上限**（例 3 分）を設け、次の起点にはみ出さない |
| J-E3 | 5xx はリトライしない（受理済みかもしれず、二重投稿になるため。bsky-bots の既存方針） |
| J-E4 | 欠落した回を後から埋める投稿はしない（「なう」が実時刻とずれるため） |

### 1-4. core の一般化（時報を載せる前提作業）

いまの core は「フォロワーの前日投稿を集計する Bot」専用になっている。時報を載せるために分ける。

| ID | 要件 |
| --- | --- |
| J-C1 | `BotDefinition` の集計専用フィールド（`defaultHandle`・`followersMaxPages`・`feedLimits`・`abortPolicy`）を、集計 Bot 用の型に移すか任意にする。**全 Bot 共通は `name`・`run`・エラー時の扱いだけ**にする |
| J-C2 | `BotContext` の `agent`（読み取り用）・`actor`・`bounds`・`limitFollowers` を集計 Bot 側に寄せる。時報には `poster` だけ渡れば足りる |
| J-C3 | CLI の引数を Bot ごとに定義できるようにする。`--live` と dry-run は共通、`--limit-followers` は集計 Bot だけが受け付ける |
| J-C4 | `Poster` で `langs` を付けない投稿ができるようにする（P1） |
| J-C5 | **skyhigh / skylog の出力を 1 バイトも変えない**。dry-run の正規化 diff で確認する |
| J-C6 | 投稿のリトライ（`retryOnRateLimit`）に**合計待ち時間の上限**を Bot ごとに指定できるようにする（J-E2） |

### 1-5. 受け入れ条件（時報）

| ID | 条件 | 確認方法 |
| --- | --- | --- |
| J-A1 | dry-run の出力が `なう(YYYY/MM/DD HH:mm:ss)` の形で、時刻が実行時の JST と一致 | `node dist/main.js jiho` を叩いて目視 |
| J-A2 | timer の次回発火時刻が :27 / :57 | `systemd-analyze calendar` と `systemctl --user list-timers` |
| J-A3 | 切り替え後 24 時間で、30 分枠の欠落が 1 枠以下、二重投稿 0 | 公開 API で集計（`docs/nodecron-gap-analysis.md` と同じ方法） |
| J-A4 | 遅れの分布が 0〜6 分に収まる | 同上 |
| J-A5 | skyhigh / skylog の dry-run 出力が core 一般化の前後で一致（J-C5） | 正規化 diff |

---

## 2. 作業手順

### 全体の順序

```
[J1] core の一般化（PR）
  ↓
[J2] 時報 Bot の追加（PR）
  ↓
[J3] 本番ツリーへの配置・App Password 新規発行・dry-run 確認
  ↓
[J4] 時報の切り替え（GCP の nodecron 停止 → 新 timer 有効化）
  ↓
[J5] 24 時間 → 7 日 観察
  ↓
（skyhigh / skylog の切り替え: docs/deploy.md の既存手順。J4 と独立に進めてよい）
  ↓
[J6] GCP 撤去 ＝ 3 Bot すべての移行が終わった後
  ↓
[J7] App Password の失効・旧リポジトリの Archive
```

**時報を skyhigh / skylog より先に切り替えるのを推奨する。** 理由:
- 機能が最も単純で、事故時の影響が最小（「なう」が 1〜2 回欠ける程度）
- 本番ツリー `~/deploy/bsky-bots`・`.env`・`~/.local/bin/node`・systemd user timer という**新しい実行基盤を最初に通す**のに向いている
- GCP 側の止め方が skyhigh / skylog と別（nodecron は常駐プロセス）なので、手順が干渉しない

### J1. core の一般化（PR 1 本）

- 対象: 1-4 の J-C1〜J-C6
- 担当: implementer（設計判断は 1-4 で確定済みのものに限る）
- 確認:
  - `tsc` / `biome` / `vitest` 通過
  - **J-A5**: skyhigh / skylog の dry-run（`--limit-followers=30`）を一般化の前後で取り、`createdAt` と時刻を除いて diff → 差分 0
  - `--live --limit-followers` の併用拒否が引き続き効く

### J2. 時報 Bot の追加（PR 1 本）

- `src/bots/jiho/`: 本文の生成（純関数）と `run`
- `deploy/bsky-jiho.service` / `deploy/bsky-jiho.timer`（1-2 の J-R2〜J-R7。**OnFailure なし**）
- `.env.sample` に `JIHO_IDENTIFIER=` / `JIHO_APP_PASSWORD=`
- `docs/deploy.md` に時報の章を追加（設置・切り替え・ロールバック・受け入れ条件 J-A1〜J-A4）
- `docs/deploy.md` 8 章（GCP 撤去）の前提に「**時報の移行完了**」を追加
- テスト: 本文の書式（JST・ゼロ埋め・日付跨ぎ）、`langs` が付かないこと、429 の合計待ち上限
- 確認: `systemd-analyze --user verify` 警告 0、dry-run で J-A1

### J3. 本番ツリーへの配置（ユーザー作業）

1. `jiho.bsky.social` の **App Password を新規発行**（旧は J7 まで失効させない。ロールバック用）
2. `~/deploy/bsky-bots` を J2 を含むタグに更新 → `npm ci && npm run build`
3. `.env` に `JIHO_IDENTIFIER` / `JIHO_APP_PASSWORD` を追記（`chmod 600` のまま）
4. unit を `~/.config/systemd/user/` に配置 → `systemctl --user daemon-reload`。**まだ enable しない**
5. dry-run で J-A1、`systemd-analyze calendar` で J-A2 を確認

### J4. 時報の切り替え（ユーザー作業）

**二重投稿を避けるため、「GCP 側を止めた確認」を「新 timer 有効化」より前に置く。**

| 時点 | 作業 | 確認 |
| --- | --- | --- |
| 事前 | GCP 上で nodecron がどう動いているかを確認する（pm2 / docker / systemd / screen 等）。**止め方と戻し方を手順として書き出す** | — |
| :35 頃 | 直前の :27 回の投稿が出たのを確認してから、**GCP の nodecron プロセスを停止**する。同居している WN Live（停止済み）と起動通知（廃止）も一緒に止まるが実害なし | — |
| :50 頃 | GCP の nodecron が止まっていることを確認する | プロセスが居ないこと |
| :50 頃 | `systemctl --user enable --now bsky-jiho.timer` | `list-timers` で次回が :57 |
| :57〜:03 | 新 timer からの投稿を確認する | `journalctl --user -u bsky-jiho`、公開 API で投稿 1 件 |
| +1 時間 | :27・:57 の 2 回とも出ていること、二重が無いこと | 公開 API |

**ロールバック**: `systemctl --user disable --now bsky-jiho.timer` → GCP の nodecron を再起動（旧 App Password は J7 まで生かしてあるのでそのまま動く）。

### J5. 観察

- 24 時間後: J-A3（欠落 1 枠以下・二重 0）、J-A4（遅れ 0〜6 分）
- 7 日後: 欠落率が現行（0.3%）と同等以下
- 失敗は通知しない（D4）ので、**観察期間中は journal を自分で見る**: `journalctl --user -u bsky-jiho --since '1 day ago' | grep -i -E 'error|fail'`

### J6. GCP 撤去（既存の docs/deploy.md 8 章を拡張）

撤去の前提条件（**すべて満たしてから**）:
- [ ] 時報: J5 の 7 日観察が終わっている
- [ ] skyhigh: 切り替え済み・観察済み（#4）
- [ ] skylog: 切り替え済み・観察済み（#4）
- [ ] GCP 上に上記以外に動いているものが無いことを確認した

### J7. 失効・後片付け

**App Password の失効候補リスト**（GCP 撤去の後に Revoke する）:

| アカウント | 用途 | 備考 |
| --- | --- | --- |
| `skyhigh.bsky.social` | 旧 skyhigh | #8（旧実装がトークンをログ出力） |
| `skylog.bsky.social` | 旧 skylog | #8 |
| `jiho.bsky.social` | 旧 nodecron の時報 | nodecron はトークンをログに出していない（確認済み）。衛生上の失効 |
| `shino5.bsky.social` | 旧 nodecron の WN Live（D1 で廃止） | 2024-03-30 以降投稿なし |
| 不明（`SYSTEM_AUTHOR`） | 旧 nodecron の起動通知（D2 で廃止） | アカウントは特定しない（D2）。GCP の nodecron の `.env` に残っている値で判断 |

その他:
- `ShinoharaTa/bsky-nodecron` の README に「bsky-bots に統合」と書いて push → Archive（skyhigh / skylog と同じ扱い）
- `~/workspace/bsky-bots/bsky-nodecron/` の作業用クローンと `.git/info/exclude` の行を削除
- `docs/` の現行仕様（spec.md を作る場合）に時報を追加

---

## 3. まだ決まっていないこと

| # | 論点 | いつまでに |
| --- | --- | --- |
| U1 | GCP 上で nodecron がどう動いているか（止め方・戻し方） | J4 の前（ユーザー作業） |
| U2 | 時報の切り替えを skyhigh / skylog より先にするか（**推奨: 先**） | J4 の前 |
| U3 | J1・J2 を issue/PR にするタイミング | ユーザー指示待ち |

---

## 4. 想定工数

| 段階 | 目安 | 担当 |
| --- | --- | --- |
| J1 core 一般化 | 半日 | implementer |
| J2 時報 Bot | 半日 | implementer |
| J3 配置 | 30 分 | ユーザー |
| J4 切り替え | 1 時間（:27〜:57 の 1 枠を使う） | ユーザー |
| J5 観察 | 7 日（作業は 1 日数分） | ユーザー |
