// The Send Protocol on a Claude Code 2.1.319 pane with Remote Control on: the footer under the box
// carries the Remote Control status row (`/rc`, `/rc active`, `/rc connecting…`, `/rc reconnecting`,
// `/rc failed`) under the statusline, the mode row and the update notice. A phone send to such a pane
// was held "Something is open at the box" while Claude sat idle (field report, Collie 1.27.4). The
// screen alone reads free (the fixture, and fold.corpus.test.ts over it); what the probe and the S1
// checks also ask is that the count of rows under the box stays the same while Collie types. The
// Remote Control row is a status row Claude draws or drops on its own (its label moves through
// connecting, active and reconnecting, and Claude leaves it out below 60 columns), so the profile names
// it among `idle.volatile.below.hints`, the rows that count leaves out. Its focused form, which adds
// `· enter to view` and takes Enter, is no hint and still counts.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { muxAck, muxOk, type MuxAck, type MuxGrid, type MuxGridRequest, type MuxOutcome } from "../mux/types.ts";
import { parseAnsi } from "../../web/src/lib/ansi.ts";
import { lineText, splitLines } from "../../web/src/lib/blocks.ts";
import { profileFor } from "../../web/src/lib/surface/profile.ts";
import type { SendAnswer } from "../../web/src/lib/surface/send.ts";
import { KeyGate } from "./key-gate.ts";
import { RowRing, SendProtocol, SessionLocks, type SendRequest } from "./protocol.ts";
import { RequestStore } from "./requests.ts";

const PANES = join(import.meta.dir, "..", "..", "web", "src", "fixtures", "panes");
/** An idle Claude Code 2.1.319 pane at 100 columns: statusline, mode row, update notice and `/rc` under the box. */
const IDLE = readFileSync(join(PANES, "claude--v2319-rc-footer-idle--w100.txt"), "utf8");
/** A row's text with its SGR styling taken out. */
const plainOf = (row: string): string => lineText(splitLines(parseAnsi(row))[0] ?? { segments: [] });
const RC_ROW = "  \x1b[0m\x1b[38;2;78;186;101m/rc\x1b[0m";

/** The fixture's screen, its box drawn from what was typed and its Remote Control row from `rc`. */
class RcFooterPane {
  box = "";
  submitted: string[] = [];
  keysSeen: string[] = [];
  /** The Remote Control row for the box as it stands: null draws none. */
  rc: (box: string) => string | null = () => RC_ROW;
  private readonly head: string[];
  private readonly rule: string;
  private readonly status: string[];
  private reads = 0;

  constructor(capture: string) {
    const rows = capture.replace(/\r/gu, "").split("\n");
    while (rows.length > 0 && rows.at(-1)!.trim() === "") rows.pop();
    const plain = rows.map(plainOf);
    const bottom = plain.findLastIndex((row) => /^─{8,}$/u.test(row));
    const top = plain.slice(0, bottom).findLastIndex((row) => /^─{8,}$/u.test(row));
    if (top < 0 || bottom < 0) throw new Error("the capture has no box");
    this.head = rows.slice(0, top);
    this.rule = rows[top]!;
    // Every footer row but the Remote Control one, which `rc` draws.
    this.status = rows.slice(bottom + 1).filter((row) => !/^\s*\/rc\b/u.test(plainOf(row)));
  }

  private render(): string {
    const lines = this.box.split("\n");
    const box = lines.map((line, i) => (i === 0 ? `❯ ${line}` : `  ${line}`));
    const rc = this.rc(this.box);
    return [...this.head, this.rule, ...box, this.rule, ...this.status, ...(rc === null ? [] : [rc])].join("\n");
  }

  readGrid = (paneId: string, request: MuxGridRequest): Promise<MuxOutcome<MuxGrid>> => {
    void request;
    this.reads++;
    return Promise.resolve(muxOk({ paneId, text: this.render(), truncated: false, revision: this.reads }));
  };

  typeText = (paneId: string, text: string): Promise<MuxAck> => {
    void paneId;
    this.box += text;
    return Promise.resolve(muxAck());
  };

  pasteText = (paneId: string, text: string): Promise<MuxAck> => this.typeText(paneId, text);

