// The person's override past the blind road's menu sign (2026-11-25, issue 863). On a pane with no reader
// profile the generic menu sign (menu-sign.ts) is a guess with no reader behind it, wrong on about one
// idle screen in six. It refuses the first send `menu_open`, as before; the person's override after the
// card ("Send anyway") takes the override road: the text goes in with NO key, Enter included, and the
// receipt keeps the sign. On a pane with a profile a menu stays a hard stop, override or not.

import { describe, expect, test } from "bun:test";
import { type SendAnswer } from "../../web/src/lib/surface/send.ts";
import { pane, NO_PROFILE, ScreenPane, rig, refusedClean, useScratchDir } from "./protocol.override-reach.rig.ts";

useScratchDir();

/** A program that asks, with old output above it: neutral rows of our own, in the shape of a menu. */
const PROMPT_ROWS = (rows: readonly string[]): string => ["$ ./tool", "", ...rows].join("\n");
const MENUS: readonly (readonly [string, readonly string[]])[] = [
  ["a (y/n) prompt", ["Replace the settings file? (y/n)"]],
  ["a numbered menu", ["Pick one to go on:", "  1. Keep it", "  2. Keep it for this run", "  3. Stop here"]],
  ["a picker", ["Choose a size", "❯ small     quick", "  medium    slower", "  large     slowest", "(1/3)"]],
  ["two key hints", ["Ready when you are", "", "enter go on   esc go back"]],
];
/** A program foreground with its `[Y/n]` live on the last row: no agent's rows, the anchored sign fires. */
const LIVE_YN = ["$ ./setup", "3 parts to add, 0 to remove.", "Go on with the setup? [Y/n] "].join("\n");

const CLAUDE_DRAFT = "claude--draft-footer-single.txt";
const SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "gu");
/** A captured screen of a pane with a profile, with `rows` put in right over its box (the first rule row). */
function overBox(name: string, rows: readonly string[]): string {
  const raw = pane(name).replace(/\r/gu, "").split("\n");
  const top = raw.findIndex((row) => /^─{8,}/u.test(row.replace(SGR, "")));
  return [...raw.slice(0, top), ...rows, ...raw.slice(top)].join("\n");
}

/** The override road's end: the text written once, in one piece, and no key at all. */
function typedNoKey(answer: SendAnswer, screen: ScreenPane, text: string): void {
  expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "override", word: "override", keys: [] });
  expect(screen.writes).toEqual([{ how: "paste", text }]);
  expect(screen.keys).toEqual([]);
  expect(answer.offers).toEqual(["keys"]);
}

