set -eu
umask 077
collie_tool() {
  _n=$1
  if _p=$(command -v "$_n" 2>/dev/null); then
    case $_p in
      /*) printf '%s' "$_p"; return 0 ;;
    esac
  fi
  for _c in "${BUN_INSTALL:-$HOME/.bun}/bin/$_n" "$HOME/.bun/bin/$_n" "$HOME/.local/bin/$_n" \
    "/usr/local/bin/$_n" "/opt/homebrew/bin/$_n" "/usr/bin/$_n" "/bin/$_n" "/usr/sbin/$_n" "/sbin/$_n"; do
    if [ -x "$_c" ]; then printf '%s' "$_c"; return 0; fi
  done
  return 1
}
CURL=$(collie_tool curl) || { echo "error: no curl on this machine" >&2; exit 20; }
TAR=$(collie_tool tar) || { echo "error: no tar on this machine" >&2; exit 21; }
SHA=$(collie_tool sha256sum) || SHA=$(collie_tool shasum) || { echo "error: no sha256 tool on this machine" >&2; exit 22; }
PATH="$(dirname "$CURL"):$(dirname "$TAR"):$(dirname "$SHA"):$PATH"
export PATH
DIR='/home/pat/.local/share/collie'
EXPECT='1.2.3'
WORK=$(mktemp -d "${TMPDIR:-/tmp}/collie-add.XXXXXX")
trap 'rm -rf "$WORK"' EXIT INT TERM
cat > "$WORK/install.sh" <<'__COLLIE_PAYLOAD__'
#__COLLIE_STDIN__
__COLLIE_PAYLOAD__
COLLIE_DIR="$DIR" COLLIE_UPDATE_REPO='AltanS/collie' COLLIE_TAG='v1.2.3' /bin/sh "$WORK/install.sh" 1>&2
ROOT="$DIR/current"
[ -x "$ROOT/bin/collie" ] || { echo "error: the install left no binary at $ROOT/bin/collie" >&2; exit 25; }
VERSION=$("$ROOT/bin/collie" version | head -n 1)
case "$VERSION" in
  "$EXPECT"*) ;;
  *) echo "error: installed $VERSION, expected $EXPECT" >&2; exit 26 ;;
esac
printf 'collie-install:root=%s\ncollie-install:version=%s\n' "$ROOT" "$VERSION"