  writeKeys = (paneId: string, keys: readonly string[]): Promise<MuxAck> => {
    void paneId;
    for (const key of keys) {
      this.keysSeen.push(key);
      if (key === "Backspace") this.box = [...this.box].slice(0, -1).join("");
      else if (key === "ctrl+j") this.box += "\n";
      else if (key === "Enter" && this.box.length > 0) {
        this.submitted.push(this.box);
        this.box = "";
      }
    }
    return Promise.resolve(muxAck());
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "collie-claude-rc-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

let ids = 0;

/** A protocol on `pane`, for Claude Code 2.1.319 (provisional, a version the binary reported). */
function rig(pane: RcFooterPane) {
  const clock = { now: 1_000_000 };
  const now = (): number => clock.now;
  const protocol = new SendProtocol({
    mux: { readGrid: pane.readGrid, typeText: pane.typeText, pasteText: pane.pasteText },
    gate: new KeyGate(pane, now),
    store: new RequestStore(join(dir, "sends"), now),
    locks: new SessionLocks(),
    ring: new RowRing(),
    profile: (harness: string) => Promise.resolve(profileFor(harness, "2.1.319", { log: () => undefined })),
    generation: () => "gen-1",
    now,
    sleep: (ms: number) => {
      clock.now += ms;
      return Promise.resolve();
    },
  });
  const send = (text: string, over: Partial<SendRequest> = {}): Promise<SendAnswer> =>
    protocol.handle({ id: `rc-footer-${String(++ids).padStart(4, "0")}`, text, mode: "send", ...over }, { session: "main", paneId: "%1", harness: "claude" });
  return { send };
}

const TEXT = "keep the current one for now";
const row = (label: string): string => `  \x1b[0m\x1b[38;2;78;186;101m${label}\x1b[0m`;

describe("a send to an idle Claude Code 2.1.319 pane with Remote Control on", () => {
  test("the footer as captured reads free, and the send goes in", async () => {
    const pane = new RcFooterPane(IDLE);
    const { send } = rig(pane);
    const view = await send("", { mode: "prepare" });
    expect(view.surface).toMatchObject({ turn: "idle", modal: "none", composer: "empty" });
    const answer = await send(TEXT);
    expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["probe", "Backspace", "Enter"] });
    expect(pane.submitted).toEqual([TEXT]);
  });

  test("the Remote Control row goes once the box holds text: the probe passes and the send goes in", async () => {
    const pane = new RcFooterPane(IDLE);
    pane.rc = (box) => (box === "" ? RC_ROW : null);
    const { send } = rig(pane);
    const answer = await send(TEXT);
    expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["probe", "Backspace", "Enter"] });
    expect(pane.submitted).toEqual([TEXT]);
  });

  test("the Remote Control row comes once the box holds text: the send goes in", async () => {
    const pane = new RcFooterPane(IDLE);
    pane.rc = (box) => (box === "" ? null : row("/rc connecting…"));
    const { send } = rig(pane);
    const answer = await send(TEXT);
    expect(answer.receipt).toMatchObject({ outcome: "sent" });
    expect(pane.submitted).toEqual([TEXT]);
  });

  test.each(["/rc active", "/rc connecting…", "/rc reconnecting", "/rc failed"])("the row %s may go as the box fills", async (label) => {
    const pane = new RcFooterPane(IDLE);
    pane.rc = (box) => (box === "" ? row(label) : null);
    const { send } = rig(pane);
    const answer = await send(TEXT);
    expect(answer.receipt).toMatchObject({ outcome: "sent" });
    expect(pane.submitted).toEqual([TEXT]);
  });

  test("the focused Remote Control row (`· enter to view`) coming under the box is no hint: the probe fails, nothing submitted", async () => {
    const pane = new RcFooterPane(IDLE);
    pane.rc = (box) => (box === "" ? null : row("/rc · enter to view"));
    const { send } = rig(pane);
    const answer = await send(TEXT);
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "probe_failed" });
    expect(pane.keysSeen).not.toContain("Enter");
    expect(pane.submitted).toEqual([]);
  });

  test("a row that comes under the box and is no Remote Control label still fails the probe", async () => {
    const pane = new RcFooterPane(IDLE);
    pane.rc = (box) => (box === "" ? null : row("/rc something else"));
    const { send } = rig(pane);
    const answer = await send(TEXT);
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "probe_failed" });
    expect(pane.submitted).toEqual([]);
  });
});
