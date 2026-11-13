// A time-out is not a fact, and one bad read does not end a send (M100 spec 03, 2026-11-13). Each case
// here failed before the change beside it, on the same reporter's screen the late-keys suite uses
// (Claude Code 2.1.314 under its agents footer): a fake pane draws its box and answers each write,
// key and read the way the case names.
//
//  1. The multiplexer took Enter and did not confirm it (`unconfirmed`, herdr-core's `terminal.keys`
//     time-out): the S2 read decides, never `typed_not_submitted: submit_failed`.
//  2. A text write that timed out is not "nothing typed": the box is read before the refusal.
//  3. One frame with a cue does not end S1 or the probe; two do.
//  4. S0 takes one more read when the multiplexer marks a read partial.
//  7. The blind road (spec 06, item 1): a pane with no name whose last rows look like an agent's is refused.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { muxAck, muxOk, muxUnconfirmed, type MuxAck, type MuxGrid, type MuxGridRequest, type MuxOutcome } from "../mux/types.ts";
import { parseAnsi } from "../../web/src/lib/ansi.ts";
import { splitLines } from "../../web/src/lib/blocks.ts";
import { surfaceOfScreen } from "../../web/src/lib/surface/fold.ts";
import { profileFor } from "../../web/src/lib/surface/profile.ts";
import type { SendAnswer } from "../../web/src/lib/surface/send.ts";
import { KeyGate } from "./key-gate.ts";
import { blindRoadSign, RowRing, SendProtocol, SessionLocks, type SendRequest } from "./protocol.ts";
import { RequestStore } from "./requests.ts";

const FIXTURES = join(import.meta.dir, "..", "..", "web", "src", "fixtures");
const CAPTURE = readFileSync(join(FIXTURES, "surface", "claude--v2-1-314-agents-footer-late-probes--w282.txt"), "utf8");
const SHELL = readFileSync(join(FIXTURES, "panes", "shell--starship-bluefin-motd--w117.txt"), "utf8");
const RULE = /^─{8,}$/u;
const HINT = " · ↓ to manage";
const LATE = "herdr-core did not confirm the keys on w2:p1 in time (herdr-core terminal.keys: timed out after 5000ms). They may still arrive, so they were not sent again.";
const LATE_TEXT = "herdr-core did not confirm the text written to w2:p1 in time (herdr-core terminal.input: timed out after 5000ms). It may still arrive, so it was not written again.";
/** A permission dialog's options, drawn where the agents footer stands for one frame. */
const DIALOG_ROWS = ["", "❯ 1. Yes", "  2. Yes, and don't ask again this session", "  3. No, and tell Claude what to do differently (esc)"];

interface Clock {
  now: number;
}

/** How the pane answers one text write: `ok` lands it; `late` lands it and is not confirmed; `lost` and `half` are not confirmed and land none or half of it. */
type WriteAnswer = "ok" | "late" | "lost" | "half";

/** The reporter's screen, its box drawn from what the agent took. */
class ClaudePane {
  box = "";
  submitted: string[] = [];
  keysSeen: string[] = [];
  reads = 0;
  /** The answers to the text writes, in order; a write past the list is `ok`. The probe is a write too. */
  writes: WriteAnswer[] = [];
  /** How Enter is answered: confirmed, or not confirmed and it landed, or not confirmed and it did not. */
  enter: "ok" | "late-landed" | "late-lost" | "late-delayed" = "ok";
  /** With `late-delayed`: the rig's clock, and when the held Enter reaches the box. */
  clock: Clock | null = null;
  private enterAt: number | null = null;
  /** Changes read `n` before it is answered: its screen, and whether the multiplexer marks it partial. */
  readHook: ((n: number, screen: string[]) => { readonly rows: string[]; readonly partial?: boolean }) | null = null;
  private writeCount = 0;
  private readonly head: string[];
  private readonly rule: string;
  private readonly modeRow: string;
  private readonly footer: string[];

