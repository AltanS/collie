// The Send Protocol on Claude Code's prompt suggestion read with no styling (M78 spec 06). After a turn
// Claude's empty box shows a suggestion in free words (`cat hello.txt to verify`), painted faint. A
// multiplexer that hands out plain text (herdr-core) loses the faint attribute, so the box read as a
// draft and a send was refused `draft_present`. On such a read the protocol now proves the box by
// where its probe character lands: at the start of the box, the suggestion, and the send goes on into an
// empty box; after the same text, a typed draft, refused as before. The fake pane draws each of the 15
// captures the M78 spec 01 report names, stripped of SGR as herdr-core reads them, with its box drawn
// from what Collie typed.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { muxAck, muxOk, type MuxAck, type MuxGrid, type MuxGridRequest, type MuxOutcome } from "../mux/types.ts";
import { parseAnsi } from "../../web/src/lib/ansi.ts";
import { splitLines } from "../../web/src/lib/blocks.ts";
import { findInputFrame } from "../../web/src/lib/surface/frame.ts";
import { loadProfiles, profileFor, type VersionRange } from "../../web/src/lib/surface/profile.ts";
import type { SendAnswer } from "../../web/src/lib/surface/send.ts";
import { KeyGate } from "./key-gate.ts";
import { BOUNDS, RowRing, SendProtocol, SessionLocks, type SendRequest } from "./protocol.ts";
import { RequestStore } from "./requests.ts";

const PANES = join(import.meta.dir, "..", "..", "web", "src", "fixtures", "panes");
const CLAUDE = loadProfiles().get("claude")!;
const PROBE = CLAUDE.probe.char;
const ESC = String.fromCodePoint(0x1b);
const SGR = new RegExp(`${ESC}\\[[0-9;:]*m`, "gu");
/** A capture as herdr-core hands it out: no SGR sequence, nothing else changed. */
const stripSgr = (raw: string): string => raw.replace(SGR, "");

/** The 15 captures whose stripped suggestion read as a draft (M78 spec 01 report, HOTFIX candidates item 1). */
const SUGGESTIONS = [
  "claude--done.txt",
  "claude--ghost-suggestion.txt",
  "claude--v2301-hold-subagent.txt",
  "claude--v2301-lab-agents-panel-empty.txt",
  "claude--v2304-heads-up-dismissed-after-explain--w65.txt",
  "claude--v2304-heads-up-explained--w65.txt",
  "claude-lab--idle-after-turn--w82.txt",
  "claude-lab--statusline-10row--w82.txt",
  "claude-lab--statusline-3row--w82.txt",
  "claude-lab--statusline-none--w82.txt",
  "claude-lab--statusline-numbered-rows--w82.txt",
  "claude-lab--statusline-prompt-row--w82.txt",
  "claude-lab--statusline-rule-row--w82.txt",
  "claude-lab--survey-rating-above-box--w82.txt",
  "claude-lab--transcript-dialog-lookalike--w82.txt",
] as const;

/** A Claude range that holds every capture's version, verified, so the rig decides nothing by version. */
const RANGE: readonly [VersionRange] = [{ range: "2.1.0 - 2.1.999", low: "2.1.0", high: "2.1.999", status: "verified", verifiedThrough: "2.1.999", verifiedOn: "2026-10-30" }];

/**
 * One capture of Claude's idle box, its prompt row drawn from what Collie typed. An empty box shows the
 * capture's own prompt row: the suggestion. Typing replaces the suggestion (it is not in the input), so
 * a probe lands at the start of the box; a typed draft keeps its cursor at its end.
 */
class SuggestionPane {
  /** What is in the input. */
  box = "";
  submitted: string[] = [];
  keysSeen: string[] = [];
  writes: string[] = [];
  /** After Enter took a text: the suggestion again, or a box with nothing in it. */
  afterEnter: "suggestion" | "blank" = "blank";
  /** Text the box shows after a lone probe character (the suggestion changed instead of going). */
  afterProbe = "";
  /** The probe character shows in the box this many reads after its write (1: the first read). */
  echoOnRead = 1;
  /** Extra time a key press costs on the rig's clock (herdr-core: about 3 s after a raw write). */
  keyCostMs = 0;
  /** The probe character goes in at the START of the input, before a typed draft (a cursor moved home). */
  cursorAtStart = false;
  clock: { now: number } | null = null;
  private readonly rows: string[];
  private readonly prompt: number;
  private readonly suggestion: string;
  private entered = false;
  private pendingEcho: { char: string; reads: number } | null = null;
  private revision = 1;

  constructor(capture: string, styled: boolean) {
    const raw = capture.replace(/\r/gu, "").split("\n");
    const rows = styled ? raw : raw.map(stripSgr);
    const frame = findInputFrame(splitLines(parseAnsi(rows.join("\n"))), CLAUDE.idle);
    if (frame === null) throw new Error("the capture has no box");
    this.rows = rows;
    this.prompt = frame.interior.prompt;
    this.suggestion = rows[this.prompt]!;
  }

