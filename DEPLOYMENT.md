# デプロイ手順（Coolify / Docker）

対象: issue #34（Coolify への移行）。3 Bot（skyhigh / skylog / jiho）を、自宅の Coolify 上の
**常駐スケジューラ 1 コンテナ**で動かす手順。systemd（LXC）版の手順は [docs/deploy.md](docs/deploy.md)。
切り替えが終わるまでは、両方を **Bot ごとに**入れ替えながら使う。

---

## 1. 構成

```
Coolify アプリ bsky-bots（build pack = dockerfile、リポジトリ直下の Dockerfile）
└─ コンテナ（tini → node dist/scheduler/main.js、node ユーザー）
   ├─ スケジューラ: croner で cron を Asia/Tokyo で読み、各回 `node dist/main.js <bot> [--live]` を子として起動
   ├─ /data（Volume）: scheduler-state.json（30 秒ごとに atomic write）
   └─ HEALTHCHECK: node dist/scheduler/healthcheck.js（状態ファイルが 90 秒以内に書かれていて ready なら healthy）
```

| job | cron（JST） | ゆらぎ | timeout | 失敗の Discord 通知 |
| --- | --- | --- | --- | --- |
| skyhigh | `45 8 * * *` | なし | 1800 秒 | する |
| skylog | `20 0 * * *` | なし | 3600 秒 | する |
| jiho | `27,57 * * * *` | 0〜360 秒 | 600 秒 | しない |

- サーバーの TZ は UTC。スケジューラは TZ 環境変数に頼らず、cron を常に `Asia/Tokyo` で読む。
- 同じジョブは前回が終わるまで起動しない（`skipped reason=overlap`）。過ぎた枠は後から実行しない。
- timeout になったら子に SIGTERM、10 秒後に SIGKILL。結果は失敗扱い。

### 該当しないもの

| 項目 | 理由 |
| --- | --- |
| HTTP（ドメイン・ポート・Traefik） | 受信ポートが無い。Bot は外へ出ていくだけで、何も待ち受けない |
| DB | DB を持たない。状態は `/data/scheduler-state.json` だけ（healthcheck 用。消えても次の書き込みで戻る） |
| Cloudflare Access | 受信 Webhook も画面も無いので、守る入口が無い |
| `/metrics` | 作らない。JSON ログの summary 行で足りる |

---

## 2. Docker のビルドと起動

Dockerfile は 3 段。

1. `deps`: `npm ci`（全依存）
2. `build`: ソース一式をコピーし、`npm run typecheck && npm run lint && npm test && npm run build`。
   **CI が無いので、テストが落ちるとイメージができない**（Coolify のデプロイも失敗する）
3. `runtime`: `node:24-slim` + tini。`npm ci --omit=dev` と `dist/` だけを入れる。テストファイルは入らない。
   `/data` は `node` の所有で作ってある（名前付き Volume は初回にイメージ側の所有者を引き継ぐ）

`.dockerignore` で `.git` `node_modules` `dist` `legacy` `bsky-*/` `.claude` `.env` `.env.*`（`.env.example` は除く）
`docs` `deploy` `*.car` を外している。`deploy/install.test.ts`（systemd 版のテスト）も一緒に外れるので、
イメージのビルドでは実行されない（ローカルの `npm test` では従来どおり実行する）。

ローカルで試すとき（Docker がある機械で。**dry-run のまま**動かす）:

```bash
docker build -t bsky-bots .
docker run --rm -e BOT_JOBS=jiho -e JOB_CRON_JIHO='* * * * *' -e JOB_JITTER_JIHO=0 \
  -v bsky-data:/data bsky-bots
# 別の端末で
docker ps                                   # STATUS が (healthy) になる（start-period 30 秒・interval 60 秒）
docker kill --signal=TERM <container>       # [scheduler] stopping → stopped で exit 0
```

- `BOT_MODE` を付けなければ dry-run（投稿しない。ログインも起動時の確認だけ。6 章）。**ローカルで `BOT_MODE=live` にしない。**
- `JOB_CRON_*` などの上書きは dry-run 専用。`BOT_MODE=live` で 1 つでも設定されていると起動しない。

---

## 3. 環境変数

