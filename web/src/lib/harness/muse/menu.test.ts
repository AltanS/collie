import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../../ansi";
import { lineText, splitLines, type StyledLine } from "../../blocks";
import { menusEqual, menusSameIdentity, type MenuModel } from "../menu-model";
import { museAdapter } from ".";
import { composerReady, extractInputDraft } from "./chrome";
import { detectMenu } from "./menu";

const PANES_DIR = join(import.meta.dirname, "..", "..", "..", "fixtures", "panes");

function lines(name: string): StyledLine[] {
  return splitLines(parseAnsi(readFileSync(join(PANES_DIR, name), "utf8")));
}

function fromTexts(texts: string[]): StyledLine[] {
  return splitLines(parseAnsi(texts.join("\n")));
}

function textsOf(name: string): string[] {
  return lines(name).map((l) => lineText(l).trimEnd());
}

function menuOf(name: string): MenuModel | null {
  const block = museAdapter.buildBlocks(lines(name)).find((b) => b.kind === "menu");
  return block?.kind === "menu" ? block.menu : null;
}

// Live captures, Muse Code 1.4.10, 2026-10-19 (`/tmp/muse14-inventory` on the capture host):
// `/model` opened, Down pressed once for the moved twin, Escape only — model/effort verified
// unchanged in the statusline afterwards. `/export` and `/effort` from the same sweep.
describe("below-box pickers lift as menus (MUSE-14)", () => {
  it("/model: footer keys only, Up/Down advertised, no digits", () => {
    const menu = menuOf("muse--menu-model.txt");
    expect(menu?.title).toBe("Choose model");
    expect(menu?.actions.map((a) => [a.label, a.keys.join("+"), a.cancel === true])).toEqual([
      ["Confirm", "Enter", false],
      ["Go back", "Escape", true],
    ]);
    expect(menu?.nav.upDown).toBe(true);
    expect(menu?.nav.leftRight).toBeUndefined();
    expect(menu?.signature).toContain("⟩ muse-wonder-full-1.0");
    expect(menu?.actions.flatMap((a) => a.keys).some((k) => /^\d$/.test(k))).toBe(false);
  });

  it("/export: esc reads `cancel` there, and the label follows the screen", () => {
    const menu = menuOf("muse--menu-export.txt");
    expect(menu?.title).toBe("Export  |  Save this session to a file");
    expect(menu?.actions.map((a) => [a.label, a.keys.join("+"), a.cancel === true])).toEqual([
      ["Confirm", "Enter", false],
      ["Cancel", "Escape", true],
    ]);
    expect(menu?.nav.upDown).toBe(true);
  });

  it("the picker owns the keyboard: no composer, no draft", () => {
    for (const name of ["muse--menu-model.txt", "muse--menu-model-moved.txt", "muse--menu-export.txt"]) {
      const ls = lines(name);
      expect(composerReady(ls), name).toBe(false);
      expect(extractInputDraft(ls), name).toBeNull();
    }
  });

  it("lifts under no other dialog kind", () => {
    for (const name of ["muse--menu-model.txt", "muse--menu-export.txt"]) {
      const kinds = museAdapter.buildBlocks(lines(name)).map((b) => b.kind);
      expect(kinds.filter((k) => k !== "raw"), name).toEqual(["menu"]);
    }
  });
});

describe("the answer path on the real walk pair", () => {
  it("first tap: the same screen re-derived is menusEqual, so Confirm may fire", () => {
    const rendered = menuOf("muse--menu-model.txt")!;
    const fresh = menuOf("muse--menu-model.txt")!;
    expect(menusEqual(rendered, fresh)).toBe(true);
  });

  it("a moved pointer refuses a committing tap but keeps arrow identity", () => {
    const before = menuOf("muse--menu-model.txt")!;
    const after = menuOf("muse--menu-model-moved.txt")!;
    expect(after.signature).toContain("⟩ muse-spark-1.3");
    expect(menusEqual(before, after)).toBe(false);
    expect(menusSameIdentity(before, after)).toBe(true);
    expect(menusSameIdentity(after, before)).toBe(true);
  });

  it("a different picker is neither equal nor the same identity", () => {
    const model = menuOf("muse--menu-model.txt")!;
    const exp = menuOf("muse--menu-export.txt")!;
    expect(menusEqual(model, exp)).toBe(false);
    expect(menusSameIdentity(model, exp)).toBe(false);
  });
});

