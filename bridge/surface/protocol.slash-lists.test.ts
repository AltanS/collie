// The Send Protocol against the scripted fake multiplexer: part slash-lists. The rig is `protocol.rig.ts`;
// the other parts sit beside this file as `protocol.<topic>.test.ts`.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadProfiles } from "../../web/src/lib/surface/profile.ts";
import { type SendAnswer } from "../../web/src/lib/surface/send.ts";
import { parseAnsi } from "../../web/src/lib/ansi.ts";
import { splitLines } from "../../web/src/lib/blocks.ts";
import { findInputFrame } from "../../web/src/lib/surface/frame.ts";
import { boxMatches, commandBoxMatches } from "./protocol.ts";
import { FakePane, type Rig, neverEscape, rig, useScratchDir } from "./protocol.rig.ts";

useScratchDir();

describe("a slash command over Claude Code's command list under the box (field case, 2.1.302, 2026-10-17)", () => {
  const V2302 = "claude--v2302-slash-model-list--w119.txt";
  const V2291 = "claude-lab--popup-slash-model-exact--w82.txt";
  const RUNNING = "✶ Noodling… (7s · ↓ 592 tokens)";
  // eslint-disable-next-line no-control-regex
  const plain = (row: string): string => row.replace(/\u001b\[[0-9;]*m/gu, "");

  /**
   * A capture of the list split at the box's bottom edge: the screen with the fake box drawn into its
   * box row, and under it the list only while the box holds a slash command (else a hint row, as
   * before the write and after the Enter). `list` rewrites the list rows, read as plain text; `over`
   * puts a row above the box (a running turn's spinner).
   */
  const listScreen = (pane: FakePane, name: string, options: { list?: (rows: string[]) => string[]; over?: string } = {}): void => {
    const rows = readFileSync(join(import.meta.dir, `../../web/src/fixtures/panes/${name}`), "utf8").split("\r\n");
    const boxRow = rows.findIndex((row, i) => i > 0 && row.startsWith("❯ ") && rows[i - 1]!.includes("─".repeat(20)));
    expect(boxRow).toBeGreaterThan(0);
    const head = rows.slice(0, boxRow + 2);
    const under = options.list === undefined ? rows.slice(boxRow + 2) : options.list(rows.slice(boxRow + 2).map(plain));
    if (options.over !== undefined) head.splice(boxRow - 2, 1, options.over);
    pane.beforeRead = (p) => {
      const top = [...head];
      top[boxRow] = `❯ ${p.box}`;
      p.fixed = [...top, ...(p.box.startsWith("/") ? under : ["  ? for shortcuts"])].join("\r\n");
    };
  };

  /** The list with the pointer moved to `command`, on the first entry's row, and that entry shown without it. */
  const pointAt =
    (command: string) =>
    (rows: string[]): string[] => {
      const at = rows.findIndex((row) => row.includes("❯ /"));
      const col = rows[at]!.search(/ {2,}\S/u);
      const desc = rows[at]!.slice(col).trimStart();
      const pointer = `  ❯ ${command}`;
      return rows.map((row, i) => (i === at ? `${pointer}${" ".repeat(Math.max(2, col + 2 - pointer.length))}${desc}` : row));
    };

  /** Every write and key in order, so a test can say what followed the text. */
  const journal = (pane: FakePane): string[] => {
    const seen: string[] = [];
    pane.afterInput = (_p, what) => seen.push(what);
    return seen;
  };

  for (const [name, version] of [
    [V2302, "2.1.302"],
    [V2291, "2.1.291"],
  ] as const) {
    test(`${name}: /model as a command is sent, the list pointing at /model is its own typeahead; only Enter follows the text`, async () => {
      const { pane, send } = rig({ version });
      listScreen(pane, name);
      const seen = journal(pane);
      const answer = await send("/model", { mode: "command" });
      expect(answer.receipt).toMatchObject({ outcome: "sent" });
      expect(answer.receipt?.keys.at(-1)).toBe("Enter");
      expect(seen.slice(seen.findIndex((what) => what.endsWith(":/model")))).toEqual([expect.stringMatching(/:\/model$/u), "keys:Enter"]);
      expect(pane.transcript.at(-1)).toBe("> /model");
      neverEscape(pane);
    });

    for (const other of ["/models", "/memory"]) {
      test(`${name}: /model typed while the list points at ${other} is left typed, no Enter, and the detail says the list points elsewhere`, async () => {
        const { pane, send, deps } = rig({ version });
        listScreen(pane, name, { list: pointAt(other) });
        const id = `list-elsewhere-${other.slice(1)}`;
        const answer = await send("/model", { id, mode: "command" });
        expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "modal_cue" });
        expect(pane.keysSeen).not.toContain("Enter");
        expect(pane.box).toBe("/model");
        expect(deps.store.get(id)?.receipt?.detail).toBe("The command list at the box pointed at another command, so Enter was not pressed.");
        neverEscape(pane);
      });
    }
  }

  /**
   * The captured tall-pane screen (lane 8788, 2026-10-17): the list stands over the box, the statusline
   * under it. The fake box is drawn into the box row; the list rows show only while the box holds a
   * slash command, blank before the write and after the Enter. `list` rewrites them; `over` puts a row
   * in the blank band above them (a running turn's spinner).
   */
  const ABOVE = "claude--v2302-slash-model-list-above--w119.txt";
  const aboveScreen = (pane: FakePane, options: { list?: (rows: string[]) => string[]; over?: string } = {}): void => {
    const rows = readFileSync(join(import.meta.dir, `../../web/src/fixtures/panes/${ABOVE}`), "utf8").split("\r\n");
    const boxRow = rows.findIndex((row, i) => i > 0 && row.startsWith("\u276f\u00a0") && rows[i - 1]!.includes("\u2500".repeat(20)));
    expect(boxRow).toBeGreaterThan(0);
    let first = boxRow - 1;
    while (rows[first - 1]!.trim() !== "") first--;
    const list = options.list === undefined ? rows.slice(first, boxRow - 1) : options.list(rows.slice(first, boxRow - 1));
    expect(list.length).toBe(4);
    if (options.over !== undefined) rows[first - 2] = options.over;
    pane.beforeRead = (p) => {
      const shown = [...rows];
      shown[boxRow] = `\u276f\u00a0${p.box}`;
      shown.splice(first, list.length, ...(p.box.startsWith("/") ? list : list.map(() => "")));
      p.fixed = shown.join("\r\n");
    };
  };

  test(`${ABOVE}: /model as a command is sent with the list over the box; only Enter follows the text`, async () => {
    const { pane, send } = rig({ version: "2.1.302" });
    aboveScreen(pane);
    const seen = journal(pane);
    const answer = await send("/model", { mode: "command" });
    expect(answer.receipt).toMatchObject({ outcome: "sent" });
    expect(seen.slice(seen.findIndex((what) => what.endsWith(":/model")))).toEqual([expect.stringMatching(/:\/model$/u), "keys:Enter"]);
    expect(pane.transcript.at(-1)).toBe("> /model");
    neverEscape(pane);
  });

  for (const other of ["/models", "/memory"]) {
    test(`${ABOVE}: /model typed while the list over the box points at ${other} is left typed, no Enter, with the list notice`, async () => {
      const { pane, send, deps } = rig({ version: "2.1.302" });
      aboveScreen(pane, { list: pointAt(other) });
      const id = `above-elsewhere-${other.slice(1)}`;
      const answer = await send("/model", { id, mode: "command" });
      expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "modal_cue" });
      expect(pane.keysSeen).not.toContain("Enter");
      expect(pane.box).toBe("/model");
      expect(deps.store.get(id)?.receipt?.detail).toBe("The command list at the box pointed at another command, so Enter was not pressed.");
    });
  }

  test(`${ABOVE}: read as a screen with /model in the box, no dialog; Submit then goes out`, async () => {
    const looked = rig({ version: "2.1.302" });
    aboveScreen(looked.pane);
    looked.pane.box = "/model";
    const prepared = await looked.protocol.handle({ id: "above-prep-1", text: "", mode: "prepare" }, { session: "main", paneId: "%1", harness: "claude" });
    expect(prepared.surface).toMatchObject({ turn: "idle", modal: "none", composer: "draft" });
    const { pane, send } = rig({ version: "2.1.302" });
    aboveScreen(pane);
    pane.box = "/model";
    expect((await send("/model", { mode: "submit" })).receipt).toMatchObject({ outcome: "sent", keys: ["Enter"] });
  });

  test(`${ABOVE}: /model as a command into a running turn, the list over the box: queued with Enter`, async () => {
    const { pane, send } = rig({ version: "2.1.302" });
    aboveScreen(pane, { over: RUNNING });
    const answer = await send("/model", { mode: "command" });
    expect(answer.receipt).toMatchObject({ outcome: "sent" });
    expect(answer.receipt?.keys.at(-1)).toBe("Enter");
  });

  /**
   * The harness lab's tmux pane (120 x 40, Claude Code 2.1.302, captured 2026-10-17): the list under the
   * box pushes the whole screen up. Before the write the screen is unscrolled: `scroll` rows of earlier
   * output, then the capture's rows down to the bottom rule with the fake box drawn in, then the two
   * status rows. Once the box holds a slash command the read is the capture itself, the screen moved up
   * by `scroll` rows. `list` rewrites the list rows.
   */
  const LAB_STATUS = ["  \u23f8 manual mode on \u00b7 ? for shortcuts \u00b7 \u2190 for agents", "                  tmux focus-events off \u00b7 add 'set -g focus-events on' to ~/.tmux.conf and reattach for focus tracking"];
  /** `full`: the screen before the write has rows down to its last row, so the list scrolls it by all of its region. */
  const scrolledScreen = (pane: FakePane, name: string, options: { scroll?: number; full?: boolean; list?: (rows: string[]) => string[] } = {}): number => {
    const rows = readFileSync(join(import.meta.dir, `../../web/src/fixtures/panes/${name}`), "utf8").split("\r\n");
    expect(rows).toHaveLength(40);
    const boxRow = rows.findIndex((row, i) => i > 0 && row.startsWith("\u276f\u00a0") && rows[i - 1]!.includes("\u2500".repeat(20)));
    expect(boxRow).toBeGreaterThan(0);
    let end = boxRow + 2;
    while (end < rows.length && rows[end]!.trim() !== "") end++;
    const listRows = end - boxRow - 2;
    const scroll = options.full === true ? rows.length - (boxRow + 2 + LAB_STATUS.length) : (options.scroll ?? listRows - 1);
    const after = options.list === undefined ? rows : [...rows.slice(0, boxRow + 2), ...options.list(rows.slice(boxRow + 2, end)), ...rows.slice(end)];
    const earlier = Array.from({ length: scroll }, (_, i) => `  earlier output, row ${String(i + 1)}`);
    pane.beforeRead = (p) => {
      if (p.box.startsWith("/")) {
        const shown = [...after];
        shown[boxRow] = `\u276f\u00a0${p.box}`;
        p.fixed = shown.join("\r\n");
        return;
      }
      const before = [...earlier, ...rows.slice(0, boxRow), `\u276f\u00a0${p.box}`, rows[boxRow + 1]!, ...LAB_STATUS];
      p.fixed = [...before, ...Array.from({ length: Math.max(0, 40 - before.length) }, () => "")].slice(0, 40).join("\r\n");
    };
    return listRows;
  };
  const LAB_MODEL = "claude--v2302-slash-model-list--w120--h40.txt";
  const LAB_EFFORT = "claude--v2302-slash-effort-list--w120--h40.txt";

  for (const [name, command] of [
    [LAB_MODEL, "/model"],
    [LAB_EFFORT, "/effort"],
  ] as const) {
    test(`${name}: ${command} as a command is sent though its list under the box scrolls the short pane up`, async () => {
      const { pane, send } = rig({ version: "2.1.302" });
      scrolledScreen(pane, name);
      const seen = journal(pane);
      const answer = await send(command, { mode: "command" });
      expect(answer.receipt).toMatchObject({ outcome: "sent" });
      expect(seen.slice(seen.findIndex((what) => what.endsWith(`:${command}`)))).toEqual([expect.stringMatching(new RegExp(`:${command}$`, "u")), "keys:Enter"]);
      expect(pane.transcript.at(-1)).toBe(`> ${command}`);
      neverEscape(pane);
    });
  }

  test(`${LAB_MODEL}: with a row drawn under the list, the rows above may scroll by the list's own rows plus one, no more: past that the screen changed`, async () => {
    const { pane, send } = rig({ version: "2.1.302" });
    const probe = rig({ version: "2.1.302" });
    const listRows = scrolledScreen(probe.pane, LAB_MODEL);
    scrolledScreen(pane, LAB_MODEL, { scroll: listRows + 2, list: (rows) => [...rows, "  Background task finished"] });
    const answer = await send("/model", { mode: "command" });
    expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "changed" });
    expect(pane.keysSeen).not.toContain("Enter");
  });

  // The list's region is taller than its rows: under the twelve rows of the h40 capture stand eight
  // blank rows down to the pane's last row. On a screen whose rows reach the bottom, the terminal
  // scrolls for those rows too, so the box moves up by the list's rows plus its blank rows.
  for (const [name, command] of [
    [LAB_MODEL, "/model"],
    [LAB_EFFORT, "/effort"],
  ] as const) {
    test(`${name}: ${command} from a screen whose rows reach the bottom is sent; the blank rows under the list scrolled it too`, async () => {
      const { pane, send } = rig({ version: "2.1.302" });
      scrolledScreen(pane, name, { full: true });
      const seen = journal(pane);
      const answer = await send(command, { mode: "command" });
      expect(answer.receipt).toMatchObject({ outcome: "sent" });
      expect(seen.slice(seen.findIndex((what) => what.endsWith(`:${command}`)))).toEqual([expect.stringMatching(new RegExp(`:${command}$`, "u")), "keys:Enter"]);
      neverEscape(pane);
    });
  }

  /**
   * The fix rig's pair (Herdr, 120 x 36, Claude Code 2.1.302, 2026-10-17): a screen whose rows reach the
   * bottom with an empty box, and the same pane once the box holds /model, its twelve list rows under
   * the box and five blank rows under them (the read leaves them out). The box moved up 16 rows. The
   * fake box is drawn into the box row of each; `s1` edits the second screen.
   */
  const FULL = "claude--v2302-idle-full-screen--w120--h36.txt";
  const PADDED = "claude--v2302-slash-model-list-padded--w120--h36.txt";
  const fullScreenPair = (pane: FakePane, options: { s0?: (rows: string[]) => string[]; s1?: (rows: string[]) => string[] } = {}): void => {
    const read = (name: string): string[] => readFileSync(join(import.meta.dir, `../../web/src/fixtures/panes/${name}`), "utf8").split("\n");
    const boxAt = (rows: readonly string[]): number => rows.findIndex((row, i) => i > 0 && row.startsWith("\u276f\u00a0") && rows[i - 1]!.includes("\u2500".repeat(20)));
    const before = options.s0 === undefined ? read(FULL) : options.s0(read(FULL));
    const after = options.s1 === undefined ? read(PADDED) : options.s1(read(PADDED));
    expect(before).toHaveLength(36);
    expect([boxAt(before), boxAt(after)]).toEqual([33, 17]);
    pane.beforeRead = (p) => {
      const typed = p.box.startsWith("/");
      const shown = typed ? [...after] : [...before];
      shown[typed ? boxAt(after) : boxAt(before)] = `\u276f\u00a0${p.box}`;
      p.fixed = shown.join("\n");
    };
  };

  test(`${PADDED}: /model from a screen whose rows reach the bottom is sent, though the box moved up past the list's own rows plus one (rig, 2026-10-17)`, async () => {
    const { pane, send } = rig({ version: "2.1.302" });
    fullScreenPair(pane);
    const seen = journal(pane);
    const answer = await send("/model", { mode: "command" });
    expect(answer.receipt).toMatchObject({ outcome: "sent" });
    expect(seen.slice(seen.findIndex((what) => what.endsWith(":/model")))).toEqual([expect.stringMatching(/:\/model$/u), "keys:Enter"]);
    expect(pane.transcript.at(-1)).toBe("> /model");
    neverEscape(pane);
  });

  test(`${PADDED}: the same pair on a version Collie could not read is sent too (the browser leg's bridge, 2026-10-17)`, async () => {
    const { pane, send } = rig({ version: "" });
    fullScreenPair(pane);
    expect((await send("/model", { mode: "command" })).receipt).toMatchObject({ outcome: "sent" });
    expect(pane.keysSeen.at(-1)).toBe("Enter");
  });

  test(`${PADDED}: a transcript row above the box that changed still keeps Enter back`, async () => {
    const { pane, send } = rig({ version: "2.1.302" });
    fullScreenPair(pane, { s1: (rows) => rows.map((row, i) => (i === 5 ? "  \u23bf  Set model to Opus 5.5 for this session only" : row)) });
    const answer = await send("/model", { mode: "command" });
    expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "changed" });
    expect(pane.keysSeen).not.toContain("Enter");
    expect(pane.box).toBe("/model");
  });

  test(`${PADDED}: a row drawn under the list takes the blank rows' allowance away, and Enter stays back`, async () => {
    const { pane, send } = rig({ version: "2.1.302" });
    fullScreenPair(pane, { s1: (rows) => [...rows, "  Background task finished"] });
    const answer = await send("/model", { mode: "command" });
    expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "changed" });
    expect(pane.keysSeen).not.toContain("Enter");
  });

  test(`${PADDED}: with no transcript row left above the box to compare, the blank rows under the list do not count`, async () => {
    const { pane, send } = rig({ version: "2.1.302" });
    // Sixteen transcript rows at S0, none above the box at S1: a move of 16 rows that only the blank rows could explain.
    fullScreenPair(pane, { s0: (rows) => rows.map((row, i) => (i >= 16 && i < 26 ? "" : row)), s1: (rows) => rows.map((row, i) => (i < 10 ? "" : row)) });
    const answer = await send("/model", { mode: "command" });
    expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "changed" });
    expect(pane.keysSeen).not.toContain("Enter");
  });

  test(`${PADDED}: the list pointing at another command over the blank rows is still left typed with the list notice`, async () => {
    const { pane, send, deps } = rig({ version: "2.1.302" });
    fullScreenPair(pane, { s1: (rows) => [...rows.slice(0, 19), ...pointAt("/models")(rows.slice(19).map(plain))] });
    const answer = await send("/model", { id: "padded-elsewhere-1", mode: "command" });
    expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "modal_cue" });
    expect(pane.keysSeen).not.toContain("Enter");
    expect(deps.store.get("padded-elsewhere-1")?.receipt?.detail).toBe("The command list at the box pointed at another command, so Enter was not pressed.");
  });

  test(`${LAB_MODEL}: /model typed while the list points at /models on the short pane is left typed with the list notice`, async () => {
    const { pane, send, deps } = rig({ version: "2.1.302" });
    scrolledScreen(pane, LAB_MODEL, { list: pointAt("/models") });
    const answer = await send("/model", { id: "lab-elsewhere-1", mode: "command" });
    expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "modal_cue" });
    expect(pane.keysSeen).not.toContain("Enter");
    expect(deps.store.get("lab-elsewhere-1")?.receipt?.detail).toBe("The command list at the box pointed at another command, so Enter was not pressed.");
  });

  test("the 2.1.302 list read as a screen: the box holds a draft, no dialog over it; pointing elsewhere still reads as before", async () => {
    const own = rig({ version: "2.1.302" });
    listScreen(own.pane, V2302);
    own.pane.box = "/model";
    const prepared = await own.protocol.handle({ id: "list-prep-1", text: "", mode: "prepare" }, { session: "main", paneId: "%1", harness: "claude" });
    expect(prepared.surface).toMatchObject({ turn: "idle", modal: "none", composer: "draft" });
    const elsewhere = rig({ version: "2.1.302" });
    listScreen(elsewhere.pane, V2302, { list: pointAt("/models") });
    elsewhere.pane.box = "/model";
    const looked = await elsewhere.protocol.handle({ id: "list-prep-2", text: "", mode: "prepare" }, { session: "main", paneId: "%1", harness: "claude" });
    expect(looked.surface?.modal).toBe("unreadable");
  });

  test("a list with no pointer keeps today's reading (no dialog, its rows weak at most) and the command goes out as before", async () => {
    const noPointer = (rows: string[]): string[] => rows.map((row) => row.replace("\u276f /", "  /"));
    const looked = rig({ version: "2.1.302" });
    listScreen(looked.pane, V2302, { list: noPointer });
    looked.pane.box = "/model";
    const prepared = await looked.protocol.handle({ id: "list-prep-3", text: "", mode: "prepare" }, { session: "main", paneId: "%1", harness: "claude" });
    expect(prepared.surface).toMatchObject({ modal: "none", composer: "draft" });
    const { pane, send } = rig({ version: "2.1.302" });
    listScreen(pane, V2302, { list: noPointer });
    expect((await send("/model", { mode: "command" })).receipt).toMatchObject({ outcome: "sent" });
    expect(pane.keysSeen.at(-1)).toBe("Enter");
  });

  test("Submit of /model after typed_not_submitted, the list pointing at it: sent, not refused not_free", async () => {
    const { pane, send } = rig({ version: "2.1.302" });
    listScreen(pane, V2302);
    pane.box = "/model";
    const answer = await send("/model", { mode: "submit" });
    expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["Enter"] });
    expect(pane.transcript.at(-1)).toBe("> /model");
  });

  test("/model as a command into a running turn, the list pointing at it: queued with Enter, not refused or left typed", async () => {
    const { pane, send } = rig({ version: "2.1.302" });
    listScreen(pane, V2302, { over: RUNNING });
    const answer = await send("/model", { mode: "command" });
    expect(answer.receipt).toMatchObject({ outcome: "sent" });
    expect(answer.receipt?.keys.at(-1)).toBe("Enter");
    neverEscape(pane);
  });
});