全変数の名前と説明は [.env.example](.env.example)。**秘密の値はユーザーが Coolify の画面で入れる**
（チャット・ログ・コミットに出さない）。秘密でない値は、ユーザーか Claude（Coolify の MCP）が入れる。

| 名前 | 既定 | 秘密 | 誰が入れるか | 意味 |
| --- | --- | --- | --- | --- |
| `BOT_MODE` | `dry-run` | いいえ | ユーザー / Claude（**live への変更はユーザーの合図で**） | `dry-run` / `live`。それ以外は起動しない |
| `BOT_JOBS` | 空 | いいえ | ユーザー / Claude | 有効にするジョブ（カンマ区切り）。空なら待機（WARN を 1 回） |
| `TZ` | — | いいえ | 設定済み（`Asia/Tokyo`） | スケジューラは使わない（cron は常に Asia/Tokyo） |
| `STATE_DIR` | `/data` | いいえ | 通常は入れない | 状態ファイルの置き場所 |
| `SERVICE_NAME` | `bsky-bots` | いいえ | 通常は入れない | ログと Discord に出す名前 |
| `APP_ENV` | `production` | いいえ | 通常は入れない | ラベル。live の判定には使わない |
| `LOG_FORMAT` | `text` | いいえ | ユーザー / Claude | `text` / `json` |
| `LOG_LEVEL` | `info` | いいえ | ユーザー / Claude | `debug` / `info` / `warn`。スケジューラ自身の行にだけ効く（例外: `debug` のとき skyhigh が投稿 0 件のハンドル一覧を 1 行出す） |
| `NOTIFY_IN_DRY_RUN` | `false` | いいえ | ユーザー / Claude | `true` なら dry-run でも Discord に送る |
| `DISCORD_WEBHOOK_URL` | なし | **はい** | ユーザー（画面） | 任意。skyhigh / skylog の失敗通知先。未設定なら起動時に WARN |
| `SKYHIGH_IDENTIFIER` / `SKYLOG_IDENTIFIER` / `JIHO_IDENTIFIER` | なし | いいえ | ユーザー / Claude | ハンドル。live のとき有効なジョブの分は必須。dry-run では skyhigh / skylog のフォロワー取得の対象（未設定なら既定のハンドル） |
| `SKYHIGH_APP_PASSWORD` / `SKYLOG_APP_PASSWORD` / `JIHO_APP_PASSWORD` | なし | **はい** | ユーザー（画面） | App Password。live のとき有効なジョブの分は必須 |
| `JOB_CRON_<BOT>` / `JOB_JITTER_<BOT>` / `JOB_TIMEOUT_<BOT>` | なし | いいえ | 試験のときだけ | dry-run 専用の上書き。live で設定されていると起動しない |

- 伏字: `*_APP_PASSWORD` と `DISCORD_WEBHOOK_URL` の値、JWT 形式の文字列は、転送するすべての行と Discord 本文で `<redacted>` になる。`*_IDENTIFIER` は伏せない。
- Coolify 側の確認は `list_env_keys`（名前だけ）で行う。値は読まない。

---

## 4. Coolify の設定

| 項目 | 設定 | 理由 |
| --- | --- | --- |
| Build Pack | `dockerfile`（リポジトリ直下の `Dockerfile`） | |
| ドメイン | なし | 受信ポートが無い |
| ポート（Ports Exposes / Mappings） | なし | 同上。Dockerfile にも `EXPOSE` は無い |
| Persistent Storage | Volume を `/data` にマウント | 状態ファイルは `/data` だけに書く。Dockerfile に `VOLUME` は無い |
| Stop Grace Period | **3600 秒** | SIGTERM を受けたら、実行中の子が終わるまで待つ（skylog の timeout が 3600 秒） |
| Rolling Update | **無効（Consistent Container Names を有効）** | 新旧のコンテナが重なると、同じ枠を 2 回実行しうる（二重投稿） |
| Health Check（ダッシュボード） | **無効** | HTTP が無い。Dockerfile の `HEALTHCHECK`（状態ファイル）を使う |
| 自動デプロイ（push で Deploy） | **無効** | 手動デプロイ（5 章） |
| PR プレビュー | **無効** | プレビューでも Bot が動いてしまう |

---

## 5. デプロイは手動

