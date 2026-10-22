# デプロイ手順（systemd system 版 / Proxmox Debian コンテナ）

作成 2026-10-22 / 対象: issue #4（GCP から自宅サーバーの systemd timer へ移す）・#22（OS の systemd で動かす構成）・#26（任意の場所に clone して動かす）

3 Bot（skyhigh / skylog / 時報）を、Proxmox の Debian コンテナ（LXC）の **OS の systemd** に
timer で登録して動かす手順。GCP 上の旧 Bot から**一斉に**切り替える。
時報の要件は [jiho-migration-plan.md](jiho-migration-plan.md)。

このリポジトリには unit のテンプレートと登録スクリプト（`deploy/install.sh`）を**置いてあるだけ**で、設置も起動もしていない。
以下は**ユーザーが自分の手で叩く**手順。コピペで実行できる形にしてある。

> 以前の systemd **--user** 版の手順と unit（`deploy/*.service`）は、手順を 1 本にするため削除した（#22）。

---

## 0. 方針（2026-10-22 決定）

| # | 決定 |
| --- | --- |
| S1 | **全 Bot を一斉に切り替える**。GCP 上の旧 Bot（skyhigh / skylog / nodecron の時報）を**すべて止めてから**、新ホストで 3 Bot を稼働させる |
| S2 | **OS の systemd に登録する**（`/etc/systemd/system/`）。各 Bot は timer で定時起動する one-shot。再起動後も自動で有効になる。常駐プロセスは持たない |
| S3 | 実行先は **Proxmox の Debian コンテナ（LXC）** |
| S4 | 移行作業は 3 Bot ともまだ始めていない（2026-10-22 時点で GCP で稼働中） |
| S5 | **切り替え中に Bot が一時的に止まるのは問題ない**（停止時間を最小化する段取りは不要） |
| S6 | GCP 上の旧 Bot は **supervisor 管理**。止めるのは supervisor を止めるだけ |

S1 に伴い、旧計画の「skyhigh → 2 週間 → skylog」「時報を先に」という**段階切り替えは取りやめた**。

---

## 1. 構成

**clone する場所・実行ユーザー・Node の場所は自由。** `deploy/install.sh` が unit テンプレートの
`@APP_DIR@` などを実際の値で埋めて `/etc/systemd/system/` に書き込む（4-3）。

```
新ホスト（Proxmox LXC / Debian 12・13）
├── <APP_DIR>/                         ← git clone してビルド（どこでもよい）
│   ├── dist/main.js, dist/tools/notify-failure.js
│   └── .env                           ← 認証情報（既定。0600）
└── /etc/systemd/system/               ← deploy/install.sh が生成して書き込む
    ├── bsky-skyhigh.service / .timer   毎日 08:45 JST         失敗→Discord
    ├── bsky-skylog.service  / .timer   毎日 00:20 JST         失敗→Discord
    ├── bsky-jiho.service    / .timer   毎時 :27/:57 +0〜6分   失敗通知なし
    └── bsky-bots-failure@.service      OnFailure から起動 → Discord webhook
```

| 項目 | install.sh の既定 | 推奨例（専用ユーザーで動かす場合。3-B） |
| --- | --- | --- |
| コード（`APP_DIR`） | `deploy/install.sh` の 1 つ上（clone した場所） | `/opt/bsky-bots`（所有 `bsky-bots`） |
| 実行ユーザー（`RUN_USER`） | `APP_DIR` の所有者。グループはそのユーザーのプライマリグループ | `bsky-bots`（`--system`、シェルなし）。root で動かさない |
| 認証情報（`ENV_FILE`） | `APP_DIR/.env`（実行ユーザーだけが読める `0600`） | `/etc/bsky-bots/bsky-bots.env`（`root:bsky-bots` `0640`）。コードと分け、実行ユーザーは読めるが書けない |
| Node（`NODE`） | `command -v node` の絶対パス | **Node 24 を apt（NodeSource）で入れる**。`/usr/bin/node` |

/root に置いて root で動かす例: `cd /root/bsky-bots && deploy/install.sh`（`APP_DIR=/root/bsky-bots`・`RUN_USER=root`・`ENV_FILE=/root/bsky-bots/.env` になる）。

| 項目 | 値 | 理由 |
| --- | --- | --- |
| Node | Node 24 | 開発環境（v24.20.0）と系統を揃える。`package.json` の `engines` も `>=24`。専用ホストなので system-wide でよい |
| タイムゾーン | OS は Asia/Tokyo に設定。timer にも `Asia/Tokyo` を明記 | ログを JST で読むため。timer は OS の TZ に依存させない |

> **共有の開発機（N100 サーバ）には置かない。** 共有機では system-wide にランタイムを入れない方針。この文書は**専用の Proxmox LXC** 向け。

---

## 2. リポジトリ内のファイル

