#!/usr/bin/env bash
# deploy/system/ の unit テンプレートの @...@ を埋めて、OS の systemd に登録する。
#
# どこに clone しても動くよう、パス・実行ユーザー・Node の場所をこのスクリプトが決める。
# 手順は docs/deploy.md 4 章。timer の有効化は --enable を付けたときだけ行う。
set -euo pipefail

DEFAULT_DEST=/etc/systemd/system
TIMERS=(bsky-skyhigh.timer bsky-skylog.timer bsky-jiho.timer)

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
TEMPLATE_DIR="$SCRIPT_DIR/system"

usage() {
  cat <<'EOF'
使い方: deploy/install.sh [オプション]

deploy/system/ の unit を埋めて /etc/systemd/system/ に書き込み、daemon-reload する。
timer は --enable を付けたときだけ有効化する。

オプション:
  --app-dir DIR    clone してビルドしたディレクトリ（既定: このスクリプトの 1 つ上）
  --user USER      実行ユーザー（既定: APP_DIR の所有者）。グループはそのユーザーのプライマリグループ
  --node PATH      node の絶対パス（既定: command -v node）
  --env-file FILE  認証情報の env ファイル（既定: APP_DIR/.env）
  --dest DIR       書き込み先（既定: /etc/systemd/system）。指定時は書き込みだけ行う（root 不要）
  --print          生成した unit を標準出力に出すだけで書き込まない（root 不要）
  --enable         書き込み後に timer を systemctl enable --now する
  -h, --help       この説明を出す

例:
  deploy/install.sh --print                      # 生成結果を確認する
  sudo deploy/install.sh                         # 登録する（timer は有効化しない）
  cd /root/bsky-bots && deploy/install.sh        # /root に置いて root で動かす
EOF
}

die() {
  echo "error: $*" >&2
  exit 1
}

warn() {
  echo "warning: $*" >&2
}

