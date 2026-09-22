# デプロイ手順（systemd --user timer）

作成 2026-09-22 / 対象: issue #4（GCP の cron から自宅サーバーの systemd timer へ移す）

このリポジトリには unit ファイルを**置いてあるだけ**で、設置も起動もしていない。
以下は**ユーザーが自分の手で叩く**手順。コピペで実行できる形にしてある。

| ファイル | 役割 |
| --- | --- |
| `deploy/bsky-skyhigh.service` / `.timer` | skyhigh を毎日 08:45 JST に 1 回実行 |
| `deploy/bsky-skylog.service` / `.timer` | skylog を毎日 00:20 JST に 1 回実行 |
| `deploy/bsky-bots-failure@.service` | 失敗を journal に残す（`OnFailure=` から起動される） |

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

### 0-2. ビルド済みの `dist/`

`dist/` は git 管理外。unit は `dist/main.js` を実行するので、**設置前にビルドしておく**。
リポジトリを更新したら毎回ビルドし直すこと（ビルドし忘れると古いコードが動き続ける）。

```bash
source ~/.nvm/nvm.sh
cd ~/workspace/bsky-bots
npm ci
npm run build
ls -l dist/main.js
```

### 0-3. App Password は新規発行する

**旧 App Password を回収して使い回さない。両 Bot とも新規発行する。**
旧実装がリフレッシュトークンを毎日ログに出していた（#8）。
新規発行して旧 App Password を失効させれば、ログに残っているトークンも同時に無効になる。

発行は Bluesky の Settings → App Passwords。**旧 App Password の Revoke まで行う。**

---

## 1. `.env` を置く

`~/workspace/bsky-bots/.env` に置く（`.gitignore` 済み）。変数名は `.env.sample` のとおり。

- `SKYHIGH_IDENTIFIER`
- `SKYHIGH_APP_PASSWORD`
- `SKYLOG_IDENTIFIER`
- `SKYLOG_APP_PASSWORD`

`AUTHOR` / `PASSWORD` へのフォールバックは無い。**4 つ全部必要**（片方の Bot だけ動かす場合も、
`EnvironmentFile=` は同じファイルを読むので 4 つ揃っている方が事故が少ない）。

```bash
cd ~/workspace/bsky-bots
cp .env.sample .env
chmod 600 .env
$EDITOR .env
```

確認（**値は表示しない**）:

```bash
stat -c '%a %n' ~/workspace/bsky-bots/.env      # 600
cut -d= -f1 ~/workspace/bsky-bots/.env | grep -v '^#' | grep -v '^$'
```

---

## 2. unit を検証してから設置する

### 2-1. 設置前の検証（警告が出たら設置しない）

```bash
cd ~/workspace/bsky-bots
systemd-analyze --user verify \
  deploy/bsky-skyhigh.service deploy/bsky-skyhigh.timer \
  deploy/bsky-skylog.service  deploy/bsky-skylog.timer \
  'deploy/bsky-bots-failure@.service'
echo "exit=$?"
```

**何も出力されず `exit=0` なら警告 0。** `node` が無い・パスが違うといった問題はここで出る。

起動時刻の解釈も確認できる（マシンの TZ は UTC。JST 表示にはならない）:

```bash
systemd-analyze calendar --iterations=3 '*-*-* 08:45:00 Asia/Tokyo'
systemd-analyze calendar --iterations=3 '*-*-* 00:20:00 Asia/Tokyo'
```

### 2-2. 設置

```bash
install -d ~/.config/systemd/user
cp ~/workspace/bsky-bots/deploy/bsky-skyhigh.service \
   ~/workspace/bsky-bots/deploy/bsky-skyhigh.timer \
   ~/workspace/bsky-bots/deploy/bsky-skylog.service \
   ~/workspace/bsky-bots/deploy/bsky-skylog.timer \
   ~/workspace/bsky-bots/deploy/'bsky-bots-failure@.service' \
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

---

## 3. 確認のしかた

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
```

`bsky-bots-failure` に何も出ていない = **プロセスが 0 終了した**というだけで、
ランキングが投稿されたことは意味しない。投稿の有無は 6 章の方法で別に見る。

---

## 4. 切り替え当日の段取り

**skyhigh を先、2 週間おいて skylog。** skylog は 1 回の投稿数が桁違いで事故時の被害が大きい。

**二重投稿が最悪ケース。だから「GCP の cron を止めた確認」を「新 timer を有効化」より必ず前に置く。**

| いつ | やること |
| --- | --- |
| D-3〜D-1 | 新旧の dry-run を毎日 diff する。**3 日連続一致**が切り替えの必要条件 |
| D 08:00 | GCP の cron を停止し、**止まったことを確認する**（`crontab -l` が空 / 該当行がコメントアウト） |
| D 08:15 | 上で止めたことを確認できてから次へ進む。確認できないうちは**絶対に enable しない** |
| D 08:30 | `systemctl --user enable --now bsky-skyhigh.timer` → `systemctl --user list-timers` で次回が 23:45 UTC になっているか見る |
| D 08:45 | `journalctl --user -u bsky-skyhigh.service -f` で追跡 |
| D 09:00 | 6 章の確認コマンドで当日のランキング投稿を確認 |
| D+1〜D+7 | 毎日 6 章を実行する（#12。1 日見ただけでは直ったと判断できない） |
| D+14 | skylog を同じ手順で切り替え。投稿数が多いので**実行中ずっとログを見る** |
| D+30 | GCP 側を撤去、旧リポジトリを Archive |

dry-run の diff（`createdAt` は毎回変わるので比較対象から外す）:

```bash
source ~/.nvm/nvm.sh
cd ~/workspace/bsky-bots
node dist/main.js skyhigh > /tmp/new-skyhigh-$(date +%F).jsonl
jq -c 'del(.createdAt)' /tmp/new-skyhigh-$(date +%F).jsonl > /tmp/new-skyhigh-$(date +%F).norm
diff /tmp/new-skyhigh-$(date -d yesterday +%F).norm /tmp/new-skyhigh-$(date +%F).norm
```

**GCP 側は最低 2 週間、できれば 1 ヶ月は起動できる状態で残す。** 消すとロールバック手段が消える。

---

## 5. ロールバック

```bash
# 1. 新 timer を止める（実行中なら service も止める）
systemctl --user disable --now bsky-skyhigh.timer
systemctl --user stop bsky-skyhigh.service
systemctl --user list-timers --all --no-pager   # 一覧から消えたことを確認

# 2. GCP 側の cron を戻す（GCP 上で）
#    crontab -e でコメントアウトを外し、crontab -l で戻ったことを確認する
```

`legacy/` の旧コードを直接実行する経路も残してある（`legacy/` を消さない理由）。

---

## 6. 切り替え後に見るもの（最低 1 週間）

**旧実装は 5 日に 1 日ランキングを落としていた（#12）。しかもエラー通知は 0 件だった。**
プロセスが 0 終了しても投稿が無いことがあるので、`OnFailure=` とは別に
**公開 API で投稿の有無を直接見る**。認証は要らない。

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

日付は**投稿された日（JST）**。`MISSING` が 1 日でも出たらその日の journal を見る。

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
```