| ファイル | 役割 |
| --- | --- |
| `deploy/system/bsky-skyhigh.service` / `.timer` | skyhigh を毎日 08:45 JST に 1 回実行。失敗で `bsky-bots-failure@` を起動 |
| `deploy/system/bsky-skylog.service` / `.timer` | skylog を毎日 00:20 JST に 1 回実行。失敗で `bsky-bots-failure@` を起動 |
| `deploy/system/bsky-jiho.service` / `.timer` | 時報を毎時 :27 / :57 JST（+0〜6 分）に実行。**失敗通知なし**（決定 D4。[jiho-migration-plan.md](jiho-migration-plan.md)） |
| `deploy/system/bsky-bots-failure@.service` | 失敗を journal に残し、Discord webhook に知らせる（`OnFailure=` から起動される） |
| `deploy/install.sh` | `deploy/system/` の unit テンプレートの `@...@` を埋めて `/etc/systemd/system/` に書き込む（4-3） |
| `src/tools/notify-failure.ts` | 上の unit が呼ぶ Discord 通知。`BSKY_SYSTEMD_SCOPE=system` で OS の systemd の unit として扱う |
| `src/tools/compare-gcp.ts` | 受け入れ条件 A の突き合わせ（読み取りのみ） |
| `src/tools/probe.ts` | 受け入れ条件 A の `[要確認]` の調査（読み取りのみ） |

### 2-1. unit の主な設定

| 設定 | 値 | 理由 |
| --- | --- | --- |
| `User=` / `Group=` | `@RUN_USER@` / `@RUN_GROUP@` | install.sh が埋める（既定は `APP_DIR` の所有者とそのプライマリグループ。`--user`） |
| `WorkingDirectory=` | `@APP_DIR@` | 4-1 で clone してビルドしたもの（既定は install.sh の 1 つ上。`--app-dir`） |
| `EnvironmentFile=` | `@ENV_FILE@` | 4-2（既定は `APP_DIR/.env`。`--env-file`） |
| `ExecStart=` | `@NODE@ dist/main.js <bot> --live` | 3-B で入れる Node（既定は `command -v node`。`--node`） |
| `ProtectHome=` | `@PROTECT_HOME@` | `APP_DIR` か `ENV_FILE` が `/root`・`/home`・`/run/user` 配下なら `read-only`（`yes` だと読めない）、それ以外は `yes` |
| `TimeoutStartSec=` | skyhigh 1800 / skylog 3600（**推定値**）/ jiho 600 / failure 120 | 未設定だと既定の 90 秒で SIGTERM される。skylog は 5 章 C と初回の実測で見直す |
| `NoNewPrivileges` / `ProtectSystem=strict` / `PrivateTmp` | 有効 | Bot は実行中にファイルを書かない |
| `OnCalendar=` | `... Asia/Tokyo` | OS の TZ に依存させない（systemd 252 以降） |
| `AccuracySec=` | `1s` | 現行 GCP の cron が秒単位でしか揺れていないので揃える |
| `RandomizedDelaySec=` | jiho のみ `360` | 現行どおり 0〜6 分のゆらぎ。プロセス内では待たない |
| `Persistent=` | `false` | 下記 |
| `OnFailure=` | skyhigh / skylog のみ | 時報は失敗通知を出さない（D4） |

`bsky-bots-failure@.service` は `SupplementaryGroups=systemd-journal` で system の journal を読み、
`Environment=BSKY_SYSTEMD_SCOPE=system` で `notify-failure.js` に `--user` を付けさせない。

`.service` には `[Install]` が無い。**enable するのは `.timer` だけ**（`bsky-bots-failure@.service` も
`OnFailure=` から起動されるので enable しない）。

#### timer の `Persistent=false` について

どの timer も**取り返し実行をしない**。skyhigh / skylog の対象日は「起動した日の前日」なので、
取り返しと定時が同じ対象日を 2 回投稿することがある。

- skyhigh: D 日 08:45 を逃して D+1 日 03:00 に起動 → 取り返しが D 日分を集計。
  D+1 日 08:45 の定時も D 日分を集計 → **二重投稿**
- skylog: D 日 00:20 を逃して D+1 日 00:00〜00:20 に起動 → 取り返しと直後の定時が同じ対象日 → **二重投稿**

取りこぼしは Discord のアラート（失敗したとき）と 7 章の投稿確認（ホストが落ちていた・timer が
動いていなかったとき）で気づき、8 章の手順で手動実行する。時報は逃した枠が欠けるだけ。

### 2-2. `notify-failure.js` の scope

| `BSKY_SYSTEMD_SCOPE` | `systemctl` / `journalctl` | 最後の起動分のログの絞り込み |
| --- | --- | --- |
| `system` | `--user` を付けない | `_SYSTEMD_INVOCATION_ID=<id> + INVOCATION_ID=<id>` |
| 未設定（それ以外） | `--user` を付ける（従来どおり） | `_SYSTEMD_INVOCATION_ID=<id> + USER_INVOCATION_ID=<id>` |

