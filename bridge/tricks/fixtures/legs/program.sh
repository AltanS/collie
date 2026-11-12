#!/bin/sh
# The legs trick: shows Collie's browser leg on the phone. It reads the newest leg log and prints one
# document. It never runs the leg and never sends anything: a tap on the decision (rerun, skip) runs
# nothing here. A skip is remembered in the trick's own state folder, and nowhere else.
#
# Tools used: sh, cat, tr, sed, grep, stat, sort, head, cut, date, awk, pgrep (optional). No jq, no bun.
# `stat -c`, `date -d @` and `sort -rn` are the GNU forms.
# Settings (all optional):
#   LEGS_LOG_DIR   folders to scan for leg logs, separated by colons.
#                  Default: $HOME/.cache/collie-lab/leg-logs
#   LEGS_RUNNING   1 or 0: skip the process check (used by test.sh)
#   LEGS_NOW       epoch seconds: a fixed clock (used by test.sh)
#   LEGS_SHOT      a PNG, JPEG or WebP in this trick's folder, by its name: the decision shows it

export LC_ALL=C

flat=$(cat | tr '\n\r\t' '   ')
first() { printf '%s' "$flat" | grep -o "\"$1\" *: *\"[^\"]*\"" | head -n 1 | sed 's/^[^:]*: *"\(.*\)"$/\1/'; }

kind=$(printf '%s' "$flat" | grep -o '"trigger" *: *{ *"kind" *: *"[a-z]*"' | sed 's/.*"\([a-z]*\)"$/\1/')
intent=$(first intent)
node=$(first node)
from=$(printf '%s' "$flat" | grep -o '"from" *: *{ *"session" *: *"[^"]*"' | head -n 1 | sed 's/.*"session" *: *"\(.*\)"$/\1/')
case "$from" in *[!A-Za-z0-9._:-]*) from="" ;; esac
state=$(printf '%s' "$flat" | sed -n 's/.*"trick" *: *{[^}]*"state" *: *"\([^"]*\)".*/\1/p')

now=${LEGS_NOW:-$(date +%s)}
nowiso=$(date -u -d "@$now" +%Y-%m-%dT%H:%M:%SZ)
logdirs=${LEGS_LOG_DIR:-$HOME/.cache/collie-lab/leg-logs}

# The newest leg log: a file named leg-*.txt or browser-leg-*.log that holds Playwright case lines.
log=""
for dir in $(printf '%s' "$logdirs" | tr ':' ' '); do
  [ -d "$dir" ] || continue
  for f in $(stat -c '%Y %n' "$dir"/leg-*.txt "$dir"/browser-leg-*.log 2>/dev/null | sort -rn | head -n 12 | cut -d' ' -f2-); do
    case "$f" in *[!A-Za-z0-9._/-]*) continue ;; esac
    [ -r "$f" ] || continue
    grep -q '\[phone\] ' "$f" 2>/dev/null || continue
    if [ -z "$log" ] || [ "$(stat -c %Y "$f")" -gt "$(stat -c %Y "$log")" ]; then log=$f; fi
    break
  done
done

mtime=0
birth=0
running=0
if [ -n "$log" ]; then
  mtime=$(stat -c %Y "$log" 2>/dev/null || echo 0)
  birth=$(stat -c %W "$log" 2>/dev/null || echo 0)
  case "$birth" in ''|*[!0-9]*) birth=0 ;; esac
  if [ -n "${LEGS_RUNNING:-}" ]; then
    running=$LEGS_RUNNING
  elif command -v pgrep >/dev/null 2>&1; then
    if pgrep -f 'playwright[ ]test' >/dev/null 2>&1 && [ $((now - mtime)) -lt 600 ]; then running=1; fi
  elif [ $((now - mtime)) -lt 180 ]; then
    running=1
  fi
fi

# The worktree the log names, to match a session by its folder.
wt=""
[ -n "$log" ] && wt=$(sed -n 's/^up:.*worktree //p' "$log" | head -n 1)

