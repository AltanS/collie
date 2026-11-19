// The override reaches every screen, and cannot answer a question by accident (M102 spec 12). A pane
// that serves one captured screen and records every write and key: the person's override ("Type it
// anyway") is a phone send with `override` and the rows hash of a `prepare`.
//
//  1. The gate table: every refusal a person's send could meet, before and after.
//  2. The harm cases: an unread permission dialog of every harness in the corpus, a `(y/n)` prompt, a
//     numbered menu and a picker, on the manual road and on the newly reached one. Nothing is typed,
//     no key is pressed, and the refusal is `menu_open` with the rows now and their hash.
//  3. A moved screen: refused with the rows now; a spinner, a clock or a turn streaming above the box
//     is no move; the next tap binds to the new hash.
//  4. At most once, never held, and the long hold's mark.
//  5. Every send Collie makes alone is the same with or without the word.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { type Profile } from "../../web/src/lib/surface/profile.ts";
import { HELD_LONG_MS, type SendAnswer } from "../../web/src/lib/surface/send.ts";
import { looseRow, type SendRequest } from "./protocol.ts";
import { HoldStore } from "./holds.ts";
import { maskedAnswer } from "../server.ts";
import { pane, NO_PROFILE, FRAMELESS, Write, ScreenPane, dir, RigOptions, rig, refusedClean, useScratchDir } from "./protocol.override-reach.rig.ts";

/** A profile whose harness takes nothing in a turn: Enter steers it and no key queues. */
function noQueue(profile: Profile): Profile {
  const { commandWhileRunning, queueKey, queueKeyByPlatform, ...keys } = profile.keys;
  void commandWhileRunning;
  void queueKey;
  void queueKeyByPlatform;
  return { ...profile, keys: { ...keys, enterWhileRunning: "steers" } };
}

useScratchDir();

/** The override road's end: the text written once, in one piece, and no key at all. */
function typedNoKey(answer: SendAnswer, screen: ScreenPane, text: string, how: Write["how"] = "paste"): void {
  expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "override", word: "override", keys: [] });
  expect(screen.writes).toEqual([{ how, text }]);
  expect(screen.keys).toEqual([]);
  expect(answer.offers).toEqual(["keys"]);
}

const CLAUDE_DRAFT = "claude--draft-footer-single.txt";
const CLAUDE_RUNNING = "claude--v2301-working-quiet--w100.txt";
const CLAUDE_RUNNING_DRAFT = "claude--v2301-working-draft--w100.txt";
const CLAUDE_IDLE = "claude--v2301-lab-agents-panel-empty.txt";
const CLAUDE_ASK = "claude-lab--permission-bash--w82.txt";
const PROMPT_ROWS = (rows: readonly string[]): string => ["$ ./deploy.sh", "", ...rows].join("\n");
/** A colour run (ESC [ ... m) in a captured row. */
const SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "gu");
/** A captured screen with `rows` put in right over its box (the first rule row). */
function overBox(name: string, rows: readonly string[]): string {
  const raw = pane(name).replace(/\r/gu, "").split("\n");
  const top = raw.findIndex((row) => /^─{8,}/u.test(row.replace(SGR, "")));
  return [...raw.slice(0, top), ...rows, ...raw.slice(top)].join("\n");
}