プロセスの出力は `_SYSTEMD_INVOCATION_ID` に、systemd 自身の「Failed with result ...」は
manager 側のフィールド（system manager は `INVOCATION_ID`、user manager は `USER_INVOCATION_ID`）に付く。
InvocationID で何も取れなければ `journalctl -u <unit>` の直近分に落とす。

---

## 3. ホストの準備

### 3-A. Proxmox の Debian コンテナ（LXC）

Proxmox ホストのシェルで実行する（値は例。ID・ストレージ名・ブリッジは環境に合わせる）。

```bash
# テンプレートの確認と取得（debian-12 か debian-13）
pveam update
pveam available --section system | grep -E 'debian-1[23]-standard'
pveam download local debian-12-standard_<版>_amd64.tar.zst

# コンテナ作成（非特権・nesting 有効）
pct create 210 local:vztmpl/debian-12-standard_<版>_amd64.tar.zst \
  --hostname bsky-bots \
  --unprivileged 1 \
  --features nesting=1 \
  --cores 1 --memory 1024 --swap 512 \
  --rootfs local-lvm:8 \
  --net0 name=eth0,bridge=vmbr0,ip=dhcp \
  --onboot 1 \
  --timezone Asia/Tokyo
pct start 210
pct enter 210
```

| 設定 | 理由 |
| --- | --- |
| `--unprivileged 1` | コンテナ内の root をホストの root にしない |
| `--features nesting=1` | Debian 12 以降の systemd がサンドボックス（`ProtectSystem` 等）や `network-online.target` を正しく扱うため。Proxmox の新規作成時の既定 |
| `--onboot 1` | Proxmox ホスト再起動時にコンテナも起動 → timer も自動で有効 |
| `--memory 1024` | 実測の最大 RSS は約 170MB。npm ci / build の余裕込み |
| `--timezone Asia/Tokyo` | 時計はホストと共有。TZ だけコンテナで持つ |

以降は**コンテナの中**で 3-B へ。

### 3-B. コンテナ内の準備（root で実行）

LXC の root で作業するので、以降の章の `sudo` は付けなくてよい（付けても動く）。
`sudo -u "$RUN_USER"` は実行ユーザーでコマンドを動かすために使うので、`sudo` パッケージを入れておく。

```bash
# 0. 時刻とタイムゾーン（時計はホストと共有。ずれていたら Proxmox ホスト側の NTP を直す）
date; cat /etc/timezone                 # Asia/Tokyo であること

# 0. systemd のバージョン確認（OnCalendar のタイムゾーン指定を使うため）
systemctl --version | head -1          # Debian 12: 252 / Debian 13: 257
systemd-analyze calendar --iterations=3 '*-*-* *:27,57:00 Asia/Tokyo'   # :27 / :57 が並べば OK

# 1. 基本パッケージ（jq は 5 章・7 章の確認で使う）
apt update
apt install -y ca-certificates curl git sudo jq

# 2. Node 24（NodeSource）
curl -fsSL https://deb.nodesource.com/setup_24.x -o /tmp/nodesource_setup.sh
less /tmp/nodesource_setup.sh          # 中身を確認してから実行する
bash /tmp/nodesource_setup.sh
apt install -y nodejs
command -v node && node -v             # /usr/bin/node / v24.x
```

Node の場所は `deploy/install.sh` が `command -v node` で拾う（別の場所なら `--node` で指定する）。

#### 推奨例: 専用の実行ユーザーとディレクトリを作る（任意）

root で動かすなら不要。専用ユーザーで動かす場合の例:

```bash
useradd --system --create-home --home-dir /var/lib/bsky-bots --shell /usr/sbin/nologin bsky-bots
usermod -aG systemd-journal bsky-bots  # 失敗通知が journal を読むため（root なら不要）
install -d -o bsky-bots -g bsky-bots -m 0755 /opt/bsky-bots
install -d -o root -g bsky-bots -m 0750 /etc/bsky-bots      # env をコードと分けて置く場合
```

---

## 4. 配置（切り替えの数日前に済ませる）

以降の例は次の変数で書く。自分の環境に合わせて最初に設定しておく。

```bash
APP_DIR=/opt/bsky-bots        # clone 先。どこでもよい（例: /root/bsky-bots）
RUN_USER=bsky-bots            # 実行ユーザー＝APP_DIR の所有者（root で動かすなら root）
ENV_FILE=$APP_DIR/.env        # 認証情報。install.sh の既定。推奨例では /etc/bsky-bots/bsky-bots.env
```

### 4-1. コード

任意の場所に clone してビルドする。`APP_DIR` の所有者が実行ユーザーになる。

