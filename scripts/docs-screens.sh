#!/usr/bin/env bash
# Regenerate the phone-sized screenshots of the update flow and the PWA install card under
# docs/images/updates/.
#
# Source: the states playground (web/src/playground/), served by Vite at
# http://127.0.0.1:5199/playground.html. Uses the `agent-browser` CLI to drive a headless
# Chromium, plus `magick` (ImageMagick) to crop full-page shots down to the phone frame or
# the update band row — `agent-browser screenshot <selector>` was unreliable against these
# `overflow-hidden` + `transform` elements (came back blank), so every shot here is: full
# page screenshot, then crop by the element's own bounding box.
#
# Four cards on the playground carry every state this script captures:
#   - "settings — solo collie, nothing paired" → the Install card at the top of Settings.
#     The install offer is a one-shot browser event (lib/install.ts), not a fixture, so it's
#     faked by dispatching a synthetic `beforeinstallprompt` on the page. The iOS share-sheet
#     hint is faked instead by patching `navigator.maxTouchPoints`/`platform` via an init script
#     (`agent-browser open --init-script`) — not `set device`, which also shrinks the viewport to
#     phone size and broke this script's own card lookup at that width.
#   - "settings — lead of a crew, three devices paired" → the Updates row in Settings.
#   - "updates — the page the Settings row opens" → the Updates page itself. It reads
#     GET/POST /api/update/check, so the up-to-date / crew-available / peer-rolled-back
#     states are reached by stubbing that route with `agent-browser network route`
#     (the same shape a live bridge would answer with — see the file's own note: "against
#     a live lead the same card grows one line per member, worst first"). Every fake crew
#     member name here comes from the playground's own fake outbuilding roster (lodge,
#     workshop, attic, …) — never a real Tailscale hostname; that leaked into this script
#     once already (`minibuch`, on the rolled-back peer, fixed 2026-09-10).
#   - "update band (a/b/d)" and "update band (c)" → the top band's states. (c)'s toggle is
#     flipped on to reach the post-run "Tap to reload" state and flipped back off after,
#     because that toggle drives a page-wide singleton every other band card also reads.
#
# Usage: scripts/docs-screens.sh
set -euo pipefail

REPO_ROOT="$(git -C "$(dirname "$0")/.." rev-parse --show-toplevel)"
OUT_DIR="$REPO_ROOT/docs/images/updates"
PLAYGROUND_URL="http://127.0.0.1:5199/playground.html"

if ! command -v agent-browser >/dev/null 2>&1; then
  echo "error: agent-browser is not on PATH. Install: npm i -g agent-browser && agent-browser install" >&2
  exit 1
fi

if ! command -v magick >/dev/null 2>&1; then
  echo "error: ImageMagick's 'magick' is not on PATH (needed to crop full-page shots)." >&2
  exit 1
fi

if ! curl -fsS -o /dev/null "$PLAYGROUND_URL"; then
  echo "error: the playground isn't answering on port 5199." >&2
  echo "hint: from collie-workspace/, run 'make playground-up' (or 'make playground' in the foreground)." >&2
  exit 1
fi

mkdir -p "$OUT_DIR"

SESSION="$(agent-browser session id --scope worktree --prefix collie-docs-shots)"
AB() { agent-browser --session "$SESSION" "$@"; }

TMP="$(mktemp -d)"
trap 'AB close >/dev/null 2>&1 || true; rm -rf "$TMP"' EXIT

# Crop "$1" (a full-page PNG) at box "$2 $3 $4 $5" (w h x y) into "$6".
crop() {
  magick "$1" -crop "${2}x${3}+${4}+${5}" +repage "$6"
}

# Scroll the element carrying data-shot="$1" flush to the top of the viewport, with no smooth-
# scroll animation to race against. `agent-browser scrollintoview` centres the element instead and
# was observed to still be mid-animation when the box was read right after, landing the frame
# partway above the viewport (a negative y) and cropping its top off — this is exact and instant.
scroll_shot_to_top() {
  cat <<EOF | AB eval --stdin
document.querySelector('[data-shot=${1}]').scrollIntoView({ behavior: 'instant', block: 'start' });
EOF
}

# Print "x y w h" (space-separated) for the element carrying data-shot="$1", as integers.
box_of() {
  AB get box "[data-shot=$1]" --json 2>/dev/null | \
    python3 -c '
import json, sys
d = json.load(sys.stdin)["data"]
print(int(d["x"]), int(d["y"]), int(d["width"]), int(d["height"]))
'
}

AB set viewport 1440 1000
AB set media light
AB open "$PLAYGROUND_URL"
AB wait --load networkidle
sleep 1

# Tag the phone-frame element inside the card labelled "$1" with data-shot="$2".
tag_phone_frame() {
  local label="$1" id="$2"
  cat <<EOF | AB eval --stdin
(function() {
  const labels = Array.from(document.querySelectorAll('p.font-mono'));
  const label = labels.find(l => l.textContent.trim() === ${label@Q});
  if (!label) throw new Error('card not found: ' + ${label@Q});
  const cardDiv = label.closest('div.min-w-0');
  const target = cardDiv.querySelector('[class*="rounded-[1.75rem]"]');
  target.setAttribute('data-shot', ${id@Q});
})()
EOF
}

