// A slash command whose text wraps, sent into Claude Code 2.1.319 over Herdr on a full screen (the owner's
// lead pane, 2026-11-07: a `/subtask` of 237 and one of 427 characters, each typed and never submitted,
// `typed_not_submitted / changed`). The box grows one row up for the wrapped text, the transcript scrolls
// one row, and the screen's first row stays where it is, blank. A command needs the transcript above the
// box to stand still (a message does not: only the box decides there), and the compare read the pinned
// first row as a new one. A short command never grows the box, so it never met this.
//
// The three captures are one lab send, read the way the bridge reads a pane (`herdr pane read --source
// visible --format ansi`, Herdr 0.9.5, 224 columns, 25 rows, CRLF line ends as the bridge reads them, no trailing newline): the empty
// box with two background agents under it, the probe character in the box, and the command typed. Lab
// folder renamed to a path of the same width. Nothing on a screen is drawn by the test.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { muxAck, muxOk, type MuxAck, type MuxGrid, type MuxGridRequest, type MuxOutcome } from "../mux/types.ts";
import { loadProfiles, profileFor } from "../../web/src/lib/surface/profile.ts";
import type { SendAnswer } from "../../web/src/lib/surface/send.ts";
import { KeyGate } from "./key-gate.ts";
import { RowRing, SendProtocol, SessionLocks } from "./protocol.ts";
import { RequestStore } from "./requests.ts";

const FIXTURES = join(import.meta.dir, "fixtures");
const capture = (state: "empty" | "probe" | "typed"): string => readFileSync(join(FIXTURES, `claude--v2319-slash-body-${state}--w224.txt`), "utf8");
const CLAUDE = loadProfiles().get("claude")!;
const PROBE = CLAUDE.probe.char;
const ESC = String.fromCodePoint(0x1b);
const plain = (screen: string): string[] => screen.replace(new RegExp(`${ESC}\\[[0-9;:]*m`, "gu"), "").split(/\r?\n/u);

/** The lab's command, 440 characters on one line: three rows in a box 224 columns wide. */
const COMMAND =
  "/subtask for the next minor release we also want the public theme gallery. a theme repository should be very simple to share, and the website should show a gallery under a themes route. every repository tagged as a theme should be listed, and once a day a job should sweep the tagged repositories and check that each one really is a theme or should be left out. start this in a dedicated tab as well and orchestrate the implementation there";

/** A pane whose every read is a capture: the empty box, the probe in it, or the command typed. `typed` may be edited. */
class SlashBodyPane {
  box = "";
  keysSeen: string[] = [];
  private revision = 1;
  private entered = false;

  constructor(private readonly typed: string) {}

  readGrid = (paneId: string, request: MuxGridRequest): Promise<MuxOutcome<MuxGrid>> => {
    void request;
    let text: string;
    if (this.entered || this.box === "") text = capture("empty");
    else if (this.box === PROBE) text = capture("probe");
    else if (this.box === COMMAND) text = this.typed;
    else throw new Error(`the lab never saw the box hold ${JSON.stringify(this.box)}`);
    return Promise.resolve(muxOk({ paneId, text, truncated: false, revision: this.revision }));
  };

  typeText = (paneId: string, text: string): Promise<MuxAck> => {
    void paneId;
    this.box += text;
    this.revision++;
    return Promise.resolve(muxAck());
  };

  pasteText = (paneId: string, text: string): Promise<MuxAck> => this.typeText(paneId, text);

  writeKeys = (paneId: string, keys: readonly string[]): Promise<MuxAck> => {
    void paneId;
    for (const key of keys) {
      this.keysSeen.push(key);
      if (key === "Backspace") this.box = [...this.box].slice(0, -1).join("");
      if (key === "Enter") {
        this.entered = true;
        this.box = "";
      }
    }
    this.revision++;
    return Promise.resolve(muxAck());
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "collie-slash-body-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** The send as the field ran it: the shipped Claude profile, version 2.1.319 (provisional, so probed). */
function send(pane: SlashBodyPane): Promise<SendAnswer> {
  const clock = { now: 1_000_000 };
  const now = (): number => clock.now;
  const protocol = new SendProtocol({
    mux: { readGrid: pane.readGrid, typeText: pane.typeText, pasteText: pane.pasteText },
    gate: new KeyGate(pane, now),
    store: new RequestStore(join(dir, "sends"), now),
    locks: new SessionLocks(),
    ring: new RowRing(),
    profile: (harness: string) => Promise.resolve(profileFor(harness, "2.1.319", { log: () => undefined, profiles: new Map([["claude", CLAUDE]]) })),
    generation: () => "gen-1",
    now,
    sleep: (ms: number) => {
      clock.now += ms;
      return Promise.resolve();
    },
  });
  return protocol.handle({ id: "slash-body-000001", text: COMMAND, mode: "command" }, { session: "main", paneId: "%1", harness: "claude" });
}

describe("a slash command whose text wraps, on Claude Code 2.1.319 over Herdr (lab, 2026-11-07)", () => {
  test("the captures are the lab's: the box grew one row up, the first row stayed blank, the rows under it scrolled one", () => {
    const empty = plain(capture("empty"));
    const typed = plain(capture("typed"));
    expect(typed.length).toBe(empty.length);
    const top = (rows: string[]) => rows.findIndex((row) => row.startsWith("─────"));
    expect(top(typed)).toBe(top(empty) - 1);
    expect(empty[0]).toBe("");
    expect(typed[0]).toBe("");
    expect(empty[1]).toBe("✻ Waiting for 2 background agents to finish");
    // Under the pinned first row the transcript moved up one row: the row that held row 2 now holds row 3.
    expect(typed.slice(1, top(typed))).toEqual(empty.slice(2, top(empty)));
    // Claude draws a no-break space after the prompt glyph.
    expect(typed.some((row) => /^❯\s\/subtask for the next minor release/u.test(row))).toBe(true);
  });

  test("the command goes out once: probed, typed, one Enter, sent", async () => {
    const pane = new SlashBodyPane(capture("typed"));
    const answer = await send(pane);
    expect(answer.receipt).toMatchObject({ profileStatus: "provisional", outcome: "sent", keys: ["probe", "Backspace", "Enter"] });
    expect(pane.keysSeen.filter((key) => key === "Enter")).toHaveLength(1);
  });

  test("a row that is NEW above the box still stops it: a line of output under the pinned row is a changed screen", async () => {
    // A row over the volatile band (the six rows over the box may change): the transcript itself.
    const typed = capture("typed").replace("is waiting on its own background work", "finished and printed a new line here.");
    expect(typed).not.toBe(capture("typed"));
    const pane = new SlashBodyPane(typed);
    const answer = await send(pane);
    expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "changed", keys: ["probe", "Backspace"] });
    expect(pane.keysSeen).not.toContain("Enter");
  });

  test("a first row that changed is no pinned row: the screen moved, nothing is pressed", async () => {
    const rows = capture("typed").split("\r\n");
    rows[0] = "A line of output that was not there before";
    const pane = new SlashBodyPane(rows.join("\r\n"));
    const answer = await send(pane);
    expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "changed" });
    expect(pane.keysSeen).not.toContain("Enter");
  });
});