describe("1. the gate table: every refusal a person's send could meet, before and after (M102 spec 12)", () => {
  // Each row names the reading, the end the base (85caf9742) gave the override, and the end now.

  test("a draft in an idle box: before the probe road (here refused, the fake echoes nothing); now typed after it, no probe, no key", async () => {
    const screen = new ScreenPane(pane(CLAUDE_DRAFT));
    const { send, override } = rig(screen);
    const plain = await send("and also this");
    expect(plain.receipt?.outcome).toBe("refused");
    screen.writes = [];
    screen.keys = [];
    const typed = await override("and also this");
    typedNoKey(typed, screen, "and also this");
    // The receipt says a draft was in the box: the person's text went after it.
    expect(typed.receipt?.draftSeen).toBe(true);
  });

  test("a turn's running signs on a screen S0 cannot read, on a harness that takes nothing in a turn: before refused turn_running; now typed, no key", async () => {
    const screen = new ScreenPane(PROMPT_ROWS(["✻ Working… (12s · esc to interrupt)", "", "> "]));
    const { send, override } = rig(screen, { harness: FRAMELESS, edit: noQueue });
    expect((await send("hello", { rowsHash: "x", fromPhone: true })).receipt?.reason).not.toBe("override");
    screen.writes = [];
    screen.keys = [];
    const typed = await override("then the docs");
    typedNoKey(typed, screen, "then the docs");
    expect(typed.receipt?.draftSeen).toBeUndefined();
  });

  test("a running turn on a harness that takes nothing in a turn: before refused turn_running (never held); now typed, no key", async () => {
    const screen = new ScreenPane(pane(CLAUDE_RUNNING));
    const { send, override } = rig(screen, { edit: noQueue });
    expect((await send("next, the docs")).receipt).toMatchObject({ outcome: "refused", reason: "turn_running" });
    typedNoKey(await override("next, the docs"), screen, "next, the docs");
  });

  test("a draft in a running turn: before refused draft_present; now typed, no key", async () => {
    const screen = new ScreenPane(pane(CLAUDE_RUNNING_DRAFT));
    const { send, override } = rig(screen);
    expect((await send("more")).receipt).toMatchObject({ outcome: "refused", reason: "draft_present" });
    typedNoKey(await override("more"), screen, "more");
  });

  test("a pane with no profile whose rows look like an agent's (issue 793): before refused not_free; now typed, no key", async () => {
    const screen = new ScreenPane(pane(CLAUDE_IDLE));
    const { send, override } = rig(screen, { harness: NO_PROFILE });
    const plain = await send("hello", { fromPhone: true });
    expect(plain.receipt).toMatchObject({ outcome: "refused", reason: "not_free" });
    expect(plain.rowsHash).toBeDefined();
    typedNoKey(await override("hello"), screen, "hello");
  });

  test("a running turn the harness queues into: before and now the plain queued send, Enter included, no word", async () => {
    const screen = new ScreenPane(pane(CLAUDE_RUNNING));
    const answer = await rig(screen).override("then the title");
    expect(answer.receipt?.word).toBeUndefined();
    expect(answer.receipt?.reason).not.toBe("override");
    expect(screen.writes.length).toBeGreaterThan(0);
  });

  test("a question the reader read (hard stop 6a): before and now refused not_free, nothing typed", async () => {
    const screen = new ScreenPane(pane(CLAUDE_ASK));
    const answer = await rig(screen).override("yes");
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "not_free", keys: [] });
    expect(screen.writes).toEqual([]);
    expect(screen.keys).toEqual([]);
  });

  test("a password prompt on a pane with no profile: before and now refused not_free, nothing typed", async () => {
    const screen = new ScreenPane(PROMPT_ROWS(["[sudo] password for operator:"]));
    const answer = await rig(screen, { harness: NO_PROFILE }).override("hunter2");
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "not_free", keys: [] });
    expect(screen.writes).toEqual([]);
  });

  test("two lines on the newly reached road where the multiplexer cannot paste them whole: refused multiline, nothing typed", async () => {
    const screen = new ScreenPane(pane(CLAUDE_DRAFT));
    const answer = await rig(screen, { write: "paste" }).override("one\ntwo");
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "multiline", keys: [] });
    expect(screen.writes).toEqual([]);
  });

  test("two lines where the multiplexer pastes the whole text (Herdr): one paste, line break inside, no key", async () => {
    const screen = new ScreenPane(pane(CLAUDE_DRAFT));
    typedNoKey(await rig(screen, { write: "block" }).override("one\ntwo"), screen, "one\ntwo", "block");
  });

  test("a multiplexer with typed keys only (zellij, herdr-core, tuios): the text typed in one write, no key", async () => {
    const screen = new ScreenPane(pane(CLAUDE_DRAFT));
    typedNoKey(await rig(screen, { write: "type" }).override("in one go"), screen, "in one go", "type");
  });

  test("a text that would stand alone as a notice's key is refused as before, nothing typed", async () => {
    const screen = new ScreenPane(overBox(CLAUDE_DRAFT, ["✦ Heads up · With GitHub triggers, anyone who files an issue can put text in front of a session", "  1: Learn more   2: Knew this already   0: Dismiss", ""]));
    const { override } = rig(screen);
    const answer = await override("1");
    expect(answer.receipt?.outcome).toBe("refused");
    expect(screen.writes).toEqual([]);
    expect(screen.keys).toEqual([]);
  });
});

