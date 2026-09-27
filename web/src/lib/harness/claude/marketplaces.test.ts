import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../../ansi";
import { lineText, splitLines, type Block, type StyledLine } from "../../blocks";
import { withUnreadDialog } from "../index";
import { menusEqual, menusSameIdentity, type MenuModel } from "../menu-model";
import { claudeAdapter, claudeBuildBlocks } from "./index";
import { detectMarketplaces } from "./marketplaces";

// The `/plugin` Marketplaces tab and a marketplace's detail screen (marketplaces.ts). Captured
// 2026-09-27 on Claude Code 2.1.283 in a private Herdr session, with a copied config and two scratch
// local marketplaces (fixtures/panes/README.md, "Plugin marketplaces corpus"), in the classic
// renderer and the full-screen one, at 40, 82 and 120 columns. These tests pin the buttons each screen
// gets, that remove is never one of them, and that no screen the grammar reads wears the unread card.

const PANES_DIR = join(import.meta.dirname, "..", "..", "..", "fixtures", "panes");

const load = (name: string): StyledLine[] =>
  splitLines(parseAnsi(readFileSync(join(PANES_DIR, name), "utf8")));
const fromTexts = (texts: string[]): StyledLine[] => splitLines(parseAnsi(texts.join("\n")));
const textsOf = (name: string): string[] => load(name).map(lineText);

/** The whole pipeline the phone runs: the adapter's blocks, then the unread-card post-pass. */
const pipeline = (lines: StyledLine[]): Block[] => withUnreadDialog(claudeAdapter, lines, claudeBuildBlocks(lines));

/** The menu block the pipeline lifts, or a failure naming the kinds it lifted instead. */
function menuOf(name: string): MenuModel {
  const blocks = pipeline(load(name));
  const menu = blocks.find((b) => b.kind === "menu");
  if (menu === undefined || menu.kind !== "menu") throw new Error(`${name}: ${blocks.map((b) => b.kind)}`);
  return menu.menu;
}

/** An action list as `Label[key]` strings, the shape a reader can check at a glance. */
const buttons = (menu: MenuModel): string[] => menu.actions.map((a) => `${a.label}[${a.keys.join("+")}]`);

const WIDTHS = ["40", "82", "120"] as const;
const MODES = ["", "fullscreen-"] as const;
const each = (state: string): string[] =>
  MODES.flatMap((mode) => WIDTHS.map((w) => `claude--v2283-${mode}plugin-${state}--w${w}.txt`));

const TAB_BUTTONS = ["Select[Enter]", "Update[u]", "Go back[Escape]"];
const PENDING_BUTTONS = ["Apply changes[Enter]", "Cancel[Escape]"];
const DETAIL_BUTTONS = ["Select[Enter]", "Go back[Escape]"];

describe("the Marketplaces tab reads as a menu in both renderers, at every width", () => {
  it.each([...each("marketplaces-add"), ...each("marketplaces-pointed")])("%s: Select, Update, Go back", (name) => {
    const menu = menuOf(name);
    expect(menu.title).toBe("Manage marketplaces");
    expect(buttons(menu)).toEqual(TAB_BUTTONS);
    expect(menu.nav).toEqual({ upDown: true });
  });

  it.each(each("marketplaces-pending"))("%s: the pending update reads Apply changes and Cancel", (name) => {
    const menu = menuOf(name);
    expect(menu.title).toBe("Manage marketplaces");
    expect(buttons(menu)).toEqual(PENDING_BUTTONS);
    expect(menu.nav).toEqual({ upDown: true });
  });

  it.each([
    ["claude--v2283-fullscreen-plugin-marketplaces-changed--w82.txt", "▔▔▔"],
    // At 40 columns the label crowds out the edge's left run: ` Plugins changed. Run /reload-plugins… ▔`.
    ["claude--v2283-fullscreen-plugin-marketplaces-changed--w40.txt", " Plugins changed."],
  ])("%s: back on the tab after an update, under an edge labelled `Plugins changed`", (name, opens) => {
    const blocks = pipeline(load(name));
    expect(blocks.map((b) => b.kind)).toEqual(["raw", "menu"]);
    expect(lineText(blocks[1]!.lines[0]!).startsWith(opens)).toBe(true);
    expect(lineText(blocks[1]!.lines[0]!)).toContain("Plugins changed.");
    expect(buttons(menuOf(name))).toEqual(TAB_BUTTONS);
  });

  it("reads the footer a 40-column pane wraps onto two rows whole, not just its last row", () => {
    // `Enter to select · u to update · d to` over `remove · Esc to go back`. The last row alone
    // parses as one hint, and the generic menu used to offer Go back and nothing else here.
    const texts = textsOf("claude--v2283-plugin-marketplaces-pointed--w40.txt");
    expect(texts.findLast((t) => t.trim() !== "")!.trim()).toBe("remove · Esc to go back");
    expect(buttons(menuOf("claude--v2283-plugin-marketplaces-pointed--w40.txt"))).toEqual(TAB_BUTTONS);
  });
});

