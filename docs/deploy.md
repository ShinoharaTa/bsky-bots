# デプロイ手順（systemd --user timer）

作成 2026-09-22 / 更新 2026-09-23 / 対象: issue #4（GCP の cron から自宅サーバーの systemd timer へ移す）

このリポジトリには unit ファイルを**置いてあるだけ**で、設置も起動もしていない。
以下は**ユーザーが自分の手で叩く**手順。コピペで実行できる形にしてある。

| ファイル | 役割 |
| --- | --- |
| `deploy/bsky-skyhigh.service` / `.timer` | skyhigh を毎日 08:45 JST に 1 回実行 |
| `deploy/bsky-skylog.service` / `.timer` | skylog を毎日 00:20 JST に 1 回実行 |
| `deploy/bsky-bots-failure@.service` | 失敗を journal に残し、Discord webhook に知らせる（`OnFailure=` から起動される） |
| `src/tools/notify-failure.ts` | 上の unit が呼ぶ Discord 通知 |
| `src/tools/compare-gcp.ts` | 受け入れ条件 A の突き合わせ（読み取りのみ） |

**本番は開発用ツリー（`~/workspace/bsky-bots`）では動かさない。** 別の clone
`~/deploy/bsky-bots` に**タグを checkout** して置く。開発用ツリーでブランチを切り替えたり
ビルドしたりしても、レビュー前のコードが `--live` で動かないようにするため。

| パス | 用途 |
| --- | --- |
| `~/workspace/bsky-bots` | 開発用。unit からは参照しない |
| `~/deploy/bsky-bots` | 本番用。タグを checkout。`dist/` と `.env` はここ |
| `~/.config/systemd/user/` | unit の設置先（`~/deploy/bsky-bots/deploy/` からコピー） |

---

## 0. 前提

### 0-1. `~/.local/bin/node` の symlink

systemd はシェルを経由しないので `~/.nvm/nvm.sh` は読まれない。
unit の `ExecStart` は `%h/.local/bin/node` を指している。
nvm のバージョンを上げたときは**この symlink を張り替えるだけ**で unit は直さない。

```bash
ls -l ~/.local/bin/node          # 既にあるか確認
ln -sfn ~/.nvm/versions/node/v24.20.0/bin/node ~/.local/bin/node
~/.local/bin/node --version      # v24.20.0
```

### 0-2. リリースのタグを打つ（開発用ツリーで）

本番に出すコミットにタグを打つ。**main にマージ済みのコミットだけ**にタグを打つ。

```bash
cd ~/workspace/bsky-bots
git fetch origin
git tag -a v1.0.0 -m "v1.0.0" origin/main
git push origin v1.0.0
```

### 0-3. 本番用ツリーを作る

```bash
install -d ~/deploy
git clone https://github.com/ShinoharaTa/bsky-bots.git ~/deploy/bsky-bots
cd ~/deploy/bsky-bots
git checkout --detach v1.0.0
source ~/.nvm/nvm.sh
npm ci
npm run build
ls -l dist/main.js dist/tools/notify-failure.js
git describe --tags --exact-match   # v1.0.0
```

`dist/` は git 管理外。**タグを切り替えたら必ず `npm ci && npm run build` し直す**（7 章）。

### 0-4. App Password は新規発行する（旧はまだ Revoke しない）

**旧 App Password を回収して使い回さない。両 Bot とも新規発行する。**
旧実装がリフレッシュトークンを毎日ログに出していた（#8）。

発行は Bluesky の Settings → App Passwords。

**ここでは旧 App Password を Revoke しない。** GCP の旧実装は旧 App Password でログインしている。
切り替え前に Revoke すると、その時点で GCP が投稿できなくなり、
**切り替えがうまくいかなかったときに戻す先も無くなる**。

旧 App Password の Revoke は、各 Bot の切り替えが安定して **GCP を撤去するとき**に行う（8 章）。
#8 の目的（ログに残ったトークンの無効化）はそこで達成される。

### 0-5. Discord webhook を用意する

失敗時のアラート先。Discord のチャンネル設定 → 連携サービス → ウェブフック → 新しいウェブフック →
「ウェブフック URL をコピー」。