# The session that ran the leg: the tap's own session, else the best match in the facts by the
# log's worktree, then by "collie" in its folder, name or space. None matches: empty, and the
# decision carries no about and no replyTo.
scope=$from
if [ -z "$scope" ]; then
  scope=$(printf '%s' "$flat" | sed 's/.*"sessions" *: *\[//; s/\] *, *"spaces".*//' | awk -v wt="$wt" '
    function field(rec, key,   m, v) {
      if (!match(rec, "\"" key "\" *: *\"[^\"]*\"")) return ""
      m = substr(rec, RSTART, RLENGTH); sub(/^[^:]*: *"/, "", m); sub(/"$/, "", m); return m
    }
    BEGIN { RS = "}" }
    {
      id = field($0, "id")
      if (id == "" || id ~ /[^A-Za-z0-9._:-]/) next
      cwd = field($0, "cwd"); hay = tolower(cwd " " field($0, "name") " " field($0, "space"))
      score = 0
      if (wt != "" && cwd != "" && index(cwd, wt) == 1) score += 4
      if (hay ~ /collie/) score += 2
      if (score > 0 && field($0, "status") == "working") score += 1
      if (score > best) { best = score; pick = id }
    }
    END { print pick }')
fi

logbase=$(basename "${log:-none}")

# A tap on a decision. A skip is written once to the trick's own state folder; a rerun changes
# nothing here, because the leg costs money and only a person or an agent starts it.
skipfile=""
[ -n "$state" ] && [ -d "$state" ] && skipfile="$state/skipped"
if [ "$kind" = tap ] && [ "$intent" = skip ]; then
  case "$node" in
    hill/case-[0-9]*) [ -n "$skipfile" ] && printf '%s %s\n' "${node#hill/}" "$logbase" > "$skipfile" ;;
  esac
fi
skipped=""
[ -n "$skipfile" ] && [ -r "$skipfile" ] && skipped=$(head -n 1 "$skipfile")

# An image for the decision: a plain name of a file in this folder, else none.
shot=${LEGS_SHOT:-}
case "$shot" in ''|*[!A-Za-z0-9._-]*|.*) shot="" ;; esac
[ -n "$shot" ] && [ ! -f "$shot" ] && shot=""

awk -v logf="$log" -v running="$running" -v now="$now" -v mtime="$mtime" -v birth="$birth" \
    -v nowiso="$nowiso" -v shot="$shot" \
    -v scope="$scope" -v logbase="$logbase" -v skipped="$skipped" '