# Tag the Stage element (the update band cards) inside the card labelled "$1" with data-shot="$2".
tag_stage() {
  local label="$1" id="$2"
  cat <<EOF | AB eval --stdin
(function() {
  const labels = Array.from(document.querySelectorAll('p.font-mono'));
  const label = labels.find(l => l.textContent.trim() === ${label@Q});
  if (!label) throw new Error('card not found: ' + ${label@Q});
  const cardDiv = label.closest('div.min-w-0');
  const target = cardDiv.querySelector(':scope > div.relative.isolate.overflow-hidden');
  target.setAttribute('data-shot', ${id@Q});
})()
EOF
}

echo "== settings-updates-row.png"
tag_phone_frame "settings — lead of a crew, three devices paired" settings-row
scroll_shot_to_top settings-row
# Scroll the phone's own inner scroller down to the Updates row.
cat <<'EOF' | AB eval --stdin
(function() {
  const el = document.querySelector('[data-shot=settings-row]');
  const scroller = el.querySelector('.pg-phone-scroll');
  const row = Array.from(scroller.querySelectorAll('div')).find((n) => n.textContent.trim() === 'Updates');
  const container = row.closest('button') || row.parentElement.parentElement;
  container.scrollIntoView({ block: 'center' });
})()
EOF
AB screenshot "$TMP/full.png"
read -r x y w h < <(box_of settings-row)
crop "$TMP/full.png" "$w" "$h" "$x" "$y" "$OUT_DIR/settings-updates-row.png"

# The Updates page card reads GET/POST /api/update/check on mount. Stub it, reload, re-tag,
# re-screenshot, crop. One helper for the three page states below.
capture_updates_page() {
  local body="$1" out="$2"
  AB network unroute
  AB network route "**/api/update/check" --body "$body"
  AB reload
  AB wait --load networkidle
  sleep 1
  tag_phone_frame "updates — the page the Settings row opens" updates-page
  scroll_shot_to_top updates-page
  AB screenshot "$TMP/full.png"
  read -r x y w h < <(box_of updates-page)
  crop "$TMP/full.png" "$w" "$h" "$x" "$y" "$OUT_DIR/$out"
}

NOW="$(date +%s%3N)"

echo "== updates-page-up-to-date.png"
capture_updates_page "$(cat <<EOF
{"current":"0.32.1","latest":"0.32.1","latestUrl":null,"releaseAvailable":false,"majorAvailable":null,"majorUrl":null,"bridgeStale":false,"checkedAt":$NOW,"newerVersions":[],"preflight":{"schema":1,"verdict":"green","checks":[]},"crew":[]}
EOF
)" updates-page-up-to-date.png

echo "== updates-page-crew-available.png"
ASOF1=$((NOW - 5000))
ASOF2=$((NOW - 600000))
capture_updates_page "$(cat <<EOF
{"current":"0.31.0","latest":"0.32.1","latestUrl":"https://github.com/AltanS/collie/releases/tag/v0.32.1","releaseAvailable":true,"majorAvailable":null,"majorUrl":null,"bridgeStale":false,"checkedAt":$NOW,"newerVersions":["0.32.1"],"preflight":{"schema":1,"verdict":"green","checks":[{"id":"git-clean","verdict":"green","reason":"working tree clean"}]},"crew":[{"name":"workshop","version":"0.31.0","verdict":"green","reasons":[],"asOf":$ASOF1},{"name":"attic","version":"0.30.2","verdict":"amber","reasons":["disk space low on /var"],"asOf":$ASOF2}]}
EOF
)" updates-page-crew-available.png

echo "== updates-page-peer-rolled-back.png"
STARTED=$((NOW - 40000))
UPDATED=$((NOW - 2000))
capture_updates_page "$(cat <<EOF
{"current":"0.32.1","latest":"0.32.1","latestUrl":null,"releaseAvailable":false,"majorAvailable":null,"majorUrl":null,"bridgeStale":false,"checkedAt":$NOW,"newerVersions":[],"preflight":{"schema":1,"verdict":"green","checks":[{"id":"git-clean","verdict":"green","reason":"working tree clean"}]},"crew":[],"run":{"schema":1,"state":"done","from":"0.31.0","to":"0.32.1","startedAt":$STARTED,"updatedAt":$UPDATED,"pid":4242,"attempt":1,"peers":[{"name":"workshop","state":"rolled-back","version":"0.31.0","reason":"health gate timed out after three attempts on the standby door"}]}}
EOF
)" updates-page-peer-rolled-back.png

AB network unroute
AB reload
AB wait --load networkidle
sleep 1

echo "== band-available.png"
tag_stage "update band (a) — a release is on offer" band-a
scroll_shot_to_top band-a
AB screenshot "$TMP/full.png"
read -r x y w h < <(box_of band-a)
crop "$TMP/full.png" 390 32 "$x" "$y" "$OUT_DIR/band-available.png"