**webhook URL は秘密情報**（知っていれば誰でもそのチャンネルに投稿できる）。
`.env` にだけ書く。チャットやログ、コミットに貼らない。

---

## 1. `.env` を置く

`~/deploy/bsky-bots/.env` に置く（`.gitignore` 済み）。変数名は `.env.sample` のとおり。

- `SKYHIGH_IDENTIFIER`
- `SKYHIGH_APP_PASSWORD`（0-4 で発行した**新しい**もの）
- `SKYLOG_IDENTIFIER`
- `SKYLOG_APP_PASSWORD`（同上）
- `DISCORD_WEBHOOK_URL`（0-5）

`AUTHOR` / `PASSWORD` へのフォールバックは無い。**Bot の 4 つは全部必要**（片方の Bot だけ動かす場合も、
`EnvironmentFile=` は同じファイルを読むので 4 つ揃っている方が事故が少ない）。

```bash
cd ~/deploy/bsky-bots
cp .env.sample .env
chmod 600 .env
$EDITOR .env
```

確認（**値は表示しない**）:

```bash
stat -c '%a %n' ~/deploy/bsky-bots/.env      # 600
cut -d= -f1 ~/deploy/bsky-bots/.env | grep -v '^#' | grep -v '^$'
# 値が空の変数を探す（何も出なければ全部埋まっている）
grep -E '^[A-Z_]+=$' ~/deploy/bsky-bots/.env
```

Discord 通知を試すとき（**実際に Discord に 1 件送られる**。本物の失敗ではないので
`Result` は `success` などになる）:

```bash
cd ~/deploy/bsky-bots
set -a; . ./.env; set +a
~/.local/bin/node dist/tools/notify-failure.js bsky-skyhigh.service; echo "exit=$?"
```

---

## 2. unit を検証してから設置する

### 2-1. 設置前の検証（警告が出たら設置しない）

```bash
cd ~/deploy/bsky-bots
systemd-analyze --user verify \
  deploy/bsky-skyhigh.service deploy/bsky-skyhigh.timer \
  deploy/bsky-skylog.service  deploy/bsky-skylog.timer \
  'deploy/bsky-bots-failure@.service'
echo "exit=$?"
```

**何も出力されず `exit=0` なら警告 0。**

`verify` が見るのは**最初の `ExecStart` の実行ファイルだけ**で、`WorkingDirectory` /
`EnvironmentFile` / 2 つ目以降の `ExecStart`（`bsky-bots-failure@` の Discord 通知）は見ない。
パスは別に確かめる:

```bash
for p in ~/.local/bin/node \
         ~/deploy/bsky-bots/dist/main.js \
         ~/deploy/bsky-bots/dist/tools/notify-failure.js \
         ~/deploy/bsky-bots/.env; do
  test -e "$p" && echo "OK      $p" || echo "MISSING $p"
done
```

起動時刻の解釈も確認できる（マシンの TZ は UTC。JST 表示にはならない）:

```bash
systemd-analyze calendar --iterations=3 '*-*-* 08:45:00 Asia/Tokyo'
systemd-analyze calendar --iterations=3 '*-*-* 00:20:00 Asia/Tokyo'
```

### 2-2. 設置

```bash
install -d ~/.config/systemd/user
cp ~/deploy/bsky-bots/deploy/bsky-skyhigh.service \
   ~/deploy/bsky-bots/deploy/bsky-skyhigh.timer \
   ~/deploy/bsky-bots/deploy/bsky-skylog.service \
   ~/deploy/bsky-bots/deploy/bsky-skylog.timer \
   ~/deploy/bsky-bots/deploy/'bsky-bots-failure@.service' \
   ~/.config/systemd/user/
systemctl --user daemon-reload
```

`.service` には `[Install]` が無い。**enable するのは `.timer` だけ**（`bsky-bots-failure@.service` も
`OnFailure=` から起動されるので enable しない）。

### 2-3. 有効化

**切り替え当日まで実行しない。** 段取りは 4 章。

```bash
systemctl --user enable --now bsky-skyhigh.timer
```