```bash
sudo -u "$RUN_USER" git clone https://github.com/ShinoharaTa/bsky-bots.git "$APP_DIR"
cd "$APP_DIR"
sudo -u "$RUN_USER" npm ci
sudo -u "$RUN_USER" npm run build
ls -l dist/main.js dist/tools/notify-failure.js
```

`dist/` は git 管理外。**コードを更新したら必ず `npm ci && npm run build` し直す**（9 章）。

#### タグ運用（任意）

本番に出すコミットを固定したいときは、タグを打って checkout する（開発用ツリーで。**main にマージ済みのコミットだけ**にタグを打つ）。

```bash
git fetch origin
git tag -a v1.0.0 -m "v1.0.0" origin/main
git push origin v1.0.0
```

新ホストで（checkout したら `npm ci && npm run build` し直す）:

```bash
cd "$APP_DIR"
sudo -u "$RUN_USER" git fetch --tags origin
sudo -u "$RUN_USER" git checkout --detach v1.0.0
sudo -u "$RUN_USER" git describe --tags --exact-match   # v1.0.0
```

### 4-2. 認証情報

**App Password を 3 つ新規発行する**（skyhigh / skylog / jiho）。Bluesky の Settings → App Passwords。
旧 App Password は回収して使い回さない（旧実装がリフレッシュトークンを毎日ログに出していた。#8）。

旧 App Password は**まだ失効させない**。GCP の旧実装は旧 App Password でログインしているので、
ここで失効させるとロールバックで GCP に戻せなくなる。失効は 10 章。

Discord webhook も用意する（Discord のチャンネル設定 → 連携サービス → ウェブフック → 新しいウェブフック →
「ウェブフック URL をコピー」）。**webhook URL は秘密情報**（知っていれば誰でもそのチャンネルに投稿できる）。
env ファイルにだけ書く。チャットやログ、コミットに貼らない。

```bash
# 既定（APP_DIR/.env）: 実行ユーザーだけが読める 0600 で作る
sudo -u "$RUN_USER" install -m 0600 /dev/null "$ENV_FILE"
sudo -u "$RUN_USER" "${EDITOR:-vi}" "$ENV_FILE"
# 推奨例（/etc/bsky-bots/bsky-bots.env）の場合は root:bsky-bots 0640 で作る
#   install -o root -g bsky-bots -m 0640 /dev/null /etc/bsky-bots/bsky-bots.env
#   sudoedit /etc/bsky-bots/bsky-bots.env
```

中身（値は書かない。変数名だけ）:

```
SKYHIGH_IDENTIFIER=skyhigh.bsky.social
SKYHIGH_APP_PASSWORD=
SKYLOG_IDENTIFIER=skylog.bsky.social
SKYLOG_APP_PASSWORD=
JIHO_IDENTIFIER=jiho.bsky.social
JIHO_APP_PASSWORD=
DISCORD_WEBHOOK_URL=
```

```bash
sudo stat -c '%U:%G %a %n' "$ENV_FILE"    # 既定なら <RUN_USER>:<group> 600、推奨例なら root:bsky-bots 640
sudo cut -d= -f1 "$ENV_FILE"              # 変数名だけ表示して確認
sudo grep -E '^[A-Z_]+=$' "$ENV_FILE"     # 値が空の変数（何も出なければ全部埋まっている）
```

- 値をクォートで囲まない（systemd の `EnvironmentFile` はクォートを値に含めることがある）。

### 4-3. unit の登録（**まだ enable しない**）

`deploy/install.sh` が `deploy/system/` の unit テンプレートの `@APP_DIR@` / `@ENV_FILE@` /
`@RUN_USER@` / `@RUN_GROUP@` / `@NODE@` / `@PROTECT_HOME@` を埋めて `/etc/systemd/system/` に
`0644` で書き込み、`daemon-reload` と `systemd-analyze verify` まで行う。**timer は有効化しない**（6 章で行う）。

| 値 | 既定 | 上書き |
| --- | --- | --- |
| `APP_DIR` | `deploy/install.sh` の 1 つ上 | `--app-dir` |
| `RUN_USER` / `RUN_GROUP` | `APP_DIR` の所有者 / そのプライマリグループ | `--user` |
| `NODE` | `command -v node` | `--node` |
| `ENV_FILE` | `APP_DIR/.env` | `--env-file` |
| `ProtectHome` | `APP_DIR` か `ENV_FILE` が `/root`・`/home`・`/run/user` 配下なら `read-only`、それ以外は `yes` | — |

```bash
cd "$APP_DIR"
deploy/install.sh --print | less              # 生成結果を確認する（書き込まない。root 不要）
sudo deploy/install.sh                        # 登録する（root が要る）
# 推奨例（/etc/bsky-bots/bsky-bots.env）の場合
#   sudo deploy/install.sh --env-file /etc/bsky-bots/bsky-bots.env
systemctl list-unit-files 'bsky-*'            # timer が disabled であること
```

