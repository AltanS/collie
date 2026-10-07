#!/usr/bin/env bash
# Rebuild the bundled UI typeface subsets in web/public/fonts/.
#
# NOT part of the build, for the same reason scripts/build-nerd-font.sh is not: a webfont is a
# release artifact, not a build step. This needs Python + fonttools + brotli, and the .woff2 files
# are committed.
#
# TWO KINDS OF CANDIDATE LIVE IN THE LIST BELOW, and the difference is not cosmetic.
#
#   * SHIPPED faces are the ones the app can actually be set to — the Typeface card in Settings
#     offers exactly these, and web/src/index.css declares exactly these. index.css MIRRORS the
#     shipped list: a face is shipped when it has an @font-face block, a computed fallback twin and
#     an entry in UI_FONT_URLS (web/src/lib/sw-routes.ts). Today: space-grotesk (the default) and
#     aldrich. Adding one means all four edits, and web/src/fonts.test.ts fails until they agree.
#   * PLAYGROUND-ONLY auditions are candidates on disk that nothing in the app names. They exist so
#     the "UI typeface" playground card can put a face beside the shipped ones at real sizes before
#     anyone argues for it. Today: ibm-plex-sans, geist. An audition that never wins is deleted —
#     its .woff2 and its LICENSE go together.
#
# A THIRD KIND, the COMPANION, is built after the loop. Aldrich has no Cyrillic, so Russian used to
# fall through to the system face, drawn ~13% too large by Aldrich's metric stand-in. The companion
# is Play 400 (Latin, Cyrillic, Greek; SIL OFL 1.1) subset to Cyrillic ONLY and declared in index.css
# under the SAME family name "Aldrich" with a `unicode-range`, so a browser downloads it only when
# Cyrillic text is on screen and the font stack never changes. It is NOT in UI_FONT_URLS (it has no
# twin and no Typeface choice of its own), only in UI_COMPANION_FONT_URLS, and it is never preloaded
# and never precached. Unlike the faces above, its source is PINNED to a google/fonts commit and
# sha256-checked, because a companion that moved under a fixed filename would be a silent change.
#
# The app face was the maker's choice when this script was written; it is a per-device setting now
# (ADR 0033). That widened what "shipped" means and changed nothing about how a face is BUILT.
#
# Unlike the Nerd Font faces, the UI face is on the critical path — it dresses every label in the
# app — so the whole job here is making it small and making its metrics knowable:
#
#   * INSTANCE first. Pin every axis the app does not use (wdth, opsz) and clamp wght to 400–700.
#     The design uses two weights (500 / 600); 400–700 leaves room without carrying 100–900.
#   * SUBSET second. Latin + Latin-Ext-A + the punctuation the app actually prints. The ja/ko/zh
#     dictionaries are deliberately NOT covered: no sane build ships a CJK webfont, and those
#     locales fall through to the system face, which is what they should do.
#   * KEEP `tnum`. Every count in the app is `tabular-nums`; dropping the feature would silently
#     turn "14m (6) p1" back into proportional figures.
#   * PRINT the fallback metric overrides. index.css declares a metric-matched stand-in per face so
#     the swap moves nothing (see its @font-face block). Those numbers are DERIVED, not chosen —
#     this script recomputes them so a font bump cannot leave them stale.
#
#   pip install 'fonttools[woff]'
#   scripts/build-ui-font.sh
set -euo pipefail

OUT="$(cd "$(dirname "$0")/.." && pwd)/web/public/fonts"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

command -v pyftsubset >/dev/null || { echo "pyftsubset not found — pip install 'fonttools[woff]'" >&2; exit 1; }

# Every face this script builds. dir : file : version : slug : pinned axes.
#
# The last field is either a (possibly empty) list of "axis=value" pins for a VARIABLE face, or the
# literal token `static` for a face that carries no `fvar` at all. Aldrich is the static case: there
# is no instancer step to run, so the TTF is copied to the instance name the subsetter and the
# metrics pass below both expect. Everything after that — subset, features, fallback twin — is
# identical, which is the point of spelling the branch here rather than forking the loop.
#
# See the header for which of these are SHIPPED and which are playground-only auditions.
CANDIDATES=(
  "spacegrotesk:SpaceGrotesk[wght].ttf:2.000:space-grotesk:"
  "aldrich:Aldrich-Regular.ttf:1.002:aldrich:static"
  "ibmplexsans:IBMPlexSans[wdth,wght].ttf:3.201:ibm-plex-sans:wdth=100"
  "geist:Geist[wght].ttf:1.800:geist:"
)

# What the app prints. Basic Latin + Latin-1 + Latin-Ext-A (German and Spanish copy, and any Latin
# name a session carries), the general-punctuation block (· — – … ‹ › • and the real quotes),
# currency, arrows (the Keys tray prints ⇧), and the handful of maths/symbol codepoints in the
# dictionaries. A codepoint in range but absent from the face falls through to the next family,
# which is the correct outcome — the range is allowed to be wider than the font.
RANGES='U+0000-00FF,U+0100-017F,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+20A0-20BF,U+2122,U+2190-21FF,U+2212,U+2264-2265,U+2699,U+2713-2714,U+25CF'
FEATURES='kern,ccmp,locl,liga,calt,tnum,case,mark,mkmk'