# 相対パスを絶対パスにする（存在しなくてもよい）。
abspath() {
  case "$1" in
    /*) printf '%s\n' "$1" ;;
    *) printf '%s/%s\n' "$(pwd -P)" "$1" ;;
  esac
}

# sed の置換文字列として安全にする（区切りに | を使う）。
sed_escape() {
  printf '%s' "$1" | sed -e 's/[\\&|]/\\&/g'
}

APP_DIR=""
RUN_USER=""
NODE=""
ENV_FILE=""
DEST="$DEFAULT_DEST"
PRINT=0
ENABLE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --app-dir) [ $# -ge 2 ] || die "--app-dir に値が無い"; APP_DIR="$2"; shift 2 ;;
    --user) [ $# -ge 2 ] || die "--user に値が無い"; RUN_USER="$2"; shift 2 ;;
    --node) [ $# -ge 2 ] || die "--node に値が無い"; NODE="$2"; shift 2 ;;
    --env-file) [ $# -ge 2 ] || die "--env-file に値が無い"; ENV_FILE="$2"; shift 2 ;;
    --dest) [ $# -ge 2 ] || die "--dest に値が無い"; DEST="$2"; shift 2 ;;
    --print) PRINT=1; shift ;;
    --enable) ENABLE=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; die "不明な引数: $1" ;;
  esac
done

# --- 値を決める ---

if [ -z "$APP_DIR" ]; then
  APP_DIR=$(cd "$SCRIPT_DIR/.." && pwd -P)
else
  [ -d "$APP_DIR" ] || die "APP_DIR が無い: $APP_DIR"
  APP_DIR=$(cd "$APP_DIR" && pwd -P)
fi

if [ -z "$RUN_USER" ]; then
  RUN_USER=$(stat -c %U "$APP_DIR")
fi
id -u "$RUN_USER" >/dev/null 2>&1 || die "ユーザーが存在しない: $RUN_USER"
RUN_GROUP=$(id -gn "$RUN_USER")

if [ -z "$NODE" ]; then
  NODE=$(command -v node || true)
  [ -n "$NODE" ] || die "node が見つからない。--node で絶対パスを指定する（sudo 経由だと PATH が変わる）"
fi
NODE=$(abspath "$NODE")
[ -f "$NODE" ] && [ -x "$NODE" ] || die "node が実行できない: $NODE"

if [ -z "$ENV_FILE" ]; then
  ENV_FILE="$APP_DIR/.env"
fi
ENV_FILE=$(abspath "$ENV_FILE")

# ホーム配下に置いたときは ProtectHome=yes だと読めないので read-only にする。
under_home() {
  case "$1" in
    /root | /root/* | /home | /home/* | /run/user | /run/user/*) return 0 ;;
    *) return 1 ;;
  esac
}
if under_home "$APP_DIR" || under_home "$ENV_FILE"; then
  PROTECT_HOME=read-only
else
  PROTECT_HOME=yes
fi

# --- 事前チェック ---

for f in dist/main.js dist/tools/notify-failure.js; do
  [ -f "$APP_DIR/$f" ] || die "$APP_DIR/$f が無い。$APP_DIR で npm ci && npm run build して"
done
[ -f "$ENV_FILE" ] || die "env ファイルが無い: $ENV_FILE（.env.sample を参考に作り、chmod 600 する）"
[ -d "$TEMPLATE_DIR" ] || die "テンプレートが無い: $TEMPLATE_DIR"

mode=$(stat -c %a "$ENV_FILE")
if [ $((0$mode & 4)) -ne 0 ]; then
  warn "$ENV_FILE が他のユーザーから読める（$mode）。chmod 600 $ENV_FILE を勧める"
fi
if [ "$RUN_USER" = root ]; then
  warn "実行ユーザーが root。Bot を root で動かす"
elif ! id -nG "$RUN_USER" | tr ' ' '\n' | grep -qx systemd-journal; then
  warn "$RUN_USER が systemd-journal グループに属していない（失敗通知が journal を読めない）。usermod -aG systemd-journal $RUN_USER"
fi

# --- 生成 ---

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

shopt -s nullglob
templates=("$TEMPLATE_DIR"/*.service "$TEMPLATE_DIR"/*.timer)
shopt -u nullglob
[ ${#templates[@]} -gt 0 ] || die "unit が無い: $TEMPLATE_DIR"

for t in "${templates[@]}"; do
  sed \
    -e "s|@APP_DIR@|$(sed_escape "$APP_DIR")|g" \
    -e "s|@ENV_FILE@|$(sed_escape "$ENV_FILE")|g" \
    -e "s|@RUN_USER@|$(sed_escape "$RUN_USER")|g" \
    -e "s|@RUN_GROUP@|$(sed_escape "$RUN_GROUP")|g" \
    -e "s|@NODE@|$(sed_escape "$NODE")|g" \
    -e "s|@PROTECT_HOME@|$(sed_escape "$PROTECT_HOME")|g" \
    "$t" >"$WORK/$(basename "$t")"
done

if left=$(grep -nE '@[A-Z_]+@' "$WORK"/*); then
  die "埋まっていないプレースホルダがある:
$left"
fi

if [ "$PRINT" -eq 1 ]; then
  for u in "$WORK"/*; do
    echo "### $(basename "$u")"
    cat "$u"
    echo
  done
  exit 0
fi

# --- 書き込み ---

if [ "$DEST" = "$DEFAULT_DEST" ]; then
  [ "$(id -u)" -eq 0 ] || die "$DEST に書き込むには root が要る（sudo で実行する）"
else
  [ "$ENABLE" -eq 0 ] || die "--enable は --dest と併用できない（--dest は書き込みだけ行う）"
fi
[ -d "$DEST" ] || die "書き込み先が無い: $DEST"

for u in "$WORK"/*; do
  install -m 0644 "$u" "$DEST/$(basename "$u")"
  echo "wrote $DEST/$(basename "$u")"
done

if [ "$DEST" != "$DEFAULT_DEST" ]; then
  exit 0
fi

systemctl daemon-reload
written=()
for u in "$WORK"/*; do
  written+=("$DEST/$(basename "$u")")
done
systemd-analyze verify "${written[@]}"

if [ "$ENABLE" -eq 1 ]; then
  systemctl enable --now "${TIMERS[@]}"
  systemctl list-timers 'bsky-*'
else
  echo "timer はまだ有効化していない。切り替え当日に GCP の supervisor を止めてから"
  echo "  systemctl enable --now ${TIMERS[*]}"
  echo "する（docs/deploy.md 6 章）。"
fi