  private render(): string {
    const rows = [...this.rows];
    if (this.box === "" && !this.entered) return rows.join("\n");
    if (this.box === "") rows[this.prompt] = this.afterEnter === "suggestion" ? this.suggestion : "❯ ";
    else rows[this.prompt] = `❯ ${this.box}${this.box === PROBE ? this.afterProbe : ""}`;
    return rows.join("\n");
  }

  readGrid = (paneId: string, request: MuxGridRequest): Promise<MuxOutcome<MuxGrid>> => {
    void request;
    if (this.pendingEcho !== null && ++this.pendingEcho.reads >= this.echoOnRead) {
      this.put(this.pendingEcho.char);
      this.pendingEcho = null;
    }
    return Promise.resolve(muxOk({ paneId, text: this.render(), truncated: false, revision: this.revision }));
  };

  private put(text: string): void {
    this.box = this.cursorAtStart ? text + this.box : this.box + text;
    this.revision++;
  }

  typeText = (paneId: string, text: string): Promise<MuxAck> => {
    void paneId;
    this.writes.push(text);
    if (text === PROBE && this.echoOnRead > 1) this.pendingEcho = { char: text, reads: 0 };
    else this.put(text);
    return Promise.resolve(muxAck());
  };

  pasteText = (paneId: string, text: string): Promise<MuxAck> => this.typeText(paneId, text);

  writeKeys = (paneId: string, keys: readonly string[]): Promise<MuxAck> => {
    void paneId;
    if (this.clock !== null) this.clock.now += this.keyCostMs;
    for (const key of keys) {
      this.keysSeen.push(key);
      if (key === "Backspace") this.box = this.cursorAtStart ? [...this.box].slice(1).join("") : [...this.box].slice(0, -1).join("");
      else if (key === "Enter" && this.box.length > 0) {
        this.submitted.push(this.box);
        this.box = "";
        this.entered = true;
      }
      this.revision++;
    }
    return Promise.resolve(muxAck());
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "collie-ghost-probe-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

let ids = 0;

function rig(pane: SuggestionPane, options: { anyText?: boolean } = {}) {
  const clock = { now: 1_000_000 };
  pane.clock = clock;
  const now = (): number => clock.now;
  const profile = options.anyText === false ? { ...CLAUDE, versions: RANGE, idle: { ...CLAUDE.idle, placeholders: { ...CLAUDE.idle.placeholders, anyText: undefined } } } : { ...CLAUDE, versions: RANGE };
  const protocol = new SendProtocol({
    mux: { readGrid: pane.readGrid, typeText: pane.typeText, pasteText: pane.pasteText },
    gate: new KeyGate(pane, now),
    store: new RequestStore(join(dir, "sends"), now),
    locks: new SessionLocks(),
    ring: new RowRing(),
    profile: (harness: string) => Promise.resolve(profileFor(harness, "2.1.310", { log: () => undefined, profiles: new Map([["claude", profile]]) })),
    generation: () => "gen-1",
    now,
    sleep: (ms: number) => {
      clock.now += ms;
      return Promise.resolve();
    },
  });
  const send = (text: string, over: Partial<SendRequest> = {}): Promise<SendAnswer> =>
    protocol.handle({ id: `ghost-${String(++ids).padStart(6, "0")}`, text, mode: "send", ...over }, { session: "main", paneId: "%1", harness: "claude" });
  return { send, clock };
}

const capture = (name: string): string => readFileSync(join(PANES, name), "utf8");

describe("Claude Code's suggestion on a read with no styling (M78 spec 06)", () => {
  test("the claude profile says its placeholder may be any text", () => {
    expect(CLAUDE.idle.placeholders.anyText).toBe(true);
  });

  for (const name of SUGGESTIONS) {
    test(`${name}: the stripped box reads a draft, the probe lands at the start, and the send goes into the empty box`, async () => {
      const pane = new SuggestionPane(capture(name), false);
      const { send } = rig(pane);
      const view = await send("", { mode: "prepare" });
      expect(view.surface, name).toMatchObject({ turn: "idle", modal: "none", composer: "draft" });
      const answer = await send("please run the tests");
      expect(answer.receipt, name).toMatchObject({ outcome: "sent", keys: ["probe", "Backspace", "Enter"] });
      expect(answer.receipt?.reason, name).toBeUndefined();
      expect(answer.receipt?.gapsMs.proof, name).toBeGreaterThan(0);
      expect(pane.submitted, name).toEqual(["please run the tests"]);
    });

    test(`${name}: the same box holding a typed draft takes the probe after the text and is refused draft_present`, async () => {
      const pane = new SuggestionPane(capture(name), false);
      pane.box = "my own words";
      const { send } = rig(pane);
      const answer = await send("please run the tests");
      expect(answer.receipt, name).toMatchObject({ outcome: "refused", reason: "draft_present", keys: ["probe", "Backspace"] });
      expect(answer.offers, name).toEqual(["append", "replace", "cancel"]);
      expect(pane.box, name).toBe("my own words");
      expect(pane.submitted, name).toEqual([]);
    });
  }

  test("a short text takes the send's own probe after the proof, and the suggestion that comes back reads as the empty box", async () => {
    const pane = new SuggestionPane(capture("claude--done.txt"), false);
    pane.afterEnter = "suggestion";
    const { send } = rig(pane);
    const answer = await send("ok");
    // The proof's probe and Backspace, then the send's own (a text of up to three characters is always probed).
    expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["probe", "Backspace", "probe", "Backspace", "Enter"] });
    expect(pane.submitted).toEqual(["ok"]);
  });

  test("the suggestion changes instead of going: the probe at the start followed by other text is still the suggestion", async () => {
    const pane = new SuggestionPane(capture("claude--done.txt"), false);
    pane.afterProbe = " to verify";
    const { send } = rig(pane);
    const answer = await send("please run the tests");
    expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["probe", "Backspace", "Enter"] });
    expect(pane.submitted).toEqual(["please run the tests"]);
  });

  test("a text that is the suggestion's own words goes out and reads as typed, not as the suggestion", async () => {
    const pane = new SuggestionPane(capture("claude--done.txt"), false);
    const { send } = rig(pane);
    const answer = await send("cat hello.txt to verify");
    expect(answer.receipt).toMatchObject({ outcome: "sent" });
    expect(pane.submitted).toEqual(["cat hello.txt to verify"]);
  });

  test("a typed draft whose cursor stands at its start: the probe before the same text is no suggestion, nothing is sent", async () => {
    const pane = new SuggestionPane(capture("claude--done.txt"), false);
    pane.box = "my own words";
    pane.cursorAtStart = true;
    const { send } = rig(pane);
    const answer = await send("please run the tests");
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "draft_present", keys: ["probe", "Backspace"] });
    expect(pane.box).toBe("my own words");
    expect(pane.submitted).toEqual([]);
  });

  test("a profile that does not say its placeholder may be any text keeps the refusal on the same read", async () => {
    const pane = new SuggestionPane(capture("claude--done.txt"), false);
    const { send } = rig(pane, { anyText: false });
    const answer = await send("please run the tests");
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "draft_present", keys: ["probe", "Backspace"] });
    expect(pane.submitted).toEqual([]);
  });
});