/root に置いて root で動かす場合は `cd /root/bsky-bots && deploy/install.sh` だけでよい。

- 事前チェックで止まる（エラー終了）: `dist/main.js` / `dist/tools/notify-failure.js` が無い（`npm ci && npm run build` する）、`ENV_FILE` が無い、`RUN_USER` が存在しない、`NODE` が実行できない
- 警告だけ出す: `ENV_FILE` が他のユーザーから読める（`chmod 600` する）、`RUN_USER` が `systemd-journal` グループに属していない（`usermod -aG systemd-journal <user>` する。root なら不要）、`RUN_USER` が root
- `sudo` 経由で `node` が PATH に無いときは `--node "$(command -v node)"` を付ける

`verify` は**何も出力されなければ警告 0**。
`verify` が見るのは**最初の `ExecStart` の実行ファイルだけ**で、`WorkingDirectory` /
`EnvironmentFile` / 2 つ目以降の `ExecStart`（`bsky-bots-failure@` の Discord 通知）は見ない。
install.sh が事前チェックで `dist/` と `ENV_FILE` の存在を確かめているが、念のため登録後に見るなら:

```bash
grep -hE '^(User|Group|WorkingDirectory|EnvironmentFile|ExecStart|ProtectHome)=' /etc/systemd/system/bsky-skyhigh.service
```

### 4-4. Discord 通知の疎通確認

失敗通知用の unit を手で 1 回起動する（Discord に**テスト通知が 1 件届く**。本物の失敗ではないので
`Result` は空などになる）。

```bash
sudo systemctl start bsky-bots-failure@manual-test.service
journalctl -u bsky-bots-failure@manual-test.service -n 20 --no-pager
```

Discord にメッセージが届き、journal に webhook URL が出ていないこと。

---

## 5. 切り替え前の受け入れ確認（新ホストで dry-run を 3 日）

dry-run はログインも投稿もしないので、**GCP が動いたままで**実行してよい。

| 条件 | 内容 |
| --- | --- |
| skyhigh / skylog | 5-1 の受け入れ条件 **A〜E**（本番の実投稿との突き合わせ・朝夜の一致・完走時間・失敗件数・投稿 0）。**A〜D を 3 日連続**で満たす。E は毎回 |
| jiho | 5-2。出力が `なう(YYYY/MM/DD HH:mm:ss)` で、時刻が実行時の JST と一致（J-A1） |
| timer | `systemd-analyze calendar` で 3 本の次回時刻が期待どおり（5-3） |
| 完走時間 | skylog のフル dry-run を 1 回測り、`TimeoutStartSec=3600` が妥当か判断する（C） |

### 5-1. skyhigh / skylog の受け入れ条件 A〜E

新実装は旧実装と**意図して出力を変えている**（did 化・skylog の分類と時刻基準・上限。README の
「旧実装との差分」）。したがって新旧の出力が一致することは条件にしない。以下の **A〜E** を見る。

以下のコマンドは新ホストの `$APP_DIR`（本番に出すコード。4 章の変数）で、root から叩く。どれも**読み取りのみ**で投稿しない。

準備（毎回）:

```bash
cd "$APP_DIR"
mkdir -p /tmp/bsky-check
D=$(TZ=Asia/Tokyo date +%F)          # 実行日（JST）。対象日はこの前日
BOT=skyhigh                           # skylog のときは BOT=skylog
run() { sudo -u "$RUN_USER" node "$@"; }
```

#### A. 本番（GCP）との突き合わせ

GCP がその日に実際に投稿した内容（公開 API で取得）と、新実装の**同じ対象日**の dry-run を比べる。
dry-run の対象日は「実行した日の前日」なので、**GCP が投稿したのと同じ日（JST）のうちに** dry-run を取る。

- skyhigh: GCP は 08:45 開始で 1〜1.5 時間かかる。**11:00 以降**に取る
- skylog: GCP は 00:20 開始。GCP の「集計終了」が出てから（7-1 のコマンドで確認）その日のうちに取る

朝の dry-run（B と C もこの 1 回で取る）:

```bash
start=$(date +%s)
run dist/main.js "$BOT" > /tmp/bsky-check/$BOT-$D-am.jsonl 2> /tmp/bsky-check/$BOT-$D-am.err
echo "exit=$? elapsed=$(( $(date +%s) - start ))s"
```

突き合わせ:

```bash
run dist/tools/compare-gcp.js "$BOT" /tmp/bsky-check/$BOT-$D-am.jsonl | tee /tmp/bsky-check/$BOT-$D-compare.txt
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
run dist/tools/probe.js did:plc:xxxxxxxxxxxxxxxxxxxxxxxx 2026-09-22
```

#### B. 決定性