### timer の `Persistent=false` について

両 timer とも**取り返し実行をしない**。対象日は「起動した日の前日」なので、取り返しと定時が
同じ対象日を 2 回投稿することがある。

- skyhigh: D 日 08:45 を逃して D+1 日 03:00 に起動 → 取り返しが D 日分を集計。
  D+1 日 08:45 の定時も D 日分を集計 → **二重投稿**
- skylog: D 日 00:20 を逃して D+1 日 00:00〜00:20 に起動 → 取り返しと直後の定時が同じ対象日 → **二重投稿**

取りこぼしは Discord のアラート（失敗したとき）と 6 章の投稿確認（マシンが落ちていた・timer が
動いていなかったとき）で気づき、3-2 の手順で手動実行する。

---

## 3. 確認のしかた

### 3-1. 状態とログ

```bash
# 次回実行時刻（UTC 表示。08:45 JST = 23:45 UTC / 00:20 JST = 15:20 UTC）
systemctl --user list-timers --all --no-pager

# timer / service の状態
systemctl --user status bsky-skyhigh.timer --no-pager
systemctl --user status bsky-skyhigh.service --no-pager

# 実行中の追跡（実行時刻の少し前から張っておく）
journalctl --user -u bsky-skyhigh.service -f

# 当日ぶんのログをまとめて読む
journalctl --user -u bsky-skyhigh.service --since today --no-pager

# 失敗検知（OnFailure から記録されたもの。err 優先度）
journalctl --user -t bsky-bots-failure --since '7 days ago' --no-pager

# Discord 通知そのものの結果（送れなかったときの理由もここ）
journalctl --user -u 'bsky-bots-failure@*' --since '7 days ago' --no-pager
```

最後のコマンドは、`bsky-bots-failure@` が一度も起動していないと
`Failed to add filter for units: No data available` と出て exit 1 になる（＝通知が一度も走っていない）。

Bot が非 0 終了すると（取得失敗が続く・投稿失敗・例外）、`bsky-bots-failure@` が journal に記録し、
Discord に unit 名・ホスト名・時刻（JST）・`Result` / `ExecMainStatus`・最後の起動分のログ末尾 30 行を送る。

**鳴らないケースがある。** timer が動いていない・マシンが落ちていた・`DISCORD_WEBHOOK_URL` が
空（journal にだけ `DISCORD_WEBHOOK_URL is not set` が出る）。**無通知＝正常ではない。**
投稿の有無は 6 章の方法で別に見る。

### 3-2. 取りこぼしたときの手動実行

**手動実行の前に、当日分が既に投稿されていないかを必ず確かめる。** 二重投稿が最悪ケース。

1. 6 章のコマンドで**今日の行**を見る。`OK` なら**実行しない**（既に投稿済み）。`MISSING` なら次へ
2. その Bot の service が動いていないことを確かめる（`inactive` か `failed` なら次へ）

   ```bash
   systemctl --user is-active bsky-skyhigh.service
   ```

3. 実行する（`--no-block` で即座に戻る。完了まで数分〜数十分かかる）

   ```bash
   systemctl --user start --no-block bsky-skyhigh.service
   journalctl --user -u bsky-skyhigh.service -f
   ```

4. 終わったら 6 章のコマンドで今日の行が `OK` になったか見る

対象日は**実行した日（JST）の前日**。日付を跨いでから実行すると別の日の集計になるので、
**取りこぼした日のうちに**実行する。跨いでしまった日の分は取り戻せない（対象日を指定する手段は無い）。

skylog も同じ（`bsky-skylog.service`）。ただし skylog は途中で落ちると「集計開始」とその後の
一部のユーザーだけが投稿済みになる。**再実行するとそのユーザーが二重に投稿される**ので、
6 章の「集計開始 / 集計終了」のコマンドで、今日「集計開始」だけが出ていないかも確かめる。

---

## 4. 切り替え前の受け入れ条件と当日の段取り

**skyhigh を先、2 週間おいて skylog。** skylog は 1 回の投稿数が桁違いで事故時の被害が大きい。

### 4-1. 受け入れ条件

