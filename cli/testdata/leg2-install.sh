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
GIT=$(collie_tool git) || { echo "error: no git on this machine" >&2; exit 20; }
BUN=$(collie_tool bun) || { echo "error: no bun on this machine" >&2; exit 21; }
ROOT='/home/pat/.collie'
COMMIT='abc123'
EXPECT='1.2.3'
WORK=$(mktemp -d "${TMPDIR:-/tmp}/collie-add.XXXXXX")
trap 'rm -rf "$WORK"' EXIT INT TERM
if printf '' | base64 -d >/dev/null 2>&1; then B64D="base64 -d"; else B64D="base64 -D"; fi
$B64D > "$WORK/bundle.part" <<'__COLLIE_PAYLOAD__'
#__COLLIE_STDIN__
__COLLIE_PAYLOAD__
"$GIT" init -q "$WORK/verify"
VMSG=$("$GIT" -C "$WORK/verify" bundle verify "$WORK/bundle.part" 2>&1 >/dev/null) || { echo "error: the pushed bundle did not verify: $VMSG" >&2; exit 22; }
mv "$WORK/bundle.part" "$WORK/bundle"
if [ -d "$ROOT/.git" ]; then
  "$GIT" -C "$ROOT" fetch --no-tags --update-shallow "$WORK/bundle" HEAD
  "$GIT" -C "$ROOT" checkout --detach "$COMMIT"
elif [ -e "$ROOT" ]; then
  echo "error: $ROOT exists and is not a git checkout — move it aside or pass --path" >&2
  exit 27
else
  mkdir -p "$(dirname "$ROOT")"
  rm -rf "$ROOT.part"
  "$GIT" clone -q "$WORK/bundle" "$ROOT.part"
  "$GIT" -C "$ROOT.part" checkout --detach "$COMMIT"
  mv "$ROOT.part" "$ROOT"
fi
GOT=$("$GIT" -C "$ROOT" rev-parse HEAD)
[ "$GOT" = "$COMMIT" ] || { echo "error: checkout is at $GOT, expected $COMMIT" >&2; exit 23; }
BUNDIR=$(dirname "$BUN")
( cd "$ROOT" && PATH="$BUNDIR:$PATH" "$BUN" run cli/main.ts build ) || { echo "error: the build failed on this machine" >&2; exit 24; }
[ -x "$ROOT/bin/collie" ] || { echo "error: the build left no binary at $ROOT/bin/collie" >&2; exit 25; }
VERSION=$("$ROOT/bin/collie" version | head -n 1)
case "$VERSION" in
  "$EXPECT"*) ;;
  *) echo "error: installed $VERSION, expected $EXPECT" >&2; exit 26 ;;
esac
printf 'collie-install:root=%s\ncollie-install:version=%s\n' "$ROOT" "$VERSION"