Coolify で **Deploy を押したときだけ**デプロイする（main への push では動かない）。
Deploy・Restart すると古いコンテナに SIGTERM が届き、スケジューラは新しい起動を止めて**実行中の子が終わるまで待つ**。

**Deploy / Restart を押さない時間帯（JST）**

| 時間帯 | 理由 |
| --- | --- |
| 00:15〜01:00 | skylog（00:20 起動。長いと 1 時間近く）が実行中 |
| 08:40〜09:00 | skyhigh（08:45 起動）が実行中 |

jiho は :27 / :57 から 0〜6 分後に起動し数秒で終わるので、それ以外の時間帯なら待ちは短い。
押した後は、ログに `[scheduler] stopping signal=SIGTERM running=<...>` → `[scheduler] stopped` が出て、
新しいコンテナの起動行が出ることを確かめる。

---

## 6. ログ

ログは標準出力・標準エラーまで（ファイルに書かない）。Loki / Prometheus は未接続。

### text（既定。`LOG_FORMAT=text`）

- Bot（子）の行は**そのまま**流す（伏字だけ適用）。Bot の stdout（dry-run の投稿 JSON）は stdout、stderr は stderr。
- スケジューラ自身の行は stderr に `[scheduler] <msg> key=value ...`。null は `none`、経過時間は `12.3s`。

```
[scheduler] start mode=dry-run jobs=skyhigh,skylog,jiho service=bsky-bots env=production
[scheduler] MODE=LIVE jobs=jiho                         ← live のときの起動行（start の代わり）
[scheduler] run job=jiho run_id=jiho-2026-11-24T07:16:00.028Z
[scheduler] done job=jiho run_id=jiho-2026-11-24T07:16:00.028Z exit=0 signal=none timeout=false elapsed=0.5s
[scheduler] skipped job=skyhigh reason=overlap
[scheduler] would notify job=skyhigh run_id=...         ← dry-run で通知の代わりに出る
[scheduler] warn: ... / [scheduler] error: ... / [scheduler] spawn failed: ...
[scheduler] stopping signal=SIGTERM running=none
[scheduler] stopped
[skyhigh] summary: status=ok processed=5 fetch_failed=0 post_failed=0 fallback=0 elapsed=4.0s
```

### json（`LOG_FORMAT=json`）

**すべての行を stdout に** 1 行 1 JSON で出す。

```json
{"ts":"2026-11-24T07:16:00.028Z","level":"info","service":"bsky-bots","env":"production","job":"jiho","run_id":"jiho-2026-11-24T07:16:00.028Z","stream":"scheduler","msg":"run"}
{"ts":"2026-11-24T07:16:00.492Z","level":"info","service":"bsky-bots","env":"production","job":"jiho","run_id":"jiho-2026-11-24T07:16:00.028Z","stream":"stdout","msg":"{\"seq\":1,\"kind\":\"post\",...}"}
```

- `stream`: 子の行は元の出力先（`stdout` / `stderr`）、スケジューラ自身の行は `scheduler`。
- `job` / `run_id`: 子の行には常に入る。スケジューラ自身の行は持つときだけ（`start` や `stopping` には無い）。
- `level`: 子の行は `info`。` summary: status=` の status が ok 以外なら `warn`、`[<bot>] failed:` を含めば `error`。
  スケジューラ自身の行は `warn:` / `error:` / `spawn failed:` などで決まり、msg からは `warn: ` などの接頭辞を外す。
- 子の stdout（dry-run の投稿 JSON）は `msg` に**文字列のまま**入る（パースしない）。
- `LOG_LEVEL` はスケジューラ自身の行にだけ効く。Bot の出力は落とさない（例外: `debug` のときだけ skyhigh が投稿 0 件のハンドル一覧を 1 行出す。既定では人数だけ）。起動行（`start` / `MODE=LIVE`）は `LOG_LEVEL` に関わらず出る。

### 起動時のログイン確認

起動するたびに（ready になった後、裏で）有効な各ジョブの `<BOT>_IDENTIFIER` と `<BOT>_APP_PASSWORD` で
bsky.social に 1 回だけ login し、通ったらすぐ logout する。投稿はしない。dry-run でも認証情報が入っていれば行う。
App Password の入れ間違い・失効を、最初の投稿の時刻を待たずに見つけるため。ジョブは 1 つずつ順に確かめ、1 回の login は 15 秒で打ち切る。