describe("a slash command over pi's and omp's own command list (field case, 2026-10-17, 1.22.5)", () => {
  // eslint-disable-next-line no-control-regex
  const plain = (row: string): string => row.replace(/\u001b\[[0-9;:]*m/gu, "");
  const capture = (name: string): string[] => readFileSync(join(import.meta.dir, `../../web/src/fixtures/panes/${name}`), "utf8").split("\r\n");
  const PI130 = { list: "pi--v130-slash-model-list--w120.txt", opened: "pi--v130-model-selector-empty--w120.txt", version: "1.3.0" };
  const PI087 = { list: "pi--v0871-slash-model-list--w120.txt", opened: "pi--v0871-model-selector-empty--w120.txt", version: "0.87.1" };
  const OMP = { list: "omp--v18-6-slash-model-list--w120.txt", opened: "omp--v18-6-model-selector-empty--w120.txt", version: "18.6.1" };
  const LIST_NOTICE = "The command list at the box pointed at another command, so Enter was not pressed.";

  /**
   * A capture of the typed command's list, split at the box (lab, 2026-10-17): the screen with the fake
   * box drawn into the box row, the list under it only while the box holds a slash command, and pi's
   * footer rows under that. Once Enter took the command the screen is `opened`, the capture of the
   * screen the command opens. `list` rewrites the list rows, read as plain text.
   */
  const captured = (pane: FakePane, name: string, opened: string, options: { list?: (rows: string[]) => string[]; shows?: (box: string) => boolean } = {}): void => {
    const rows = capture(name);
    const open = rows.findIndex((row) => plain(row).startsWith("╰─ "));
    const boxRow = open >= 0 ? open : rows.findIndex((row, i) => i > 0 && /^─{20,}$/u.test(plain(rows[i - 1]!).trimEnd()) && plain(row).startsWith("/"));
    expect(boxRow).toBeGreaterThan(0);
    const listFrom = open >= 0 ? boxRow + 1 : boxRow + 2;
    let footer = listFrom;
    while (footer < rows.length && !/^[^\s→❯]/u.test(plain(rows[footer]!))) footer++;
    const list = rows.slice(listFrom, footer);
    expect(list.length).toBeGreaterThan(1);
    const under = options.list === undefined ? list : options.list(list.map(plain));
    const box = (text: string): string => (open >= 0 ? `╰─ ${text}` : `${text}\u001b[7m \u001b[0m`);
    const after = capture(opened).join("\r\n");
    pane.beforeRead = (p) => {
      if (p.box === "" && p.keysSeen.includes("Enter")) {
        p.fixed = after;
        return;
      }
      const head = rows.slice(0, listFrom);
      head[boxRow] = box(p.box);
      const shows = options.shows ?? ((text: string) => text.startsWith("/"));
      p.fixed = [...head, ...(shows(p.box) ? under : []), ...rows.slice(footer)].join("\r\n");
    };
  };

  /** The list with its pointer moved onto the entry named `command`. */
  const pointAt =
    (command: string) =>
    (rows: string[]): string[] =>
      rows.map((row) => {
        const glyph = /^(?:→ |❯ )/u.exec(row);
        if (glyph !== null) return `  ${row.slice(2)}`;
        return new RegExp(`^ {2}(?:\\S+ {1,2})?${command} `, "u").test(row) ? `${row.startsWith("  ⬢") || row.startsWith("  ⇄") ? "❯" : "→"} ${row.slice(2)}` : row;
      });

  const journal = (pane: FakePane): string[] => {
    const seen: string[] = [];
    pane.afterInput = (_p, what) => seen.push(what);
    return seen;
  };

  const harnessOf = (c: typeof PI130): string => (c === OMP ? "omp" : "pi");
  const paneOf = (c: typeof PI130): FakePane => new FakePane(c === OMP ? "generic" : "claude");

  for (const c of [PI130, PI087, OMP]) {
    test(`${c.list}: /model as a command is sent with one Enter after the text, and the selector it opens counts as sent`, async () => {
      const pane = paneOf(c);
      const { send } = rig({ pane, harness: harnessOf(c), version: c.version });
      captured(pane, c.list, c.opened);
      const seen = journal(pane);
      const answer = await send("/model", { mode: "command" });
      expect(answer.receipt).toMatchObject({ outcome: "sent" });
      expect(answer.receipt?.keys.at(-1)).toBe("Enter");
      expect(seen.slice(seen.findIndex((what) => what.endsWith(":/model")))).toEqual([expect.stringMatching(/:\/model$/u), "keys:Enter"]);
      neverEscape(pane);
    });

    test(`${c.list}: read with /model in the box, no dialog; Submit then goes out with Enter`, async () => {
      const looked = rig({ pane: paneOf(c), harness: harnessOf(c), version: c.version });
      captured(looked.pane, c.list, c.opened);
      looked.pane.box = "/model";
      const prepared = await looked.protocol.handle({ id: `own-prep-${c.version.replaceAll(".", "-")}`, text: "", mode: "prepare" }, { session: "main", paneId: "%1", harness: harnessOf(c) });
      expect(prepared.surface).toMatchObject({ turn: "idle", modal: "none", composer: "draft" });
      const pane = paneOf(c);
      const { send } = rig({ pane, harness: harnessOf(c), version: c.version });
      captured(pane, c.list, c.opened);
      pane.box = "/model";
      expect((await send("/model", { mode: "submit" })).receipt).toMatchObject({ outcome: "sent", keys: ["Enter"] });
    });

    test(`${c.list}: /model while the selector already stands is refused, nothing typed`, async () => {
      const pane = paneOf(c);
      const { send } = rig({ pane, harness: harnessOf(c), version: c.version });
      pane.fixed = capture(c.opened).join("\r\n");
      const answer = await send("/model", { mode: "command" });
      expect(answer.receipt?.outcome).toBe("refused");
      expect(pane.calls).toEqual([]);
      expect(pane.keysSeen).toEqual([]);
    });

    test(`${c.list}: an Enter the harness swallows is never reported sent`, async () => {
      const pane = paneOf(c);
      pane.enterSubmits = false;
      const { send } = rig({ pane, harness: harnessOf(c), version: c.version });
      captured(pane, c.list, c.opened);
      const answer = await send("/model", { mode: "command" });
      expect(answer.receipt?.outcome).not.toBe("sent");
      expect(pane.box).toBe("/model");
    });
  }

  for (const [c, other] of [
    [PI130, "scoped-models"],
    [PI087, "scoped-models"],
    [OMP, "modelpreset"],
  ] as const) {
    test(`${c.list}: /model typed while the list points at ${other} is left typed, no Enter`, async () => {
      const pane = paneOf(c);
      const { send, deps } = rig({ pane, harness: harnessOf(c), version: c.version });
      captured(pane, c.list, c.opened, { list: pointAt(other) });
      const id = `own-elsewhere-${c.version.replaceAll(".", "-")}`;
      const answer = await send("/model", { id, mode: "command" });
      expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "modal_cue" });
      expect(pane.keysSeen).not.toContain("Enter");
      expect(pane.box).toBe("/model");
      // pi (since issue 638) and omp name `leadOpens`: the fuzzy list is the typed text's own popup, the
      // box is found past it, and the detail is the list notice, not the "something opened" of any other cue.
      expect(deps.store.get(id)?.receipt?.detail).toBe(LIST_NOTICE);
    });
  }

  // Issue 638 (pi 1.4.0 on Herdr): a command left typed under a list that points elsewhere must leave a box
  // the phone can still clear. pi's fuzzy list matches nothing once the probe character stands after the
  // text, so it closes while the probe is in and opens again after its Backspace. The rows of the box's own
  // list are no rows under the box (countBelow), so the next send reads the draft and Discard clears it.
  for (const c of [PI130, OMP] as const) {
    test(`${c.list}: after /model was left typed under a list pointed elsewhere, a later send finds the draft and Discard clears the box`, async () => {
      const pane = paneOf(c);
      const { send } = rig({ pane, harness: harnessOf(c), version: c.version });
      const probe = "⌁";
      captured(pane, c.list, c.opened, { list: pointAt(c === OMP ? "modelpreset" : "scoped-models"), shows: (text) => text.startsWith("/") && !text.includes(probe) });
      expect((await send("/model", { mode: "command" })).receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "modal_cue" });
      expect(pane.box).toBe("/model");
      const later = await send("/session", { mode: "command" });
      expect(later.receipt).toMatchObject({ outcome: "refused", reason: "draft_present" });
      const discarded = await send("/model", { mode: "discard", rowsHash: later.rowsHash! });
      expect(discarded.receipt?.outcome).toBe("discarded");
      expect(pane.box).toBe("");
      expect(pane.keysSeen).not.toContain("Enter");
    });
  }
});