describe("2. the harm cases: an override never answers a question (M102 spec 12)", () => {
  const MENUS: readonly (readonly [string, readonly string[]])[] = [
    ["a (y/n) prompt", ["Overwrite config.toml? (y/n)"]],
    ["a numbered menu", ["Do you want to make this edit?", "  1. Yes", "  2. Yes, allow all edits this session", "  3. No"]],
    ["a picker", ["Select a model", "❯ fast      quick answers", "  smart     slower, better", "  huge      slowest", "(1/3)"]],
  ];

  for (const [what, rows] of MENUS) {
    test(`${what} on the manual road (unread screen): refused menu_open, nothing typed, no key`, async () => {
      const screen = new ScreenPane(PROMPT_ROWS(rows));
      refusedClean(await rig(screen, { harness: FRAMELESS }).override("1"), screen, "menu_open");
    });

    test(`${what} on the newly reached road (no profile): refused menu_open, nothing typed, no key`, async () => {
      const screen = new ScreenPane(PROMPT_ROWS(rows));
      refusedClean(await rig(screen, { harness: NO_PROFILE }).override("y"), screen, "menu_open");
    });

    test(`${what} over a draft the reader read (the newly reached road): refused menu_open, nothing typed, no key`, async () => {
      const screen = new ScreenPane(overBox(CLAUDE_DRAFT, rows));
      refusedClean(await rig(screen).override("2"), screen, "menu_open");
    });
  }

  test("Collie's own send on the blind road (no profile, no person) meets a menu: refused menu_open, nothing typed, no key", async () => {
    for (const [, rows] of MENUS) {
      const screen = new ScreenPane(PROMPT_ROWS(rows));
      const answer = await rig(screen, { harness: NO_PROFILE }).send("yes please");
      expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "menu_open", keys: [] });
      expect(screen.writes).toEqual([]);
      expect(screen.keys).toEqual([]);
    }
  });

  test("the menu sign answers with the rows its hash covers, and the next tap on them still refuses", async () => {
    const screen = new ScreenPane(PROMPT_ROWS(MENUS[0]![1]));
    const r = rig(screen, { harness: FRAMELESS });
    const first = await r.override("y");
    expect(first.rows).toContain("Overwrite config.toml? (y/n)");
    const again = await r.send("y", { rowsHash: first.rowsHash!, override: true, fromPhone: true });
    refusedClean(again, screen, "menu_open");
  });
});