describe("the person's override past the blind road's menu sign", () => {
  for (const [what, rows] of MENUS) {
    test(`on a pane with no profile, a send past a menu sign with the override types the text and presses no Enter (${what})`, async () => {
      const screen = new ScreenPane(PROMPT_ROWS(rows));
      typedNoKey(await rig(screen, { harness: NO_PROFILE }).override("y"), screen, "y");
    });
  }

  for (const foreground of ["program", "unknown", undefined] as const) {
    test(`on a pane with no profile, a send past a menu sign with the override types the text and presses no Enter (no agent's rows, foreground ${foreground ?? "not read"})`, async () => {
      // No profile's rows show, so without the sign this road would press Enter after the text: past the sign it presses none.
      const screen = new ScreenPane(LIVE_YN);
      typedNoKey(await rig(screen, { harness: NO_PROFILE, foreground }).override("n"), screen, "n");
    });
  }

  test("the first send at a menu sign is refused as before", async () => {
    for (const [, rows] of MENUS) {
      const screen = new ScreenPane(PROMPT_ROWS(rows));
      const answer = await rig(screen, { harness: NO_PROFILE }).send("y", { fromPhone: true });
      refusedClean(answer, screen, "menu_open");
      expect(answer.offers).toEqual(["keys"]);
      expect(answer.menuSign).toBeDefined();
    }
    // Collie's own send (no person) too, with no word from anyone.
    const screen = new ScreenPane(LIVE_YN);
    refusedClean(await rig(screen, { harness: NO_PROFILE, foreground: "program" }).send("y"), screen, "menu_open");
  });

  test("the card's second tap, bound to the refusal's own rows hash, goes in with no key: the loop ends", async () => {
    const screen = new ScreenPane(PROMPT_ROWS(MENUS[1]![1]));
    const r = rig(screen, { harness: NO_PROFILE });
    const first = await r.send("2", { fromPhone: true });
    refusedClean(first, screen, "menu_open");
    typedNoKey(await r.send("2", { rowsHash: first.rowsHash!, override: true, fromPhone: true }), screen, "2");
  });

  test("the overridden send's receipt keeps the sign", async () => {
    const screen = new ScreenPane(LIVE_YN);
    const r = rig(screen, { harness: NO_PROFILE, foreground: "program" });
    const answer = await r.override("y");
    expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "override", menuSign: { kind: "yes-no", row: 2 } });
    expect(Object.keys(answer.receipt?.menuSign ?? {}).toSorted()).toEqual(["kind", "row"]);
    expect(r.protocol.recent("%1", 1)[0]?.menuSign).toEqual({ kind: "yes-no", row: 2 });
    expect(r.store.list().at(-1)?.receipt?.menuSign).toEqual({ kind: "yes-no", row: 2 });
    // The sign names no screen text.
    expect(JSON.stringify(answer.receipt)).not.toContain("setup");
  });

  test("on a pane with a profile an override at a menu is still refused", async () => {
    for (const [, rows] of MENUS.slice(0, 3)) {
      const screen = new ScreenPane(overBox(CLAUDE_DRAFT, rows));
      const r = rig(screen);
      const first = await r.override("2");
      refusedClean(first, screen, "menu_open");
      // The second tap on the rows the refusal carried is refused the same: a menu is a hard stop there.
      refusedClean(await r.send("2", { rowsHash: first.rowsHash!, override: true, fromPhone: true }), screen, "menu_open");
    }
  });

  test("the override past a sign still refuses a stale screen", async () => {
    const screen = new ScreenPane(PROMPT_ROWS(MENUS[0]![1]));
    const r = rig(screen, { harness: NO_PROFILE });
    const seen = await r.prepare();
    screen.screen = PROMPT_ROWS(["Replace the other file? (y/n)"]);
    const moved = await r.send("y", { rowsHash: seen, override: true, fromPhone: true });
    refusedClean(moved, screen, "stale_surface");
    // A hash nobody handed out is no screen the person saw either.
    const forged = await r.send("y", { rowsHash: "0000000000", override: true, fromPhone: true });
    refusedClean(forged, screen, "stale_surface");
  });

  test("the override past a sign keeps the blind road's other gates: a sign-in code, a password prompt", async () => {
    const screen = new ScreenPane(PROMPT_ROWS(MENUS[0]![1]));
    const secret = await rig(screen, { harness: NO_PROFILE }).override("123456", { secret: true });
    expect(secret.receipt).toMatchObject({ outcome: "refused", keys: [] });
    expect(screen.writes).toEqual([]);
    const prompt = new ScreenPane(PROMPT_ROWS([...MENUS[1]![1], "Password: "]));
    const answer = await rig(prompt, { harness: NO_PROFILE }).override("2");
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "not_free", keys: [] });
    expect(prompt.writes).toEqual([]);
    expect(prompt.keys).toEqual([]);
  });

  test("an override that is not the phone's own never takes the road past the sign", async () => {
    const screen = new ScreenPane(PROMPT_ROWS(MENUS[0]![1]));
    const r = rig(screen, { harness: NO_PROFILE });
    const hash = await r.prepare();
    // Without the phone's word the override is no override: the sign refuses.
    refusedClean(await r.send("y", { rowsHash: hash, override: true }), screen, "menu_open");
  });
  test("the override past a sign writes no control byte: a Tab is a space, ESC, BEL and the paste markers are cut", async () => {
    const screen = new ScreenPane(PROMPT_ROWS(MENUS[0]![1]));
    const answer = await rig(screen, { harness: NO_PROFILE }).override("a\tb\u001b[Ac\u0007d\u001b[201~e");
    expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "override", keys: [] });
    expect(screen.writes).toEqual([{ how: "paste", text: "a b[Acde" }]);
    expect(screen.keys).toEqual([]);
  });

  test("a text of more than one line past a sign is refused multiline on every multiplexer, nothing typed", async () => {
    for (const write of ["type", "paste", "block"] as const) {
      const screen = new ScreenPane(PROMPT_ROWS(MENUS[0]![1]));
      const answer = await rig(screen, { harness: NO_PROFILE, write }).override("yes\nand more");
      expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "multiline", keys: [] });
      expect(screen.writes).toEqual([]);
      expect(screen.keys).toEqual([]);
    }
  });
});
