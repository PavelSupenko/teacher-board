#!/bin/sh
# Sets the board up on a machine that has nothing installed.
#
# Node is fetched into the project folder rather than into the system, so no
# administrator password, no Homebrew and no package manager are needed. Run
# this once; afterwards the board is started by the launcher it creates.
set -eu

NODE_VERSION="v24.20.0"
MIN_MAJOR=20

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
RUNTIME="$ROOT/.runtime"

# Messages follow the system language: teachers are the audience here.
case "${BOARD_LANG:-${LANG:-en}}" in
  uk*|UK*) UK=1 ;;
  *) UK=0 ;;
esac
say() { if [ "$UK" = 1 ]; then printf '%s\n' "$2"; else printf '%s\n' "$1"; fi; }

say "Class Board — setup" "Навчальна дошка — встановлення"
say "This takes a few minutes and needs no password." "Це займе кілька хвилин і не потребує пароля."
echo

# ---------------------------------------------------------------- Node ------

node_ok() {
  command -v "$1" >/dev/null 2>&1 || return 1
  major="$("$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [ "$major" -ge "$MIN_MAJOR" ] 2>/dev/null
}

if [ -x "$RUNTIME/bin/node" ] && node_ok "$RUNTIME/bin/node"; then
  NODE="$RUNTIME/bin/node"
  say "Node: already downloaded." "Node: уже завантажено."
elif node_ok node; then
  NODE="$(command -v node)"
  say "Node: found in the system." "Node: знайдено в системі."
else
  case "$(uname -s)" in
    Darwin) OS="darwin" ;;
    Linux) OS="linux" ;;
    *) say "Unsupported system. Use scripts/install.ps1 on Windows." \
           "Непідтримувана система. У Windows запустіть scripts/install.ps1"; exit 1 ;;
  esac
  case "$(uname -m)" in
    arm64|aarch64) ARCH="arm64" ;;
    x86_64|amd64) ARCH="x64" ;;
    *) say "Unsupported processor: $(uname -m)" "Непідтримуваний процесор: $(uname -m)"; exit 1 ;;
  esac

  PKG="node-$NODE_VERSION-$OS-$ARCH"
  say "Downloading Node ($PKG), about 50 MB…" "Завантажую Node ($PKG), близько 50 МБ…"
  rm -rf "$RUNTIME" "$ROOT/.node-download.tar.gz"
  curl -fL --progress-bar -o "$ROOT/.node-download.tar.gz" \
    "https://nodejs.org/dist/$NODE_VERSION/$PKG.tar.gz"
  mkdir -p "$RUNTIME"
  tar -xzf "$ROOT/.node-download.tar.gz" -C "$RUNTIME" --strip-components=1
  rm -f "$ROOT/.node-download.tar.gz"
  NODE="$RUNTIME/bin/node"
  node_ok "$NODE" || { say "Node did not install." "Node не встановився."; exit 1; }
fi

NODE_BIN_DIR="$(dirname "$NODE")"
NPM_CLI="$NODE_BIN_DIR/../lib/node_modules/npm/bin/npm-cli.js"
[ -f "$NPM_CLI" ] || NPM_CLI="$(dirname "$(command -v npm 2>/dev/null || echo /nonexistent)")/../lib/node_modules/npm/bin/npm-cli.js"
[ -f "$NPM_CLI" ] || { say "npm not found next to Node." "npm не знайдено поруч із Node."; exit 1; }
npm_run() { PATH="$NODE_BIN_DIR:$PATH" "$NODE" "$NPM_CLI" "$@"; }

# ------------------------------------------------------------ the board -----

echo
say "Installing the board…" "Встановлюю дошку…"
npm_run install --no-audit --no-fund --loglevel=error
say "Building…" "Збираю…"
npm_run run build >/dev/null
# Only the build needed those; the server itself runs on ws alone.
npm_run prune --omit=dev --loglevel=error >/dev/null 2>&1 || true

# --------------------------------------------------------------- launcher ---

make_launcher() {
  file="$ROOT/$1"
  cat > "$file" <<LAUNCH
#!/bin/sh
# Double-click this file to start the board.
cd "\$(dirname "\$0")"
if [ -x ".runtime/bin/node" ]; then NODE=".runtime/bin/node"; else NODE="node"; fi
exec "\$NODE" server/index.js $2
LAUNCH
  chmod +x "$file"
  # The file was created here, so macOS will not treat it as downloaded.
  xattr -d com.apple.quarantine "$file" 2>/dev/null || true
}

make_launcher "Start Board.command" "--open"
make_launcher "Start Board (share).command" "--open --tunnel"

echo
say "Done." "Готово."
say "Double-click “Start Board.command” in this folder to begin." \
    "Двічі клацніть «Start Board.command» у цій теці, щоб почати."
say "“Start Board (share).command” also opens a link for pupils at home." \
    "«Start Board (share).command» ще й відкриває посилання для учнів удома."