新実装は旧実装と**意図して出力を変えている**（did 化・skylog の分類と時刻基準・上限。README の
「旧実装との差分」）。したがって新旧の出力が一致することは条件にしない。以下の **A〜E** を見る。

**A〜D を 3 日連続で満たしたら切り替えてよい。** E は毎回。

以下のコマンドは `~/deploy/bsky-bots`（本番に出すタグ）で叩く。どれも**読み取りのみ**で投稿しない。

準備（毎回）:

```bash
source ~/.nvm/nvm.sh
cd ~/deploy/bsky-bots
mkdir -p /tmp/bsky-check
D=$(TZ=Asia/Tokyo date +%F)          # 実行日（JST）。対象日はこの前日
BOT=skyhigh                           # skylog のときは BOT=skylog
```

#### A. 本番（GCP）との突き合わせ

GCP がその日に実際に投稿した内容（公開 API で取得）と、新実装の**同じ対象日**の dry-run を比べる。
dry-run の対象日は「実行した日の前日」なので、**GCP が投稿したのと同じ日（JST）のうちに** dry-run を取る。

- skyhigh: GCP は 08:45 開始で 1〜1.5 時間かかる。**11:00 以降**に取る
- skylog: GCP は 00:20 開始。GCP の「集計終了」が出てから（6 章のコマンドで確認）その日のうちに取る

朝の dry-run（B と C もこの 1 回で取る）:

```bash
start=$(date +%s)
node dist/main.js "$BOT" > /tmp/bsky-check/$BOT-$D-am.jsonl 2> /tmp/bsky-check/$BOT-$D-am.err
echo "exit=$? elapsed=$(( $(date +%s) - start ))s"
```

突き合わせ:

```bash
node dist/tools/compare-gcp.js "$BOT" /tmp/bsky-check/$BOT-$D-am.jsonl | tee /tmp/bsky-check/$BOT-$D-compare.txt
```

出力の見かた:

- `[説明済]` … 自動で説明がついた差分（skylog: 非リポスト総数が一致していて、リポスト数か
  投稿／リプの内訳だけが違う → リポスト時刻基準・リプライのリポストの扱い。handle.invalid のユーザー）
- `[要確認]` … 人が理由を確かめる差分。各行に出る `probe.js` のコマンドを叩き、下の表のどれかに当てはまるか見る

| 理由 | probe の出力での見分け方 |
| --- | --- |
| handle.invalid のユーザー | skyhigh の `[要確認]` の下に `← handle.invalid` と出る |
| 旧上限（skyhigh 20・skylog 15 ページ）に達していた | `--- AppView ---` の `打ち切り: ページ上限`、またはリクエスト数が skyhigh 20 / skylog 15 を超える（probe は**今から**遡るので、GCP の実行時より多めに出る） |
| skylog のリポスト時刻基準・リプライのリポストの扱い | （skylog は自動判定。非リポスト総数が一致しているもの） |
| 日付境界付近 | `indexedAt 基準`（旧の基準）と `createdAt 基準` / PDS の件数が違う |
| 新が取得に失敗した（D の対象） | dry-run の `.err` に `skip <did>` が出ている（サマリの `fetch_failed` に計上） |
| skylog の「10 件以上」の境目 | 旧だけにいて、PDS の非リポストが 10 件未満（新では投稿対象外） |

**不変条件（skylog）**: 非リポスト総数（投稿＋リプ）がユーザーごとに一致すること。
上限到達・フォールバック（PDS が駄目で AppView から取った）のユーザーは除く。
両方にいるユーザーでこれが崩れていると `[要確認]` になる。

**A の合格**: `[要確認]` がすべて上の表のどれかで説明できること。

probe の例:

```bash
node dist/tools/probe.js did:plc:xxxxxxxxxxxxxxxxxxxxxxxx 2026-09-22
```

#### B. 決定性

同じ対象日の dry-run を**朝と夜**に取り、時刻文字列と `createdAt` を除いて完全一致すること。
朝の分は A で取ったもの。夜（同じ日の 20:00〜23:30 ごろ。**日付を跨がないこと**）:

```bash
node dist/main.js "$BOT" > /tmp/bsky-check/$BOT-$D-pm.jsonl 2> /tmp/bsky-check/$BOT-$D-pm.err
```

比較:

```bash
norm() {
  jq -c 'del(.createdAt)
    | .text |= sub("集計(?<k>開始|終了)：[0-9/]+ [0-9:]+"; "集計\(.k)：<time>")' "$1"
}
diff <(norm /tmp/bsky-check/$BOT-$D-am.jsonl) <(norm /tmp/bsky-check/$BOT-$D-pm.jsonl) \
  && echo "B: IDENTICAL"
```

**B の合格**: `B: IDENTICAL` が出ること。

差分が出たら、それが朝から夜の間に**フォロワーが増減した**・対象日の投稿が**削除された**ことによる
ものか（skyhigh の `users: N`、skylog のユーザーの出入り、件数の減少）を確認し、記録しておく。

#### C. 完走時間

全件 dry-run が unit の `TimeoutStartSec` の **1/3 以内**であること。A の実行で出た `elapsed=` を見る。

| Bot | TimeoutStartSec | 1/3 | 実測 |
| --- | --- | --- | --- |
| skyhigh | 1800 秒 | 600 秒 | 406.79 秒（2026-09-22）/ 348 秒（2026-09-23） |
| skylog | 3600 秒（**推定値**） | 1200 秒 | **未実測**。A の 1 回目で測る |

skylog の `TimeoutStartSec=3600` は旧実装の実績からの推定値。C で実測したら
`deploy/bsky-skylog.service` の値を見直す。

dry-run は投稿しないので、`--live` の実時間は**投稿のぶん長くなる**（skylog は対象ユーザー数ぶんの
リプライを投稿する）。切り替え後の実時間は 6 章のコマンドで確かめる。

#### D. 失敗件数

PDS も AppView も駄目だったユーザー（「両経路とも失敗」）が **0〜1 人**で、
**`status=ok` で終わっている**こと。

アプリは終了時に stderr へ 1 行サマリを出す:

```
[skyhigh] summary: status=ok processed=374 fetch_failed=0 post_failed=0 fallback=3 elapsed=349.7s
```

| 項目 | 意味 | 合格ライン |
| --- | --- | --- |
| `status` | `ok` / `aborted`（停止条件に当たった）/ `error`（例外） | `ok` |
| `fetch_failed` | 両経路とも失敗して集計から外れた人数 | 0〜1 |
| `post_failed` | 投稿の失敗（dry-run では常に 0） | 0 |
| `fallback` | PDS 直読みに失敗して AppView から取れた人数（参考。#17） | 目安 5 以下 |

```bash
grep ' summary: ' /tmp/bsky-check/$BOT-$D-am.err
# 外れた人の内訳（did とエラー）
grep '^skip ' /tmp/bsky-check/$BOT-$D-am.err
```

#### E. dry-run は投稿しない

`--live` なしでは投稿（createRecord）が 0 件であること。dry-run はログインしないので
構造上は投稿できないが、Bot アカウントの投稿数が dry-run の前後で変わらないことで確かめる
（GCP が投稿していない時間帯に取る。skyhigh は 11:00 以降、skylog は集計終了後）。

```bash
posts() { curl -s "https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=$1" | jq .postsCount; }
before=$(posts $BOT.bsky.social)
node dist/main.js "$BOT" --limit-followers=5 > /dev/null 2> /tmp/bsky-check/$BOT-$D-e.err
after=$(posts $BOT.bsky.social)
echo "before=$before after=$after"
grep -c 'logged in as' /tmp/bsky-check/$BOT-$D-e.err
```

**E の合格**: `before` と `after` が同じで、`logged in as` が 0 件（0 件のとき `grep -c` は exit 1 になるが正常）。

### 4-2. 切り替え当日の段取り

**二重投稿が最悪ケース。だから「GCP の cron を止めた確認」を「新 timer を有効化」より必ず前に置く。**