// Issue 497 (omp 18.11.3, the box composer, captured 2026-10-18 in a scratch tmux session): sends that
// ended `typed_not_submitted` (mismatch or modal_cue) on main, read off the captures themselves.
describe("omp 18.11's box composer (issue 497)", () => {
  const PANES = join(import.meta.dir, "../../web/src/fixtures/panes");
  const capture = (name: string): string[] => readFileSync(join(PANES, name), "utf8").split(/\r?\n/u);
  // eslint-disable-next-line no-control-regex
  const plain = (row: string): string => row.replace(/\u001b\]8;[^\u001b]*\u001b\\/gu, "").replace(/\u001b\[[0-9;:]*m/gu, "");
  const VERSION = "18.11.3";
  const WRAP =
    "Collie wrap probe: the quick brown fox jumps over the lazy dog while the phone sends a long single line that must wrap " +
    "across two rows of the omp box at one hundred and thirty columns wide, ending here.";
  const IMAGE = "/tmp/c497/uploads/w1-mx7k2p-1a2b3c4d.png";
  const OMP = loadProfiles().get("omp")!;
  const collapse = new RegExp(OMP.collapse.pattern, "uy");

  /** The draft the Surface reads off a capture, as the bridge reads it. */
  const boxOf = (name: string): string => {
    const rows = capture(name).join("\n");
    const frame = findFrame(rows);
    expect(frame, name).not.toBeNull();
    return frame!.placeholder ? "" : frame!.interior.text;
  };
  const findFrame = (text: string): ReturnType<typeof findInputFrame> => findInputFrame(splitLines(parseAnsi(text)), OMP.idle);

  test("boxMatches takes the drafts, the chips and the ghost word off the captures", () => {
    for (const w of [130, 80]) {
      expect(boxMatches(boxOf(`omp--v18-11-nerd-box-wrapped--w${String(w)}.txt`), "", [WRAP], collapse)).toBe(true);
      expect(boxMatches(boxOf(`omp--v18-11-nerd-box-two-lines--w${String(w)}.txt`), "", ["First line of a two-line draft.", "Second line of the same draft."], collapse)).toBe(true);
      expect(boxMatches(boxOf(`omp--v18-11-nerd-image-chip--w${String(w)}.txt`), "", [IMAGE], collapse)).toBe(true);
      expect(boxMatches(boxOf(`omp--v18-11-nerd-ghost-word--w${String(w)}.txt`), "", ["please push"], collapse)).toBe(true);
    }
    expect(boxMatches(boxOf("omp--v18-11-image-chip--w130.txt"), "", [IMAGE], collapse)).toBe(true);
    expect(boxMatches(boxOf("omp--v18-11-ghost-word--w130.txt"), "", ["please push"], collapse)).toBe(true);
    // Still a mismatch: the box holds more than was typed.
    expect(boxMatches(boxOf("omp--v18-11-nerd-ghost-word--w130.txt"), "", ["please"], collapse)).toBe(false);
    expect(boxMatches(boxOf("omp--v18-11-nerd-box-wrapped--w130.txt"), "", [WRAP.slice(0, -1)], collapse)).toBe(false);
  });

  /**
   * The capture `name` while the box holds `shown` (the typed text, or "" for a capture of an empty box).
   * Any other box text draws the capture up to its top edge, then one `╰─ <text>` row with the right
   * border, as omp draws a short draft, and nothing under it. A submit key (Enter, or omp's ctrl+q)
   * takes the text out of the box: into the transcript over the box, or, with `running`, into omp's
   * queue rows over the box.
   */
  const scene = (pane: FakePane, name: string, shown: string, options: { running?: boolean } = {}): void => {
    const rows = capture(name);
    const width = Number(/--w(\d+)\.txt$/u.exec(name)![1]);
    const top = rows.findLastIndex((row) => plain(row).startsWith("╭──"));
    expect(top).toBeGreaterThan(0);
    const shortRow = (text: string): string => `╰─ ${text}${" ".repeat(Math.max(1, width - 5 - text.length))}─╯`;
    const above: string[] = [];
    let taken: string | null = null;
    pane.collapseOver = 100_000;
    pane.beforeWrite = (p, what) => {
      if ((what === "keys:Enter" || what === "keys:ctrl+q") && p.box !== "") taken = p.box;
    };
    pane.afterInput = (p, what) => {
      if (taken === null || (what !== "keys:Enter" && what !== "keys:ctrl+q")) return;
      // OMP's queue block, header first (omp--v18-6-queue-after): the queued row reads only under it.
      if (options.running === true) above.push(" After yield · 1", `   1. ${taken}`, "   └ Alt+↑ to edit");
      else above.push(` ${taken.replace(/\n/gu, " ")}`, "");
      taken = null;
      p.box = "";
    };
    pane.beforeRead = (p) => {
      const head = rows.slice(0, top);
      if (p.box === shown && above.length === 0) {
        p.fixed = rows.join("\n");
        return;
      }
      p.fixed = [...head.slice(above.length), ...above, rows[top]!, shortRow(p.box.replace(/\n/gu, " "))].join("\n");
    };
  };

  const sendOn = async (name: string, text: string, mode: "send" | "command", options: { running?: boolean } = {}): Promise<{ answer: SendAnswer; pane: FakePane }> => {
    const pane = new FakePane("generic");
    const { send } = rig({ pane, harness: "omp", version: VERSION });
    scene(pane, name, options.running === true ? "" : text, options);
    const answer = await send(text, { mode });
    return { answer, pane };
  };

  // M78 spec 06, pinned and not fixed: on a read with no styling (herdr-core) omp's ghost word `ed` has
  // no grey to mark it, so S1 reads `please pushed` after `please push` was typed. The box holds more than
  // was typed and the send stops before its submit key, the text left in the box for the person.
  test("the ghost word on a read with no styling: typed_not_submitted, no submit key (M78 spec 06, pinned)", async () => {
    const name = "omp--v18-11-ghost-word--w130.txt";
    const pane = new FakePane("generic");
    const { send } = rig({ pane, harness: "omp", version: VERSION });
    scene(pane, name, "please push");
    const styled = pane.beforeRead!;
    pane.beforeRead = async (p, n) => {
      await styled(p, n);
      if (p.fixed !== null) p.fixed = p.fixed.split("\n").map(plain).join("\n");
    };
    const answer = await send("please push");
    expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "mismatch", keys: ["probe", "Backspace"] });
    expect(pane.keysSeen).not.toContain("ctrl+q");
    expect(pane.keysSeen).not.toContain("Enter");
    expect(pane.box).toBe("please push");
  });

  test("a wrapped 202-character line, at 130 and at 80 columns: sent with ctrl+q", async () => {
    for (const w of [130, 80]) {
      const { answer, pane } = await sendOn(`omp--v18-11-nerd-box-wrapped--w${String(w)}.txt`, WRAP, "send");
      expect(answer.receipt, String(w)).toMatchObject({ outcome: "sent" });
      expect(pane.keysSeen.at(-1)).toBe("ctrl+q");
      neverEscape(pane);
    }
  });

  test("a two-line draft: sent", async () => {
    const { answer } = await sendOn("omp--v18-11-nerd-box-two-lines--w130.txt", "First line of a two-line draft.\nSecond line of the same draft.", "send");
    expect(answer.receipt).toMatchObject({ outcome: "sent" });
  });

  // An upload alone is its path, which starts with `/`, so the phone sends it as a command (Enter).
  test("an upload path that omp turns into its image chip, Nerd Font and unicode: sent with Enter", async () => {
    for (const name of ["omp--v18-11-nerd-image-chip--w130.txt", "omp--v18-11-image-chip--w130.txt"]) {
      const { answer, pane } = await sendOn(name, IMAGE, "command");
      expect(answer.receipt, name).toMatchObject({ outcome: "sent" });
      expect(pane.keysSeen.at(-1)).toBe("Enter");
    }
  });

  test("an upload path inside a message, wrapped to the box's right border: sent with ctrl+q", async () => {
    const text =
      "look at /tmp/c497/uploads/w1-mx7k2p-1a2b3c4d-and-a-long-tail-so-the-path-fills-the-row-to-the-right-border-" +
      "0123456789abcdef0123456789abcdef.png please";
    for (const w of [130, 80]) {
      const { answer, pane } = await sendOn(`omp--v18-11-nerd-box-path-text--w${String(w)}.txt`, text, "send");
      expect(answer.receipt, String(w)).toMatchObject({ outcome: "sent" });
      expect(pane.keysSeen.at(-1)).toBe("ctrl+q");
    }
  });

  test("/model with the Nerd Font pointer on it, and /wrap-up with the pointer on skill:wrap-up: sent with Enter", async () => {
    for (const [name, text] of [
      ["omp--v18-11-nerd-slash-model--w130.txt", "/model"],
      ["omp--v18-11-nerd-skill-pointed--w80.txt", "/wrap-up"],
      ["omp--v18-11-skill-pointed--w130.txt", "/wrap-up"],
    ] as const) {
      const { answer, pane } = await sendOn(name, text, "command");
      expect(answer.receipt, name).toMatchObject({ outcome: "sent" });
      expect(pane.keysSeen.at(-1)).toBe("Enter");
      neverEscape(pane);
    }
  });

  test("/wrap-up while the list shows a command wrap-up beside the skill: left typed, no Enter", async () => {
    const pane = new FakePane("generic");
    const { send } = rig({ pane, harness: "omp", version: VERSION });
    const name = "omp--v18-11-skill-pointed--w130.txt";
    scene(pane, name, "/wrap-up");
    const rows = capture(name);
    const list = rows.findIndex((row) => plain(row).startsWith("❯ "));
    expect(list).toBeGreaterThan(0);
    const withCommand = [...rows.slice(0, list + 1), "  ⌘ wrap-up                A command of the same name", ...rows.slice(list + 1)].join("\n");
    const draw = pane.beforeRead!;
    pane.beforeRead = (p, n) => {
      void draw(p, n);
      if (p.box === "/wrap-up") p.fixed = withCommand;
    };
    const answer = await send("/wrap-up", { mode: "command" });
    expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "modal_cue" });
    expect(pane.keysSeen).not.toContain("Enter");
    neverEscape(pane);
  });

  test("a send during a running tool turn, at 13 s and past a minute: queued with ctrl+q", async () => {
    for (const name of ["omp--v18-11-nerd-running-tool--w80.txt", "omp--v18-11-nerd-running-tool-minute--w130.txt"]) {
      const { answer, pane } = await sendOn(name, "QUEUED 497 follow up", "send", { running: true });
      expect(answer.receipt, name).toMatchObject({ outcome: "sent", queued: true });
      expect(pane.keysSeen.at(-1)).toBe("ctrl+q");
      neverEscape(pane);
    }
  });

  // omp names no `commandWhileRunning`, and its Enter steers a turn: a command in a turn waits for the
  // pane to read free (no hold store here, so it is refused), and nothing is typed.
  test("/model during the running tool turn is not typed: the turn is seen", async () => {
    for (const name of ["omp--v18-11-nerd-running-tool--w130.txt", "omp--v18-11-nerd-running-tool-minute--w80.txt"]) {
      const { answer, pane } = await sendOn(name, "/model", "command", { running: true });
      expect(answer.receipt, name).toMatchObject({ outcome: "refused", reason: "turn_running" });
      expect(pane.calls).toEqual([]);
      expect(pane.keysSeen).toEqual([]);
    }
  });
});

