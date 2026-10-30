// The Send Protocol on UNSTYLED frames and on a core that holds a key (M78 spec 02). herdr-core hands
// out the screen as plain text (HC_API.md, terminal.read): no colour, no attribute, one run per row.
// Every pane fixture was captured styled, so here each idle fixture is stripped of its escapes and
// drawn by a fake core (bridge/mux/herdr-core/fake-core.ts) behind the real herdr-core adapter. The
// protocol, the key gate and the adapter are the shipped ones; only the program in the terminal is
// scripted. The fake core holds a key press for about 3 s after a raw write (HC_API.md, The key
// hold), on a manual clock shared with the protocol, so no real second passes.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HerdrCoreMux } from "../mux/herdr-core/adapter.ts";
import type { WireRead } from "../mux/herdr-core/client.ts";
import { FakeHcCore, KEY_HOLD_MS, ManualClock, type FakeInput } from "../mux/herdr-core/fake-core.ts";
import { parseAnsi } from "../../web/src/lib/ansi.ts";
import { lineText, splitLines } from "../../web/src/lib/blocks.ts";
import { loadProfiles, profileFor } from "../../web/src/lib/surface/profile.ts";
import type { SendAnswer } from "../../web/src/lib/surface/send.ts";
import { KeyGate } from "./key-gate.ts";
import { BOUNDS, RowRing, SendProtocol, SessionLocks, type SendRequest } from "./protocol.ts";
import { RequestStore } from "./requests.ts";

const PANES = join(import.meta.dir, "..", "..", "web", "src", "fixtures", "panes");

/** A capture with every escape sequence and carriage return taken out: what a plain-text mux hands out. */
function unstyled(name: string): string[] {
  const text = splitLines(parseAnsi(readFileSync(join(PANES, name), "utf8").replaceAll("\r", ""))).map(lineText).join("\n");
  const rows = text.split("\n").map((row) => row.trimEnd());
  while (rows.length > 0 && rows.at(-1) === "") rows.pop();
  return rows;
}

/** The screen of one harness's idle box, and how its program edits it. */
interface Harness {
  readonly id: string;
  readonly version: string;
  readonly fixture: string;
  /** The keys that submit the box, lower case, as the core spells them. */
  readonly submit: readonly string[];
  /**
   * The rows above the box (`head`, the transcript), the box's top edge (`pre`), the rows under it
   * (`foot`) and the prefixes of the box's first and later rows. `keepTail` rows at the end of `head`
   * stay under a transcript echo (omp draws its bar row over the box).
   */
  readonly split: (rows: readonly string[]) => { head: string[]; pre: string[]; foot: string[]; open: string; next: string; keepTail: number };
}

const rule = (row: string): boolean => /^─{8,}$/u.test(row);

const HARNESSES: Harness[] = [
  {
    id: "claude",
    version: "2.1.310",
    fixture: "claude--fresh-idle.txt",
    submit: ["enter"],
    split: (rows) => {
      const bottom = rows.findLastIndex(rule);
      const top = rows.slice(0, bottom).findLastIndex(rule);
      return { head: rows.slice(0, top), pre: rows.slice(top, top + 1), foot: rows.slice(bottom), open: "❯ ", next: "  ", keepTail: 0 };
    },
  },
  {
    id: "omp",
    version: "18.12.6",
    fixture: "omp--fresh-idle.txt",
    submit: ["enter", "ctrl+q"],
    split: (rows) => {
      const at = rows.findLastIndex((row) => row.startsWith("╰─"));
      return { head: rows.slice(0, at), pre: [], foot: rows.slice(at + 1), open: "╰─ ", next: "   ", keepTail: 1 };
    },
  },
  {
    id: "pi",
    version: "1.2.0",
    fixture: "pi--v110-idle.txt",
    submit: ["enter", "alt+enter"],
    split: (rows) => {
      const bottom = rows.findLastIndex(rule);
      const top = rows.slice(0, bottom).findLastIndex(rule);
      return { head: rows.slice(0, top), pre: rows.slice(top, top + 1), foot: rows.slice(bottom), open: " ", next: " ", keepTail: 0 };
    },
  },
];