describe("a marketplace's detail screen reads as a menu", () => {
  it.each([
    ["claude--v2283-plugin-marketplace-detail--w40.txt", "lab-market"],
    ["claude--v2283-plugin-marketplace-detail--w82.txt", "lab-market"],
    ["claude--v2283-plugin-marketplace-detail--w120.txt", "lab-market"],
    ["claude--v2283-fullscreen-plugin-marketplace-detail--w120.txt", "lab-market"],
    ["claude--v2283-fullscreen-plugin-marketplace-detail-short--w40.txt", "demo-market"],
    ["claude--v2283-fullscreen-plugin-marketplace-detail-short--w82.txt", "demo-market"],
    ["claude--v2283-fullscreen-plugin-marketplace-detail-short--w120.txt", "demo-market"],
  ])("%s: Select and Go back, titled with the marketplace's name", (name, title) => {
    const menu = menuOf(name);
    expect(menu.title).toBe(title);
    expect(buttons(menu)).toEqual(DETAIL_BUTTONS);
    expect(menu.nav).toEqual({ upDown: true });
  });

  it("finds its title far above the actions: the tall classic detail's header is dozens of rows up", () => {
    const texts = textsOf("claude--v2283-plugin-marketplace-detail--w40.txt");
    const header = texts.findIndex((t) => t.trim() === "6 available plugins");
    const actions = texts.findIndex((t) => t.includes("Browse plugins (6)"));
    expect(actions - header).toBeGreaterThan(30);
    expect(menuOf("claude--v2283-plugin-marketplace-detail--w40.txt").title).toBe("lab-market");
  });

  it.each([
    ["claude--v2283-plugin-marketplace-detail--w82.txt", "─"],
    ["claude--v2283-fullscreen-plugin-marketplace-detail-short--w82.txt", "▔"],
    ["claude--v2283-plugin-marketplaces-pointed--w82.txt", "─"],
    ["claude--v2283-fullscreen-plugin-marketplaces-pointed--w82.txt", "▔"],
  ])("%s: the region is the whole modal, from its %s row down to the footer", (name, edge) => {
    const blocks = pipeline(load(name));
    expect(blocks.map((b) => b.kind)).toEqual(["raw", "menu"]);
    const region = blocks[1]!.lines.map(lineText).map((t) => t.trim());
    // The edge runs the pane's width, so a region read at 82 columns is never accepted at 120.
    expect(region[0]).toBe(edge.repeat(82));
    expect(region[1]).toBe("Plugins  Discover   Installed   Marketplaces   Errors   Stats");
    expect(region.at(-1)).toMatch(/^Enter to select · /);
  });

  it("reads the page after its own Update marketplace row ran: `✔ Updated 1 marketplace` above the rows", () => {
    const name = "claude--v2283-plugin-marketplace-detail-updated--w82.txt";
    expect(textsOf(name).some((t) => t.trim() === "✔ Updated 1 marketplace")).toBe(true);
    const menu = menuOf(name);
    expect(menu.title).toBe("lab-market");
    expect(buttons(menu)).toEqual(DETAIL_BUTTONS);
  });

  it("reads the operator's shape too: an auto-update row, and a note between the actions and the footer", () => {
    // Hand-built from a real screen's layout (a GitHub-backed marketplace with auto-update on). The
    // lab's local marketplaces print neither the row nor the note, so no capture holds them.
    const menu = detectMarketplaces(fromTexts(AUTO_UPDATE_DETAIL))!;
    expect(menu.title).toBe("team-market");
    expect(buttons(menu)).toEqual(DETAIL_BUTTONS);
  });
});