function jstr(s) {
  gsub(/[^ -~]/, "", s)
  gsub(/\\/, "\\\\", s)
  gsub(/"/, "\\\"", s)
  return "\"" s "\""
}
function clip(s, max) {
  gsub(/[^ -~]/, "", s)
  if (length(s) > max) return substr(s, 1, max - 3) "..."
  return s
}
function ago(sec) {
  if (sec < 90) return "just now"
  if (sec < 5400) return int(sec / 60 + 0.5) " min ago"
  if (sec < 172800) return int(sec / 3600 + 0.5) " h ago"
  return int(sec / 86400) " d ago"
}
function base(p) { sub(/.*\//, "", p); return p }
function label(i) { return (smem[i] ? "Crew leg" : (score[i] ? "Solo leg, core" : "Solo leg, herdr")) }
BEGIN { total = 0; n = 0; ok = 0; reds = 0; sec = 0; pmem = 0; pcore = 0 }
{
  line = $0
  if (line ~ /^up:/) { pmem = 0; pcore = 0; if (match(line, /worktree .*/)) wt = substr(line, RSTART + 9) }
  if (line ~ /^[ \t]+member /) { pmem = 1 }
  if (line ~ /herdr-core session|hc\.sock/) { if (line ~ /^[ \t]+member / || !pmem) pcore = 1 }
  if (line ~ /^Running [0-9]+ tests?/) {
    split(line, w, " ")
    total += w[2]; sec++
    smem[sec] = pmem; score[sec] = pcore; sdone[sec] = 0; sred[sec] = 0
    next
  }
  if (line ~ /^[ \t]+(✓|✘|×|-)[ \t]+[0-9]+ \[/) {
    n++
    st[n] = (line ~ /^[ \t]+✓/) ? "ok" : ((line ~ /^[ \t]+-/) ? "skip" : "red")
    t = line
    sub(/[ \t]*\([0-9.]+(ms|s|m|h)\)[ \t]*$/, "", t)
    k = split(t, parts, " › ")
    nm[n] = clip(parts[k], 200); sub(/^[0-9]+ /, "", nm[n])
    if (st[n] == "ok") ok++
    if (st[n] == "red") { reds++; sred[sec]++; if (reds == 1) { firstred = n; redsec = sec } }
    next
  }
  if (line ~ /^[ \t]+[0-9]+ (passed|failed|flaky|skipped)/ && line ~ /\(/) { if (sec > 0) sdone[sec] = 1; next }
  if (line ~ /^[ \t]+Error: / && firsterr == "") { e = line; sub(/^[ \t]+Error: /, "", e); firsterr = e; next }
  if (line ~ /^OpenRouter requests this run: /) { split(line, w, ": "); orr += w[2] + 0; hasor = 1; next }
  if (line ~ /^Anthropic requests this run: /) { split(line, w, ": "); ant += w[2] + 0; hasant = 1; next }
}
END {
  none = (logf == "" || sec == 0)
  isred = (reds > 0)
  complete = (!running && sec > 0 && sdone[sec] == 1 && n == total)
  badge_label = ""
  if (none) { tone = "muted"; blabel = "no leg"; subline = "No leg has run on this machine yet" }
  else {
    blabel = ok "/" total
    if (isred) tone = "danger"
    else if (running) tone = "accent"
    else if (complete) tone = "ok"
    else tone = "muted"
    if (isred && running) subline = "case " (n + 1) " running, red at case " firstred ": " nm[firstred]
    else if (isred) subline = "case " firstred " red: " nm[firstred]
    else if (running) subline = "case " (n + 1) " running"
    else if (complete) subline = ok "/" total " green, " ago(now - mtime)
    else subline = "stopped at " n "/" total ", " ago(now - mtime)
  }
  subline = clip(subline, 120)
  blabel = clip(blabel, 12)

  out = "{\"v\":1,\"asOf\":" jstr(nowiso) ",\"fresh\":\"60s\",\"parts\":["
  out = out "{\"at\":\"belt\",\"id\":\"belt\",\"mark\":{\"icon\":\"flask\",\"label\":" jstr(blabel) ",\"tone\":\"" (none ? "plain" : tone) "\"}},"
  out = out "{\"at\":\"session\",\"id\":\"legs\",\"name\":\"Browser leg\",\"icon\":\"flask\""
  if (running && !none) out = out ",\"tone\":\"accent\""
  out = out ",\"subtitle\":" jstr(subline)
  if (isred) out = out ",\"badge\":{\"count\":" reds "}"
  if (!none) {
    pv = int(n * 12 / total + 0.5); if (pv > 12) pv = 12
    out = out ",\"progress\":{\"value\":" pv ",\"max\":12}"
  }
  out = out ",\"view\":["
  if (none) {
    out = out "{\"kind\":\"para\",\"text\":\"No leg log found yet.\"}"
  } else {
    out = out "{\"kind\":\"number\",\"text\":" jstr(clip(ok "/" total, 12)) ",\"attrs\":{\"label\":\"cases green\",\"tone\":\"" tone "\"}}"
    # The meter is the share of cases that ran, a fraction, so its max stays the default.
    frac = (total > 0) ? n / total : 0
    out = out ",{\"kind\":\"meter\",\"attrs\":{\"role\":\"progress\",\"value\":\"" sprintf("%.2f", frac) "\",\"tone\":\"" tone "\",\"label\":\"cases run\"}}"
    # One chip per leg, 12 at most (a log holds three legs at most today).
    legs = (sec > 12) ? 12 : sec
    cur = isred ? redsec : sec
    out = out ",{\"kind\":\"bar\",\"attrs\":{\"label\":\"Legs\"},\"kids\":["
    for (i = 1; i <= legs; i++) {
      cs = (sdone[i] ? "done" : ((running && i == sec) ? "working" : "gone"))
      ca = "\"state\":\"" cs "\""
      if (i == cur) ca = ca ",\"current\":\"\""
      if (sred[i] > 0) ca = ca ",\"tone\":\"danger\""
      out = out (i > 1 ? "," : "") "{\"kind\":\"chip\",\"text\":" jstr(label(i)) ",\"attrs\":{" ca "}}"
    }
    if (legs < 12) {
      if (running && birth > 0) out = out ",{\"kind\":\"chip\",\"attrs\":{\"icon\":\"clock\",\"at\":\"" birth "000\",\"clock\":\"elapsed\"}}"
      else if (!running && mtime > 0) out = out ",{\"kind\":\"chip\",\"attrs\":{\"icon\":\"clock\",\"at\":\"" mtime "000\",\"clock\":\"ago\"}}"
    }
    out = out "]}"
    if (isred) {
      rtext = "case " firstred ", " nm[firstred] (firsterr != "" ? ": " firsterr : "")
      out = out ",{\"kind\":\"card\",\"attrs\":{\"tone\":\"danger\"},\"kids\":["
      out = out "{\"kind\":\"para\",\"text\":" jstr("Case " firstred " is red") ",\"attrs\":{\"role\":\"heading\"}},"
      out = out "{\"kind\":\"para\",\"text\":" jstr(clip(rtext, 400)) "}]}"
    }
    turns = hasor ? ("OpenRouter " orr ", Claude " ant) : (running ? "not known yet" : "not in the log")
    out = out ",{\"kind\":\"list\",\"kids\":["
    out = out "{\"kind\":\"row\",\"text\":\"Reds\",\"attrs\":{\"end\":" jstr(reds == 0 ? "none" : reds " of " n) "}},"
    out = out "{\"kind\":\"row\",\"text\":\"Turns\",\"attrs\":{\"end\":" jstr(clip(turns, 40)) "}},"
    out = out "{\"kind\":\"row\",\"text\":\"Worktree\",\"attrs\":{\"end\":" jstr(clip(base(wt), 40)) "}},"
    out = out "{\"kind\":\"row\",\"text\":\"Log\",\"attrs\":{\"end\":" jstr(clip(logbase, 40)) "}}"
    out = out "]}"
  }
  out = out "]}]"
  # One decision for the first red case, once the leg stopped and a skip did not close it.
  if (isred && !running && skipped != ("case-" firstred " " logbase)) {
    sum = nm[firstred] (firsterr != "" ? ": " firsterr : "")
    out = out ",\"decisions\":[{\"key\":\"case-" firstred "\",\"title\":" jstr(clip("Leg red: case " firstred ". Rerun it?", 120))
    out = out ",\"summary\":" jstr(clip("Case " firstred " failed, " ok " passed. " sum, 280))
    out = out ",\"options\":[{\"intent\":\"rerun\",\"label\":\"Rerun\"},{\"intent\":\"skip\",\"label\":\"Skip\"}]"
    out = out ",\"recommends\":{\"intent\":\"rerun\",\"why\":\"A red case in a replay leg is often a timeout, and a rerun shows it.\"}"
    out = out ",\"priority\":\"today\""
    if (scope != "") out = out ",\"about\":" jstr(scope) ",\"replyTo\":" jstr(scope)
    if (shot != "") out = out ",\"media\":[{\"file\":" jstr(shot) ",\"caption\":" jstr(clip("Case " firstred, 80)) "}]"
    out = out "}]"
  }
  out = out "}"
  print out
}
' "${log:-/dev/null}"
