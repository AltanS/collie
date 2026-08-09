#!/usr/bin/env bash
# Rebuild the bundled Nerd Font symbol subsets in web/public/fonts/.
#
# NOT part of the build. The .woff2 files are committed, because a webfont is a release artifact,
# not a build step: this script needs Python + fonttools + brotli, and requiring those to build
# Collie would be a worse trade than 1.1 MB in git. Run it only to move to a new Nerd Fonts
# release, then update the filenames and the sizes quoted in web/src/index.css.
#
# It splits the font at the plane boundary so `unicode-range` can be selective — a Powerline-only
# prompt fetches the BMP face alone. Everything outside the private-use areas is dropped: those
# codepoints (♥, ⚡, ☰ …) already render from the system font, and overriding them with a symbol
# face would change text the user can read today.
#
#   pip install 'fonttools[woff]'
#   scripts/build-nerd-font.sh [version]
set -euo pipefail

VERSION="${1:-3.5.0}"
OUT="$(cd "$(dirname "$0")/.." && pwd)/web/public/fonts"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

command -v pyftsubset >/dev/null || { echo "pyftsubset not found — pip install 'fonttools[woff]'" >&2; exit 1; }

echo "→ fetching Nerd Fonts v$VERSION symbols"
curl -fsSL -o "$WORK/symbols.zip" \
  "https://github.com/ryanoasis/nerd-fonts/releases/download/v$VERSION/NerdFontsSymbolsOnly.zip"
unzip -qo "$WORK/symbols.zip" -d "$WORK"

# The Mono variant, because every glyph lands in a single terminal cell — the mirror is a grid.
SRC="$WORK/SymbolsNerdFontMono-Regular.ttf"
subset() { # <name> <unicodes>
  pyftsubset "$SRC" --unicodes="$2" --flavor=woff2 --layout-features='' --no-hinting \
    --desubroutinize --output-file="$OUT/nerd-symbols-$VERSION-$1.woff2"
}
mkdir -p "$OUT"
subset pua  'U+E000-F8FF'    # Powerline, devicons, codicons, Font Awesome, Octicons, seti, weather
subset spua 'U+F0000-F1AFF'  # plane 15: Material Design Icons, the bulk of the glyph count
# The ranges are deliberately wider than the font: a codepoint in range but absent from the font
# falls through to the next family, which is what should happen. So a pre-v3 Nerd Font config still
# emitting the OLD Material block (U+F500-FD46, moved to plane 15 in v3) is tofu because the GLYPHS
# are gone upstream — widening the range here cannot bring them back. Fix is on the prompt's side.
cp "$WORK/LICENSE" "$OUT/LICENSE.txt"

ls -lh "$OUT"
echo "→ update the filenames + quoted sizes in web/src/index.css"