| いつ | やること |
| --- | --- |
| D-3〜D-1 | 4-1 の A〜D を毎日確認する。**3 日連続で満たす**ことが切り替えの必要条件 |
| D 08:00 | GCP の cron を停止し、**止まったことを確認する**（`crontab -l` が空 / 該当行がコメントアウト） |
| D 08:15 | 上で止めたことを確認できてから次へ進む。確認できないうちは**絶対に enable しない** |
| D 08:30 | `systemctl --user enable --now bsky-skyhigh.timer` → `systemctl --user list-timers` で次回が 23:45 UTC になっているか見る |
| D 08:45 | `journalctl --user -u bsky-skyhigh.service -f` で追跡 |
| D 09:00 | 6 章の確認コマンドで当日のランキング投稿を確認 |
| D+1〜D+7 | 毎日 6 章を実行する（#12。1 日見ただけでは直ったと判断できない） |
| D+14 | skylog を同じ手順で切り替え（GCP の停止確認 → enable）。投稿数が多いので**実行中ずっとログを見る** |
| 両 Bot が安定してから | 8 章（GCP 撤去・旧 App Password の Revoke） |

**GCP 側は最低 2 週間、できれば 1 ヶ月は起動できる状態で残す。** 消すとロールバック手段が消える。

---

## 5. ロールバック

### 5-1. GCP に戻す

```bash
# 1. 新 timer を止める（実行中なら service も止める）
systemctl --user disable --now bsky-skyhigh.timer
systemctl --user stop bsky-skyhigh.service
systemctl --user list-timers --all --no-pager   # 一覧から消えたことを確認
```

2. **GCP 側の `.env` の `PASSWORD` を、0-4 で発行した新しい App Password に書き換える**（GCP 上で）。
   旧 App Password は最終的に失効させる（8 章）ので、GCP を旧のまま動かし続けない。
   GCP の旧実装は `AUTHOR` / `PASSWORD` を読む。
3. GCP 側の cron を戻す（GCP 上で）。`crontab -e` でコメントアウトを外し、`crontab -l` で戻ったことを確認する

`legacy/` の旧コードを直接実行する経路も残してある（`legacy/` を消さない理由）。

### 5-2. 新実装を前のタグに戻す

新しいタグに上げてから問題が出たときは、GCP に戻さずに前のタグに戻せばよい。
手順は 7 章の「更新」と同じで、タグを前のものにするだけ。

```bash
cd ~/deploy/bsky-bots
git describe --tags --exact-match       # 今のタグ
git tag --sort=-creatordate | head -5   # 戻し先を選ぶ
```

---

## 6. 切り替え後に見るもの（最低 1 週間）

**旧実装は 5 日に 1 日ランキングを落としていた（#12）。しかもエラー通知は 0 件だった。**
Discord のアラートとは別に、**公開 API で投稿の有無を直接見る**。認証は要らない。
3-2 の手動実行の前の確認にもこれを使う。

### skyhigh: 直近 7 日ぶんのランキング投稿の有無

```bash
curl -s "https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=skyhigh.bsky.social&filter=posts_no_replies&limit=100" \
| TZ=Asia/Tokyo jq -r --arg actor skyhigh.bsky.social --arg prefix '【すか廃ランキング' '
  [ .feed[].post
    | select(.author.handle == $actor)
    | select(.record.text | startswith($prefix))
    | (.record.createdAt[0:19] + "Z" | fromdateiso8601 | strflocaltime("%F")) ] as $days
  | [range(0; 7)]
  | map(now - (. * 86400) | strflocaltime("%F"))
  | .[] as $d
  | $d + "  " + (if ($days | index($d)) then "OK" else "MISSING" end)'
```

日付は**投稿された日（JST）**。先頭の行が今日。`MISSING` が 1 日でも出たらその日の journal を見る。

```
2026-09-22  MISSING
2026-09-21  OK
...
2026-09-17  MISSING
```

上は 2026-09-22 時点の**旧実装（GCP）の実測**。5 日おきに落ちているのが #12 の症状そのもの。
切り替え後は**7 日すべて OK**になるのが期待値。

### skylog: 直近 7 日ぶんの完走の有無

skylog のフォロワーごとの投稿はリプライなので `posts_no_replies` には出ない。
代わりに「集計終了」の投稿で**完走したか**を見る（途中で落ちると出ない）。