  constructor(capture: string) {
    const rows = capture.replace(/\r/gu, "").split("\n");
    while (rows.length > 0 && rows.at(-1)!.trim() === "") rows.pop();
    const bottom = rows.findLastIndex((row) => RULE.test(row));
    const top = rows.slice(0, bottom).findLastIndex((row) => RULE.test(row));
    this.head = rows.slice(0, top);
    this.rule = rows[top]!;
    this.modeRow = rows[bottom + 1]!;
    this.footer = rows.slice(bottom + 2);
  }

  private mode(): string {
    if (this.box !== "") return this.modeRow;
    const at = this.modeRow.indexOf("shell") + "shell".length;
    const rest = this.modeRow.slice(at);
    return `${this.modeRow.slice(0, at)}${HINT}${rest.slice(HINT.length)}`;
  }

  rows(): string[] {
    return [...this.head, this.rule, `❯ ${this.box}`, this.rule, this.mode(), ...this.footer];
  }

  /** The rows with the agents footer swapped for a dialog's options. */
  withDialog(): string[] {
    const rows = this.rows();
    return [...rows.slice(0, rows.length - this.footer.length), ...DIALOG_ROWS];
  }

  readGrid = (paneId: string, request: MuxGridRequest): Promise<MuxOutcome<MuxGrid>> => {
    void request;
    this.reads++;
    if (this.enterAt !== null && this.clock !== null && this.clock.now >= this.enterAt) {
      this.enterAt = null;
      this.submitted.push(this.box);
      this.box = "";
    }
    const hooked = this.readHook?.(this.reads, this.rows()) ?? { rows: this.rows() };
    const grid: MuxGrid = hooked.partial === true ? { paneId, text: hooked.rows.join("\n"), truncated: false, revision: this.reads, partial: true } : { paneId, text: hooked.rows.join("\n"), truncated: false, revision: this.reads };
    return Promise.resolve(muxOk(grid));
  };

  typeText = (paneId: string, text: string): Promise<MuxAck> => {
    void paneId;
    const answer = this.writes[this.writeCount++] ?? "ok";
    if (answer === "ok" || answer === "late") this.box += text;
    if (answer === "half") this.box += text.slice(0, Math.ceil(text.length / 2));
    return Promise.resolve(answer === "ok" ? muxAck() : muxUnconfirmed(LATE_TEXT));
  };

  pasteText = (paneId: string, text: string): Promise<MuxAck> => this.typeText(paneId, text);