describe("a styled read never takes the suggestion's path (M78 spec 06)", () => {
  test("the faint suggestion reads as the empty box: no proof, no probe for it", async () => {
    const pane = new SuggestionPane(capture("claude--done.txt"), true);
    const { send } = rig(pane);
    const view = await send("", { mode: "prepare" });
    expect(view.surface).toMatchObject({ turn: "idle", modal: "none", composer: "empty" });
    const answer = await send("please run the tests");
    // A verified profile and a long text: no probe at all, only Enter.
    expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["Enter"] });
    expect(answer.receipt?.gapsMs.proof).toBeUndefined();
    expect(pane.writes).toEqual(["please run the tests"]);
  });

  test("a typed draft on a styled read is refused draft_present as today: one probe and one Backspace, no more", async () => {
    const pane = new SuggestionPane(capture("claude--done.txt"), true);
    pane.box = "my own words";
    const { send } = rig(pane);
    const answer = await send("please run the tests");
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "draft_present", keys: ["probe", "Backspace"] });
    expect(pane.writes).toEqual([PROBE]);
    expect(pane.box).toBe("my own words");
  });

  test("a styled read whose probe lands at the start is no suggestion: nothing is sent", async () => {
    const pane = new SuggestionPane(capture("claude--done.txt"), true);
    pane.box = "my own words";
    pane.cursorAtStart = true;
    // Typing at the start of the draft: the box shows the probe before other text, which the plain read takes for a suggestion that changed.
    const { send } = rig(pane);
    const answer = await send("please run the tests");
    expect(answer.receipt?.outcome).toBe("refused");
    expect(pane.submitted).toEqual([]);
    expect(pane.box).toBe("my own words");
  });
});

describe("the suggestion's probe on a slow multiplexer (herdr-core 0.1.14, M78 spec 06)", () => {
  test("a probe that shows on the second read and a Backspace held three seconds stay inside the probe's budget", async () => {
    const pane = new SuggestionPane(capture("claude--done.txt"), false);
    pane.echoOnRead = 2;
    pane.keyCostMs = 3000;
    const { send } = rig(pane);
    const answer = await send("please run the tests");
    expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["probe", "Backspace", "Enter"] });
    expect(pane.submitted).toEqual(["please run the tests"]);
  });

  test("a probe that does not show inside the probe's reads ends probe_failed, nothing sent", async () => {
    const pane = new SuggestionPane(capture("claude--done.txt"), false);
    pane.echoOnRead = BOUNDS.probe.reads * 4;
    const { send } = rig(pane);
    const answer = await send("please run the tests");
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "probe_failed" });
    expect(pane.submitted).toEqual([]);
    expect(pane.keysSeen).not.toContain("Enter");
  });
});
