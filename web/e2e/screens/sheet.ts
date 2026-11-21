import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { SCREENS } from "./list";

// CONTACT SHEETS OF THE SCREEN LIST. Turns a folder of `<id>.<width>.png` (what `SCREENS_SHOTS=<dir>` writes) into sheets of
// 12 screens each, 4 across and 3 down, every tile labelled `<id> [<wide>]`. Needs ImageMagick's `montage`.
//
//     cd web && SCREENS_SHOTS=<dir> E2E_SET=screens bun run e2e --workers=4
//     cd web && bun e2e/screens/sheet.ts <dir> [width] [out-dir]
//
// `width` is the shot to tile (default 1440; 390 gives the phone's). The sheets go to `<out-dir>`, by default `<dir>/sheets`
// as `sheet-<width>-<n>.png`. Never point `<dir>` inside the repository tree unless it is git-ignored.

const PER_SHEET = 12;

const [dirArg, widthArg = "1440", outArg] = process.argv.slice(2);
if (dirArg === undefined) {
  console.error("usage: bun e2e/screens/sheet.ts <shots-dir> [width] [out-dir]");
  process.exit(2);
}
const dir = resolve(dirArg);
const out = resolve(outArg ?? join(dir, "sheets"));
mkdirSync(out, { recursive: true });

const tiles = SCREENS.flatMap((screen) => {
  const file = join(dir, `${screen.id}.${widthArg}.png`);
  return existsSync(file) ? [{ file, label: `${screen.id} [${screen.wide}]` }] : [];
});
if (tiles.length === 0) {
  console.error(`no ${widthArg}px shot in ${dir}`);
  process.exit(1);
}

const size = widthArg === "390" ? "260x563" : "480x300";
const columns = widthArg === "390" ? 6 : 4;
const rows = PER_SHEET / columns;
for (let first = 0, n = 1; first < tiles.length; first += PER_SHEET, n += 1) {
  const chunk = tiles.slice(first, first + PER_SHEET);
  const target = join(out, `sheet-${widthArg}-${String(n)}.png`);
  const args = [
    "-background", "#222", "-fill", "white", "-pointsize", "15",
    ...chunk.flatMap((tile) => ["-label", tile.label, tile.file]),
    "-tile", `${String(columns)}x${String(rows)}`, "-geometry", `${size}+6+6`, target,
  ];
  const run = spawnSync("montage", args, { encoding: "utf8" });
  if (run.status !== 0) {
    console.error(`montage failed for ${target}: ${run.stderr}`);
    process.exit(1);
  }
  console.log(target);
}