describe("3. a moved screen, without a loop (M102 spec 12, decision 5)", () => {
  test("the box's rows changed: refused stale_surface with the rows now; a tap with the new hash is typed", async () => {
    const screen = new ScreenPane(pane(CLAUDE_DRAFT));
    const r = rig(screen);
    const seen = await r.prepare();
    screen.screen = screen.screen.replace("❯", "❯ x");
    const moved = await r.send("then this", { rowsHash: seen, override: true, fromPhone: true });
    refusedClean(moved, screen, "stale_surface");
    typedNoKey(await r.send("then this", { rowsHash: moved.rowsHash!, override: true, fromPhone: true }), screen, "then this");
  });

  test("a clock and a token count ticked on a screen with no frame: no move", async () => {
    const screen = new ScreenPane(PROMPT_ROWS(["✻ Working… (12s · ↑ 340 tokens) 12:01", "────────────────", "> ", "────────────────"]));
    const r = rig(screen, { harness: NO_PROFILE });
    const seen = await r.prepare();
    screen.screen = screen.screen.replace("✻ Working… (12s · ↑ 340 tokens) 12:01", "✶ Working… (13s · ↑ 351 tokens) 12:02");
    expect(await r.prepare()).not.toBe(seen);
    const answer = await r.send("status", { rowsHash: seen, override: true, fromPhone: true });
    expect(answer.receipt?.reason).not.toBe("stale_surface");
  });

  test("the transcript above a found box moved (a turn streaming): no move", async () => {
    const screen = new ScreenPane(pane(CLAUDE_RUNNING_DRAFT));
    const r = rig(screen);
    const seen = await r.prepare();
    screen.screen = `a new line streamed in\n${screen.screen}`;
    typedNoKey(await r.send("more", { rowsHash: seen, override: true, fromPhone: true }), screen, "more");
  });

  test("a spinner turned on a screen with no frame: no move", async () => {
    const screen = new ScreenPane(PROMPT_ROWS(["⠋ building the index", "────────────────", "> ", "────────────────"]));
    const r = rig(screen, { harness: NO_PROFILE });
    const seen = await r.prepare();
    screen.screen = screen.screen.replace("⠋", "⠙");
    const answer = await r.send("status", { rowsHash: seen, override: true, fromPhone: true });
    expect(answer.receipt?.reason).not.toBe("stale_surface");
  });

  test("the loose form masks digits and spinner glyphs only", () => {
    expect(looseRow("✻ Working… (12s · ↑ 340 tokens) 12:01")).toBe(looseRow("✶ Working… (13s · ↑ 341 tokens) 12:02"));
    expect(looseRow("❯ 1. Yes")).not.toBe(looseRow("  1. Yes"));
    expect(looseRow("Allow")).not.toBe(looseRow("Deny"));
  });

  test("a bridge that masks secret shapes masks the rows of a refusal; the hash stays the plain rows' hash", async () => {
    const key = `sk-or-v1-your-key-here-${"0".repeat(40)}`;
    const screen = new ScreenPane(PROMPT_ROWS([`export KEY=${key}`, "Overwrite config.toml? (y/n)"]));
    const answer = await rig(screen, { harness: FRAMELESS }).override("y");
    expect(answer.rows?.join("\n")).toContain(key);
    const shown = maskedAnswer(answer);
    expect(shown.rows?.join("\n")).not.toContain(key);
    expect(shown.rows?.length).toBe(answer.rows?.length);
    expect(shown.rowsHash).toBe(answer.rowsHash);
  });

  test("a hash this bridge never handed out (a restart) is compared exactly: refused once, then typed", async () => {
    const screen = new ScreenPane(pane(CLAUDE_DRAFT));
    const r = rig(screen);
    const stale = await r.send("x", { rowsHash: "abcdef12", override: true, fromPhone: true });
    expect(stale.receipt?.reason).toBe("stale_surface");
    typedNoKey(await r.send("x", { rowsHash: stale.rowsHash!, override: true, fromPhone: true }), screen, "x");
  });
});