// Omp 18.6.1 and 18.12.6 (omp gang, 2026-10-25): `/skill:<name> <arg>` never sent, because omp rewrites the box
// into a chip `✦ name arg…` as soon as a space follows the name, and the profile's collapse pattern did not know
// it. Every skill with an argument ended `typed_not_submitted / mismatch`. The pasted image chip is `🖼 #N` on
// 18.6.1 and `📷 #N` on 18.12.6; only the first was a collapse form.
describe("omp's skill chip and image chip glyphs (omp gang 02 and 05)", () => {
  const PANES = join(import.meta.dir, "../../web/src/fixtures/panes");
  const capture = (name: string): string[] => readFileSync(join(PANES, name), "utf8").split(/\r?\n/u).filter((row, i, all) => row !== "" || i < all.length - 1);
  const OMP = loadProfiles().get("omp")!;
  const collapse = new RegExp(OMP.collapse.pattern, "uy");
  const SKILL = "/skill:darius-work-plan reply with the single word OK and call no tools";
  const SKILL_CHIPS = [
    ["omp--v18-6-skill-chip--w120.txt", "18.6.1"],
    ["omp--v18-12-6-skill-chip--w120.txt", "18.12.6"],
  ] as const;

  /** The box text the Surface reads off a capture, as the bridge reads it. */
  const boxOf = (name: string): string => {
    const frame = findInputFrame(splitLines(parseAnsi(capture(name).join("\n"))), OMP.idle);
    expect(frame, name).not.toBeNull();
    return frame!.placeholder ? "" : frame!.interior.text;
  };

  /**
   * The capture while the box holds `shown`; any other text draws the band and one `╰─ <text>` prompt row, as omp
   * draws a short draft. Enter takes the text out of the box into the transcript over the band.
   */
  const bandScene = (pane: FakePane, name: string, shown: string): void => {
    const rows = capture(name);
    const band = rows.findLastIndex((row) => row.startsWith(" π "));
    expect(band).toBeGreaterThanOrEqual(0);
    const above: string[] = [];
    let taken: string | null = null;
    pane.collapseOver = 100_000;
    pane.beforeWrite = (p, what) => {
      if (what === "keys:Enter" && p.box !== "") taken = p.box;
    };
    pane.afterInput = (p, what) => {
      if (taken === null || what !== "keys:Enter") return;
      above.push(` ${taken}`, "");
      taken = null;
      p.box = "";
    };
    pane.beforeRead = (p) => {
      if (p.box === shown && above.length === 0) {
        p.fixed = rows.join("\n");
        return;
      }
      p.fixed = [...above, rows[band]!, p.box === "" ? "╰─" : `╰─ ${p.box}`].join("\n");
    };
  };

  test("the box that shows the skill chip is the typed `/skill:name arg`, read off the 18.6.1 and 18.12.6 captures", () => {
    for (const [name] of SKILL_CHIPS) {
      expect(boxOf(name), name).toBe("✦ darius-work-plan reply with the single word OK and call no tools");
      expect(commandBoxMatches(boxOf(name), "", [SKILL], collapse), name).toBe(true);
    }
  });

  test("a skill chip with nothing after the name, a long argument that wraps and a namespaced skill all match", () => {
    const long = `/skill:ship ${"word ".repeat(60).trim()}`;
    expect(commandBoxMatches("✦ ship", "", ["/skill:ship"], collapse)).toBe(true);
    expect(commandBoxMatches(`✦ ship ${"word ".repeat(30)}\n${"word ".repeat(29)}word`, "", [long], collapse)).toBe(true);
    expect(commandBoxMatches("✦ dev-tools:wordsmith fix the changelog", "", ["/skill:dev-tools:wordsmith fix the changelog"], collapse)).toBe(true);
  });

  test("the chip is read at the start of the box only: a box that does not begin with it is a mismatch", () => {
    expect(commandBoxMatches("", "", [SKILL], collapse)).toBe(false);
    expect(commandBoxMatches("hello", "", [SKILL], collapse)).toBe(false);
    expect(commandBoxMatches("please ✦ darius-work-plan reply", "", [SKILL], collapse)).toBe(false);
    expect(commandBoxMatches("✦", "", [SKILL], collapse)).toBe(false);
    expect(commandBoxMatches("✦darius-work-plan reply", "", [SKILL], collapse)).toBe(false);
    // A draft already in the box is a prefix the protocol checks first; the chip cannot stand behind it.
    expect(boxMatches("old draft ✦ ship now", "", ["/skill:ship now"], collapse)).toBe(false);
  });

  test("a chip stands for ONE typed line: a second typed line after it never matches", () => {
    expect(boxMatches("✦ ship now", "", ["/skill:ship now", "and more"], collapse)).toBe(false);
  });

  test("the pasted image chip is `🖼 #N` on 18.6.1 and `📷 #N` on 18.12.6, and the Nerd and document chips keep matching", () => {
    const IMAGE = "/tmp/uploads/w1-mx7k2p-1a2b3c4d.png";
    expect(boxOf("omp--v18-12-6-image-chip--w120.txt")).toBe("📷 #1");
    expect(boxMatches(boxOf("omp--v18-12-6-image-chip--w120.txt"), "", [IMAGE], collapse)).toBe(true);
    expect(boxMatches(boxOf("omp--v18-11-image-chip--w130.txt"), "", [IMAGE], collapse)).toBe(true);
    for (const chip of ["🖼 #1", "📷 #1", "📄 #3", "\u{F03E} #2", "\u{F15C} #4"]) expect(boxMatches(chip, "", [IMAGE], collapse), chip).toBe(true);
    expect(boxMatches("📷 #", "", [IMAGE], collapse)).toBe(false);
    expect(boxMatches("📷#1", "", [IMAGE], collapse)).toBe(false);
    expect(boxMatches("🎨 #1", "", [IMAGE], collapse)).toBe(false);
  });

  test("/skill:name arg is sent with Enter on both versions: the chip is what the box shows, not a mismatch", async () => {
    for (const [name, version] of SKILL_CHIPS) {
      const pane = new FakePane("generic");
      const { send } = rig({ pane, harness: "omp", version });
      bandScene(pane, name, SKILL);
      const answer = await send(SKILL, { mode: "command" });
      expect(answer.receipt, name).toMatchObject({ outcome: "sent" });
      expect(answer.receipt?.reason, name).toBeUndefined();
      expect(pane.keysSeen.at(-1), name).toBe("Enter");
      expect(pane.keysSeen, name).not.toContain("Escape");
    }
  });
});

