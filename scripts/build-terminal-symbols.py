#!/usr/bin/env python3
"""Rebuild the bundled terminal-symbol subset in web/public/fonts/.

NOT part of the build, for the same reason scripts/build-nerd-font.sh is not: a webfont is a
release artifact, not a build step. This needs Python + fonttools + brotli, and the .woff2 file is
committed. Run it only to move to a new JuliaMono release or to change RANGES, then update the
filename in web/src/index.css and FONT_URLS in web/src/lib/sw-routes.ts.

Agents draw their chrome from two blocks phones mostly lack: Claude Code's ⎿ tool results, ⏺
bullets, ⏵⏵ mode line and ⏸ pause are Miscellaneous Technical (U+2300-23FF); its ⧉ selection and
⧖ marks are Miscellaneous Mathematical Symbols-B (U+2980-29FF). JuliaMono covers both blocks and
is monospace, so each glyph fills one terminal cell, and a phone that would draw ⏺ as a colour
emoji draws the terminal's glyph instead.

RANGES leaves out the block's East Asian Wide codepoints — ⌚⌛ 〈〉 ⏩⏪⏫⏬ ⏰ ⏳, the emoji-default
ones and the two angle brackets. A terminal gives each of those two cells, so a one-cell glyph
would pull the rest of its row out of line, and the phone's own colour emoji is the right drawing.

JuliaMono is OFL with the Reserved Font Name "JuliaMono", and a subset is a Modified Version, so
the subset is renamed "Terminal Symbols" inside the file while preserving copyright and licence
records (nameIDs 0, 7, 13, 14).
"""

from __future__ import annotations

import subprocess
import sys
import tarfile
import tempfile
import urllib.request
from pathlib import Path
from fontTools.ttLib import TTFont

DEFAULT_VERSION = "0.63.2"
RANGES = "U+2300-2319,U+231C-2328,U+232B-23E8,U+23ED-23EF,U+23F1-23F2,U+23F4-23FF,U+2980-29FF"


def main() -> None:
  version = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_VERSION
  repo_root = Path(__file__).resolve().parent.parent
  out_dir = repo_root / "web" / "public" / "fonts"
  out_dir.mkdir(parents=True, exist_ok=True)
  dest = out_dir / f"terminal-symbols-{version}.woff2"

  url = f"https://github.com/cormullion/juliamono/releases/download/v{version}/JuliaMono-ttf.tar.gz"
  with tempfile.TemporaryDirectory() as tmp:
    work = Path(tmp)
    archive = work / "jm.tar.gz"
    urllib.request.urlretrieve(url, archive)
    with tarfile.open(archive, "r:gz") as tar:
      tar.extractall(work, filter="data")

    subset_ttf = work / "subset.ttf"
    subprocess.run(
      [
        "pyftsubset",
        str(work / "JuliaMono-Regular.ttf"),
        f"--unicodes={RANGES}",
        "--name-IDs=0,1,2,3,4,5,6,7,13,14",
        "--layout-features=",
        "--no-hinting",
        "--desubroutinize",
        f"--output-file={subset_ttf}",
      ],
      check=True,
    )

    font = TTFont(str(subset_ttf))
    for rec in font["name"].names:
      if rec.nameID in (0, 7, 13, 14):
        continue
      text = rec.toUnicode()
      if "JuliaMono" in text:
        replacement = "TerminalSymbols" if rec.nameID == 6 else "Terminal Symbols"
        rec.string = text.replace("JuliaMono", replacement)
    font.flavor = "woff2"
    font.save(str(dest))

  print(f"Wrote {dest} ({dest.stat().st_size} bytes)")


if __name__ == "__main__":
  main()