  writeKeys = (paneId: string, keys: readonly string[]): Promise<MuxAck> => {
    void paneId;
    for (const key of keys) {
      this.keysSeen.push(key);
      if (key === "Backspace") this.box = [...this.box].slice(0, -1).join("");
      if (key === "Enter") {
        if (this.enter === "late-lost") return Promise.resolve(muxUnconfirmed(LATE));
        if (this.enter === "late-delayed") {
          // herdr-core holds the key behind a slow read and delivers it seconds later.
          this.enterAt = (this.clock?.now ?? 0) + 4_000;
          return Promise.resolve(muxUnconfirmed(LATE));
        }
        if (this.box.length > 0) this.submitted.push(this.box);
        this.box = "";
        if (this.enter === "late-landed") return Promise.resolve(muxUnconfirmed(LATE));
      }
    }
    return Promise.resolve(muxAck());
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "collie-not-sure-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

let ids = 0;

function rig(harness = "claude") {
  const clock: Clock = { now: 1_000_000 };
  const pane = new ClaudePane(CAPTURE);
  pane.clock = clock;
  const now = (): number => clock.now;
  const protocol = new SendProtocol({
    mux: { readGrid: pane.readGrid, typeText: pane.typeText, pasteText: pane.pasteText },
    gate: new KeyGate(pane, now),
    store: new RequestStore(join(dir, "sends"), now),
    locks: new SessionLocks(),
    ring: new RowRing(),
    profile: (name: string) => Promise.resolve(profileFor(name, "2.1.314", { log: () => undefined })),
    generation: () => "gen-1",
    now,
    sleep: (ms: number) => {
      clock.now += ms;
      return Promise.resolve();
    },
  });
  const send = (text: string, over: Partial<SendRequest> = {}): Promise<SendAnswer> =>
    protocol.handle({ id: `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`, text, mode: "send", ...over }, { session: "main", paneId: "w2:p1", harness });
  return { pane, send };
}

const enters = (pane: ClaudePane): number => pane.keysSeen.filter((key) => key === "Enter").length;

describe("1. an Enter the multiplexer did not confirm: the S2 read decides", () => {
  test("it landed (the box let the text go): sent, Enter pressed once", async () => {
    const { pane, send } = rig();
    pane.enter = "late-landed";
    const answer = await send("hello there");
    expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["probe", "Backspace", "Enter"] });
    expect(pane.submitted).toEqual(["hello there"]);
    expect(enters(pane)).toBe(1);
  });

  test("it landed four seconds late, past one S2 bound: S2 reads once more and the send is sent", async () => {
    const { pane, send } = rig();
    pane.enter = "late-delayed";
    const answer = await send("hello there");
    expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["probe", "Backspace", "Enter"] });
    expect(pane.submitted).toEqual(["hello there"]);
    expect(enters(pane)).toBe(1);
  });

  test("it did not land (the whole text still in the box): typed, not submitted, and nothing pressed again", async () => {
    const { pane, send } = rig();
    pane.enter = "late-lost";
    const answer = await send("hello there");
    expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "submit_failed" });
    expect(answer.receipt?.detail).toContain("They may still arrive");
    expect(pane.box).toBe("hello there");
    expect(enters(pane)).toBe(1);
  });

  test("neither (a dialog took the box's place): unknown, never typed_not_submitted, and no Resend offered", async () => {
    const { pane, send } = rig();
    pane.enter = "late-lost";
    let entered = false;
    pane.readHook = (_n, rows) => {
      if (pane.keysSeen.includes("Enter")) entered = true;
      return { rows: entered ? pane.withDialog().filter((row) => !RULE.test(row) && !row.startsWith("❯ hello")) : rows };
    };
    const answer = await send("hello there");
    expect(answer.receipt).toMatchObject({ outcome: "unknown", reason: "no_evidence" });
    expect(answer.detail).toContain("They may still arrive");
    expect(answer.offers ?? []).not.toContain("submit");
    expect(enters(pane)).toBe(1);
  });
});

describe("2. a text write that timed out is read before it is called nothing typed", () => {
  test("the whole text landed: the send goes on through S1 and is sent", async () => {
    const { pane, send } = rig();
    // The probe is the first write; the text is the second.
    pane.writes = ["ok", "late"];
    const answer = await send("hello there");
    expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["probe", "Backspace", "Enter"] });
    expect(pane.submitted).toEqual(["hello there"]);
  });

  test("nothing landed: refused write_failed as before, no Enter", async () => {
    const { pane, send } = rig();
    pane.writes = ["ok", "lost"];
    const answer = await send("hello there");
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "write_failed" });
    expect(enters(pane)).toBe(0);
    expect(pane.box).toBe("");
  });

  test("half of it landed: typed, not submitted, with the half in the box, and no Enter", async () => {
    const { pane, send } = rig();
    pane.writes = ["ok", "half"];
    const answer = await send("hello there");
    expect(answer.receipt?.outcome).toBe("typed_not_submitted");
    expect(enters(pane)).toBe(0);
    expect(pane.box).toBe("hello ");
  });
});