describe("a slash command over Muse's own slash palette inside the box (MUSE-03, #519)", () => {
  const PANES = join(import.meta.dir, "../../web/src/fixtures/panes");
  const capture = (name: string): string[] => readFileSync(join(PANES, name), "utf8").split(/\r?\n/u);
  // eslint-disable-next-line no-control-regex
  const plain = (row: string): string => row.replace(/\u001b\[[0-9;:]*m/gu, "");

  /**
   * The capture `name` while the box holds `shown`. Any other box text draws the capture's box
   * (its top rule, one prompt row, its bottom rule and status row) with that text in it and no
   * palette rows, as Muse draws a box with no list open. Enter takes the text out of the box
   * into a transcript row over it.
   */
  const scene = (pane: FakePane, name: string, shown: string): void => {
    const rows = capture(name);
    const prompt = rows.findLastIndex((row) => plain(row).startsWith("❯"));
    const bottom = rows.findIndex((row, i) => i > prompt && /^─+$/u.test(plain(row).trim()));
    expect(prompt).toBeGreaterThan(0);
    expect(bottom).toBeGreaterThan(prompt);
    const top = prompt - 1;
    const above: string[] = [];
    let taken: string | null = null;
    pane.beforeWrite = (p, what) => {
      if (what === "keys:Enter" && p.box !== "") taken = p.box;
    };
    pane.afterInput = (p, what) => {
      if (taken === null || what !== "keys:Enter") return;
      above.push(` ${taken}`, "");
      taken = null;
      p.box = "";
    };
    pane.beforeRead = (p) => {
      if (p.box === shown && above.length === 0) {
        p.fixed = rows.join("\n");
        return;
      }
      const head = rows.slice(0, top);
      p.fixed = [...head.slice(above.length), ...above, rows[top]!, p.box === "" ? "❯" : `❯ ${p.box}`, rows[bottom]!, ...rows.slice(bottom + 1)].join("\n");
    };
  };

  const sendOn = async (
    name: string,
    text: string,
    id?: string,
  ): Promise<{ answer: SendAnswer; pane: FakePane; deps: Rig["deps"] }> => {
    const pane = new FakePane("generic");
    const { send, deps } = rig({ pane, harness: "muse", version: "1.4.7" });
    scene(pane, name, text);
    const answer = await send(text, id === undefined ? { mode: "command" } : { id, mode: "command" });
    return { answer, pane, deps };
  };

  test("/plan as a command is sent, the palette's bold entry on /plan is its own list; only Enter follows the text", async () => {
    const { answer, pane } = await sendOn("muse--palette-skill.txt", "/plan");
    expect(answer.receipt).toMatchObject({ outcome: "sent" });
    expect(pane.keysSeen.at(-1)).toBe("Enter");
    neverEscape(pane);
  });

  test("/resume as a command is sent under its argument hint, the bold entry on /resume", async () => {
    const { answer, pane } = await sendOn("muse--palette-hint-skills.txt", "/resume");
    expect(answer.receipt).toMatchObject({ outcome: "sent" });
    expect(pane.keysSeen.at(-1)).toBe("Enter");
    neverEscape(pane);
  });

  test("/resume typed while the bold entry moved to /resume-claude is left typed, no Enter, and the detail says the list points elsewhere", async () => {
    const { answer, pane, deps } = await sendOn("muse--palette-hint-moved.txt", "/resume", "muse-list-elsewhere-1");
    expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "modal_cue" });
    expect(pane.keysSeen).not.toContain("Enter");
    expect(pane.box).toBe("/resume");
    expect(deps.store.get("muse-list-elsewhere-1")?.receipt?.detail).toBe("The command list at the box pointed at another command, so Enter was not pressed.");
    neverEscape(pane);
  });
});