echo "== band-updating.png (the Restarting snapshot, third of three)"
tag_stage "update band (b) — a run in flight, all three words" band-b
scroll_shot_to_top band-b
AB screenshot "$TMP/full.png"
read -r x y w h < <(box_of band-b)
# Three stacked rows of ~29px each; the third (Restarting) sits at the bottom of the box.
crop "$TMP/full.png" 390 32 "$x" "$((y + h - 32))" "$OUT_DIR/band-updating.png"

echo "== band-peers.png (the first of two rows: still-moving peer)"
tag_stage "update band (d) — peers following, and one that did not" band-d
scroll_shot_to_top band-d
AB screenshot "$TMP/full.png"
read -r x y w h < <(box_of band-d)
crop "$TMP/full.png" 390 32 "$x" "$y" "$OUT_DIR/band-peers.png"

echo "== band-updated-reload.png (stale-bundle toggle ON, first of two rows)"
cat <<'EOF' | AB eval --stdin
(function() {
  const labels = Array.from(document.querySelectorAll('p.font-mono'));
  const label = labels.find((l) => l.textContent.trim() === 'update band (c) — this bundle is behind the bridge');
  const cardDiv = label.closest('div.min-w-0');
  cardDiv.querySelector('button').click();
})()
EOF
sleep 1
tag_stage "update band (c) — this bundle is behind the bridge" band-c
scroll_shot_to_top band-c
AB screenshot "$TMP/full.png"
read -r x y w h < <(box_of band-c)
crop "$TMP/full.png" 390 32 "$x" "$y" "$OUT_DIR/band-updated-reload.png"

# Flip the toggle back off — it drives a page-wide singleton every other band card reads.
cat <<'EOF' | AB eval --stdin
(function() {
  const labels = Array.from(document.querySelectorAll('p.font-mono'));
  const label = labels.find((l) => l.textContent.trim() === 'update band (c) — this bundle is behind the bridge');
  const cardDiv = label.closest('div.min-w-0');
  cardDiv.querySelector('button').click();
})()
EOF

# The Install card (lib/install.ts) renders only while the browser holds an install offer, or —
# on an Apple touch device — its share-sheet hint. Neither is a fixture, so both are faked here
# rather than reached through a card prop. Back to a clean reload first: the network stubs above
# are gone (unrouted), but the page itself still reflects the last update-page/band state.
AB reload
AB wait --load networkidle
sleep 1

echo "== settings-install-offered.png"
cat <<'EOF' | AB eval --stdin
(function() {
  // Chromium's own nonstandard event: cancelable, and carrying the two members lib/install.ts
  // checks for (isInstallPrompt) before it will hold the offer.
  const ev = new Event('beforeinstallprompt', { cancelable: true });
  ev.prompt = () => Promise.resolve();
  ev.userChoice = Promise.resolve({ outcome: 'accepted' });
  window.dispatchEvent(ev);
})()
EOF
sleep 1
tag_phone_frame "settings — solo collie, nothing paired" settings-install
scroll_shot_to_top settings-install
AB screenshot "$TMP/full.png"
read -r x y w h < <(box_of settings-install)
crop "$TMP/full.png" "$w" "$h" "$x" "$y" "$OUT_DIR/settings-install-offered.png"

# Fresh reload so the held offer above doesn't leak into the iOS shot below (that offer is a
# module-level singleton in lib/install.ts, not page state a reload alone would clear otherwise —
# a fresh document is what actually resets it).
AB reload
AB wait --load networkidle
sleep 1

echo "== settings-install-ios-hint.png"
# iOS never fires beforeinstallprompt at all — install lives in the share sheet — so
# lib/install.ts's hint is reached by making the probe (lib/install.ts's probeShareSheetInstall)
# see an Apple touch device. `set device` was tried first and rejected: it also shrinks the
# viewport to phone size, which broke this script's own card-lookup (the playground's control
# toolbar doesn't reflow at that width and the crop grabbed it instead of the phone frame). This
# instead patches just the two properties the probe reads, at the DESKTOP viewport every other
# shot uses, via an init script so the patch is in place before the page's own first render —
# a same-document eval can't do that, because InstallControl reads them again on every render
# and nothing here forces one after the fact.
cat > "$TMP/ios-touch-init.js" <<'JS'
Object.defineProperty(Navigator.prototype, 'maxTouchPoints', { get: () => 5, configurable: true });
Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'iPhone', configurable: true });
JS
AB open --init-script "$TMP/ios-touch-init.js" "$PLAYGROUND_URL"
AB wait --load networkidle
# A fresh `open` drops the emulated colour scheme set at the top of this script, so light mode
# needs re-asserting here too — otherwise this is the one shot in the set that comes out dark.
AB set media light
sleep 1
tag_phone_frame "settings — solo collie, nothing paired" settings-install-ios
scroll_shot_to_top settings-install-ios
AB screenshot "$TMP/full.png"
read -r x y w h < <(box_of settings-install-ios)
crop "$TMP/full.png" "$w" "$h" "$x" "$y" "$OUT_DIR/settings-install-ios-hint.png"

echo "done: $OUT_DIR"
ls -la "$OUT_DIR"