同じ対象日の dry-run を**朝と夜**に取り、時刻文字列と `createdAt` を除いて完全一致すること。
朝の分は A で取ったもの。夜（同じ日の 20:00〜23:30 ごろ。**日付を跨がないこと**）:

```bash
run dist/main.js "$BOT" > /tmp/bsky-check/$BOT-$D-pm.jsonl 2> /tmp/bsky-check/$BOT-$D-pm.err
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
`deploy/system/bsky-skylog.service` の値を見直す。

dry-run は投稿しないので、`--live` の実時間は**投稿のぶん長くなる**（skylog は対象ユーザー数ぶんの
リプライを投稿する）。切り替え後の実時間は 7 章のコマンドで確かめる。

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
run dist/main.js "$BOT" --limit-followers=5 > /dev/null 2> /tmp/bsky-check/$BOT-$D-e.err
after=$(posts $BOT.bsky.social)
echo "before=$before after=$after"
grep -c 'logged in as' /tmp/bsky-check/$BOT-$D-e.err
```

**E の合格**: `before` と `after` が同じで、`logged in as` が 0 件（0 件のとき `grep -c` は exit 1 になるが正常）。

### 5-2. jiho

```bash
cd "$APP_DIR"
sudo -u "$RUN_USER" node dist/main.js jiho; echo "exit=$?"
TZ=Asia/Tokyo date '+%Y/%m/%d %H:%M:%S'
```

出力が `なう(YYYY/MM/DD HH:mm:ss)` で、時刻が直後の `date` と一致すること（J-A1）。

### 5-3. timer

```bash
systemd-analyze calendar --iterations=3 '*-*-* 08:45:00 Asia/Tokyo'
systemd-analyze calendar --iterations=3 '*-*-* 00:20:00 Asia/Tokyo'
systemd-analyze calendar --iterations=3 '*-*-* *:27,57:00 Asia/Tokyo'
```

OS の TZ が Asia/Tokyo なら JST で、UTC なら UTC で表示される（08:45 JST = 23:45 UTC / 00:20 JST = 15:20 UTC）。

---

## 6. 一斉切り替え（当日）

### 6-1. 時間帯の選び方

一時停止は許容されるので（S5）、気にするのは**旧 skyhigh / skylog の実行中に止めないこと**だけ。
実行中に止めると、「集計開始」だけ出て結果が出ない中途半端な状態になる。

| 避ける時間帯（JST） | 理由 |
| --- | --- |
| 00:15〜01:00 | 旧 skylog の実行中（00:20〜00:56 頃） |
| 08:40〜10:30 | 旧 skyhigh の実行中（08:45〜10:20 頃） |

時報は止まっても欠けるだけなので気にしなくてよい。
新ホストでの初回は、時報が直後の :27 か :57、skylog が翌 00:20、skyhigh が翌 08:45 になる。
**翌日の 00:20 と 08:45 に様子を見られる日**を選ぶ。

### 6-2. 手順

**二重投稿を避けるため、「GCP 側が止まった確認」を「新ホストの timer 有効化」より前に置く。**

#### GCP 側（supervisor を止める）

```bash
# 1. いま何が supervisor 管理下にあるか記録しておく（ロールバック用）
sudo supervisorctl status | tee ~/bsky-supervisor-before.txt

# 2. 全部止める
sudo supervisorctl stop all

# 3. マシン再起動で旧 Bot が勝手に復活しないようにする（★必須）
#    supervisord は OS 起動時に autostart で全プログラムを起こす。
#    GCP を撤去するまでの間に再起動が入ると、新ホストと二重に投稿する。
sudo systemctl disable supervisor        # サービス名は環境により supervisord の場合あり

# 4. 止まったことを確認
sudo supervisorctl status                # すべて STOPPED
pgrep -af node || echo "node プロセスなし"
```

> supervisor 以外（crontab 等）から旧 Bot が起動されていないことも、念のため `crontab -l` と `sudo crontab -l` で確かめておく。

#### 新ホスト側

```bash
systemctl enable --now bsky-skyhigh.timer bsky-skylog.timer bsky-jiho.timer
systemctl list-timers 'bsky-*'           # 次回: jiho 直近の :27 か :57、skylog 翌 00:20、skyhigh 翌 08:45
```

#### 確認

| いつ | 見ること |
| --- | --- |
| 直後の時報の枠 | 公開 API で 1 件だけ出ている（二重なし）。`journalctl -u bsky-jiho -n 20` に成功ログ |
| その次の枠 | 同上 |
| 翌 00:20〜 | skylog の初回。`journalctl -u bsky-skylog -f`、summary が `status=ok` |
| 翌 08:45〜 | skyhigh の初回。`journalctl -u bsky-skyhigh -f`、ランキング投稿が出る |

```bash
# 新ホストでの確認コマンド
systemctl list-timers 'bsky-*'
journalctl -u 'bsky-*' --since today --no-pager | grep -E ' summary: |error|fail'
```