describe("remove is never a button", () => {
  const lifted = readdirSync(PANES_DIR)
    .filter((f) => f.startsWith("claude--v2283-") && f.includes("plugin-market"))
    .toSorted()
    .filter((f) => pipeline(load(f)).some((b) => b.kind === "menu"));

  it("the corpus has something to check", () => {
    expect(lifted.length).toBe(29);
  });

  it.each(lifted)("%s offers no d and no Remove", (name) => {
    const menu = menuOf(name);
    expect(menu.actions.flatMap((a) => a.keys)).not.toContain("d");
    expect(menu.actions.map((a) => a.label).filter((l) => /remove/i.test(l))).toEqual([]);
  });

  it("the tab footer does print d, so the grammar withholds a key the screen named", () => {
    expect(textsOf("claude--v2283-plugin-marketplaces-pointed--w82.txt").some((t) => t.includes("d to remove"))).toBe(
      true,
    );
  });

  it("withholds Enter while the pointer sits on Remove marketplace, which opens the same confirm", () => {
    const menu = menuOf("claude--v2283-plugin-marketplace-detail-remove--w82.txt");
    expect(menu.title).toBe("demo-market");
    expect(buttons(menu)).toEqual(["Go back[Escape]"]);
    // The arrows stay, so the operator can walk back up to a row Enter is offered on.
    expect(menu.nav).toEqual({ upDown: true });
  });
});

describe("no screen the grammar reads wears the unread card", () => {
  const all = readdirSync(PANES_DIR)
    .filter((f) => f.startsWith("claude--v2283-") && f.includes("plugin-market"))
    .toSorted();

  it.each(all)("%s", (name) => {
    const lines = load(name);
    const kinds = pipeline(lines).map((b) => b.kind);
    const expected = EXPECTED_KIND.get(name) ?? "menu";
    if (expected === "menu") {
      expect(kinds).toEqual(["raw", "menu"]);
      expect(claudeAdapter.composerReady!(lines)).toBe(false);
    } else if (expected === "idle") {
      // The update applied: the menu closed and the chat shows the result above a live box.
      expect(kinds).toEqual(["raw"]);
      expect(claudeAdapter.composerReady!(lines)).toBe(true);
    } else if (expected === "clipped") {
      // Full screen, a detail taller than the pane: its footer is below the last row, so the screen
      // names no key. No button may be invented (ADR 0009), and with no key-hint row in its tail it
      // gets no card either. Typing stays refused, because there is no input box.
      expect(kinds).toEqual(["raw"]);
      expect(claudeAdapter.composerReady!(lines)).toBe(false);
    } else {
      expect(kinds).toEqual(["unread-dialog"]);
    }
  });

  it("the updated screens show the result line", () => {
    for (const w of WIDTHS) {
      for (const mode of MODES) {
        const texts = textsOf(`claude--v2283-${mode}plugin-marketplaces-updated--w${w}.txt`);
        expect(texts.some((t) => t.includes("✔ Updated 1 marketplace"))).toBe(true);
      }
    }
  });
});

describe("the race guard sees what the card was drawn from", () => {
  it("a moved pointer refuses a committing key and lets an arrow through", () => {
    const onAdd = menuOf("claude--v2283-plugin-marketplaces-add--w82.txt");
    const onMarket = menuOf("claude--v2283-plugin-marketplaces-pointed--w82.txt");
    expect(menusEqual(onAdd, onMarket)).toBe(false);
    expect(menusSameIdentity(onAdd, onMarket)).toBe(true);
  });

  it("a Select drawn on the list is refused once the tab shows a pending update", () => {
    const list = menuOf("claude--v2283-plugin-marketplaces-pointed--w82.txt");
    const pending = menuOf("claude--v2283-plugin-marketplaces-pending--w82.txt");
    expect(menusSameIdentity(list, pending)).toBe(false);
  });

  it("two marketplaces' detail screens are two menus, even where their action rows match", () => {
    const tall = menuOf("claude--v2283-fullscreen-plugin-marketplace-detail--w120.txt");
    const short = menuOf("claude--v2283-fullscreen-plugin-marketplace-detail-short--w120.txt");
    expect(tall.title).not.toBe(short.title);
    expect(menusSameIdentity(tall, short)).toBe(false);
  });
});