/** The program in the terminal: a box that takes text and keys the way the fixture's harness does. */
class BoxProgram {
  box = "";
  submitted: string[] = [];
  /** Runs after a text write has drawn, for a scripted change under the send. */
  afterText: (() => void) | null = null;
  private head: string[];
  private readonly pre: string[];
  private readonly foot: string[];
  private readonly open: string;
  private readonly next: string;
  private readonly keepTail: number;

  constructor(
    private readonly fake: FakeHcCore,
    private readonly address: string,
    private readonly harness: Harness,
  ) {
    const parts = harness.split(unstyled(harness.fixture));
    this.head = parts.head;
    this.pre = parts.pre;
    this.foot = parts.foot;
    this.open = parts.open;
    this.next = parts.next;
    this.keepTail = parts.keepTail;
    const rows = unstyled(harness.fixture);
    fake.resize(address, Math.max(...rows.map((row) => [...row].length)), rows.length);
    this.draw();
    fake.program(address, (input) => this.take(input));
  }

  private draw(): void {
    const lines = this.box.split("\n").map((line, i) => (i === 0 ? `${this.open}${line}` : `${this.next}${line}`));
    this.fake.setScreen(this.address, [...this.head, ...this.pre, ...lines, ...this.foot]);
  }

  private take(input: FakeInput): void {
    if (input.kind === "text") {
      this.box += input.text;
      this.draw();
      this.afterText?.();
      return;
    }
    for (const key of input.keys) {
      if (key === "backspace") this.box = [...this.box].slice(0, -1).join("");
      else if (key === "ctrl+j" || key === "shift+enter") this.box += "\n";
      else if (this.harness.submit.includes(key) && this.box.length > 0) {
        this.submitted.push(this.box);
        const echo = ` > ${this.box.replace(/\n/gu, " ")}`;
        this.head = [...this.head.slice(0, this.head.length - this.keepTail), echo, ...this.head.slice(this.head.length - this.keepTail)];
        this.box = "";
      }
    }
    this.draw();
  }
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "collie-unstyled-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

let ids = 0;

/** A protocol over the herdr-core adapter, a fake core and one terminal drawing `harness`'s idle frame. */
function rig(harness: Harness, hold?: { answer: "late" | "early"; ms?: number }, core: FakeHcCore = new FakeHcCore(false)) {
  const fake = core;
  const clock = new ManualClock();
  const address = fake.add({ keep: true, status: { state: "idle", app: harness.id === "claude" ? "claude-code" : harness.id, kind: "" } });
  const program = new BoxProgram(fake, address, harness);
  const generation = (): string | null => {
    const terminal = fake.peek(address);
    return terminal === undefined ? null : `${terminal.foreground?.name ?? "-"}:${terminal.status?.app ?? "-"}`;
  };
  if (hold !== undefined) fake.holdKeysAfterRawWrite(clock, hold);
  const adapter = new HerdrCoreMux(fake, "/home/dev");
  const now = (): number => 1_000_000 + clock.now();
  const protocol = new SendProtocol({
    mux: { readGrid: (id, request) => adapter.readGrid(id, request), typeText: (id, text) => adapter.typeText(id, text) },
    gate: new KeyGate(adapter, now),
    store: new RequestStore(join(dir, "sends"), now),
    locks: new SessionLocks(),
    ring: new RowRing(),
    profile: (id) => Promise.resolve(profileFor(id, harness.version, { log: () => undefined, profiles: loadProfiles() })),
    generation: () => generation(),
    now,
    sleep: (ms) => clock.wait(ms),
  });
  const send = (text: string, over: Partial<SendRequest> = {}): Promise<SendAnswer> =>
    protocol.handle({ id: `req-unstyled-${String(++ids).padStart(6, "0")}`, text, mode: "send", ...over }, { session: "main", paneId: address, harness: harness.id });
  return { fake, adapter, program, send, clock, address };
}

describe.each(HARNESSES)("$id: an unstyled idle frame on a plain-text core", (harness) => {
  test("the fixture really has no escape, and one run per row", () => {
    expect(unstyled(harness.fixture).some((row) => row.includes("\u001b"))).toBe(false);
  });

  test("with no key hold the probe shows and the send goes out: sent", async () => {
    const { send, program, fake } = rig(harness);
    const answer = await send("hello there");
    expect(answer.receipt).toMatchObject({ outcome: "sent", profileId: harness.id });
    expect(program.submitted).toEqual(["hello there"]);
    expect(fake.writes().filter((w) => w.kind === "text").map((w) => w.payload[0])).toContain("hello there");
  });

  test("the core's 3 s key hold lands inside the probe's budget: still sent, and the hold is the writes' cost, not the reads'", async () => {
    const { send, program } = rig(harness, { answer: "late" });
    const answer = await send("hello there");
    expect(answer.receipt).toMatchObject({ outcome: "sent", profileId: harness.id });
    expect(program.submitted).toEqual(["hello there"]);
    expect(answer.receipt?.gapsMs.probeWrite ?? 0).toBeGreaterThanOrEqual(KEY_HOLD_MS - BOUNDS.probe.ms);
    expect(answer.receipt?.gapsMs.probe ?? 0).toBeLessThan(BOUNDS.probe.ms);
  });

  test("a key that reaches the program later than the probe's read budget after its answer: refused probe_failed, nothing submitted", async () => {
    const { send, program } = rig(harness, { answer: "early", ms: 5000 });
    const answer = await send("hello there");
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "probe_failed" });
    expect(program.submitted).toEqual([]);
  });
});

