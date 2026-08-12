set -eu
ROOT='/home/pat/.collie'
exec "$ROOT/bin/collie" 'join' 'desk.tail.ts.net' '-' '--address' '100.1.2.3:8787' '--label' 'nas' <<'__COLLIE_PAYLOAD__'
#__COLLIE_STDIN__
__COLLIE_PAYLOAD__
