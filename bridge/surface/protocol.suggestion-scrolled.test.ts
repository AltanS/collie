// Where omp's suggestion rule (issue 854) meets the scrolled-box rule (PR 857): the scrolled rule wins.
// A box at its scroll height shows only a part of its draft, so it is never empty and never a suggestion,
// whatever colour its text wears: no suggestion probe, a send refused as a draft before any key, Clear
// refused before any key, the phone's Surface keeps it a draft. A profile without `anyStyle` (Claude
// Code) reads its scrolled box as before.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { muxAck, muxOk, type MuxAck, type MuxGrid, type MuxOutcome } from "../mux/types.ts";
import { parseAnsi } from "../../web/src/lib/ansi.ts";
import { splitLines } from "../../web/src/lib/blocks.ts";
import { surfaceOfScreen } from "../../web/src/lib/surface/fold.ts";
import { boxInk } from "../../web/src/lib/surface/frame.ts";
import { loadProfiles, profileFor, type Profile, type VersionRange } from "../../web/src/lib/surface/profile.ts";
import type { SendAnswer } from "../../web/src/lib/surface/send.ts";
import type { AgentView } from "../types.ts";
import { ClearService } from "./clear.ts";
import { KeyGate } from "./key-gate.ts";
import { RowRing, SendProtocol, SessionLocks } from "./protocol.ts";
import { RequestStore } from "./requests.ts";
import { SurfaceShadow } from "./shadow.ts";

const FIXTURES = join(import.meta.dir, "..", "..", "web", "src", "fixtures");
const ESC = String.fromCodePoint(0x1b);
const DIM_DARK = "95;102;115";

/**
 * omp's box at its scroll height (`omp--draft-scrolled-26-lines--v18.6.1.txt`, a plain capture), every
 * row of its text drawn in the dark theme's suggestion colour: the one look a suggestion has.
 */
function scrolledOmpInSuggestionColour(): string {
  const rows = readFileSync(join(FIXTURES, "surface", "omp--draft-scrolled-26-lines--v18.6.1.txt"), "utf8").split("\n");
  const prompt = rows.findLastIndex((row) => row.startsWith("╰─ "));
  return rows
    .map((row, at) => {
      if (at < prompt || row.trim() === "") return row;
      const lead = at === prompt ? "╰─ " : "   ";
      return `${lead}${ESC}[38;2;${DIM_DARK}m${row.slice(lead.length)}${ESC}[0m`;
    })
    .join("\n");
}

const CLAUDE_SCROLLED = readFileSync(join(FIXTURES, "panes", "claude--v2331-draft-scrolled-up--w59.txt"), "utf8");

/** A pane that shows one screen and records every key and text sent to it. */
class StillPane {
  readonly written: string[] = [];
  constructor(private readonly screen: string) {}
  readGrid = (paneId: string): Promise<MuxOutcome<MuxGrid>> => Promise.resolve(muxOk({ paneId, text: this.screen, truncated: false, revision: 1 }));
  typeText = (_paneId: string, text: string): Promise<MuxAck> => {
    this.written.push(text);
    return Promise.resolve(muxAck());
  };
  pasteText = (paneId: string, text: string): Promise<MuxAck> => this.typeText(paneId, text);
  writeKeys = (_paneId: string, keys: readonly string[]): Promise<MuxAck> => {
    this.written.push(...keys);
    return Promise.resolve(muxAck());
  };
}

const VERSIONS = { omp: "18.22.0", claude: "2.1.331" } as const;
type Harness = keyof typeof VERSIONS;