```
[scheduler] login check job=jiho result=ok
[scheduler] login check job=skyhigh result=failed reason=Invalid identifier or password
[scheduler] login check job=skylog result=unset reason=SKYLOG_IDENTIFIER, SKYLOG_APP_PASSWORD is not set
[scheduler] login check job=jiho result=skipped previous=ok checked_at=2026-11-24T07:10:00.000Z
```

```json
{"ts":"2026-11-24T07:16:00.512Z","level":"info","service":"bsky-bots","env":"production","job":"jiho","stream":"scheduler","msg":"login check result=ok"}
{"ts":"2026-11-24T07:16:01.034Z","level":"error","service":"bsky-bots","env":"production","job":"skyhigh","stream":"scheduler","msg":"login check result=failed reason=Invalid identifier or password"}
```

| result | level | 意味 |
| --- | --- | --- |
| `ok` | info | login できた |
| `failed` | error | login できなかった（`reason` に理由。秘密の値は伏字）。skyhigh / skylog は失敗通知と同じ条件で Discord にも送る（live、または dry-run で `NOTIFY_IN_DRY_RUN=true`） |
| `unset` | warn | `<BOT>_IDENTIFIER` か `<BOT>_APP_PASSWORD` が無い・空（dry-run のときだけ起こる。live は起動しない） |
| `skipped` | info | 同じ認証情報で 10 分以内に確かめ済み。試さず前回の結果（`previous`、`checked_at`）を引き継ぐ。通知もしない |

- **失敗してもスケジューラは落とさず、healthy のまま。** 落とすと Coolify が再起動を繰り返し、そのたびに login して
  createSession の回数制限に当たりやすくなる（当たると正しい認証情報でも投稿できなくなる）。気づくのはログと Discord で。
- 再起動が続いても、同じ認証情報なら 10 分以内は試し直さない。認証情報を直したら（値が変わるので）再デプロイで
  すぐ確かめ直される。
- 状態ファイル（`/data/scheduler-state.json`）の各ジョブに `login: {result, at, fp, reason?}` が残る（確かめる前は `pending`）。
  `fp` は認証情報の短いハッシュ（sha256 の先頭 16 桁）で、値そのものではない。ログには出さない。
- login の回数は、起動 1 回につき 1 Bot 1 回増えるだけ（10 分以内の再起動なら増えない）。
- 起動時の行がログから流れても分かるよう、各回の `done` の行の末尾に `login=<result>` を付ける
  （`ok` / `failed` / `unset` / 確かめる前は `pending`。`skipped` のときは引き継いだ前回の結果）。
  例: `[scheduler] done job=jiho run_id=... exit=0 signal=none timeout=false elapsed=0.4s login=ok`

### よく見るもの

```bash
# text（Coolify のログ画面、または docker logs）
docker logs <container> 2>&1 | grep -E '^\[scheduler\] (start|MODE=LIVE)'   # どのモード・ジョブで起動したか
docker logs <container> 2>&1 | grep ' summary: status='                    # Bot ごとの結果
docker logs <container> 2>&1 | grep '^skip '                               # 取得をスキップしたユーザー
docker logs <container> 2>&1 | grep -E '^\[scheduler\] done .*exit=[^0]'   # 失敗した回
```

LogQL の例（Loki を接続した後。ラベル `{app="bsky-bots"}` は接続のしかたで変わる）:

```logql
# live で起動した記録（監査）
{app="bsky-bots"} |= "MODE=LIVE"
# summary 行（json）
{app="bsky-bots"} | json | msg=~".* summary: status=.*"
# 失敗・警告（json）
{app="bsky-bots"} | json | level=~"warn|error"
# ジョブごとの終了（json）
{app="bsky-bots"} | json | stream="scheduler" and job="skyhigh" and msg=~"done .*"
# 起動時のログイン確認で通らなかった Bot（json）
{app="bsky-bots"} | json | stream="scheduler" and msg=~"login check result=(failed|unset).*"
```

### 不在アラート（Grafana。作るのは基盤側）

「来るはずの行が来ない」を拾う。例: skyhigh の summary が 26 時間出なければ通知する。