describe("fails closed — measured siblings stay raw", () => {
  it("/effort: the filter row owns typed keys (MUSE-16), so no menu and no composer", () => {
    const ls = lines("muse--menu-effort-filter.txt");
    expect(detectMenu(ls)).toBeNull();
    expect(museAdapter.buildBlocks(ls).every((b) => b.kind === "raw")).toBe(true);
    expect(composerReady(ls)).toBe(false);
    expect(extractInputDraft(ls)).toBeNull();
  });

  it("claims no other muse capture in the corpus", () => {
    const own = new Set(["muse--menu-model.txt", "muse--menu-model-moved.txt", "muse--menu-export.txt"]);
    const others = readdirSync(PANES_DIR).filter(
      (f) => f.startsWith("muse--") && f.endsWith(".txt") && !own.has(f),
    );
    expect(others.length).toBeGreaterThan(40);
    for (const name of others) {
      expect(detectMenu(lines(name)), name).toBeNull();
    }
  });

  const base = textsOf("muse--menu-model.txt");
  const decline = (label: string, texts: string[]) =>
    it(label, () => {
      expect(texts).not.toEqual(base);
      expect(detectMenu(fromTexts(texts))).toBeNull();
    });

  decline(
    "a draft in the box: a quoted picker above a live composer",
    base.map((t) => (t === "❯" ? "❯ hello" : t)),
  );

  decline(
    "a filter row under the title (the /effort shape)",
    base.flatMap((t) => (t === "  Choose model" ? [t, "  filter"] : [t])),
  );

  decline(
    "an unknown footer token (`type to filter`)",
    base.map((t) =>
      t.includes("enter confirm") ? "  ↑↓ move · type to filter · enter confirm · esc go back" : t,
    ),
  );

  decline(
    "a composite key token (`enter/space toggle`, the /hud shape)",
    base.map((t) => (t.includes("enter confirm") ? "  ↑↓ move · enter/space toggle · esc close" : t)),
  );

  decline(
    "numbered options (the /permissions shape)",
    base.map((t) =>
      t === "⟩ muse-wonder-full-1.0" ? "⟩ 2. muse-wonder-full-1.0" : t,
    ),
  );

  decline(
    "checkbox options (the /skills shape)",
    base.map((t) => (t === "  muse-spark-1.3" ? "  [x] muse-spark-1.3" : t)),
  );

  decline(
    "a scroll-window row (`↓ N more` is unmeasured geometry)",
    base.map((t) => (t === "  muse-spark-1.2" ? "  muse-spark-1.2" : t)).flatMap((t) =>
      t === "  muse-spark-1.2" ? [t, "  ↓ 3 more"] : [t],
    ),
  );

  decline("two pointed rows", base.map((t) => (t === "  muse-spark-1.3" ? "⟩ muse-spark-1.3" : t)));

  decline("no pointed row", base.map((t) => (t === "⟩ muse-wonder-full-1.0" ? "  muse-wonder-full-1.0" : t)));

  decline(
    "a statusline under the footer (the picker no longer owns the tail)",
    [...base, "  muse-wonder-full-1.0 · xhigh · /tmp · YOLO"],
  );

  decline(
    "the footer loses its esc segment",
    base.map((t) => (t.includes("enter confirm") ? "  ↑↓ move · enter confirm" : t)),
  );

  it("declines garbage, blanks, and torn tails", () => {
    for (const text of ["", "\n\n", "❯ half a box\n  ↑↓ move · enter confirm · esc go back"]) {
      expect(detectMenu(splitLines(parseAnsi(text)))).toBeNull();
    }
  });
});