mkdir -p "$OUT"
for entry in "${CANDIDATES[@]}"; do
  IFS=':' read -r dir file version slug axes <<<"$entry"
  echo "→ $slug $version"
  # `[` and `]` are literal in the upstream filename and must be percent-encoded for curl.
  url_file="${file//\[/%5B}"; url_file="${url_file//\]/%5D}"
  curl -fsSL -o "$WORK/$slug.ttf" "https://raw.githubusercontent.com/google/fonts/main/ofl/$dir/$url_file"
  curl -fsSL -o "$OUT/LICENSE-$slug.txt" "https://raw.githubusercontent.com/google/fonts/main/ofl/$dir/OFL.txt"

  if [ "$axes" = "static" ]; then
    # No fvar, so nothing to instance: the file IS its own instance. Copied rather than symlinked so
    # the metrics pass below reads the same bytes on every platform.
    cp "$WORK/$slug.ttf" "$WORK/$slug-inst.ttf"
  else
    # shellcheck disable=SC2086 # $axes is a deliberate word-split list of "axis=value" pairs.
    fonttools varLib.instancer -q "$WORK/$slug.ttf" $axes 'wght=400:700' -o "$WORK/$slug-inst.ttf"
  fi
  pyftsubset "$WORK/$slug-inst.ttf" --unicodes="$RANGES" --layout-features="$FEATURES" \
    --no-hinting --desubroutinize --flavor=woff2 \
    --output-file="$OUT/ui-$slug-$version-latin.woff2"
done

# ── The Cyrillic companion ──────────────────────────────────────────────────────────────────────
# Source pinned to a google/fonts commit; both downloads are sha256-checked and the script stops if
# either differs. Bumping Play means a new commit, new hashes and a new version in the filename.
PLAY_COMMIT=5e8a3ba899557829a76cfdac30fa512bda91d7ca
PLAY_TTF_SHA256=eed0da79005cab35d6ed0eacab594ed67cc643be0b2632fa9e440b3bc5078dc4
PLAY_OFL_SHA256=6d216cec166b6e139adaa599053dd49720c053e1f2adb4845de3cc9c3704344d
PLAY_VERSION=2.101
# Cyrillic that Russian (and Ukrainian) copy needs: U+0400-045F (basic + Ukrainian/Serbian/
# Macedonian letters), U+0490-0491 (Ukrainian ghe with upturn), U+04B0-04B1 (Kazakh straight u) and
# U+2116 (№). Play carries every one of them. Keep in step with the `unicode-range` of the Play
# @font-face in web/src/index.css and web/index.html: that range is what makes the file lazy.
PLAY_RANGES='U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116'
echo "→ play $PLAY_VERSION (cyrillic companion)"
play_base="https://raw.githubusercontent.com/google/fonts/$PLAY_COMMIT/ofl/play"
curl -fsSL -o "$WORK/play.ttf" "$play_base/Play-Regular.ttf"
curl -fsSL -o "$WORK/play-OFL.txt" "$play_base/OFL.txt"
echo "$PLAY_TTF_SHA256  $WORK/play.ttf" | sha256sum -c - >/dev/null || { echo "Play-Regular.ttf does not match the pinned sha256" >&2; exit 1; }
echo "$PLAY_OFL_SHA256  $WORK/play-OFL.txt" | sha256sum -c - >/dev/null || { echo "Play OFL.txt does not match the pinned sha256" >&2; exit 1; }
cp "$WORK/play-OFL.txt" "$OUT/LICENSE-play.txt"
pyftsubset "$WORK/play.ttf" --unicodes="$PLAY_RANGES" --layout-features="$FEATURES" \
  --no-hinting --desubroutinize --flavor=woff2 \
  --output-file="$OUT/ui-play-$PLAY_VERSION-cyrillic.woff2"

echo
echo "→ fallback metric overrides for index.css (recomputed, do not hand-edit)"
curl -fsSL -o "$WORK/arimo.ttf" 'https://raw.githubusercontent.com/google/fonts/main/ofl/arimo/Arimo%5Bwght%5D.ttf'
curl -fsSL -o "$WORK/roboto.ttf" 'https://raw.githubusercontent.com/google/fonts/main/ofl/roboto/Roboto%5Bwdth,wght%5D.ttf'
WORK="$WORK" python3 - <<'PY'
import os
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