describe("3. one frame with a cue waits for one more read", () => {
  test("S1: one read shows a dialog under the box, the next is clean: sent", async () => {
    const { pane, send } = rig();
    let shown = false;
    pane.readHook = (_n, rows) => {
      if (pane.box === "hello there" && !shown) {
        shown = true;
        return { rows: pane.withDialog() };
      }
      return { rows };
    };
    const answer = await send("hello there");
    expect(shown).toBe(true);
    expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["probe", "Backspace", "Enter"] });
  });

  test("S1: two reads in a row show it: typed, not submitted (modal_cue), as before", async () => {
    const { pane, send } = rig();
    let shown = 0;
    pane.readHook = (_n, rows) => {
      if (pane.box === "hello there" && shown < 2) {
        shown++;
        return { rows: pane.withDialog() };
      }
      return { rows };
    };
    const answer = await send("hello there");
    expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "modal_cue" });
    expect(enters(pane)).toBe(0);
  });

  test("the probe: one read shows a dialog with the probe in the box, the next is clean: sent", async () => {
    const { pane, send } = rig();
    let shown = false;
    pane.readHook = (_n, rows) => {
      if (pane.box.length === 1 && !shown) {
        shown = true;
        return { rows: pane.withDialog() };
      }
      return { rows };
    };
    const answer = await send("hello there");
    expect(shown).toBe(true);
    expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["probe", "Backspace", "Enter"] });
  });

  test("the probe: the dialog stays: refused probe_failed, the probe taken out, no Enter", async () => {
    const { pane, send } = rig();
    pane.readHook = (_n, rows) => ({ rows: pane.box.length === 1 ? pane.withDialog() : rows });
    const answer = await send("hello there");
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "probe_failed" });
    expect(enters(pane)).toBe(0);
  });
});

describe("4. a partial read at S0 is read again", () => {
  test("the first read is partial, the next whole: sent", async () => {
    const { pane, send } = rig();
    pane.readHook = (n, rows) => (n === 1 ? { rows: rows.slice(0, 5), partial: true } : { rows });
    const answer = await send("hello there");
    expect(answer.receipt).toMatchObject({ outcome: "sent" });
    expect(pane.submitted).toEqual(["hello there"]);
  });

  test("two partial reads in a row: refused probe_failed with the partial-read words, nothing typed", async () => {
    const { pane, send } = rig();
    pane.readHook = (n, rows) => (n <= 2 ? { rows: rows.slice(0, 5), partial: true } : { rows });
    const answer = await send("hello there");
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "probe_failed", keys: [] });
    expect(answer.receipt?.detail).toContain("rows may be missing");
  });
});

describe("7. the blind road: a pane with no name whose last rows look like an agent's (spec 06, item 1)", () => {
  test("an agent's box on a pane the multiplexer reads as a shell: refused not_free, nothing typed", async () => {
    const { pane, send } = rig("");
    const answer = await send("hello there");
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "not_free", keys: [], profileId: null });
    expect(answer.offers).toEqual(["keys"]);
    expect(pane.box).toBe("");
    expect(enters(pane)).toBe(0);
  });

  const read = (text: string) => {
    const rows = splitLines(parseAnsi(text));
    return { rows, surface: surfaceOfScreen({ seq: 0, source: "screen", at: 0, revision: 1, rows, ask: null }, null).surface };
  };

  test("the signs, read as profile data: a box, a dialog's options, a footer row a profile names; a shell shows none", () => {
    const pane = new ClaudePane(CAPTURE);
    const box = read(pane.rows().join("\n"));
    expect(blindRoadSign(box.rows, box.surface)).toBe("frame");
    const dialog = read(["$ make", "Proceed?", ...DIALOG_ROWS.slice(1)].join("\n"));
    expect(blindRoadSign(dialog.rows, dialog.surface)).toBe("cue");
    const footer = read(["$ make", "done", "", "  ● main", "  ◯ general-purpose  Loading"].join("\n"));
    expect(blindRoadSign(footer.rows, footer.surface)).toBe("footer");
    const shell = read(SHELL);
    expect(blindRoadSign(shell.rows, shell.surface)).toBeNull();
    const prompts = read(["❯ cd project", "❯ ls", "notes.txt  src", "❯ git status", "On branch main", "❯ "].join("\n"));
    expect(blindRoadSign(prompts.rows, prompts.surface)).toBeNull();
  });
});
