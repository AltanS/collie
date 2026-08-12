set -eu
umask 077
CFG='/cfg'
mkdir -p "$CFG"
ENVFILE="$CFG/.env"
TMP="$ENVFILE.collie-add.$$"
trap 'rm -f "$TMP"' EXIT INT TERM
: > "$TMP"
chmod 600 "$TMP"
KEYS='COLLIE_HOST|COLLIE_PORT'
if [ -f "$ENVFILE" ]; then
  grep -v -E "^[[:space:]]*(export[[:space:]]+)?($KEYS)=" "$ENVFILE" >> "$TMP" || true
fi
printf 'COLLIE_HOST=%s\n' '100.1.2.3' >> "$TMP"
printf 'COLLIE_PORT=%s\n' '8787' >> "$TMP"
[ -s "$TMP" ] || { echo "error: refusing to write an empty .env" >&2; exit 30; }
mv "$TMP" "$ENVFILE"
printf 'collie-configure:env=%s\n' "$ENVFILE"
