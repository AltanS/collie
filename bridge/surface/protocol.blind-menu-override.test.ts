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

const CLAUDE_DRAFT = "claude--draft-footer-single.txt";
const SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "gu");
/** A captured screen of a pane with a profile, with `rows` put in right over its box (the first rule row). */
function overBox(name: string, rows: readonly string[]): string {
  const raw = pane(name).replace(/\r/gu, "").split("\n");
  const top = raw.findIndex((row) => /^─{8,}/u.test(row.replace(SGR, "")));
  return [...raw.slice(0, top), ...rows, ...raw.slice(top)].join("\n");
}

/** A (y/n) question drawn over an agent's input box: the screen shows an agent's box, so the override may pass. */
const AGENT_YN = (): string => overBox(CLAUDE_DRAFT, MENUS[0]![1]);

/** The override road's end: the text written once, in one piece, and no key at all. */
function typedNoKey(answer: SendAnswer, screen: ScreenPane, text: string): void {
  expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "override", word: "override", keys: [] });
  expect(screen.writes).toEqual([{ how: "paste", text }]);
  expect(screen.keys).toEqual([]);
  expect(answer.offers).toEqual(["keys"]);
}

/** A `menu_open` no override can pass: nothing typed, no key, the sign named, and no rows hash to bind a Send anyway to. */
function refusedNoPast(answer: SendAnswer, screen: ScreenPane): void {
  expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "menu_open", keys: [] });
  expect(answer.receipt?.menuSign).toBeDefined();
  expect(answer.rowsHash).toBeUndefined();
  expect(answer.offers).toEqual(["keys"]);
  expect(screen.writes).toEqual([]);
  expect(screen.keys).toEqual([]);
}