**GCP 側は観察期間（7 章）が終わるまで起動できる状態で残す。** 消すとロールバック手段が消える。

### 6-3. ロールバック

旧 App Password は 10 章まで失効させていないので、GCP をそのまま戻せる。

```bash
# 新ホスト
systemctl disable --now bsky-skyhigh.timer bsky-skylog.timer bsky-jiho.timer
systemctl list-units 'bsky-*.service' --state=active     # 実行中が無いこと
```

```bash
# GCP
sudo systemctl enable --now supervisor
sudo supervisorctl start all
sudo supervisorctl status                # ~/bsky-supervisor-before.txt と同じ状態に戻ったこと
```

**Bot 単位で戻すこともできる**: 新ホストで timer を 1 本だけ disable し、GCP では `sudo supervisorctl start <プログラム名>` で該当 Bot だけ起こす。
ただしこの場合は supervisor 全体を enable に戻すと他の Bot も起動するので、**`systemctl enable supervisor` はせず**、他のプログラムが STOPPED のままであることを確認する。

新しいタグに上げてから問題が出たときは、GCP に戻さずに前のタグに戻せばよい（9 章）。

---

## 7. 観察

| 期間 | 見ること |
| --- | --- |
| 当日〜翌日 | 3 Bot の初回がすべて `status=ok`（時報は exit 0） |
| 7 日 | skyhigh のランキングが**毎日**出ている（旧実装は 5 日に 1 日落としていた。#12）。7-1 |
| 7 日 | skylog が毎日完走している（「集計終了」が出ている）。7-1 |
| 7 日 | 時報の 30 分枠の欠落が 0.3% 以下、二重 0、遅れ 0〜6 分 |
| 7 日 | skylog の所要時間（`elapsed=`）→ `TimeoutStartSec` を見直す |

```bash
journalctl -u bsky-skyhigh --since '7 days ago' --no-pager | grep ' summary: '
journalctl -u bsky-skylog  --since '7 days ago' --no-pager | grep ' summary: '
journalctl -u bsky-jiho    --since '1 day ago'  --no-pager | grep -ciE 'error|fail'
# 失敗検知（OnFailure から記録されたもの。err 優先度）
journalctl -t bsky-bots-failure --since '7 days ago' --no-pager
# Discord 通知そのものの結果（送れなかったときの理由もここ）
journalctl -u 'bsky-bots-failure@*' --since '7 days ago' --no-pager
# 直近の実行の開始・終了時刻
systemctl show bsky-skyhigh.service -p ExecMainStartTimestamp -p ExecMainExitTimestamp
```

時報は失敗しても通知しない（D4）ので、観察期間中は上のコマンドで journal を見る。

skyhigh / skylog が非 0 終了すると（取得失敗が続く・投稿失敗・例外）、`bsky-bots-failure@` が journal に記録し、
Discord に unit 名・ホスト名・時刻（JST）・`Result` / `ExecMainStatus`・最後の起動分のログ末尾 30 行を送る。

**鳴らないケースがある。** timer が動いていない・ホストが落ちていた・`DISCORD_WEBHOOK_URL` が
空（journal にだけ `DISCORD_WEBHOOK_URL is not set` が出る）。**無通知＝正常ではない。**
投稿の有無は 7-1 の方法で別に見る。

### 7-1. 公開 API で投稿の有無を直接見る

**旧実装は 5 日に 1 日ランキングを落としていた（#12）。しかもエラー通知は 0 件だった。**
Discord のアラートとは別に、**公開 API で投稿の有無を直接見る**。認証は要らない。
8 章の手動実行の前の確認にもこれを使う。

#### skyhigh: 直近 7 日ぶんのランキング投稿の有無

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

#### skylog: 直近 7 日ぶんの完走の有無

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

「集計開始」があって「集計終了」が無い日（途中で落ちた）にも注意する。
途中まで投稿されている日にもう一度実行すると、その日の前半のユーザーが二重に投稿される。

```bash
curl -s "https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=skylog.bsky.social&filter=posts_no_replies&limit=20" \
| TZ=Asia/Tokyo jq -r '.feed[].post | select(.author.handle == "skylog.bsky.social")
  | select(.record.text | test("^集計(開始|終了)"))
  | (.record.createdAt[0:19] + "Z" | fromdateiso8601 | strflocaltime("%F %T")) + "  " + (.record.text | split("：")[0])'
```

---

## 8. 取りこぼしたときの手動実行（skyhigh / skylog）

**手動実行の前に、当日分が既に投稿されていないかを必ず確かめる。** 二重投稿が最悪ケース。

1. 7-1 のコマンドで**今日の行**を見る。`OK` なら**実行しない**（既に投稿済み）。`MISSING` なら次へ
2. その Bot の service が動いていないことを確かめる（`inactive` か `failed` なら次へ）

   ```bash
   systemctl is-active bsky-skyhigh.service
   ```