work = os.environ["WORK"]
# The line the width ratio is measured over: a real slab of Collie's own chrome, NOT the alphabet.
# An unweighted A-Za-z0-9 sample was tried first and was wrong by 5% on Space Grotesk — it counts
# every letter once, so the wide capitals it never prints outvote the lowercase it prints constantly.
# The ratio this produces agrees with what Chrome measures on the same line to within 0.5%.
SAMPLE = (
    "Needs you Working Idle Unknown Terminal font size Applies to the mirror and the transcript "
    "Reload Not now A newer build is on the server bluefin collie-website sportsight "
    "14m 3m 1h 08m 18h 6d (6) (11) (2) (1) (0) p1 p4 p2 p10 p7 Settings Display Crew Devices "
    "Paired Connection"
)

def metrics(path, loc):
    f = TTFont(path)
    if "fvar" in f:
        f = instantiateVariableFont(f, loc, inplace=True, updateFontNames=False)
    cmap, hmtx, upm = f.getBestCmap(), f["hmtx"], f["head"].unitsPerEm
    width = sum(hmtx[cmap[ord(c)]][0] for c in SAMPLE if ord(c) in cmap) / upm
    os2, hhea = f["OS/2"], f["hhea"]
    # USE_TYPO_METRICS (fsSelection bit 7) decides which pair the browser lays lines out with.
    typo = bool(os2.fsSelection & (1 << 7))
    asc, desc, gap = (
        (os2.sTypoAscender, os2.sTypoDescender, os2.sTypoLineGap) if typo
        else (hhea.ascent, hhea.descent, hhea.lineGap)
    )
    return width, asc / upm, desc / upm, gap / upm

# Arimo is metric-compatible with Arial; Roboto is printed only to confirm it still measures within
# a fraction of a percent of it, which is what lets ONE stand-in face cover both platforms. If that
# gap ever opens up, index.css needs a second fallback family, not a fudged number.
refs = {"Arial": metrics(f"{work}/arimo.ttf", {"wght": 400}),
        "Roboto": metrics(f"{work}/roboto.ttf", {"wght": 400, "wdth": 100})}
print(f"  reference spread: Roboto is {refs['Roboto'][0]/refs['Arial'][0]*100 - 100:+.2f}% vs Arial")
for slug in ("space-grotesk", "aldrich", "ibm-plex-sans", "geist"):
    width, asc, desc, gap = metrics(f"{work}/{slug}-inst.ttf", {"wght": 400})
    sa = width / refs["Arial"][0]
    print(f"  {slug:14}  size-adjust: {sa*100:.2f}%  "
          f"ascent-override: {asc/sa*100:.2f}%  descent-override: {abs(desc)/sa*100:.2f}%  "
          f"line-gap-override: {gap/sa*100:.2f}%")
PY

echo
echo "→ Play's overrides for index.css: scaled so its letters match Aldrich's, line box = Aldrich's"
WORK="$WORK" python3 - <<'PY'
import os
from fontTools.pens.boundsPen import BoundsPen
from fontTools.ttLib import TTFont

work = os.environ["WORK"]

def face(path):
    f = TTFont(path)
    cmap, upm = f.getBestCmap(), f["head"].unitsPerEm
    glyphs = f.getGlyphSet()
    def top(ch):
        pen = BoundsPen(glyphs)
        glyphs[cmap[ord(ch)]].draw(pen)
        return pen.bounds[3] / upm
    os2, hhea = f["OS/2"], f["hhea"]
    typo = bool(os2.fsSelection & (1 << 7))
    asc, desc, gap = (
        (os2.sTypoAscender, os2.sTypoDescender, os2.sTypoLineGap) if typo
        else (hhea.ascent, hhea.descent, hhea.lineGap)
    )
    return {"x": top("x"), "cap": top("H"), "asc": asc / upm, "desc": abs(desc) / upm, "gap": gap / upm}

# Aldrich has no Cyrillic to measure widths on, and Play is a different design with its own
# rhythm, so the honest match is LETTER SIZE: the mean of the x-height and cap-height ratios.
# Cyrillic lowercase is almost all x-height, and its capitals sit at the cap line.
ald, play = face(f"{work}/aldrich-inst.ttf"), face(f"{work}/play.ttf")
sa = (ald["x"] / play["x"] + ald["cap"] / play["cap"]) / 2
print(f"  x-height  Aldrich {ald['x']:.3f}  Play {play['x']:.3f}  ratio {ald['x']/play['x']*100:.2f}%")
print(f"  cap-height Aldrich {ald['cap']:.3f}  Play {play['cap']:.3f}  ratio {ald['cap']/play['cap']*100:.2f}%")
print(f"  play          size-adjust: {sa*100:.2f}%  "
      f"ascent-override: {ald['asc']/sa*100:.2f}%  descent-override: {ald['desc']/sa*100:.2f}%  "
      f"line-gap-override: {ald['gap']/sa*100:.2f}%")
PY

ls -l "$OUT"
echo "→ update the filenames, the quoted sizes and the override percentages in web/src/index.css"
echo "→ update UI_FONT_URLS in web/src/lib/sw-routes.ts and the preload in web/index.html"
echo "→ the Play companion: UI_COMPANION_FONT_URLS in sw-routes.ts, no preload, unicode-range as above"