describe("the person's override past the blind road's menu sign", () => {
  // Agent rows: an input box a profile's frame finds (`blindRoadSign` "frame") or a footer a profile names
  // ("footer"). A strong modal cue alone ("cue", a `[y/N]` line) is no agent screen here. The override goes
  // past a sign only on agent rows, and never at a row of one-key items (counsel, 2026-11-25).
  const AGENT_SIGNS: readonly (readonly [string, string])[] = [
    ["a (y/n) prompt over an agent's box", AGENT_YN()],
    ["a picker over an agent's box", overBox(CLAUDE_DRAFT, MENUS[2]![1])],
    ["a numbered menu over an agent's box", overBox(CLAUDE_DRAFT, MENUS[1]![1])],
    ["two key hints over an agent's box", overBox(CLAUDE_DRAFT, ["Ready when you are", "enter go on   esc go back"])],
  ];
  /** A plain program with no agent's rows: the numbered menu and the key hints, nothing a profile names. */
  const PLAIN_SIGNS: readonly (readonly [string, string])[] = [
    ["a numbered menu", PROMPT_ROWS(MENUS[1]![1])],
    ["two key hints", PROMPT_ROWS(MENUS[3]![1])],
    ["a (y/n) prompt, a strong cue only", PROMPT_ROWS(MENUS[0]![1])],
    ["a picker, a strong cue only", PROMPT_ROWS(MENUS[2]![1])],
  ];
  /** The live run's case 2 (2026-11-25): a `[y/N]` question a plain program reads with one key, no Enter. */
  const ONE_KEY_YN = ["Setup of the sample tool", "Go on with the setup? [y/N] "].join("\n");
  /** The live run's case 3: a numbered menu a plain program reads with one key. */
  const ONE_KEY_MENU = ["Pick one to go on:", "  1. Keep it", "  2. Delete it", "  3. Leave it", "Choose [1-3]: "].join("\n");

  test("a [y/N] question on a plain program, read by one key, refuses the override and nothing is typed", async () => {
    const screen = new ScreenPane(ONE_KEY_YN);
    const r = rig(screen, { harness: NO_PROFILE, foreground: "program" });
    refusedNoPast(await r.send("yes please", { fromPhone: true }), screen);
    refusedNoPast(await r.override("yes please"), screen);
  });

  test("a numbered menu on a plain program refuses the override", async () => {
    const screen = new ScreenPane(ONE_KEY_MENU);
    const r = rig(screen, { harness: NO_PROFILE, foreground: "program" });
    refusedNoPast(await r.send("2 things to say", { fromPhone: true }), screen);
    refusedNoPast(await r.override("2 things to say"), screen);
  });
  const SINGLE_KEY = ["Review the change:", "a approve  |  s request changes  |  c comment"];

  for (const [what, rows] of AGENT_SIGNS) {
    test(`at another kind of sign on a pane that shows agent rows the override types the text and presses no key (${what})`, async () => {
      const screen = new ScreenPane(rows);
      const answer = await rig(screen, { harness: NO_PROFILE }).override("y");
      typedNoKey(answer, screen, "y");
      expect(answer.receipt?.menuSign?.kind).not.toBe("single-key");
    });
  }

  for (const [what, rows] of PLAIN_SIGNS) {
    for (const foreground of ["program", "unknown", undefined] as const) {
      test(`at a sign on a plain program with no agent rows the override is refused and nothing is typed (${what}, foreground ${foreground ?? "not read"})`, async () => {
        const screen = new ScreenPane(rows);
        const r = rig(screen, { harness: NO_PROFILE, foreground });
        const first = await r.send("2", { fromPhone: true });
        refusedNoPast(first, screen);
        refusedNoPast(await r.override("2"), screen);
      });
    }
  }

  test("at a single-key sign the override is refused on a pane that shows agent rows", async () => {
    for (const rows of [overBox(CLAUDE_DRAFT, SINGLE_KEY), PROMPT_ROWS(SINGLE_KEY)]) {
      const screen = new ScreenPane(rows);
      const r = rig(screen, { harness: NO_PROFILE });
      const first = await r.send("a", { fromPhone: true });
      refusedNoPast(first, screen);
      expect(first.menuSign?.kind).toBe("single-key");
      refusedNoPast(await r.override("a"), screen);
    }
  });

  test("a refusal the override cannot pass does not offer Send anyway: no rows hash, the key pad only", async () => {
    const screen = new ScreenPane(PROMPT_ROWS(MENUS[1]![1]));
    const answer = await rig(screen, { harness: NO_PROFILE }).send("2", { fromPhone: true });
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "menu_open", keys: [] });
    expect(answer.rowsHash).toBeUndefined();
    expect(answer.offers).toEqual(["keys"]);
    expect(answer.menuSign).toBeDefined();
    // A refusal the override can pass keeps its hash: the card binds Send anyway to it.
    const passable = await rig(new ScreenPane(AGENT_YN()), { harness: NO_PROFILE }).send("y", { fromPhone: true });
    expect(passable.rowsHash).toMatch(/^[0-9a-f]+$/u);
  });

  test("the first send at a menu sign is refused as before", async () => {
    for (const [, rows] of AGENT_SIGNS) {
      const screen = new ScreenPane(rows);
      const answer = await rig(screen, { harness: NO_PROFILE }).send("y", { fromPhone: true });
      refusedClean(answer, screen, "menu_open");
      expect(answer.offers).toEqual(["keys"]);
      expect(answer.menuSign).toBeDefined();
    }
    // Collie's own send (no person) too, with no word from anyone.
    const screen = new ScreenPane(AGENT_YN());
    refusedClean(await rig(screen, { harness: NO_PROFILE, foreground: "program" }).send("y"), screen, "menu_open");
  });

  test("the card's second tap, bound to the refusal's own rows hash, goes in with no key: the loop ends", async () => {
    const screen = new ScreenPane(AGENT_YN());
    const r = rig(screen, { harness: NO_PROFILE });
    const first = await r.send("y", { fromPhone: true });
    refusedClean(first, screen, "menu_open");
    typedNoKey(await r.send("y", { rowsHash: first.rowsHash!, override: true, fromPhone: true }), screen, "y");
  });

  test("the overridden send's receipt keeps the sign", async () => {
    const screen = new ScreenPane(overBox(CLAUDE_DRAFT, ["Go on with the setup? [Y/n]"]));
    const r = rig(screen, { harness: NO_PROFILE, foreground: "program" });
    const answer = await r.override("y");
    expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "override", menuSign: { kind: "yes-no" } });
    const sign = answer.receipt?.menuSign;
    expect(Object.keys(sign ?? {}).toSorted()).toEqual(["kind", "row"]);
    expect(r.protocol.recent("%1", 1)[0]?.menuSign).toEqual(sign);
    expect(r.store.list().at(-1)?.receipt?.menuSign).toEqual(sign);
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
    const screen = new ScreenPane(AGENT_YN());
    const r = rig(screen, { harness: NO_PROFILE });
    const seen = await r.prepare();
    screen.screen = overBox(CLAUDE_DRAFT, ["Replace the other file? (y/n)"]);
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
    const screen = new ScreenPane(AGENT_YN());
    const r = rig(screen, { harness: NO_PROFILE });
    const hash = await r.prepare();
    // Without the phone's word the override is no override: the sign refuses.
    refusedClean(await r.send("y", { rowsHash: hash, override: true }), screen, "menu_open");
  });
  test("the override past a sign writes no control byte: a Tab is a space, ESC, BEL and the paste markers are cut", async () => {
    const screen = new ScreenPane(AGENT_YN());
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