describe("two lines of text on a plain-text core (the newline key path)", () => {
  const claude = HARNESSES[0]!;

  test.each([[false], [true]])("claude, key hold %p: the line break goes in as ctrl+j and the whole text is submitted", async (held) => {
    const { send, program, fake } = rig(claude, held ? { answer: "late" } : undefined);
    const text = "first line\nsecond line";
    const answer = await send(text);
    expect(answer.receipt).toMatchObject({ outcome: "sent", profileId: "claude" });
    expect(program.submitted).toEqual([text]);
    expect(fake.writes().filter((w) => w.kind === "keys" && w.payload.includes("ctrl+j"))).toHaveLength(1);
  });
});

describe("a screen the core marks partial decides nothing", () => {
  class PartialScreen extends FakeHcCore {
    partial = false;
    /** Reads are incomplete from this many writes on. */
    partialFrom = Infinity;
    override async readTerminal(address: string, lines: number): Promise<WireRead> {
      const whole = await super.readTerminal(address, lines);
      return this.partial || this.writes().length >= this.partialFrom ? { ...whole, complete: false, why: "working" } : whole;
    }
  }

  test.each(HARNESSES)("$id: every read partial, so no text and no key is written, and the words are not pane_gone", async (harness) => {
    const core = new PartialScreen(false);
    const { send, fake, program } = rig(harness, undefined, core);
    core.partial = true;
    const answer = await send("hello there");
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "probe_failed", keys: [] });
    expect(answer.receipt?.detail).toContain("rows may be missing");
    expect(fake.writes()).toEqual([]);
    expect(program.submitted).toEqual([]);
  });

  test.each(HARNESSES)("$id: reads turn partial once the probe is out, and the send stops before its Enter", async (harness) => {
    const core = new PartialScreen(false);
    const { send, fake, program } = rig(harness, undefined, core);
    core.partialFrom = 2;
    const answer = await send("hello there");
    expect(answer.receipt?.outcome).not.toBe("sent");
    expect(program.submitted).toEqual([]);
    expect(fake.writes().flatMap((w) => (w.kind === "keys" ? w.payload : []))).not.toContain("enter");
  });
});

describe("the program is lost under a send: keep puts a shell at the same address", () => {
  test.each(HARNESSES)("$id: the send ends without Enter, and the text is not submitted", async (harness) => {
    const { send, fake, program, address } = rig(harness);
    program.afterText = () => fake.loseProgram(address);
    const answer = await send("hello there");
    expect(answer.receipt?.outcome).not.toBe("sent");
    expect(program.submitted).toEqual([]);
    expect(fake.writes().flatMap((w) => (w.kind === "keys" ? w.payload : []))).not.toContain("enter");
  });
});
