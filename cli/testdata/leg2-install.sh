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
ORIGIN='https://github.com/AltanS/collie.git'
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
  if ! "$GIT" -C "$ROOT" fetch --no-tags --update-shallow "$WORK/bundle" HEAD 2>"$WORK/fetch.err"; then
    "$GIT" -C "$ROOT" bundle unbundle "$WORK/bundle" >/dev/null 2>>"$WORK/fetch.err" || { cat "$WORK/fetch.err" >&2; echo "error: the pushed bundle could not be applied to $ROOT" >&2; exit 28; }
  fi
  "$GIT" -C "$ROOT" checkout --detach "$COMMIT"
  case "$("$GIT" -C "$ROOT" remote get-url origin 2>/dev/null || true)" in
    */collie-add.*/bundle) "$GIT" -C "$ROOT" remote set-url origin "$ORIGIN" ;;
  esac
elif [ -e "$ROOT" ]; then
  echo "error: $ROOT exists and is not a git checkout — move it aside or pass --path" >&2
  exit 27
else
  mkdir -p "$(dirname "$ROOT")"
  rm -rf "$ROOT.part"
  "$GIT" clone -q "$WORK/bundle" "$ROOT.part"
  "$GIT" -C "$ROOT.part" checkout --detach "$COMMIT"
  "$GIT" -C "$ROOT.part" remote set-url origin "$ORIGIN"
  mv "$ROOT.part" "$ROOT"
fi
for PARENT in $("$GIT" -C "$ROOT" cat-file commit "$COMMIT" | sed -n '/^$/q; s/^parent //p'); do
  if ! "$GIT" -C "$ROOT" cat-file -e "$PARENT^{commit}" 2>/dev/null; then
    grep -qx "$COMMIT" "$ROOT/.git/shallow" 2>/dev/null || printf '%s\n' "$COMMIT" >> "$ROOT/.git/shallow"
    break
  fi
done
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