describe("it fails closed", () => {
  const tab = textsOf("claude--v2283-plugin-marketplaces-pointed--w82.txt");
  const detail = textsOf("claude--v2283-plugin-marketplace-detail--w82.txt");

  it("reads nothing without the tab's title", () => {
    expect(detectMarketplaces(fromTexts(tab.map((t) => t.replace("Manage marketplaces", "Manage things"))))).toBeNull();
  });

  it("reads nothing without the Add Marketplace row", () => {
    expect(detectMarketplaces(fromTexts(tab.filter((t) => !t.includes("+ Add Marketplace"))))).toBeNull();
  });

  it("reads nothing with two pointers in the list", () => {
    expect(detectMarketplaces(fromTexts(tab.map((t) => t.replace("  ● demo-market", "❯ ● demo-market"))))).toBeNull();
  });

  it("reads nothing once output lands below the footer", () => {
    expect(detectMarketplaces(fromTexts([...tab, "● Wrote the file"]))).toBeNull();
  });

  it("reads no detail screen without its header, which is where the title comes from", () => {
    expect(detectMarketplaces(fromTexts(detail.filter((t) => t.trim() !== "6 available plugins")))).toBeNull();
  });

  it("reads no detail screen without its Update row", () => {
    expect(detectMarketplaces(fromTexts(detail.filter((t) => !t.includes("Update marketplace"))))).toBeNull();
  });

  it("reads no detail screen whose actions are split by a blank row", () => {
    const i = detail.findIndex((t) => t.includes("Remove marketplace"));
    expect(detectMarketplaces(fromTexts([...detail.slice(0, i), "", ...detail.slice(i)]))).toBeNull();
  });

  it("does not claim the Add Marketplace source field it opens", () => {
    expect(detectMarketplaces(load("claude--v2283-plugin-marketplaces-add-form--w82.txt"))).toBeNull();
  });
});

/** What each capture should read as, where it is not the menu. */
const EXPECTED_KIND = new Map<string, "idle" | "clipped" | "card">([
  ["claude--v2283-plugin-marketplaces-updated--w40.txt", "idle"],
  ["claude--v2283-plugin-marketplaces-updated--w82.txt", "idle"],
  ["claude--v2283-plugin-marketplaces-updated--w120.txt", "idle"],
  ["claude--v2283-fullscreen-plugin-marketplaces-updated--w40.txt", "idle"],
  ["claude--v2283-fullscreen-plugin-marketplaces-updated--w82.txt", "idle"],
  ["claude--v2283-fullscreen-plugin-marketplaces-updated--w120.txt", "idle"],
  ["claude--v2283-fullscreen-plugin-marketplace-detail--w40.txt", "clipped"],
  ["claude--v2283-fullscreen-plugin-marketplace-detail--w82.txt", "clipped"],
  ["claude--v2283-plugin-marketplaces-add-form--w82.txt", "card"],
]);

/** A detail screen in the shape a GitHub-backed marketplace with auto-update on prints, with made-up
 *  names. */
const AUTO_UPDATE_DETAIL = [
  "─".repeat(82),
  "  Plugins  Discover   Installed   Marketplaces   Errors   Stats",
  "",
  "  team-market",
  "  example-org/team-plugins",
  "",
  "  2 available plugins",
  "",
  "  Installed plugins (2):",
  "   ● one-kit",
  "     A scratch plugin.",
  "   ● two-kit",
  "     A scratch plugin.",
  "",
  "  ❯ Browse plugins (2)",
  "    Update marketplace (last updated 9/27/2026)",
  "    Disable auto-update",
  "    Remove marketplace",
  "",
  "  Auto-update enabled. Claude Code will automatically update this marketplace and its installed",
  "  plugins.",
  "",
  "  Enter to select · Esc to go back",
];