/** The harness's profile, verified for the version the test names, so every rule of a verified profile runs. */
function verified(harness: Harness): Profile {
  const versions: readonly [VersionRange] = [
    { range: "0.0.0 - *", status: "verified", low: "0.0.0", high: null, verifiedThrough: VERSIONS[harness], verifiedOn: "2026-11-24" },
  ];
  return { ...loadProfiles().get(harness)!, versions };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "collie-suggestion-scrolled-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

let ids = 0;

function rig(pane: StillPane, harness: Harness) {
  const clock = { now: 1_000_000 };
  const now = (): number => clock.now;
  const proven: { paneId: string; text: string; ink: string }[] = [];
  const profiles = new Map<string, Profile>([[harness, verified(harness)]]);
  const profile = (name: string) => Promise.resolve(profileFor(name, VERSIONS[harness], { log: () => undefined, profiles }));
  const sleep = (ms: number) => {
    clock.now += ms;
    return Promise.resolve();
  };
  const gate = new KeyGate(pane, now);
  const protocol = new SendProtocol({
    mux: { readGrid: pane.readGrid, typeText: pane.typeText, pasteText: pane.pasteText },
    gate,
    store: new RequestStore(join(dir, "sends"), now),
    locks: new SessionLocks(),
    ring: new RowRing(),
    profile,
    generation: () => "gen-1",
    suggestion: (paneId, ghost) => void proven.push({ paneId, ...ghost }),
    now,
    sleep,
  });
  const send = (text: string, mode: "send" | "replace" | "append" = "send"): Promise<SendAnswer> =>
    protocol.handle({ id: `scrolled-${String(++ids).padStart(6, "0")}`, text, mode }, { session: "main", paneId: "%1", harness });
  const clear = new ClearService({ staleFrame: () => undefined, mux: pane, gate, profile, suggestion: (paneId, ghost) => void proven.push({ paneId, ...ghost }), sleep });
  const clearBox = () => clear.handle(`scrolled-clear-${String(++ids).padStart(6, "0")}`, "%1", harness);
  return { send, clearBox, proven };
}

function readOf(screen: string, harness: string) {
  const rows = splitLines(parseAnsi(screen));
  return { rows, read: surfaceOfScreen({ seq: 0, source: "screen", at: 0, revision: 1, rows, ask: null }, loadProfiles().get(harness)!.idle) };
}

function agent(harness: string): AgentView {
  return { paneId: "w1:p1", workspaceId: "w1", workspaceLabel: "one", workspaceNumber: 1, tabId: "w1:t1", agent: harness, status: "idle", cwd: "/x", focused: false };
}

/** The bridge's Surface over one screen, with a suggestion marked for the text and colour that screen's box shows. */
async function shadowMarked(screen: string, harness: Harness) {
  const mux = { readGrid: (paneId: string) => Promise.resolve(muxOk({ paneId, text: screen, truncated: false, revision: 1 })) };
  const shadow = new SurfaceShadow({ mux, pollMs: 1000, log: () => undefined, now: () => 1_000_000, version: () => Promise.resolve(VERSIONS[harness]) });
  await shadow.observe([agent(harness)]);
  const { rows, read } = readOf(screen, harness);
  shadow.markSuggestion("w1:p1", { text: read.frame!.interior.text, ink: boxInk(rows, read.frame!) ?? "rgb(1,2,3)" });
  return shadow;
}

describe("an omp box at its scroll height, its text in the suggestion's colour (issue 854 meets PR 857)", () => {
  const screen = scrolledOmpInSuggestionColour();

  test("reads as a scrolled draft in one colour: the suggestion's look, but no suggestion", () => {
    const { rows, read } = readOf(screen, "omp");
    expect(read.frame?.scrolled).toBe(true);
    expect(read.surface).toMatchObject({ turn: "idle", modal: "none", composer: "draft" });
    // Every row of its text wears the suggestion's colour, and a box of many rows has no one-row colour.
    expect(screen.split("\n").filter((row) => row.includes(`${ESC}[38;2;${DIM_DARK}m`)).length).toBeGreaterThan(16);
    expect(boxInk(rows, read.frame!)).toBeNull();
  });

  for (const mode of ["send", "replace", "append"] as const) {
    test(`a ${mode} is refused as a draft with no suggestion probe`, async () => {
      const pane = new StillPane(screen);
      const { send, proven } = rig(pane, "omp");
      const answer = await send("please run the tests", mode);
      expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "draft_present", keys: [] });
      expect(pane.written).not.toContain("⌁");
      expect(pane.written).not.toContain("ctrl+q");
      expect(proven).toEqual([]);
    });
  }

  test("Clear is refused before any key", async () => {
    const pane = new StillPane(screen);
    const { clearBox, proven } = rig(pane, "omp");
    const answer = await clearBox();
    expect(answer).toMatchObject({ kind: "receipt", receipt: { outcome: "refused", reason: "unreadable" }, pressed: false });
    expect(pane.written).toEqual([]);
    expect(proven).toEqual([]);
  });

  test("a suggestion mark for the same text and colour leaves the phone's Surface a draft with no whole draft", async () => {
    const shadow = await shadowMarked(screen, "omp");
    expect(shadow.surfaceOf("w1:p1")).toMatchObject({ composer: "draft" });
    expect(shadow.boxOf("w1:p1")?.box).toBeNull();
  });
});

describe("a Claude Code box scrolled past its prompt row, on a profile without `anyStyle` (unchanged)", () => {
  test("the Claude profile names no suggestion in any style", () => {
    expect(loadProfiles().get("claude")!.idle.placeholders.anyStyle).toBeUndefined();
  });

  test("a send is refused as a draft before any key, and Clear before any key", async () => {
    const pane = new StillPane(CLAUDE_SCROLLED);
    const { send, clearBox, proven } = rig(pane, "claude");
    const answer = await send("yes please");
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "draft_present", keys: [] });
    const cleared = await clearBox();
    expect(cleared).toMatchObject({ kind: "receipt", receipt: { outcome: "refused", reason: "unreadable" }, pressed: false });
    expect(pane.written).toEqual([]);
    expect(proven).toEqual([]);
  });

  test("a suggestion mark changes nothing on the phone's Surface", async () => {
    const shadow = await shadowMarked(CLAUDE_SCROLLED, "claude");
    expect(shadow.surfaceOf("w1:p1")).toMatchObject({ composer: "draft" });
    expect(shadow.boxOf("w1:p1")?.box).toBeNull();
  });
});