describe("4. at most once, never held, and the long hold (M102 spec 12, decisions 6 and 7)", () => {
  test("a retry of an override with the same id writes nothing again and answers the stored receipt", async () => {
    const screen = new ScreenPane(pane(CLAUDE_DRAFT));
    const r = rig(screen);
    const request = { id: "override-once-0001", rowsHash: await r.prepare(), override: true, fromPhone: true } as const;
    const once = await r.send("only once", request);
    const twice = await r.send("only once", request);
    expect(once.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "override" });
    expect(twice.replayed).toBe(true);
    expect(twice.receipt).toEqual(once.receipt!);
    expect(twice.offers).toEqual(["keys"]);
    expect(screen.writes).toEqual([{ how: "paste", text: "only once" }]);
    expect(screen.keys).toEqual([]);
  });

  test("an override on a pane with held sends does not join their queue: it goes now, and they stay held", async () => {
    const holds = new HoldStore(join(dir, "held"));
    const screen = new ScreenPane(pane(CLAUDE_RUNNING));
    const r = rig(screen, { edit: noQueue, holds });
    const held = await r.send("later, please");
    expect(held.receipt?.outcome).toBe("held");
    typedNoKey(await r.override("now, please"), screen, "now, please");
    expect(holds.list().map((entry) => entry.id)).toEqual([held.receipt!.requestId]);
  });

  test("a held row says heldLong two minutes after it was held, and not before", async () => {
    const holds = new HoldStore(join(dir, "held"), () => r.clock.now);
    const screen = new ScreenPane(pane(CLAUDE_RUNNING));
    const r = rig(screen, { edit: noQueue, holds });
    await r.send("later, please");
    r.clock.now += HELD_LONG_MS - 1;
    expect(r.protocol.heldOf("main", "%1")[0]?.heldLong).toBeUndefined();
    r.clock.now += 1;
    expect(r.protocol.heldOf("main", "%1")[0]?.heldLong).toBe(true);
    // The hold poll marks the entry itself, so the mark survives a restart.
    expect(holds.list()[0]?.heldLong).toBeUndefined();
    await Promise.all(r.protocol.tickHolds("main", () => ({ revision: 1, turn: "running", modal: "none", composer: "empty" })));
    expect(holds.list()[0]?.heldLong).toBe(true);
  });
});

describe("5. a send Collie makes alone is the same with or without the word (M102 spec 12, decision 1)", () => {
  /** The receipt without its own id and timing, and what reached the pane. */
  const outcomeOf = (answer: SendAnswer, screen: ScreenPane) => {
    // The text hash is salted per request (its id); the length beside it stays.
    const { requestId, gapsMs, textHash, ...rest } = answer.receipt!;
    void requestId;
    void gapsMs;
    void textHash;
    return { receipt: rest, writes: screen.writes, keys: screen.keys, offers: answer.offers, rowsHash: answer.rowsHash !== undefined, rows: answer.rows };
  };

  const SCREENS: readonly (readonly [string, string, RigOptions])[] = [
    ["a draft", pane(CLAUDE_DRAFT), {}],
    ["a running turn that does not queue", pane(CLAUDE_RUNNING), { edit: noQueue }],
    ["a running turn that queues", pane(CLAUDE_RUNNING), {}],
    ["a question", pane(CLAUDE_ASK), {}],
    ["an unread screen", PROMPT_ROWS(["Overwrite config.toml? (y/n)"]), { harness: FRAMELESS }],
    ["an agent's rows on a pane with no profile", pane(CLAUDE_IDLE), { harness: NO_PROFILE }],
    ["a bare shell", PROMPT_ROWS(["$ "]), { harness: NO_PROFILE }],
  ];

  const CALLERS: readonly (readonly [string, Partial<SendRequest>])[] = [
    ["a hook or the CLI (not the phone)", { override: true }],
    ["a WalkyTalky message (draftHolds, never from the phone)", { override: true, draftHolds: true }],
    ["a WalkyTalky message with its tag", { override: true, walky: "wt_0001" }],
    ["a steer", { override: true, fromPhone: true, when: "steer" }],
  ];

  for (const [what, raw, options] of SCREENS) {
    for (const [caller, word] of CALLERS) {
      test(`${what}, ${caller}: the word changes nothing`, async () => {
        const plainScreen = new ScreenPane(raw);
        const plain = rig(plainScreen, options);
        // The same request with the word taken out.
        const { override: dropped, ...rest } = word;
        void dropped;
        const base: Partial<SendRequest> = { ...rest, rowsHash: await plain.prepare() };
        const without = await plain.send("hello there", base);
        const wordScreen = new ScreenPane(raw);
        const withWord = rig(wordScreen, options);
        const answer = await withWord.send("hello there", { ...base, rowsHash: await withWord.prepare(), ...word });
        expect(outcomeOf(answer, wordScreen)).toEqual(outcomeOf(without, plainScreen));
      });
    }
  }
});