3. 実行する（`--no-block` で即座に戻る。完了まで数分〜数十分かかる）

   ```bash
   systemctl start --no-block bsky-skyhigh.service
   journalctl -u bsky-skyhigh.service -f
   ```

4. 終わったら 7-1 のコマンドで今日の行が `OK` になったか見る

対象日は**実行した日（JST）の前日**。日付を跨いでから実行すると別の日の集計になるので、
**取りこぼした日のうちに**実行する。跨いでしまった日の分は取り戻せない（対象日を指定する手段は無い）。

skylog も同じ（`bsky-skylog.service`）。ただし skylog は途中で落ちると「集計開始」とその後の
一部のユーザーだけが投稿済みになる。**再実行するとそのユーザーが二重に投稿される**ので、
7-1 の「集計開始 / 集計終了」のコマンドで、今日「集計開始」だけが出ていないかも確かめる。

時報は手動で取り返さない（逃した枠は欠けるだけ）。

---

## 9. 更新手順（新しいリリースを入れるとき）

one-shot なので、**実行中でなければ**入れ替えるだけで次回の起動から新しいコードになる。

```bash
systemctl list-units 'bsky-*.service' --state=active   # 実行中が無いこと（時報は :27/:57 付近を避ける）
cd "$APP_DIR"
OLD=$(sudo -u "$RUN_USER" git rev-parse HEAD)         # 今のコミットを控える（ロールバック先）
sudo -u "$RUN_USER" git pull
sudo -u "$RUN_USER" npm ci
sudo -u "$RUN_USER" npm run build
sudo -u "$RUN_USER" git diff --stat "$OLD" HEAD -- deploy/   # unit（テンプレート / install.sh）が変わったか
# unit が変わったときだけ（4-3 と同じオプションで）
sudo deploy/install.sh
```

戻すときは `git checkout --detach "$OLD"` してから同じく `npm ci && npm run build`（unit が変わっていたら `deploy/install.sh` も）。

タグ運用（任意。4-1）の場合は `git pull` の代わりに `git fetch --tags origin && git checkout --detach v1.0.1` とし、
戻すときは前のタグで同じことをする（`git tag --sort=-creatordate | head -5` で戻し先を選ぶ）。

---

## 10. GCP 撤去と失効（観察 7 日が終わってから）

1. GCP 上の旧 Bot 一式（supervisor のプログラム定義、旧 skyhigh / skylog / nodecron のコードと `.env`）と、**supervisor のログ**（既定は `/var/log/supervisor/`）を削除する。#8: 旧 skyhigh / skylog はリフレッシュトークンとメールアドレスを毎日ログに出していた
2. **旧 App Password を失効させる**（Bluesky の Settings → App Passwords → Revoke）。4-2 で新規発行したものは残す。
   **これで #8（旧実装がログに出していたリフレッシュトークン）が無効になる**

   | アカウント | 用途 |
   | --- | --- |
   | `skyhigh.bsky.social` | 旧 skyhigh |
   | `skylog.bsky.social` | 旧 skylog |
   | `jiho.bsky.social` | 旧 nodecron の時報 |
   | `shino5.bsky.social` | 旧 nodecron の WN Live（廃止） |
   | 不明（`SYSTEM_AUTHOR`） | 旧 nodecron の起動通知（廃止）。GCP の nodecron の `.env` の値で判断 |

3. `ShinoharaTa/bsky-skyhigh` / `bsky-skylog` / `bsky-nodecron` の README に統合先を書いて push → Archive

---

## 11. 作業の全体順序

| # | 作業 | 担当 | 依存 |
| --- | --- | --- | --- |
| 1 | J1 core の一般化（#20） | implementer | — |
| 2 | J2 時報 Bot の追加（#21） | implementer | 1 |
| 3 | system 用 unit・notify-failure の scope 対応・この文書（#22） | implementer | 2 |
| 4 | リリースタグ `v1.0.0`（任意） | ユーザー指示で | 3 |
| 5 | 新ホストの準備（3 章）・配置（4 章） | ユーザー | 4 |
| 6 | 受け入れ確認 dry-run 3 日（5 章） | ユーザー | 5 |
| 7 | 一斉切り替え（6 章） | ユーザー | 6 |
| 8 | 観察 7 日（7 章） | ユーザー | 7 |
| 9 | GCP 撤去・失効・Archive（10 章） | ユーザー | 8 |

---

## 12. 当日確認すること

| # | 論点 |
| --- | --- |
| U2 | GCP の supervisor のサービス名（`supervisor` / `supervisord`）とプログラム名は、当日 `supervisorctl status` で確認する |
| U4 | LXC の ID・ストレージ名・ブリッジ名（3-A の `pct create` の値。ユーザー環境依存） |