```logql
absent_over_time({app="bsky-bots"} |= "[skyhigh] summary: status=ok" [26h])
absent_over_time({app="bsky-bots"} |= "[skylog] summary: status=ok" [26h])
# jiho は summary を出さないので、終了行で見る（30 分ごと。2 時間を目安に）
absent_over_time({app="bsky-bots"} | json | job="jiho" and stream="scheduler" and msg=~"done exit=0 .*" [2h])
```

コンテナが落ちている・unhealthy のときはログ自体が止まるので、これで同時に拾える。

---

## 7. Phase 0: dry-run の並走（3 日）

LXC の systemd 版（live）を動かしたまま、Coolify 側を **dry-run** で 3 日動かす。
`BOT_MODE=dry-run`（または未設定）・`BOT_JOBS=skyhigh,skylog,jiho` にして Deploy する。
dry-run は投稿しない（ログインは起動時の確認だけ。6 章）ので、LXC 側と並べても二重投稿にならない。

確かめること:

- [ ] ビルドが通る（build ステージの typecheck・lint・test を含む）
- [ ] コンテナが healthy になる
- [ ] `/data/scheduler-state.json` が再デプロイ後も残る（Volume が効いている）
- [ ] Deploy を押したときに SIGTERM の drain が効く（`stopping` → 実行中の子の終了 → `stopped`。Stop Grace Period 内に収まる）
- [ ] skyhigh / skylog の summary 行が毎日出て、status=ok。jiho の `done ... exit=0` が 30 分ごとに出る

---

## 8. 切り替え（Bot ごと。jiho → skyhigh → skylog の順）

**必ず「送る側を止めてから、もう一方を起こす」**。1 Bot ずつ、毎回次の順で行う（`<bot>` は jiho / skyhigh / skylog）。
live に切り替える前に、その Bot の `<BOT>_IDENTIFIER` と `<BOT>_APP_PASSWORD` をユーザーが Coolify の画面で入れ、
`JOB_CRON_*` などの上書きをすべて消しておく（live では上書きがあると起動しない）。

1. LXC（root）で timer を止める

   ```bash
   systemctl disable --now bsky-<bot>.timer
   ```

2. 止まったことを確かめる

   ```bash
   systemctl list-timers 'bsky-*'                       # bsky-<bot>.timer が無い
   systemctl is-active bsky-<bot>.timer bsky-<bot>.service   # どちらも inactive
   ```

3. Coolify の環境変数を変える: `BOT_MODE=live`、`BOT_JOBS` に `<bot>` を足す
   （jiho の後は `jiho`、skyhigh の後は `jiho,skyhigh`、最後は `jiho,skyhigh,skylog`）。
   `BOT_MODE` は全ジョブ共通なので、live にした後は、まだ切り替えていない Bot を Coolify で dry-run 並走させることはできない
4. Restart（5 章の時間帯を避ける）
5. ログで `[scheduler] MODE=LIVE jobs=<...>` の行を確かめる（`<bot>` が入っている）

## 9. ロールバック（Bot ごと）

1. Coolify の `BOT_JOBS` からその Bot を外して Restart する（すべて外すなら `BOT_MODE=dry-run` に戻してもよい）
2. 起動行（`MODE=LIVE jobs=<...>` または `start ...`）にその Bot が入っていないことを確かめる
3. LXC（root）で timer を起こす

   ```bash
   systemctl enable --now bsky-<bot>.timer
   systemctl list-timers 'bsky-*'
   ```

順番を逆にしない（両方が live で動く時間を作らない）。

---

## 10. 未解決の課題

- Phase 0 の開始日
- LXC の timer（systemd 版）を撤去する時期
- Loki / Prometheus の接続先（決まるまでログは標準出力まで）。Coolify で `LOG_FORMAT=json` にする時期
- Coolify の Discord 通知（未設定。デプロイ失敗・再起動上限はこちらで拾う。アプリ内のジョブ失敗は `DISCORD_WEBHOOK_URL` で拾う）
- Volume（`/data`）のバックアップ先（未整備。中身は状態ファイルだけ）
- Stop Grace Period が Consistent Container Names のときにも効くか（Phase 0 で実測する）
- zod の脆弱性（#33）
