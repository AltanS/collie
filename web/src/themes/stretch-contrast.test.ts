import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { SHIPPED_THEME_IDS, contrast } from "@/lib/theme/schema";

// The stretch colours (index.css, `--stretch-N` and `--stretch-N-faded`) sit outside the theme token
// list (ADR 0106) and are fixed under every theme. An open stretch's added words are PROSE in those
// colours, so they have to read on every shipped theme's page and card, in both halves. This measures
// each colour as index.css writes it against each shipped theme's `background` and `card`.
//
// Light holds 4.5:1 for soft and faded alike. Dark holds it for soft; dark faded keeps the plugin's
// own mix, which is dimmer on purpose, and is pinned at the floor it measures today so it cannot slip.

const web = resolve(import.meta.dirname, "../..");
const css = readFileSync(resolve(web, "src/index.css"), "utf8");

interface Pair {
  name: string;
  faded: boolean;
  light: string;
  dark: string;
}

const pairs: Pair[] = [...css.matchAll(/--stretch-(\d)(-faded)?:\s*light-dark\((#[0-9a-f]{6}),\s*(#[0-9a-f]{6})\)/gi)].map((m) => ({
  name: `stretch-${m[1]}${m[2] ?? ""}`,
  faded: m[2] !== undefined,
  light: m[3] ?? "",
  dark: m[4] ?? "",
}));

const SOFT_FLOOR = 4.5;
const DARK_FADED_FLOOR = 3.5;

describe("stretch colours against the shipped themes", () => {
  it("finds all eight colours in index.css", () => {
    expect(pairs.map((p) => p.name).toSorted()).toEqual(
      ["stretch-1", "stretch-1-faded", "stretch-2", "stretch-2-faded", "stretch-3", "stretch-3-faded", "stretch-4", "stretch-4-faded"],
    );
  });

  for (const id of SHIPPED_THEME_IDS) {
    // SAFETY: the shipped theme files are checked against the schema by themes.test.ts; this reads two tokens of each half.
    const theme = JSON.parse(readFileSync(resolve(web, `src/themes/${id}.json`), "utf8")) as {
      light: Record<string, string>;
      dark: Record<string, string>;
    };
    for (const half of ["light", "dark"] as const) {
      for (const ground of ["background", "card"] as const) {
        it(`${id} ${half} ${ground}`, () => {
          const base = theme[half][ground];
          expect(base).toBeDefined();
          for (const pair of pairs) {
            const floor = half === "dark" && pair.faded ? DARK_FADED_FLOOR : SOFT_FLOOR;
            const ratio = contrast(pair[half], base ?? "");
            expect(ratio, `${pair.name} on ${id} ${half} ${ground}`).toBeGreaterThanOrEqual(floor);
          }
        });
      }
    }
  }
});