describe("6. the blind road reads the menu sign by what stands in the foreground (M102 spec 12)", () => {
  /** A shell screen: a numbered list printed by an earlier command, and the prompt under it. */
  const OLD_LIST = ["$ cat -n todo.txt", "     1  fix the login redirect", "     2  write the release notes", "     3  ask about the logo", "$ "].join("\n");
  /** A program that asks, its `[Y/n]` live on the last row. */
  const LIVE_YN = ["$ sudo apt upgrade", "4 upgraded, 0 newly installed, 0 to remove.", "Do you want to continue? [Y/n] "].join("\n");

  for (const who of ["Collie's own send", "the person's send"] as const) {
    const go = (r: ReturnType<typeof rig>, text: string): Promise<SendAnswer> => (who === "the person's send" ? r.send(text, { fromPhone: true }) : r.send(text));

    test(`${who}, shell foreground, a numbered list above the prompt: the text and Enter go in`, async () => {
      const screen = new ScreenPane(OLD_LIST);
      const answer = await go(rig(screen, { harness: NO_PROFILE, foreground: "shell" }), "ls");
      expect(answer.receipt?.reason).not.toBe("menu_open");
      expect(screen.writes.map((w) => w.text)).toEqual(["ls"]);
      expect(screen.keys).toEqual(["Enter"]);
    });

    test(`${who}, shell foreground, a live [Y/n] on the last row reads no menu sign; the profiles' own cue still holds it (not_free)`, async () => {
      const screen = new ScreenPane(LIVE_YN);
      const answer = await go(rig(screen, { harness: NO_PROFILE, foreground: "shell" }), "ls");
      expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "not_free", keys: [] });
      expect(answer.receipt?.menuSign).toBeUndefined();
    });

    test(`${who}, program foreground, a live [Y/n] on the last row: refused menu_open, nothing typed, the sign on the receipt`, async () => {
      const screen = new ScreenPane(LIVE_YN);
      const answer = await go(rig(screen, { harness: NO_PROFILE, foreground: "program" }), "y");
      expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "menu_open", keys: [], menuSign: { kind: "yes-no", row: 2 } });
      expect(answer.menuSign).toEqual({ kind: "yes-no", row: 2 });
      expect(screen.writes).toEqual([]);
      expect(screen.keys).toEqual([]);
    });

    for (const foreground of ["program", "unknown", undefined] as const) {
      test(`${who}, foreground ${foreground ?? "not read"}, old numbered output above a prompt: the anchored sign reads no menu, the send goes`, async () => {
        const screen = new ScreenPane(OLD_LIST);
        const answer = await go(rig(screen, { harness: NO_PROFILE, foreground }), "ls");
        expect(answer.receipt?.reason).not.toBe("menu_open");
        expect(screen.keys).toEqual(["Enter"]);
      });
    }
  }

  test("the sign on the receipt names its kind and row, never the row's text, and the receipt list carries it", async () => {
    const screen = new ScreenPane(LIVE_YN);
    const r = rig(screen, { harness: NO_PROFILE, foreground: "unknown" });
    const answer = await r.send("y");
    expect(answer.receipt?.menuSign).toEqual({ kind: "yes-no", row: 2 });
    expect(JSON.stringify(answer.receipt?.menuSign)).not.toContain("continue");
    expect(r.protocol.recent("%1", 1)[0]?.menuSign).toEqual({ kind: "yes-no", row: 2 });
    const stored = r.store.list().at(-1)?.receipt;
    expect(stored?.menuSign).toEqual({ kind: "yes-no", row: 2 });
  });

  test("a foreground read that throws reads as unknown: the anchored sign still refuses a live [Y/n]", async () => {
    const screen = new ScreenPane(LIVE_YN);
    const answer = await rig(screen, { harness: NO_PROFILE, foregroundThrows: true }).send("y");
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "menu_open" });
  });
});