```bash
curl -s "https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=skylog.bsky.social&filter=posts_no_replies&limit=100" \
| TZ=Asia/Tokyo jq -r --arg actor skylog.bsky.social --arg prefix '集計終了' '
  [ .feed[].post
    | select(.author.handle == $actor)
    | select(.record.text | startswith($prefix))
    | (.record.createdAt[0:19] + "Z" | fromdateiso8601 | strflocaltime("%F")) ] as $days
  | [range(0; 7)]
  | map(now - (. * 86400) | strflocaltime("%F"))
  | .[] as $d
  | $d + "  " + (if ($days | index($d)) then "OK" else "MISSING" end)'
```

3-2 の手動実行の前は、「集計開始」があって「集計終了」が無い日（途中で落ちた）にも注意する。
途中まで投稿されている日にもう一度実行すると、その日の前半のユーザーが二重に投稿される。

```bash
curl -s "https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=skylog.bsky.social&filter=posts_no_replies&limit=20" \
| TZ=Asia/Tokyo jq -r '.feed[].post | select(.author.handle == "skylog.bsky.social")
  | select(.record.text | test("^集計(開始|終了)"))
  | (.record.createdAt[0:19] + "Z" | fromdateiso8601 | strflocaltime("%F %T")) + "  " + (.record.text | split("：")[0])'
```

### そのほか

- `journalctl --user -t bsky-bots-failure --since '7 days ago'` が空であること
- `systemctl --user list-timers` に timer が載っていて、次回時刻が想定どおりであること
  （timer 自体が動いていなければ `OnFailure=` は起動しない。**無通知＝正常ではない**）
- 所要時間。`TimeoutStartSec` は skyhigh 1800 秒 / skylog 3600 秒。
  実測が近づいたら unit の値を見直す

```bash
# 直近の実行にかかった時間
journalctl --user -u bsky-skyhigh.service --since '7 days ago' --no-pager \
  | grep -E 'Starting|Finished|Succeeded|Failed'

# 最後の実行の開始・終了時刻（UTC）
systemctl --user show bsky-skyhigh.service -p ExecMainStartTimestamp -p ExecMainExitTimestamp
```

---

## 7. 更新（新しいタグを本番に出す）

1. 0-2 と同じ手順で新しいタグ（例 `v1.0.1`）を打って push する
2. **Bot が動いていない時間帯に**本番用ツリーを切り替える
   （skyhigh 08:45〜10:00 ごろ / skylog 00:20〜01:30 ごろ は避ける）

```bash
systemctl --user is-active bsky-skyhigh.service bsky-skylog.service   # 両方 inactive か failed であること
source ~/.nvm/nvm.sh
cd ~/deploy/bsky-bots
git describe --tags --exact-match   # 今のタグを控える（ロールバック先）
git fetch --tags origin
git checkout --detach v1.0.1
npm ci
npm run build
git describe --tags --exact-match   # v1.0.1
```

3. unit ファイル（`deploy/`）が変わっていたら設置し直す（変わっていなければ不要）

```bash
cd ~/deploy/bsky-bots
git diff --stat v1.0.0 v1.0.1 -- deploy/
# 変わっていたら 2-1 の verify → 2-2 の cp と daemon-reload
```

ロールバックは同じ手順で `git checkout --detach <前のタグ>` → `npm ci` → `npm run build`
（unit が変わっていたら 2-2 もやり直す）。

---

## 8. GCP 撤去と旧 App Password の Revoke

両 Bot の切り替えが安定し（6 章を 1 週間以上見て問題が無い）、GCP に戻す必要が無くなったら:

1. GCP 側の cron を削除し、VM / 実行環境を撤去する
2. Bluesky の Settings → App Passwords で、**両 Bot の旧 App Password を Revoke する**
   （0-4 で新規発行したものは残す）。
   **これで #8（旧実装がログに出していたリフレッシュトークン）が無効になる**
3. 旧リポジトリ（`ShinoharaTa/bsky-skyhigh` / `ShinoharaTa/bsky-skylog`）を Archive
