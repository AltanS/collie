// The Send Protocol against a scripted fake multiplexer (M56 spec 05): every step's refusal, every
// outcome, the probe against a dialog that swallows input and one that echoes it, the collapse form,
// a modal cue between S0 and S1, the lock bound, the crash case, the same id twice, and bracketed
// paste on and off. The fake draws a box the way the Claude profile reads one (a rule, the prompt
// glyph, a rule, a status row), or, for a harness with no profile, a bare editor between two rules.

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { muxAck, muxOk, muxRefused, muxUnreachable, type MuxAck, type MuxGrid, type MuxGridRequest, type MuxOutcome } from "../mux/types.ts";
import { forPlatform, loadProfiles, profileFor, resetProfileLog, type Profile, type ProfileForOptions, type ProfileStatus, type VersionRange } from "../../web/src/lib/surface/profile.ts";
import type { HeldCancelAnswer, SendAnswer } from "../../web/src/lib/surface/send.ts";
import { parseAnsi } from "../../web/src/lib/ansi.ts";
import { splitLines } from "../../web/src/lib/blocks.ts";
import { findInputFrame } from "../../web/src/lib/surface/frame.ts";
import { KeyGate } from "./key-gate.ts";
import { boxMatches, commandBoxMatches, GENERIC_PROBE, LOCK_BOUND_MS, locateText, neverHeldEntry, probeLanding, RowRing, runsInTurnEntry, SendProtocol, SessionLocks, steadyRow, type SendDeps, type SendRequest } from "./protocol.ts";
import { RequestStore } from "./requests.ts";
import { SurfaceLedger } from "./counters.ts";
import { HoldStore } from "./holds.ts";

const RULE = "─".repeat(40);
const WIDTH = 38;
const PROBE = "⌁";
/** A harness with no profile: a send on it goes in blind, with no read (a bare shell is one, harness ""). */
const NO_PROFILE = "nothing-known";
/**
 * A harness with a profile whose frame S0 never finds: the screen reads unknown(no-match), so a send
 * takes the two-tap manual Send and is probed against the probe's own landing spot. Its keys are the
 * generic ones (Enter, Backspace with slack 16, the generic probe, no paste). Codex
 * screens below stand in for such a pane: Codex has a profile since M56 spec 13.
 */
const FRAMELESS = "frameless-test";

/** The profile of {@link FRAMELESS}, built from a real one with every frame anchor made to never match. */
function framelessProfile(): Profile {
  const base = loadProfiles().get("agy")!;
  const never = { pattern: "(?!)", column: 0 };
  const { paste, ...rest } = base;
  void paste;
  return {
    ...rest,
    id: FRAMELESS,
    identity: { ...base.identity, agentNames: [] },
    versions: [{ ...base.versions[0], range: "0.0.0 - *", low: "0.0.0", high: null }],
    idle: { ...base.idle, frame: { ...base.idle.frame, top: never, prompt: { pattern: "(?!)(?<draft>.*)", column: 0 }, bottom: never }, runningRows: [] },
    keys: { ...base.keys, submit: ["Enter"], enterWhileRunning: "queues" },
    reservedLeads: ["/", "!", "@"],
    probe: { ...base.probe, char: GENERIC_PROBE },
  };
}
const DIALOG = [" Do you want to proceed?", " ❯ 1. Yes", "   2. No", " Esc to cancel · Enter to select"];

type Mode = "claude" | "generic" | "codex";

/** A pane that reacts to text and keys like a harness's input box, with knobs for every failure. */
class FakePane {
  revision = 1;
  transcript = ["> an earlier question", "An answer from the agent, two rows", "of it."];
  box = "";
  placeholder = 'Try "fix the failing tests"';
  status = ["  sonnet · project · main"];
  /** The rows under the box while it holds text, when they differ (Claude Code's footer follows the box). */
  statusWithText: string[] | null = null;
  /** The row under a generic box: a path, or a status line that counts. */
  footer = "~/project";
  over: string[] = [];
  popup: string[] | null = null;
  dialog: string[] | null = null;
  /** The keyboard belongs to something that draws nothing: typing does nothing. */
  swallow = false;
  /** The keyboard belongs to a search field above the box: typing lands there. */
  echo: { field: string; changesList: boolean } | null = null;
  list = ["  first match", "  second match"];
  backspaceRestores = true;
  /** A shell line: a box that starts with `!` shows the bang as its prompt glyph, as Claude's shell mode does. */
  bangPrompt = false;
  dropLastChar = false;
  enterSubmits = true;
  /**
   * A harness that swallows a too-soon Enter (#507, Muse): an Enter within this many ms of the last
   * text write does nothing. Null takes every Enter at once. Reads the rig's clock through {@link now}.
   */
  swallowEnterWithinMs: number | null = null;
  /** The rig's clock, for {@link swallowEnterWithinMs}; the test wires it. */
  now: (() => number) | null = null;
  private lastWriteAt: number | null = null;
  /**
   * Enter during a turn draws Claude Code 2.1.301's queued shape: the text on a pointer row with the
   * "ctrl+enter to send now" hint under it, both over the running row, instead of a transcript row.
   */
  drawsQueuedRow = false;
  collapseOver = 120;
  pastes = 0;
  readFails = false;
  readsSeen = 0;
  calls: string[] = [];
  keysSeen: string[] = [];
  /** A screen this many rows high shows only its last rows, so new rows scroll the rest up; null shows all. */
  height: number | null = null;
  /** With a height: a row that stays at the top of the screen while the rows under it scroll (Codex 0.163.0 pins the turn's prompt row). */
  pinned: string | null = null;
  /** A whole screen to answer every read with, as a capture holds it; null draws the fake box. */
  fixed: string | null = null;
  /** Runs after every text write or key, for scripted changes. */
  afterInput: ((pane: FakePane, what: string) => void) | null = null;
  /** Runs before every read; may change the screen or return a promise to hold the read. */
  beforeRead: ((pane: FakePane, n: number) => Promise<void> | void) | null = null;
  /** Runs when a text write or a key press arrives, before it acts; a promise held for ever is a hung multiplexer. */
  beforeWrite: ((pane: FakePane, what: string) => Promise<void> | void) | null = null;

  /**
   * Codex mode only: the rows Codex 0.163.0 draws for messages queued with Tab during a turn, the
   * header, one `↳` row per text and the edit hint (lab, M56 spec 13, 2026-10-16).
   */
  queued: string[] = [];
  /** Codex mode only: the status row under the box. One with no ` · ` in it leaves the box unframed. */
  codexStatus = "  GPT-6-Luna low · ~/project";
  /** Codex mode only: a welcome picture over the box that Codex hides once the box holds a character. */
  codexWelcome: string[] = [];
  /** Codex mode only: a hint row that stays put, where null draws the hint Codex shows for the box. */
  codexHint: string | null = null;
  /**
   * Codex mode only: a turn runs with no working row on the screen, as while an answer streams in
   * (lab, 0.163.0, 2026-10-16). Null reads the turn from the working row over the box.
   */
  turn: boolean | null = null;
  /**
   * Codex mode only: the 0.150 and 0.156 shape, where the queue hint takes the status row's place
   * (`tab to queue message   99% context left`) once the box holds text in a turn. False draws the
   * 0.159 and 0.163 shape: the status row stays and the hint takes the hint row's place under it.
   */
  queueHintOnStatus = false;
  /** Codex mode only: the edit hint under the queued texts (0.159 and 0.163; 0.150 draws `alt + ↑`). */
  queuedHint = "    shift+← edit last queued message";

  constructor(readonly mode: Mode = "claude") {}

  /** Codex mode: a turn runs while a running row stands over the box, or while {@link turn} says so. */
  private running(): boolean {
    return this.turn ?? this.over.some((row) => row.includes("esc to interrupt"));
  }

  private bump(): void {
    this.revision++;
  }

  private boxRows(): string[] {
    if (this.mode === "codex") {
      if (this.box === "") return ["\u001b[1m›\u001b[0m \u001b[2mAsk Codex to do anything\u001b[0m"];
      const rows: string[] = [];
      this.box.split("\n").forEach((line, li) => {
        const chunks = line.length === 0 ? [""] : (line.match(new RegExp(`.{1,${String(WIDTH)}}`, "gu")) ?? [""]);
        chunks.forEach((chunk, ci) => rows.push(li === 0 && ci === 0 ? `› ${chunk}` : `  ${chunk}`));
      });
      return rows;
    }
    if (this.mode === "generic") {
      const lines = this.box.split("\n");
      return lines.map((line, i) => (i === lines.length - 1 ? `${line}\u001b[7m \u001b[0m` : line));
    }
    if (this.box === "") return [`❯ \u001b[2m${this.placeholder}\u001b[0m`];
    if (this.bangPrompt && this.box.startsWith("!")) return [`! ${this.box.slice(1)}`];
    const rows: string[] = [];
    this.box.split("\n").forEach((line, li) => {
      const chunks = line.length === 0 ? [""] : (line.match(new RegExp(`.{1,${String(WIDTH)}}`, "gu")) ?? [""]);
      chunks.forEach((chunk, ci) => rows.push(li === 0 && ci === 0 ? `❯ ${chunk}` : `  ${chunk}`));
    });
    return rows;
  }

  render(): string {
    if (this.fixed !== null) return this.fixed;
    const rows = [...this.transcript, ""];
    if (this.echo !== null) rows.push(` Search: ${this.echo.field}`, ...this.list, "");
    if (this.dialog !== null) {
      rows.push(...this.dialog);
      return rows.join("\n");
    }
    if (this.mode === "codex") {
      // Codex draws no edge glyphs: a blank row, the prompt and draft rows, a blank row, the status row, the hint row.
      const queued = this.queued.length === 0 ? [] : ["", "• Queued follow-up inputs", ...this.queued.map((text) => `  ↳ ${text}`), this.queuedHint];
      // Codex (lab, 2026-10-16): the hint row goes once the box holds a character, and a turn shows its
      // queue hint whenever the box holds text: under the status row (0.159, 0.163), or in its place (0.150, 0.156).
      const queueHint = this.box !== "" && this.running();
      const onStatus = queueHint && this.queueHintOnStatus;
      const shown = this.box === "" ? "  ← for agents · ? for shortcuts" : queueHint && !onStatus ? "  tab to queue message" : null;
      const hint = this.codexHint ?? shown;
      const status = onStatus ? `  tab to queue message${" ".repeat(60)}99% context left` : this.codexStatus;
      const welcome = this.box === "" ? this.codexWelcome : [];
      rows.push(...welcome, ...this.over, ...queued, "", "", ...this.boxRows(), "", status, ...(hint === null ? [] : [hint]));
      if (this.height !== null && this.pinned !== null) return [this.pinned, ...rows.slice(-(this.height - 1))].join("\n");
      return (this.height === null ? rows : rows.slice(-this.height)).join("\n");
    }
    rows.push(...this.over, RULE, ...this.boxRows(), RULE);
    if (this.mode === "generic") rows.push(this.footer);
    else rows.push(...(this.popup ?? (this.box.length > 0 && this.statusWithText !== null ? this.statusWithText : this.status)));
    return (this.height === null ? rows : rows.slice(-this.height)).join("\n");
  }

  /** Whether an Enter now submits: a too-soon Enter is swallowed where {@link swallowEnterWithinMs} says so. */
  private takesEnter(): boolean {
    if (!this.enterSubmits) return false;
    if (this.swallowEnterWithinMs === null || this.now === null || this.lastWriteAt === null) return true;
    return this.now() - this.lastWriteAt >= this.swallowEnterWithinMs;
  }

  private take(text: string, pasted: boolean): void {
    if (this.now !== null) this.lastWriteAt = this.now();
    if (this.swallow || this.dialog !== null) return;
    if (this.echo !== null) {
      this.echo.field += text;
      if (this.echo.changesList) this.list = this.list.slice(1);
      this.bump();
      return;
    }
    let put = this.dropLastChar && text.length > 3 ? text.slice(0, -1) : text;
    if (pasted && put.length > this.collapseOver) put = `[Pasted text #${String(++this.pastes)}]`;
    this.box += put;
    this.bump();
  }

  // ── the multiplexer ports ──

  readGrid = async (paneId: string, request: MuxGridRequest): Promise<MuxOutcome<MuxGrid>> => {
    void request;
    this.readsSeen++;
    await this.beforeRead?.(this, this.readsSeen);
    if (this.readFails) return muxUnreachable("pane read failed");
    return muxOk({ paneId, text: this.render(), truncated: false, revision: this.revision });
  };

  typeText = (paneId: string, text: string): Promise<MuxAck> => {
    void paneId;
    const held = this.beforeWrite?.(this, `type:${text}`);
    if (held !== undefined) return held.then(() => muxAck());
    this.calls.push(`type:${text}`);
    this.take(text, text.length > 200);
    this.afterInput?.(this, `type:${text}`);
    return Promise.resolve(muxAck());
  };

  pasteText = (paneId: string, text: string): Promise<MuxAck> => {
    void paneId;
    const held = this.beforeWrite?.(this, `paste:${text}`);
    if (held !== undefined) return held.then(() => muxAck());
    this.calls.push(`paste:${text}`);
    this.take(text, true);
    this.afterInput?.(this, `paste:${text}`);
    return Promise.resolve(muxAck());
  };

  writeKeys = (paneId: string, keys: readonly string[]): Promise<MuxAck> => {
    void paneId;
    const held = this.beforeWrite?.(this, `keys:${keys.join(",")}`);
    if (held !== undefined) return held.then(() => muxAck());
    for (const key of keys) {
      this.keysSeen.push(key);
      if (this.swallow || this.dialog !== null) continue;
      if (key === "Backspace") {
        if (this.echo !== null) {
          this.echo.field = this.echo.field.slice(0, -1);
        } else if (this.backspaceRestores) {
          const chip = /\[Pasted text #\d+\]$/u.exec(this.box);
          this.box = chip === null ? [...this.box].slice(0, -1).join("") : this.box.slice(0, chip.index);
        }
      } else if (key === "ctrl+j") {
        this.box += "\n";
      } else if (key === "Tab" && this.mode === "codex") {
        // Codex 0.150.0, 0.159.2 and 0.163.0 (lab, 2026-10-16): Tab queues a draft during a turn, sends it when idle, and does nothing on an empty box.
        if (this.box.length > 0 && this.running()) this.queued.push(this.box.replace(/\n/gu, " "));
        else if (this.box.length > 0) this.transcript.push(`› ${this.box.replace(/\n/gu, " ")}`);
        this.box = "";
      } else if (key === "Enter" && this.mode === "codex" && this.takesEnter()) {
        // Enter during a Codex turn steers: the text joins the running turn, above the running row.
        if (this.box.length > 0 && this.running()) this.over = [`› ${this.box.replace(/\n/gu, " ")}`, "", ...this.over];
        else if (this.box.length > 0) this.transcript.push(`› ${this.box.replace(/\n/gu, " ")}`);
        this.box = "";
      } else if (key === "Enter" && this.takesEnter()) {
        if (this.drawsQueuedRow && this.box.length > 0) this.over = [`❯ ${this.box.replace(/\n/gu, " ")}`, "  ctrl+enter to send now", ...this.over];
        else if (this.box.length > 0) this.transcript.push(`> ${this.box.replace(/\n/gu, " ")}`);
        this.box = "";
      }
      this.bump();
    }
    this.afterInput?.(this, `keys:${keys.join(",")}`);
    return Promise.resolve(muxAck());
  };
}

// ── harness ──

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "collie-protocol-"));
  resetProfileLog();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

interface Rig {
  pane: FakePane;
  protocol: SendProtocol;
  deps: SendDeps & { gate: KeyGate; store: RequestStore; locks: SessionLocks; ring: RowRing };
  clock: { now: number };
  send: (text: string, over?: Partial<SendRequest>) => Promise<SendAnswer>;
}

let ids = 0;
function nextId(): string {
  ids++;
  return `req-${String(ids).padStart(6, "0")}`;
}

/**
 * The Claude range these tests were written against: verified through 2.1.296. In them 2.1.301 and
 * 2.1.302 stand for the provisional versions the live screens of 2026-10-17 came from, and the
 * probed path they take is what the tests prove. A harness lab run that moves claude.json's range
 * (2.1.302 on 2026-10-18) must not turn those versions verified under the tests, so the rig keeps
 * this range for Claude. profile.test.ts covers the shipped range itself.
 */
const CLAUDE_TEST_RANGE: readonly [VersionRange] = [
  { range: "2.1.0 - 2.1.296", low: "2.1.0", high: "2.1.296", status: "verified", verifiedThrough: "2.1.296", verifiedOn: "2026-10-12" },
];

function rig(
  options: {
    mode?: Mode;
    version?: string;
    harness?: string;
    paste?: boolean;
    pane?: FakePane;
    storeDir?: string;
    ledger?: SurfaceLedger;
    edit?: (profile: Profile) => Profile;
    status?: ProfileStatus;
    holds?: HoldStore;
    generation?: () => string | null;
    clock?: { now: number };
  } = {},
): Rig {
  const pane = options.pane ?? new FakePane(options.mode ?? "claude");
  const clock = options.clock ?? { now: 1_000_000 };
  const now = (): number => clock.now;
  const mux = options.paste === false ? { readGrid: pane.readGrid, typeText: pane.typeText } : { readGrid: pane.readGrid, typeText: pane.typeText, pasteText: pane.pasteText };
  const gate = new KeyGate(pane, now);
  const store = new RequestStore(options.storeDir ?? join(dir, "sends"), now);
  const locks = new SessionLocks();
  const ring = new RowRing();
  const version = options.version ?? "2.1.200";
  const deps = {
    mux,
    gate,
    store,
    locks,
    ring,
    profile: (harness: string) => {
      // An edited profile is matched as the bridge would match it, so an edited range moves the status.
      const { edit, status } = options;
      const loaded = harness === FRAMELESS ? framelessProfile() : loadProfiles().get(harness);
      const base = harness === "claude" && loaded !== undefined ? { ...loaded, versions: CLAUDE_TEST_RANGE } : loaded;
      const pinned = harness === FRAMELESS || harness === "claude";
      const profiles = base === undefined ? undefined : edit !== undefined ? new Map([[harness, edit(base)]]) : pinned ? new Map([[harness, base]]) : undefined;
      const lookup: ProfileForOptions = profiles === undefined ? { log: () => undefined } : { log: () => undefined, profiles };
      const match = profileFor(harness, version, lookup);
      if (match === null) return Promise.resolve(null);
      return Promise.resolve(status === undefined ? match : { ...match, status });
    },
    generation: options.generation ?? (() => "gen-1"),
    ledger: options.ledger,
    holds: options.holds,
    now,
    sleep: (ms: number) => {
      clock.now += ms;
      return Promise.resolve();
    },
  };
  const protocol = new SendProtocol(deps);
  const harness = options.harness ?? (options.mode === "generic" ? FRAMELESS : "claude");
  const send = (text: string, over: Partial<SendRequest> = {}): Promise<SendAnswer> =>
    protocol.handle({ id: nextId(), text, mode: "send", ...over }, { session: "main", paneId: "%1", harness });
  return { pane, protocol, deps, clock, send };
}

/** A profile whose harness does not queue a command entered during a turn (no `keys.commandWhileRunning`). */
function noCommandQueue(profile: Profile): Profile {
  const { commandWhileRunning, ...keys } = profile.keys;
  void commandWhileRunning;
  return { ...profile, keys };
}

/** A profile whose harness takes nothing in a turn: Enter steers it and no key queues (Hermes's shape). */
function steersWithNoQueueKey(profile: Profile): Profile {
  const { commandWhileRunning, queueKey, queueKeyByPlatform, ...keys } = profile.keys;
  void commandWhileRunning;
  void queueKey;
  void queueKeyByPlatform;
  return { ...profile, keys: { ...keys, enterWhileRunning: "steers" } };
}

function neverEscape(pane: FakePane): void {
  expect(pane.keysSeen.filter((key) => /^esc(ape)?$/iu.test(key))).toEqual([]);
}

// ── the happy paths ──

describe("a send that goes through", () => {
  test("free box, verified profile: one write, Enter through the gate, sent, with a full receipt", async () => {
    const { pane, send, deps } = rig();
    const answer = await send("please fix the failing test in the parser");
    expect(answer.receipt).toMatchObject({
      outcome: "sent",
      session: "main",
      paneId: "%1",
      paneGeneration: "gen-1",
      harness: "claude",
      version: "2.1.200",
      profileId: "claude",
      profileStatus: "verified",
      textLength: 41,
      keys: ["Enter"],
    });
    expect(answer.receipt?.reason).toBeUndefined();
    expect(answer.receipt?.s0).toMatchObject({ revision: expect.any(Number), hash: expect.any(String) });
    expect(answer.receipt?.s1).not.toBeNull();
    expect(answer.receipt?.s2).not.toBeNull();
    expect(Object.keys(answer.receipt?.gapsMs ?? {}).toSorted()).toEqual(["commit", "probe", "s0", "s1", "s2", "write"]);
    expect(answer.offers).toEqual([]);
    expect(pane.calls).toEqual(["paste:please fix the failing test in the parser"]);
    expect(pane.box).toBe("");
    expect(pane.transcript.at(-1)).toBe("> please fix the failing test in the parser");
    // The receipt is on disk, and the rows are only in memory.
    expect(deps.store.get(answer.receipt!.requestId)?.receipt).toEqual(answer.receipt);
    expect(deps.ring.size).toBeGreaterThan(0);
    neverEscape(pane);
  });

  test("a provisional profile takes the probed path: the probe, Backspace, then the text", async () => {
    const { pane, send } = rig({ version: "2.1.999" });
    const answer = await send("hello there, agent");
    expect(answer.receipt).toMatchObject({ outcome: "sent", profileStatus: "provisional", keys: ["probe", "Backspace", "Enter"] });
    expect(pane.calls).toEqual([`type:${PROBE}`, "paste:hello there, agent"]);
  });

  test("a text of one to three characters takes the probed path on a verified profile", async () => {
    const { pane, send } = rig();
    const answer = await send("ok");
    expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["probe", "Backspace", "Enter"] });
    expect(pane.calls[0]).toBe(`type:${PROBE}`);
  });

  test("a wrapped text is matched with white space and wrapping ignored", async () => {
    const { send } = rig();
    const text = "word ".repeat(30).trim();
    expect((await send(text)).receipt?.outcome).toBe("sent");
  });

  test("multi-line: each line is one write and the line break is the profile's newline key", async () => {
    const { pane, send } = rig();
    const answer = await send("first line\nsecond line\n");
    expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["ctrl+j", "Enter"] });
    expect(pane.calls).toEqual(["paste:first line", "paste:second line"]);
    expect(pane.transcript.at(-1)).toBe("> first line second line");
  });

  test("control bytes, tabs and paste markers never reach the pane", async () => {
    const { pane, send } = rig();
    await send("a\tb\u001b[201~c\u0007d\u007f");
    expect(pane.calls).toEqual(["paste:a bcd"]);
  });

  test("the collapse form: a long paste the harness folds still matches", async () => {
    const { pane, send } = rig();
    const long = "x".repeat(400);
    const answer = await send(long);
    expect(answer.receipt?.outcome).toBe("sent");
    expect(pane.calls).toEqual([`paste:${long}`]);
    expect(pane.transcript.at(-1)).toBe("> [Pasted text #1]");
  });

  test("bracketed paste off: with no paste call the text is typed", async () => {
    const { pane, send } = rig({ paste: false });
    expect((await send("typed, not pasted")).receipt?.outcome).toBe("sent");
    expect(pane.calls).toEqual(["type:typed, not pasted"]);
  });

  test("a running sign after Enter counts as taken, even with the box still full", async () => {
    const { pane, send } = rig();
    pane.enterSubmits = false;
    pane.afterInput = (p, what) => {
      if (what === "keys:Enter") p.over = ["✻ Thinking… (2s · esc to interrupt)"];
    };
    expect((await send("start the long job")).receipt?.outcome).toBe("sent");
  });

  test("a turn that starts while the text goes in stops the send before an Enter that would steer it", async () => {
    // S0 reads idle; the turn's row shows up once the text is in. Where Enter queues, it goes; where
    // Enter steers the turn (Hermes's shape), the text stays in the box and no Enter is pressed.
    const steering = rig({ edit: steersWithNoQueueKey });
    steering.pane.afterInput = (p, what) => {
      if (what.includes("then summarize the changes")) p.over = [LIVE_ROW];
    };
    const answer = await steering.send("then summarize the changes");
    expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "changed" });
    expect(answer.detail).toBe("A turn started while the text was typed, so Enter was not pressed. The text is in the box. Submit it when the turn ends.");
    expect(steering.pane.keysSeen).not.toContain("Enter");
    const queuing = rig();
    queuing.pane.afterInput = (p, what) => {
      if (what.includes("then summarize the changes")) p.over = [LIVE_ROW];
    };
    expect((await queuing.send("then summarize the changes")).receipt?.outcome).toBe("sent");
  });
});

describe("a harness that swallows a too-soon Enter takes the send with its profile settle (#507)", () => {
  // Muse on 1.4.10: the checked send wrote the text and sent Enter ~85 ms later, the box never
  // emptied, and the receipt read unknown/no_evidence with keys [probe, Backspace, Enter]. The fake
  // pane below swallows an Enter within 350 ms of the text write, the way the reply route measured
  // on Muse 1.4.4 (fails at <=50 ms, smallest success 411 ms).
  const swallowRig = (options: { edit?: (profile: Profile) => Profile } = {}) => {
    const clock = { now: 1_000_000 };
    const pane = new FakePane("claude");
    pane.now = () => clock.now;
    pane.swallowEnterWithinMs = 350;
    const rigOptions: Parameters<typeof rig>[0] = { pane, clock, harness: "muse", version: "1.4.5" };
    if (options.edit !== undefined) rigOptions.edit = options.edit;
    return rig(rigOptions);
  };

  test("muse: the settle holds Enter past the swallow window and the send goes through", async () => {
    const { pane, send } = swallowRig();
    const answer = await send("please fix the parser test");
    expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["probe", "Backspace", "Enter"] });
    expect(answer.receipt?.gapsMs.s1).toBeGreaterThanOrEqual(350);
    expect(pane.box).toBe("");
    neverEscape(pane);
  });

  test("with no settle the same pane swallows Enter: unknown/no_evidence, the text still in the box", async () => {
    const { pane, send } = swallowRig({ edit: (profile) => ({ ...profile, paste: { bracketed: true } }) });
    const answer = await send("please fix the parser test");
    expect(answer.receipt).toMatchObject({ outcome: "unknown", reason: "no_evidence", keys: ["probe", "Backspace", "Enter"] });
    expect(pane.box).toBe("please fix the parser test");
    neverEscape(pane);
  });
});

/** A plain shell pane as the dev lane read it on v1.22.4 (Herdr agent `shell`): the Bluefin motd, then a starship prompt. */
const SHELL_SCREEN = "shell--starship-bluefin-motd--w117.txt";

describe("a pane with no profile is typed and Entered blind (a bare shell, 2026-10-17 field case)", () => {
  // On v1.22.4 both a send and a command on a plain shell were refused `unconfirmed` with `no-match`:
  // a pane with no profile took the two-tap manual Send. It takes the send the way 1.21.3 did.
  test.each([
    ["send", "claude-danger", ""],
    ["command", "/usr/bin/true", ""],
    ["send", "claude-danger", NO_PROFILE],
    ["command", "!ls", NO_PROFILE],
  ] as const)("%s %p on harness %p: no read, the text, Enter, sent, and the receipt says no-profile", async (mode, text, harness) => {
    const pane = new FakePane("generic");
    pane.fixed = readFileSync(join(import.meta.dir, `../../web/src/fixtures/panes/${SHELL_SCREEN}`), "utf8");
    const { send, deps } = rig({ pane, harness });
    const answer = await send(text, { mode });
    expect(answer.receipt).toMatchObject({ outcome: "sent", harness, profileId: null, profileStatus: null, keys: ["Enter"], s0: { hash: expect.any(String) }, s1: null, s2: null });
    expect(answer.receipt?.reason).toBeUndefined();
    expect(answer.receipt?.saw).toEqual({ turn: "unknown", modal: "unknown", composer: "unknown", reason: "no-profile" });
    expect(answer.offers).toEqual([]);
    expect(answer.rowsHash).toBeUndefined();
    // One read, for the password-prompt stop only: no second S0 read, no probe, no S1, no S2.
    expect(pane.readsSeen).toBe(1);
    expect(pane.calls).toEqual([`type:${text}`]);
    expect(pane.keysSeen).toEqual(["Enter"]);
    expect(Object.keys(answer.receipt?.gapsMs ?? {}).toSorted()).toEqual(["commit", "s0", "write"]);
    // The receipt is on disk with its saw, and reads back the same.
    expect(deps.store.get(answer.receipt!.requestId)?.receipt).toEqual(answer.receipt);
    neverEscape(pane);
  });

  test("a send on a pane with no profile is never held, even with a hold queue and a screen that will not hold still", async () => {
    const holds = new HoldStore(join(dir, "held"));
    const r = rig({ harness: "", holds });
    r.pane.beforeRead = (p) => {
      p.transcript.push("a row that came in");
    };
    const answer = await r.send("hello");
    expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["Enter"] });
    expect(holds.list()).toEqual([]);
    expect(r.pane.readsSeen).toBe(1);
  });

  // The password-prompt stop (#103, ADR 0017): a prompt that does not echo would swallow the text and
  // Enter would submit it as a password. The phone's own detector reads the last rows first.
  const shellScreen = (lastRow: string): FakePane => {
    const pane = new FakePane("generic");
    const rows = readFileSync(join(import.meta.dir, `../../web/src/fixtures/panes/${SHELL_SCREEN}`), "utf8").split("\r\n");
    rows[rows.length - 1] = lastRow;
    pane.fixed = rows.join("\r\n");
    return pane;
  };

  test("a shell at a sudo password prompt refuses the send before any key, offers the key pad, and is never held", async () => {
    const holds = new HoldStore(join(dir, "held"));
    const pane = shellScreen("[sudo] password for altan: ");
    const { send } = rig({ pane, harness: "", holds });
    const answer = await send("claude-danger");
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "not_free", profileId: null, keys: [] });
    expect(answer.offers).toEqual(["keys"]);
    expect(answer.detail).toBe("A password prompt is waiting on the last row. Collie does not type into it from the text box. Use Type to answer it.");
    // The receipt never keeps the prompt's row: it names a user.
    expect(JSON.stringify(answer.receipt)).not.toContain("altan");
    expect(pane.calls).toEqual([]);
    expect(pane.keysSeen).toEqual([]);
    expect(holds.list()).toEqual([]);
  });

  test("the same shell at its normal starship prompt is sent", async () => {
    const pane = shellScreen("❯ ");
    const { send } = rig({ pane, harness: "" });
    expect((await send("claude-danger")).receipt).toMatchObject({ outcome: "sent", keys: ["Enter"] });
    expect(pane.calls).toEqual(["type:claude-danger"]);
    expect(pane.keysSeen).toEqual(["Enter"]);
  });

  test("an Enter the multiplexer refuses leaves the text typed, and offers only the key pad: there is no rows hash to bind a Submit to", async () => {
    const r = rig({ mode: "generic", harness: "" });
    r.pane.writeKeys = () => Promise.resolve(muxRefused("no such pane"));
    const answer = await r.send("make test");
    expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "submit_failed", keys: [] });
    expect(answer.receipt?.saw).toMatchObject({ reason: "no-profile" });
    expect(answer.offers).toEqual(["keys"]);
    expect(r.pane.calls).toEqual(["type:make test"]);
  });

  test("a pane that changed program is refused before any key", async () => {
    // The accept files gen-1; the program changed before the text went in.
    let reads = 0;
    const r = rig({ mode: "generic", harness: "", generation: () => (reads++ === 0 ? "gen-1" : "gen-2") });
    const answer = await r.send("make test");
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "pane_gone", keys: [] });
    expect(r.pane.calls).toEqual([]);
  });

  test("multi-line text on a pane with no profile is refused multiline: its newline key is unknown", async () => {
    const { pane, send } = rig({ mode: "generic", harness: NO_PROFILE });
    const answer = await send("a\nb");
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "multiline", keys: [] });
    expect(answer.detail).toContain("one line at a time");
    expect(pane.calls).toEqual([]);
  });

  test("prepare on a pane with no profile offers nothing: the next tap is a plain send", async () => {
    const { pane, protocol } = rig({ mode: "generic", harness: "" });
    const prepared = await protocol.handle({ id: "unused-prepare", text: "", mode: "prepare" }, { session: "main", paneId: "%1", harness: "" });
    expect(prepared.offers).toEqual([]);
    expect(pane.calls).toEqual([]);
  });
});

describe("a profile whose frame S0 cannot find", () => {
  test("the screen is unknown(no-match): the first tap is refused unconfirmed with the rows hash", async () => {
    const { pane, send } = rig({ mode: "generic" });
    const answer = await send("hello from the phone");
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "unconfirmed", profileId: FRAMELESS, keys: [] });
    expect(answer.rowsHash).toMatch(/^[0-9a-f]{14}$/u);
    expect(answer.surface).toMatchObject({ turn: "unknown", modal: "unknown", composer: "unknown", reason: "no-match" });
    expect(answer.offers).toEqual(["commit", "keys"]);
    expect(pane.calls).toEqual([]);
  });

  test("prepare reads and hands back the rows hash, and writes nothing", async () => {
    const { pane, protocol } = rig({ mode: "generic" });
    const prepared = await protocol.handle({ id: "unused-prepare", text: "", mode: "prepare" }, { session: "main", paneId: "%1", harness: FRAMELESS });
    expect(prepared.receipt).toBeUndefined();
    expect(prepared.rowsHash).toMatch(/^[0-9a-f]{14}$/u);
    expect(prepared.offers).toEqual(["commit", "keys"]);
    expect(pane.calls).toEqual([]);
    expect(pane.keysSeen).toEqual([]);
  });

  test("the commit with the rows hash takes the probed path and is sent", async () => {
    const { pane, send } = rig({ mode: "generic" });
    const first = await send("hello from the phone");
    const answer = await send("hello from the phone", { rowsHash: first.rowsHash! });
    expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["probe", "Backspace", "Enter"] });
    // No profile: never a paste, and the generic probe character.
    expect(pane.calls).toEqual([`type:${GENERIC_PROBE}`, "type:hello from the phone"]);
    expect(pane.transcript.at(-1)).toBe("> hello from the phone");
  });

  test("a status row under the box that changes on submit does not hide the send (live on pi 0.87.1)", async () => {
    const { pane, send } = rig({ mode: "generic" });
    pane.footer = "0.0%/200k (auto)";
    pane.afterInput = (p, what) => {
      if (what.endsWith("Enter")) p.footer = "0.9%/200k (auto)";
    };
    const first = await send("count my tokens");
    const answer = await send("count my tokens", { rowsHash: first.rowsHash! });
    expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["probe", "Backspace", "Enter"] });
  });

  test("a commit whose rows moved since the person looked is refused stale_surface", async () => {
    const { pane, send } = rig({ mode: "generic" });
    const first = await send("hello");
    pane.transcript.push("a new line arrived");
    const answer = await send("hello", { rowsHash: first.rowsHash! });
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "stale_surface" });
    expect(answer.rowsHash).not.toBe(first.rowsHash);
    expect(pane.calls).toEqual([]);
  });

  test("a search field that echoes the probe and narrows its list fails the probe; one Backspace takes the probe out of the field, and no text follows", async () => {
    const { pane, send } = rig({ mode: "generic" });
    const first = await send("hello");
    pane.echo = { field: "", changesList: true };
    pane.list = ["  first match", "  second match"];
    const again = await send("hello", { rowsHash: first.rowsHash! });
    // The rows moved (the field drew): the commit is stale first.
    expect(again.receipt?.reason).toBe("stale_surface");
    const answer = await send("hello", { rowsHash: again.rowsHash! });
    // The narrowed list is not a hint that hid, so the probe fails. Its character stands once, on the
    // row it was put into, so one Backspace removes it; nothing of the text is typed.
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "probe_failed", keys: ["probe", "Backspace"] });
    expect(pane.keysSeen).toEqual(["Backspace"]);
    expect(pane.calls).toEqual([`type:${GENERIC_PROBE}`]);
    expect(pane.echo?.field).toBe("");
  });

  test("the honest limit: a field with no cue that only echoes takes the probed text, and nothing proves it was taken", async () => {
    const { pane, send } = rig({ mode: "generic" });
    pane.echo = { field: "", changesList: false };
    const first = await send("hello");
    const answer = await send("hello", { rowsHash: first.rowsHash! });
    // With no profile the probe's landing spot IS the box: one new run, Backspace gave it back. The
    // text lands in that field (ARCHITECTURE.md, "Honest limits": it approves nothing), the person had
    // confirmed the rows, and since the field never empties S2 has no evidence: unknown, not sent.
    expect(answer.receipt).toMatchObject({ outcome: "unknown", reason: "no_evidence", keys: ["probe", "Backspace", "Enter"] });
    expect(pane.echo?.field).toBe("hello");
  });
});

/** The welcome picture a fresh Codex 0.163.0 session draws above the box, as the M56 lab read it on 2026-10-16. */
const CODEX_WELCOME: string[] = ["               ⣀⣤⣤⣤⣀⣀", "            ⣠⣶⣿⣿⣿⣿⣿⣿⣿⣿⣦⣤⣤⣤⣤⣤⣤⡀", "          ⢀⣾⣿⣿⠿⠋⠉⠉⢉⣭⣿⣿⣿⣿⣿⠿⣿⣿⣿⣿⣷⣄", "         ⣀⣾⣿⣿⠃ ⣀⣴⣾⣿⣿⡿⠟⠋ ⣀⡀ ⠈⠙⢿⣿⣿⣧", "      ⣀⣶⣿⣿⣿⣿⡇ ⢸⣿⣿⡿⠛⠉⢀⣠⣴⣿⣿⣿⣷⣦⣀⠈⢻⣿⣿⡇", "     ⣰⣿⣿⡿⢿⣿⣿⡇ ⢸⣿⣿⢀⣤⣶⣿⣿⣿⠟⠛⠻⣿⣿⣿⣿⣮⣿⣿⡷", "    ⢰⣿⣿⡟⠁⢸⣿⣿⡇ ⢸⣿⣿⣿⣿⠿⠿⣿⣿⣿⣦⣄⡀⠈⠛⠿⣿⣿⣿⣧⡀", "    ⣾⣿⣿⠃ ⢸⣿⣿⡇ ⢸⣿⣿⠋⠁  ⠈⠙⢻⣿⣿⣿⣶⣤⡀ ⠹⢿⣿⣷⡄", "    ⢸⣿⣿⣇ ⠸⣿⣿⣷⣦⣼⣿⣿      ⢸⣿⣿⠻⢿⣿⣿⡇ ⠘⣿⣿⣿", "    ⠈⢿⣿⣿⣦⡀⠈⠛⠿⣿⣿⣿⣿⣄⡀  ⢀⣠⣼⣿⣿  ⣿⣿⡇  ⣿⣿⣿⠇", "      ⢻⣿⣿⣿⣷⣦⣀⠈⠙⠻⣿⣿⣿⣶⣶⣿⣿⣿⣿⣿  ⣿⣿⡇ ⣠⣿⣿⣿", "      ⢸⣿⣿⡿⢿⣿⣿⣿⣦⣠⣴⣿⣿⣿⡿⠟⠋⢸⣿⣿  ⣿⣿⣷⣴⣿⣿⣿⠃", "      ⠘⣿⣿⣷ ⠈⠛⢿⣿⣿⣿⠿⠋⠉ ⣠⣴⣿⣿⣿  ⣿⣿⣿⣿⣿⠟⠁", "       ⠻⣿⣿⣿⣤⣀ ⠈⠉ ⢀⣤⣶⣿⣿⣿⠿⠟⠁ ⣰⣿⣿⡟⠋⠁", "        ⠈⠿⣿⣿⣿⣿⣶⣾⣿⣿⣿⣿⠟⠋⠁  ⣠⣼⣿⣿⡟", "           ⠙⠛⠛⠛⠻⠛⢿⣿⣿⣿⣿⣷⣾⣿⣿⣿⡿⠏", "                  ⠈⠙⠛⠿⠿⠿⠿⠛⠉"];

/**
 * Codex 0.163.0 as the lab read it (2026-10-16, tmux 3.7c, 100 columns), home path cut: no frame, a
 * dim placeholder on the `›` row, the status row, and the hint row `← for agents · ? for shortcuts`,
 * which Codex hides as soon as the box holds one character (also seen on 0.162.1 in the send drill).
 * `logo` stands for the welcome art a fresh session shows above the box until the box holds a character.
 */
class CodexPane extends FakePane {
  logo: string[] = [];
  constructor() {
    super("generic");
    this.transcript = ["  >_ OpenAI Codex (v0.163.0)", "     ~/project", "", "› reply with one word: ready", "", "• ready", "", "  Worked for 1s • 5:53 AM"];
  }

  override render(): string {
    const empty = this.box === "";
    return [
      ...this.transcript,
      ...(empty ? this.logo : this.logo.map(() => "")),
      "",
      "",
      empty ? "\u001b[1m›\u001b[0m \u001b[2mAsk Codex to do anything\u001b[0m" : `\u001b[1m›\u001b[0m ${this.box}`,
      "",
      "  GPT-6.1-Sol default · ~/project · Reply ready",
      empty ? "  \u001b[1m←\u001b[0m for agents · \u001b[1m?\u001b[0m for shortcuts" : "",
    ].join("\n");
  }
}

/**
 * Codex 0.163.0 as Herdr reads it (send drill 2 and the lab of 2026-10-16, a 120 by 40 pane, home path
 * as read): the header, the welcome picture of a fresh session, the box on screen row 36, the status
 * row on 38 and the hint row on 39. Herdr's pane read leaves out the trailing blank rows, so once the
 * hint row hides the read is one row shorter than at S0; tmux always reads the whole pane.
 */
class HerdrCodexPane extends FakePane {
  sent: string[] = [];
  constructor() {
    super("generic");
  }

  override render(): string {
    const empty = this.box === "";
    const path = "~/.cache/collie-lab/lab-m56-codex-2/repo";
    const rows: string[] = Array.from({ length: 40 }, () => "");
    rows[1] = "  >_ \u001b[1mOpenAI Codex\u001b[0m\u001b[2m (v0.163.0)\u001b[0m";
    rows[2] = `     \u001b[2m${path}\u001b[0m`;
    if (this.sent.length === 0 && empty) CODEX_WELCOME.forEach((row, i) => (rows[11 + i] = " ".repeat(39) + row));
    this.sent.forEach((text, i) => (rows[5 + 2 * i] = `\u001b[1m\u001b[2m› \u001b[0m${text}`));
    rows[36] = empty ? "\u001b[1m›\u001b[0m \u001b[2mAsk Codex to do anything\u001b[0m" : `\u001b[1m›\u001b[0m ${this.box}`;
    rows[38] = `  GPT-6-Luna medium · ${path}`;
    if (empty) rows[39] = "  \u001b[1m←\u001b[0m for agents · \u001b[1m?\u001b[0m for shortcuts";
    while (rows.length > 0 && rows[rows.length - 1]!.trim().length === 0) rows.pop();
    return rows.join("\n");
  }
}

describe("a manual send compares less (M56 send drill, 2026-10-16)", () => {
  test("Codex hides its hint row once the box holds a character: the manual Send passes the probe and is sent", async () => {
    const pane = new CodexPane();
    const { send } = rig({ pane, harness: FRAMELESS });
    const first = await send("reply with one word: ok");
    expect(first.receipt).toMatchObject({ outcome: "refused", reason: "unconfirmed", profileId: FRAMELESS, keys: [] });
    // The same words as the phone's catalog line printed above it.
    expect(first.detail).toBe("Collie cannot read this screen. Check the pane, then tap Type here.");
    const answer = await send("reply with one word: ok", { rowsHash: first.rowsHash! });
    expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["probe", "Backspace", "Enter"] });
    expect(pane.calls).toEqual([`type:${GENERIC_PROBE}`, "type:reply with one word: ok"]);
    expect(pane.transcript.at(-1)).toBe("> reply with one word: ok");
    expect(pane.box).toBe("");
    neverEscape(pane);
  });

  test("a fresh Codex 0.163.0 hides its welcome picture once the box holds a character: the rows above only lost text, so the first message is sent", async () => {
    const pane = new CodexPane();
    pane.transcript = ["", "  >_ OpenAI Codex (v0.163.0)", "     ~/project", "", "", "", "", "", "", "", ""];
    pane.logo = CODEX_WELCOME;
    // The picture comes back when the box is empty again (seen live after the probe's Backspace),
    // and is gone for good once a message went in.
    pane.afterInput = (_p, what) => {
      if (what.endsWith("Enter")) pane.logo = [];
    };
    const { send } = rig({ pane, harness: FRAMELESS });
    const first = await send("reply with one word: hi");
    expect(first.receipt).toMatchObject({ outcome: "refused", reason: "unconfirmed", keys: [] });
    const answer = await send("reply with one word: hi", { rowsHash: first.rowsHash! });
    expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["probe", "Backspace", "Enter"] });
    expect(pane.calls).toEqual([`type:${GENERIC_PROBE}`, "type:reply with one word: hi"]);
    expect(pane.transcript.at(-1)).toBe("> reply with one word: hi");
  });

  test("Codex on Herdr: the read is one row shorter once the hint row hides, and the first and second messages are still sent", async () => {
    const pane = new HerdrCodexPane();
    pane.afterInput = (p, what) => {
      if (what.endsWith("Enter") && p instanceof HerdrCodexPane) p.sent.push(p.transcript.at(-1)!.slice(2));
    };
    const { send } = rig({ pane, harness: FRAMELESS });
    for (const text of ["reply with one word: ok", "say ok"]) {
      const look = await send(text);
      expect(look.receipt).toMatchObject({ outcome: "refused", reason: "unconfirmed", keys: [] });
      const answer = await send(text, { rowsHash: look.rowsHash! });
      expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["probe", "Backspace", "Enter"] });
      expect(pane.transcript.at(-1)).toBe(`> ${text}`);
    }
    expect(pane.calls).toEqual([`type:${GENERIC_PROBE}`, "type:reply with one word: ok", `type:${GENERIC_PROBE}`, "type:say ok"]);
    neverEscape(pane);
  });

  test("Codex on Herdr: a row under the box that shows other text still fails, though the read got shorter", async () => {
    const pane = new HerdrCodexPane();
    const render = pane.render.bind(pane);
    pane.render = () => (pane.box.length > 1 ? render().replace("  GPT-6-Luna medium", "  ❯ hello-world.ts") : render());
    const { send } = rig({ pane, harness: FRAMELESS });
    const look = await send("hello");
    const answer = await send("hello", { rowsHash: look.rowsHash! });
    expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "mismatch", keys: ["probe", "Backspace"] });
  });

  test("on the manual path a row above the box that gains text still fails the probe, with no frame and with one", async () => {
    const bare = new CodexPane();
    const noFrame = rig({ pane: bare, harness: FRAMELESS });
    const first = await noFrame.send("hello");
    bare.afterInput = (p, what) => {
      if (what === `type:${GENERIC_PROBE}`) p.transcript[5] = "• ready, and more text";
    };
    expect((await noFrame.send("hello", { rowsHash: first.rowsHash! })).receipt).toMatchObject({ outcome: "refused", reason: "probe_failed" });
    expect(bare.calls).toEqual([`type:${GENERIC_PROBE}`]);

    const framed = rig();
    framed.pane.transcript = Array.from({ length: 12 }, (_, i) => `transcript row ${String(i)}`);
    framed.pane.over = ["● How is the agent doing this session? (optional)", "  1: Bad    2: Fine    3: Good    0: Dismiss"];
    const look = await framed.send("carry on");
    expect(look.surface?.modal).toBe("unreadable");
    framed.pane.afterInput = (p, what) => {
      if (what === `type:${PROBE}`) p.transcript.splice(2, 0, "a new row of output");
    };
    expect((await framed.send("carry on", { rowsHash: look.rowsHash! })).receipt).toMatchObject({ outcome: "refused", reason: "probe_failed" });
    expect(framed.pane.calls).toEqual([`type:${PROBE}`]);
  });

  test("on the manual path a framed transcript that only lost a row above the box still goes through", async () => {
    const { pane, send } = rig();
    pane.transcript = Array.from({ length: 12 }, (_, i) => `transcript row ${String(i)}`);
    pane.over = ["● How is the agent doing this session? (optional)", "  1: Bad    2: Fine    3: Good    0: Dismiss"];
    const look = await send("carry on");
    pane.afterInput = (p, what) => {
      if (what === `type:${PROBE}`) p.transcript[2] = "";
    };
    expect((await send("carry on", { rowsHash: look.rowsHash! })).receipt).toMatchObject({ outcome: "sent", keys: ["probe", "Backspace", "Enter"] });
  });

  test("with no frame, a row under the box that shows other text still fails the probe", async () => {
    const pane = new CodexPane();
    const { send } = rig({ pane, harness: FRAMELESS });
    const first = await send("hello");
    // A row under the box that turns into a list entry is not a hint that hid.
    const render = pane.render.bind(pane);
    pane.render = () => (pane.box === "" ? render() : render().replace("  GPT-6.1-Sol default · ~/project · Reply ready", "  ❯ hello-world.ts"));
    const answer = await send("hello", { rowsHash: first.rowsHash! });
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "probe_failed" });
    expect(pane.calls).toEqual([`type:${GENERIC_PROBE}`]);
  });

  test("a manual send on a framed screen lets the rows under the box move, but a changed row above it still fails", async () => {
    const setup = (): Rig => {
      const r = rig();
      r.pane.transcript = Array.from({ length: 12 }, (_, i) => `transcript row ${String(i)}`);
      r.pane.over = ["● How is the agent doing this session? (optional)", "  1: Bad    2: Fine    3: Good    0: Dismiss"];
      return r;
    };
    const below = setup();
    below.pane.afterInput = (p, what) => {
      if (what.startsWith("type:") || what.startsWith("paste:")) p.status = [];
      if (what.endsWith("Enter")) p.status = ["  sonnet · project · main"];
    };
    const look = await below.send("carry on");
    expect(look.surface?.modal).toBe("unreadable");
    expect((await below.send("carry on", { rowsHash: look.rowsHash! })).receipt).toMatchObject({ outcome: "sent", keys: ["probe", "Backspace", "Enter"] });

    const above = setup();
    above.pane.afterInput = (p, what) => {
      if (what === `type:${PROBE}`) p.transcript[3] = "a transcript row that moved";
    };
    const again = await above.send("carry on");
    const answer = await above.send("carry on", { rowsHash: again.rowsHash! });
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "probe_failed" });
    expect(above.pane.calls).toEqual([`type:${PROBE}`]);
  });

  test("a profiled pane on a free screen keeps the strict compare where Enter does not queue: a row above the box or a hint under it that changes fails the probe", async () => {
    // On a harness that does not queue, a row above the box must stand still while Collie types.
    // (A harness that queues lets it move: the rows above the box, a sending drill below.)
    const rowAbove = rig({ version: "2.1.999", edit: (profile) => ({ ...profile, keys: { ...profile.keys, enterWhileRunning: "submits" } }) });
    // Rows close over the box are its volatile band; a transcript row above that band must stand still.
    rowAbove.pane.transcript = Array.from({ length: 12 }, (_, i) => `transcript row ${String(i)}`);
    rowAbove.pane.afterInput = (p, what) => {
      if (what === `type:${PROBE}`) p.transcript[0] = "> a different question";
    };
    expect((await rowAbove.send("hello there")).receipt).toMatchObject({ outcome: "refused", reason: "probe_failed" });
    expect(rowAbove.pane.calls).toEqual([`type:${PROBE}`]);

    const hintBelow = rig({ version: "2.1.999" });
    hintBelow.pane.afterInput = (p, what) => {
      if (what === `type:${PROBE}`) p.status = [];
    };
    expect((await hintBelow.send("hello there")).receipt).toMatchObject({ outcome: "refused", reason: "probe_failed" });
    expect(hintBelow.pane.calls).toEqual([`type:${PROBE}`]);
  });
});

describe("after a failed probe", () => {
  test("the probe character standing once in the box gets one Backspace through the gate, and the detail says the box is clean again", async () => {
    // A row above the box that shows new text while the probe goes in is text the rows gained:
    // the probe fails, and its character stands in the box.
    const pane = new CodexPane();
    const { send, deps } = rig({ pane, harness: FRAMELESS });
    const first = await send("hello");
    pane.afterInput = (p, what) => {
      if (what === `type:${GENERIC_PROBE}`) p.transcript[7] = "  Worked for 2s • 5:53 AM";
    };
    const answer = await send("hello", { rowsHash: first.rowsHash! });
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "probe_failed", keys: ["probe", "Backspace"] });
    expect(answer.detail).toBe("The probe character changed more than the box. One Backspace removed the probe character, so the box is clean again.");
    expect(pane.box).toBe("");
    expect(pane.calls).toEqual([`type:${GENERIC_PROBE}`]);
    expect(pane.keysSeen).toEqual(["Backspace"]);
    // The Backspace went through the gate: it is in the receipt on disk too.
    expect(deps.store.get(answer.receipt!.requestId)?.receipt?.keys).toEqual(["probe", "Backspace"]);
    expect(answer.surface?.composer).not.toBe("draft");
  });

  test("a framed box that took the probe and a hint that hid under it: the strict probe fails, one Backspace cleans the box", async () => {
    const { pane, send } = rig({ version: "2.1.999" });
    pane.afterInput = (p, what) => {
      if (what === `type:${PROBE}`) p.status = [];
    };
    const answer = await send("hello there");
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "probe_failed", keys: ["probe", "Backspace"] });
    expect(answer.detail).toContain("the box is clean again");
    expect(pane.box).toBe("");
  });

  test("a probe character that shows nowhere gets no key, and the detail says one may remain in the box", async () => {
    const { pane, send } = rig({ version: "2.1.999" });
    pane.swallow = true;
    const answer = await send("hello there");
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "probe_failed", keys: ["probe"] });
    expect(answer.detail).toBe(`The probe character did not show in the box. A probe character (${PROBE}) may remain in the box. Check the pane before you type.`);
    expect(pane.keysSeen).toEqual([]);
  });

  test("a probe character that shows twice (one already on screen) gets no key, and the detail says one may remain in the box", async () => {
    const { pane, send } = rig({ version: "2.1.999" });
    pane.transcript.push(`an earlier line that shows ${PROBE}`);
    pane.afterInput = (p, what) => {
      if (what === `type:${PROBE}`) p.status = [];
    };
    const answer = await send("hello there");
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "probe_failed", keys: ["probe"] });
    expect(answer.detail).toContain("may remain in the box");
    expect(pane.keysSeen).toEqual([]);
    expect(pane.box).toBe(PROBE);
  });
});

// ── refusals, step by step ──

describe("accept", () => {
  test("the same id twice returns the same receipt and sends nothing more", async () => {
    const { pane, protocol } = rig();
    const request: SendRequest = { id: "same-id-0001", text: "only once", mode: "send" };
    const target = { session: "main", paneId: "%1", harness: "claude" };
    const first = await protocol.handle(request, target);
    const second = await protocol.handle(request, target);
    expect(second.receipt).toEqual(first.receipt);
    expect(second.replayed).toBe(true);
    expect(pane.calls).toEqual(["paste:only once"]);
    expect(pane.keysSeen).toEqual(["Enter"]);
  });

  test("the same id with another text is refused id_reused and the first receipt stays", async () => {
    const { pane, protocol, deps } = rig();
    const target = { session: "main", paneId: "%1", harness: "claude" };
    const first = await protocol.handle({ id: "same-id-0002", text: "first", mode: "send" }, target);
    const other = await protocol.handle({ id: "same-id-0002", text: "second", mode: "send" }, target);
    expect(other.receipt).toMatchObject({ outcome: "refused", reason: "id_reused" });
    expect(deps.store.get("same-id-0002")?.receipt).toEqual(first.receipt);
    expect(pane.calls).toEqual(["paste:first"]);
  });

  test("a retry of the same id while it runs waits and answers the same receipt", async () => {
    const { protocol } = rig();
    const target = { session: "main", paneId: "%1", harness: "claude" };
    const request: SendRequest = { id: "same-id-0003", text: "in flight", mode: "send" };
    const [a, b] = await Promise.all([protocol.handle(request, target), protocol.handle(request, target)]);
    expect(b.receipt).toEqual(a.receipt);
  });

  test("a leading slash, bang or at is refused reserved_lead with the verb route named, before any read", async () => {
    for (const text of ["/model", "  !ls -la", "@README.md what is this"]) {
      const { pane, send } = rig();
      const answer = await send(text);
      expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "reserved_lead", s0: null });
      expect(answer.detail).toContain("mode command");
      expect(pane.readsSeen).toBe(0);
      expect(pane.calls).toEqual([]);
    }
  });
});

describe("a command (M56 spec 06)", () => {
  const SLASH_POPUP = ["  /compact     Clear the history but keep a summary", "  /config      Open the settings", "  /cost        Show the cost of this session"];

  test("a slash command goes through as a command: its popup under the box does not hold it", async () => {
    const { pane, send } = rig();
    pane.afterInput = (p, what) => {
      if (what.startsWith("paste:/")) p.popup = SLASH_POPUP;
      if (what.endsWith("Enter")) p.popup = null;
    };
    const answer = await send("/compact", { mode: "command" });
    expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["Enter"] });
    expect(pane.calls).toEqual(["paste:/compact"]);
    expect(pane.transcript.at(-1)).toBe("> /compact");
    neverEscape(pane);
  });

  test("an idle command whose box holds only / under the full slash list (claude-lab--popup-slash-all--w82.txt) is sent: its own popup (review L1)", async () => {
    const { pane, send } = rig({ version: "2.1.301" });
    const capture = readFileSync(join(import.meta.dir, "../../web/src/fixtures/panes/claude-lab--popup-slash-all--w82.txt"), "utf8");
    // Before the write the same screen with the box as the fake holds it and the footer under it.
    const top = capture.split("\n").slice(0, 16);
    const at = top.findIndex((row) => row.startsWith("\u276f\u00a0/"));
    const idleScreen = (box: string): string => [...top.slice(0, at), `\u276f\u00a0${box}\r`, ...top.slice(at + 1), "  ? for shortcuts"].join("\n");
    let written = false;
    let entered = false;
    let reads = 0;
    pane.afterInput = (_p, what) => {
      if (what.startsWith("paste:/") || what.startsWith("type:/")) written = true;
      if (what.endsWith("Enter")) entered = true;
    };
    pane.beforeRead = (p) => {
      if (entered) {
        p.fixed = idleScreen("");
        return;
      }
      if (!written) {
        p.fixed = idleScreen(p.box);
        return;
      }
      // The first read after the write finds the box at `/` with every command listed, then the whole command.
      reads += 1;
      p.fixed = reads === 1 ? capture : capture.replace("\u276f\u00a0/\r", "\u276f\u00a0/add-dir\r");
    };
    const answer = await send("/add-dir", { mode: "command" });
    expect(answer.receipt?.outcome).toBe("sent");
    expect(answer.receipt?.keys.at(-1)).toBe("Enter");
    expect(reads).toBeGreaterThan(0);
    neverEscape(pane);
  });

  test("the same text as a plain send is still refused reserved_lead, before any read", async () => {
    const { pane, send } = rig();
    expect((await send("/compact")).receipt).toMatchObject({ outcome: "refused", reason: "reserved_lead" });
    expect(pane.readsSeen).toBe(0);
  });

  test("a shell line whose bang turns into the prompt glyph matches the box without its lead", async () => {
    const { pane, send } = rig();
    pane.bangPrompt = true;
    const answer = await send("!ls -la", { mode: "command" });
    expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["Enter"] });
  });

  test("a shell line in the send drill's shape (a6): the box reads `! echo ok` and the row under it `! for shell mode`; sent, then Submit of the same text holds too", async () => {
    // The rows of /tmp/send-drill/shots/a6-claude-bang.png, also read live in the M56 lab on Claude
    // 2.1.301: the bang turns into the prompt glyph with a space after it, the status row turns into
    // the shell-mode hint.
    const shellMode = (p: FakePane, what: string): void => {
      if (p.box.startsWith("!")) p.status = ["  ! for shell mode"];
      if (what.endsWith("Enter")) p.status = ["  sonnet · project · main"];
    };
    // Provisional, as in the drill: the command is probed first.
    const sent = rig({ version: "2.1.999" });
    sent.pane.bangPrompt = true;
    sent.pane.afterInput = shellMode;
    const answer = await sent.send("!echo ok", { mode: "command" });
    expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["probe", "Backspace", "Enter"] });
    expect(sent.pane.transcript.at(-1)).toBe("> !echo ok");

    // Submit after a typed_not_submitted names the text with its lead; the box shows it without.
    const held = rig();
    held.pane.bangPrompt = true;
    held.pane.afterInput = shellMode;
    held.pane.box = "!echo ok";
    held.pane.status = ["  ! for shell mode"];
    const submit = await held.send("!echo ok", { mode: "submit" });
    expect(submit.receipt).toMatchObject({ outcome: "sent", keys: ["Enter"] });
    expect(held.pane.box).toBe("");
  });

  test("a command whose box shows a mode marker in front of the text is matched without its lead", async () => {
    const { pane, send } = rig();
    const render = pane.render.bind(pane);
    pane.render = () => render().replace("❯ !echo ok", "❯ $ echo ok");
    const answer = await send("!echo ok", { mode: "command" });
    expect(answer.receipt).toMatchObject({ outcome: "sent" });
  });

  test("a command that opens its own screen after Enter is taken: the box went away", async () => {
    const { pane, send } = rig();
    pane.afterInput = (p, what) => {
      if (what.endsWith("Enter")) p.dialog = DIALOG;
    };
    const answer = await send("/model", { mode: "command" });
    expect(answer.receipt).toMatchObject({ outcome: "sent" });
  });

  test("a command into a busy screen is refused like a send: nothing typed", async () => {
    const { pane, send } = rig();
    pane.dialog = DIALOG;
    expect((await send("/compact", { mode: "command" })).receipt).toMatchObject({ outcome: "refused", reason: "not_free", keys: [] });
    expect(pane.calls).toEqual([]);
  });

  test("a framed screen with a strong cue above the box takes the manual Send: unconfirmed, then probed and sent", async () => {
    const { pane, send } = rig();
    pane.transcript = Array.from({ length: 12 }, (_, i) => `transcript row ${String(i)}`);
    pane.over = ["● How is the agent doing this session? (optional)", "  1: Bad    2: Fine    3: Good    0: Dismiss"];
    const first = await send("carry on with the plan");
    expect(first.surface?.modal).toBe("unreadable");
    expect(first.receipt).toMatchObject({ outcome: "refused", reason: "unconfirmed", keys: [] });
    const commit = await send("carry on with the plan", { rowsHash: first.rowsHash! });
    expect(commit.receipt).toMatchObject({ outcome: "sent", keys: ["probe", "Backspace", "Enter"] });
    expect(pane.transcript.at(-1)).toBe("> carry on with the plan");
  });

  test("a transcript that moves under a command still holds the Enter", async () => {
    const { pane, send } = rig();
    pane.transcript = Array.from({ length: 12 }, (_, i) => `transcript row ${String(i)}`);
    pane.afterInput = (p, what) => {
      if (what.startsWith("paste:")) p.transcript[0] = "> a different question";
    };
    const answer = await send("/compact", { mode: "command" });
    expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "changed" });
    expect(pane.keysSeen).toEqual([]);
  });
});

// ── a send into a running turn ──

/** The live running row of Claude Code 2.1.301 (claude--v2301-working-quiet--w100.txt): no interrupt hint. */
const LIVE_ROW = "* Wibbling… (4s · ↓ 304 tokens)";

describe("codex: Tab sends every text, Enter steers a running turn (M56 spec 13)", () => {
  const CODEX_RUNNING = "• Working (4s • esc to interrupt)";
  const codex = (options: Parameters<typeof rig>[0] = {}): Rig => rig({ pane: new FakePane("codex"), harness: "codex", version: "0.159.2", ...options });
  /** The Codex profile as it was before Tab became the submit key: Enter submits, Tab queues. */
  const enterSubmits = (profile: Profile): Profile => {
    const { commandSubmit, ...keys } = profile.keys;
    void commandSubmit;
    return { ...profile, keys: { ...keys, submit: ["Enter"] } };
  };
  /** The Codex profile with no queue key. */
  const noQueueKey = (profile: Profile): Profile => {
    const { queueKey, ...keys } = profile.keys;
    void queueKey;
    return { ...profile, keys };
  };
  /** Rows of an answer that streams in above the box, one more on every read. */
  const streams = (pane: FakePane): void => {
    pane.turn = true;
    pane.beforeRead = (p, n) => {
      p.transcript.push(`streamed row ${String(n)}`);
    };
  };

  test("a free Codex box: one write, Tab, sent, no queued field, never Enter", async () => {
    const { pane, send } = codex();
    const answer = await send("please list the files in this folder");
    expect(answer.receipt).toMatchObject({ outcome: "sent", profileId: "codex", profileStatus: "verified", keys: ["Tab"] });
    expect(answer.receipt && "queued" in answer.receipt).toBe(false);
    expect(pane.transcript.at(-1)).toBe("› please list the files in this folder");
    expect(pane.keysSeen).not.toContain("Enter");
  });

  test("a provisional Codex: the probe passes though the hint row under the box hides at the first character (lab screens of 0.163.0, on 0.164.0)", async () => {
    const { pane, send } = codex({ version: "0.164.0" });
    const answer = await send("please list the files in this folder");
    expect(answer.receipt).toMatchObject({ outcome: "sent", profileStatus: "provisional", keys: ["probe", "Backspace", "Tab"] });
    expect(pane.transcript.at(-1)).toBe("› please list the files in this folder");
  });

  test("a fresh Codex hides its welcome picture at the first character: the rows above only lost text, so the probe passes (lab, 0.163.0)", async () => {
    const { pane, send } = codex({ version: "0.164.0" });
    pane.codexWelcome = CODEX_WELCOME;
    const answer = await send("please list the files in this folder");
    expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["probe", "Backspace", "Tab"] });
  });

  test("a row above the Codex box that gains text no longer fails the probe: the send goes in with Tab, never Enter (2026-10-17 decision)", async () => {
    const { pane, send } = codex({ version: "0.164.0" });
    // Rows high above the box, past the profile's volatile band over the top edge.
    pane.transcript = ["• first", "• second", "• third", "• fourth", "• fifth", "• sixth", "• seventh", "• eighth"];
    pane.afterInput = (p, what) => {
      // The fourth row: below the three rows at the very top that may come back from the scrollback.
      if (what.startsWith("type:")) p.transcript = [...p.transcript.slice(0, 3), "• fourth, and a new line of output", ...p.transcript.slice(4)];
    };
    // Only the box and the rows under it decide the probe now; rows above that moved route the commit to the queue key.
    const answer = await send("please list the files in this folder");
    expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["probe", "Backspace", "Tab"] });
    expect(pane.keysSeen).not.toContain("Enter");
  });

  test("a row under the Codex box that is no hint still fails the probe", async () => {
    const { pane, send } = codex({ version: "0.164.0" });
    pane.afterInput = (p, what) => {
      if (what.startsWith("type:")) p.codexHint = "  a row that is no hint";
    };
    const answer = await send("please list the files in this folder");
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "probe_failed" });
    expect(pane.keysSeen.filter((key) => key === "Tab" || key === "Enter")).toEqual([]);
  });

  test("a running turn: probed, Tab, and the queued row with the text makes the receipt say queued", async () => {
    const { pane, send } = codex();
    pane.over = [CODEX_RUNNING];
    const answer = await send("then add a short summary");
    expect(answer.receipt).toMatchObject({ outcome: "sent", queued: true, keys: ["probe", "Backspace", "Tab"] });
    expect(pane.keysSeen).not.toContain("Enter");
    expect(pane.queued).toEqual(["then add a short summary"]);
    expect(pane.box).toBe("");
    neverEscape(pane);
  });

  test("S0 read a running turn, but the turn ends before Tab: Tab sends, and with no queued row the receipt says sent", async () => {
    const { pane, send } = codex();
    pane.over = [CODEX_RUNNING];
    pane.afterInput = (p, what) => {
      if (what.startsWith("paste:then")) p.over = [];
    };
    const answer = await send("then add a short summary");
    expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["probe", "Backspace", "Tab"] });
    expect(answer.receipt && "queued" in answer.receipt).toBe(false);
    expect(pane.queued).toEqual([]);
    expect(pane.transcript.at(-1)).toBe("› then add a short summary");
  });

  test("S1 in a turn sees the queue hint under the status row (0.159 and 0.163 shape), and the send goes in queued", async () => {
    const { pane, send } = codex();
    pane.over = [CODEX_RUNNING];
    const hints: boolean[] = [];
    pane.afterInput = (p, what) => {
      if (what.startsWith("paste:then")) hints.push(p.render().split("\n").includes("  tab to queue message"));
    };
    const answer = await send("then add a short summary");
    expect(hints).toEqual([true]);
    expect(answer.receipt).toMatchObject({ outcome: "sent", queued: true, keys: ["probe", "Backspace", "Tab"] });
  });

  test("S1 in a turn sees the queue hint take the status row's place (0.150 and 0.156 shape), and the send goes in queued", async () => {
    const { pane, send } = codex({ version: "0.156.1" });
    pane.queueHintOnStatus = true;
    pane.queuedHint = "    alt + ↑ edit last queued message";
    pane.over = [CODEX_RUNNING];
    const hints: boolean[] = [];
    pane.afterInput = (p, what) => {
      if (what.startsWith("paste:then")) hints.push(p.render().split("\n").some((row) => row.startsWith("  tab to queue message ") && row.endsWith("context left")));
    };
    const answer = await send("then add a short summary");
    expect(hints).toEqual([true]);
    expect(answer.receipt).toMatchObject({ outcome: "sent", queued: true, keys: ["probe", "Backspace", "Tab"] });
    expect(pane.keysSeen).not.toContain("Enter");
  });

  test("a Codex transcript that echoes the prompt behind its glyph, the answer indented under it, is no open list at the box (lab, 0.163.0)", async () => {
    const { pane, send } = codex();
    pane.transcript = ["› Write the numbers 1 to 3 in words.", "", "  one", "  two", "  three", "", "› Run the shell command sleep 30 in this folder.", ""];
    pane.over = ["• Working (8s • esc to interrupt) · 1 background terminal running · /ps to view · /stop to close"];
    const answer = await send("then add a short summary");
    expect(answer.receipt).toMatchObject({ outcome: "sent", queued: true, keys: ["probe", "Backspace", "Tab"] });
    expect(pane.keysSeen).not.toContain("Enter");
  });

  test("Enter never goes into a running Codex turn: ten queued sends press Tab ten times and Enter never", async () => {
    const { pane, send } = codex();
    pane.over = [CODEX_RUNNING];
    for (let i = 0; i < 10; i++) expect((await send(`follow-up number ${String(i)}`)).receipt).toMatchObject({ outcome: "sent", queued: true });
    expect(pane.keysSeen.filter((key) => key === "Enter")).toEqual([]);
    expect(pane.keysSeen.filter((key) => key === "Tab")).toHaveLength(10);
    expect(pane.queued).toHaveLength(10);
  });

  test("an answer that streams above a Codex box with no working row: the send presses Tab, never Enter, and the queued row says queued (lab, 0.163.0)", async () => {
    const { pane, send } = codex();
    streams(pane);
    const answer = await send("please list the files in this folder");
    expect(answer.receipt).toMatchObject({ outcome: "sent", queued: true });
    expect(answer.receipt?.keys.at(-1)).toBe("Tab");
    expect(pane.keysSeen).not.toContain("Enter");
    expect(pane.queued).toEqual(["please list the files in this folder"]);
  });

  test("an answer that streams under a pinned prompt row: the probe passes and the send goes in with Tab (lab, 0.163.0, 2026-10-16)", async () => {
    const { pane, send } = codex();
    pane.height = 26;
    pane.pinned = "› Write the numbers from one to four hundred as English words";
    for (let i = 0; i < 20; i++) pane.transcript.push(`  number row ${String(i)}`);
    streams(pane);
    const answer = await send("now reply with the single word cherry");
    expect(answer.receipt).toMatchObject({ outcome: "sent", queued: true });
    expect(answer.receipt?.keys.at(-1)).toBe("Tab");
    expect(pane.keysSeen).not.toContain("Enter");
  });

  test("rows under a pinned first row that were replaced while the box holds the text: the queue key goes out, never Enter (2026-10-17 decision)", async () => {
    const { pane, send } = codex();
    pane.height = 26;
    pane.pinned = "› Write the numbers from one to four hundred as English words";
    for (let i = 0; i < 20; i++) pane.transcript.push(`  number row ${String(i)}`);
    pane.turn = true;
    pane.beforeRead = (p, n) => {
      // Another screen under the same top row: none of the rows before stands in the read after.
      p.transcript = Array.from({ length: 20 }, (_, i) => `  other screen ${String(n)} row ${String(i)}`);
    };
    // Once the text is typed only the box and the rows under it decide; the rows above may change.
    const answer = await send("now reply with the single word cherry");
    expect(answer.receipt).toMatchObject({ outcome: "sent", queued: true });
    expect(answer.receipt?.keys.at(-1)).toBe("Tab");
    expect(pane.keysSeen).not.toContain("Enter");
  });

  test("Submit of a draft while the answer streams with no working row presses Tab, never Enter (K1)", async () => {
    const { pane, send } = codex();
    pane.box = "half a thought";
    streams(pane);
    const answer = await send("half a thought", { mode: "submit" });
    expect(answer.receipt).toMatchObject({ outcome: "sent", queued: true });
    expect(answer.receipt?.keys).toEqual(["Tab"]);
    expect(pane.keysSeen).not.toContain("Enter");
    expect(pane.queued).toEqual(["half a thought"]);
  });

  test("a steering profile whose submit key is Enter: rows that move above the box route the send to the queue key, never Enter (K8)", async () => {
    const { pane, send } = codex({ edit: enterSubmits });
    // An answer that streams fast: a dozen rows a read, past the volatile band over the box.
    pane.turn = true;
    pane.beforeRead = (p, n) => {
      for (let i = 0; i < 12; i++) p.transcript.push(`streamed row ${String(n)}.${String(i)}`);
    };
    const answer = await send("please list the files in this folder");
    expect(answer.receipt).toMatchObject({ outcome: "sent" });
    expect(answer.receipt?.keys.at(-1)).toBe("Tab");
    expect(pane.keysSeen).not.toContain("Enter");
  });

  test("a steering profile whose submit key is Enter still presses Enter on a still, idle box", async () => {
    const { pane, send } = codex({ edit: enterSubmits });
    const answer = await send("please list the files in this folder");
    expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["Enter"] });
    expect(pane.transcript.at(-1)).toBe("› please list the files in this folder");
  });

  test("a command on an idle Codex box goes in with Enter, never Tab: Tab completes in the slash popup", async () => {
    const { pane, send } = codex();
    const answer = await send("/compact", { mode: "command" });
    expect(answer.receipt).toMatchObject({ outcome: "sent" });
    expect(answer.receipt?.keys.at(-1)).toBe("Enter");
    expect(pane.keysSeen).not.toContain("Tab");
  });

  test("`!ls` is a shell command on Codex: Enter on an idle box; in a turn it is refused, never queued (keys.neverHeld)", async () => {
    // Lab, 2026-10-16: on an idle box Tab does nothing with `!ls` (Shell mode) and Enter runs it; in a
    // turn Tab would queue it, but a shell line acts on the machine as it is then, so the profile lists
    // `!` in keys.neverHeld and Collie neither queues nor holds it (review of spec 15, H6).
    const idle = codex();
    const sent = await idle.send("!ls", { mode: "command" });
    expect(sent.receipt).toMatchObject({ outcome: "sent" });
    expect(sent.receipt?.keys.at(-1)).toBe("Enter");
    expect(idle.pane.keysSeen).not.toContain("Tab");
    expect((await idle.send("!ls")).receipt).toMatchObject({ outcome: "refused", reason: "reserved_lead" });
    const busy = codex();
    busy.pane.over = [CODEX_RUNNING];
    expect((await busy.send("!ls")).receipt).toMatchObject({ outcome: "refused", reason: "reserved_lead", keys: [] });
    const refused = await busy.send("!ls", { mode: "command" });
    expect(refused.receipt).toMatchObject({ outcome: "refused", reason: "turn_running", keys: [] });
    expect(refused.detail).toBe("Collie does not queue this command during a turn. Send it when the turn ends.");
    expect(busy.pane.queued).toEqual([]);
    expect(busy.pane.keysSeen).not.toContain("Enter");
    expect(busy.pane.keysSeen).not.toContain("Tab");
  });

  test("an `@` text is a message on Codex: it goes in with Tab, never Enter (N2)", async () => {
    const { pane, send } = codex();
    const answer = await send("@README.md sum this file up");
    expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["Tab"] });
    expect(pane.transcript.at(-1)).toBe("› @README.md sum this file up");
    expect(pane.keysSeen).not.toContain("Enter");
  });

  test("`/model` is a command on Codex: Enter on an idle box, the queue key in a turn, never Enter (N2, M56 spec 15)", async () => {
    const idle = codex();
    const sent = await idle.send("/model", { mode: "command" });
    expect(sent.receipt).toMatchObject({ outcome: "sent" });
    expect(sent.receipt?.keys.at(-1)).toBe("Enter");
    expect(idle.pane.keysSeen).not.toContain("Tab");
    const busy = codex();
    busy.pane.over = [CODEX_RUNNING];
    expect((await busy.send("/model", { mode: "command" })).receipt).toMatchObject({ outcome: "sent", keys: ["probe", "Backspace", "Tab"] });
    expect(busy.pane.queued).toEqual(["/model"]);
    expect(busy.pane.keysSeen).not.toContain("Enter");
  });

  test("a `/` text that names no Codex command still takes Enter as a command: Tab would complete it (N2)", async () => {
    const { pane, send } = codex();
    const answer = await send("/nosuchcommand", { mode: "command" });
    expect(answer.receipt).toMatchObject({ outcome: "sent" });
    expect(answer.receipt?.keys.at(-1)).toBe("Enter");
    expect(pane.keysSeen).not.toContain("Tab");
    // As a plain send it is refused: a `/` text has its own route.
    expect((await send("/nosuchcommand")).receipt).toMatchObject({ outcome: "refused", reason: "reserved_lead" });
  });

  test("Submit of a command draft on an idle Codex box presses Enter", async () => {
    const { pane, send } = codex();
    pane.box = "/compact";
    const answer = await send("/compact", { mode: "submit" });
    expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["Enter"] });
    expect(pane.keysSeen).not.toContain("Tab");
  });

  test("a Codex profile with no queue key refuses a send into a turn: turn_running, nothing typed", async () => {
    const { pane, send } = codex({ edit: noQueueKey });
    pane.over = [CODEX_RUNNING];
    const answer = await send("then add a short summary");
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "turn_running", keys: [] });
    expect(answer.detail).toBe("The agent is working, and this harness does not take a message during a turn.");
    expect(pane.calls).toEqual([]);
    expect(pane.keysSeen).toEqual([]);
  });

  test("a Codex version the binary did not report never queues", async () => {
    const { pane, send } = codex({ version: "no version here" });
    pane.over = [CODEX_RUNNING];
    expect((await send("then add a short summary")).receipt).toMatchObject({ outcome: "refused", reason: "turn_running", keys: [] });
    expect(pane.keysSeen).toEqual([]);
  });

  test("a draft in a running Codex box keeps the draft offers, and Add to it goes in queued with Tab", async () => {
    const { pane, send } = codex();
    pane.over = [CODEX_RUNNING];
    pane.box = "half a thought";
    expect((await send("hello")).receipt).toMatchObject({ outcome: "refused", reason: "draft_present", keys: [] });
    const added = await send(" and the rest", { mode: "append" });
    expect(added.receipt).toMatchObject({ outcome: "sent", queued: true });
    expect(added.receipt?.keys.at(-1)).toBe("Tab");
    expect(pane.queued).toEqual(["half a thought and the rest"]);
    expect(pane.keysSeen).not.toContain("Enter");
  });

  test("Replace on a draft in a running Codex box goes in queued with Tab", async () => {
    const { pane, send } = codex();
    pane.over = [CODEX_RUNNING];
    pane.box = "half a thought";
    const replaced = await send("a new thought", { mode: "replace" });
    expect(replaced.receipt).toMatchObject({ outcome: "sent", queued: true });
    expect(replaced.receipt?.keys.at(-1)).toBe("Tab");
    expect(pane.queued).toEqual(["a new thought"]);
    expect(pane.keysSeen).not.toContain("Enter");
  });

  test("a command in a Codex turn is queued with Tab (lab, 0.163.0: `/status` then Tab queued it and it ran after the turn)", async () => {
    const { pane, send } = codex();
    pane.over = [CODEX_RUNNING];
    const answer = await send("/compact", { mode: "command" });
    expect(answer.receipt).toMatchObject({ outcome: "sent" });
    expect(answer.receipt?.keys.at(-1)).toBe("Tab");
    expect(pane.queued).toEqual(["/compact"]);
    neverEscape(pane);
  });

  test("a Codex profile with no commandWhileRunning refuses a command in a turn when no hold queue is there: turn_running, nothing typed", async () => {
    const { pane, send } = codex({ edit: noCommandQueue });
    pane.over = [CODEX_RUNNING];
    expect((await send("/compact", { mode: "command" })).receipt).toMatchObject({ outcome: "refused", reason: "turn_running", keys: [] });
    expect(pane.calls).toEqual([]);
  });

  test("a Codex screen with no box and a running row: the two-tap send presses Tab, never Enter; with no box there is no witness, so no queued label", async () => {
    const { pane, send } = codex();
    pane.over = [CODEX_RUNNING];
    pane.codexStatus = "  something the profile does not know";
    pane.codexHint = "  ? for shortcuts";
    const first = await send("then add a short summary");
    expect(first.receipt?.keys).toEqual([]);
    expect(first.rowsHash).toEqual(expect.any(String));
    const manual = await send("then add a short summary", { rowsHash: first.rowsHash! });
    expect(manual.receipt).toMatchObject({ outcome: "sent" });
    expect(manual.receipt?.keys.at(-1)).toBe("Tab");
    expect(pane.keysSeen).not.toContain("Enter");
    expect(pane.queued).toEqual(["then add a short summary"]);
  });

  test("a Codex screen with no box and a running row, and no queue key: the two-tap send is refused turn_running, nothing typed", async () => {
    const { pane, send } = codex({ edit: noQueueKey });
    pane.over = [CODEX_RUNNING];
    pane.codexStatus = "  something the profile does not know";
    const first = await send("then add a short summary");
    const manual = await send("then add a short summary", { rowsHash: first.rowsHash! });
    expect(manual.receipt).toMatchObject({ outcome: "refused", reason: "turn_running", keys: [] });
    expect(pane.calls).toEqual([]);
    expect(pane.keysSeen).toEqual([]);
  });
});

describe("a send into a running turn", () => {
  test("an empty box on a harness that queues: typed, Enter through the gate, sent, the receipt says queued", async () => {
    const { pane, send } = rig();
    pane.over = [LIVE_ROW];
    const answer = await send("then give it a title");
    expect(answer.receipt).toMatchObject({ outcome: "sent", queued: true, keys: ["probe", "Backspace", "Enter"] });
    expect(answer.receipt?.reason).toBeUndefined();
    expect(answer.offers).toEqual([]);
    expect(pane.box).toBe("");
    expect(pane.transcript.at(-1)).toBe("> then give it a title");
    neverEscape(pane);
  });

  test("the transcript the turn prints while the text goes in does not stop the send", async () => {
    const { pane, send } = rig();
    pane.over = [LIVE_ROW];
    pane.beforeRead = (p, n) => {
      p.transcript.push(`streamed reply row ${String(n)}`);
    };
    expect((await send("then give it a title")).receipt).toMatchObject({ outcome: "sent", queued: true });
    expect(pane.transcript).toContain("> then give it a title");
  });

  test("S2 needs the box empty: the running sign alone is no evidence, and the text still in the box points at a dialog", async () => {
    const { pane, send } = rig();
    pane.over = [LIVE_ROW];
    pane.enterSubmits = false;
    const answer = await send("then give it a title");
    expect(answer.receipt).toMatchObject({ outcome: "unknown", reason: "dialog_after_enter" });
    expect(answer.detail).toBe("The submit key did not reach the box. A dialog may have taken it. Check the transcript.");
    expect(answer.receipt?.queued).toBeUndefined();
  });

  test("a dialog that opens while the text goes in still holds the Enter", async () => {
    const { pane, send } = rig();
    pane.over = [LIVE_ROW];
    pane.afterInput = (p, what) => {
      if (what.startsWith("paste:")) p.over = ["● Pick one", "  ❯ 1. Red", "    2. Blue", "  Enter to select · Esc to cancel"];
    };
    const answer = await send("then give it a title");
    expect(answer.receipt?.outcome).toBe("typed_not_submitted");
    expect(pane.keysSeen.filter((key) => key === "Enter")).toEqual([]);
  });

  test("a draft in the box keeps the draft offers, and Add to it goes in queued", async () => {
    const { pane, send } = rig();
    pane.over = [LIVE_ROW];
    pane.box = "half a thought";
    const answer = await send("hello");
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "draft_present", keys: [] });
    expect(answer.offers).toEqual(["append", "replace", "cancel"]);
    expect(pane.calls).toEqual([]);
    const added = await send(" and the rest", { mode: "append" });
    expect(added.receipt).toMatchObject({ outcome: "sent", queued: true });
    expect(pane.transcript.at(-1)).toBe("> half a thought and the rest");
  });

  test("a command in a turn goes in queued on a harness that queues commands (lab, 2.1.301: `/help` then Enter queued it and it ran after the turn)", async () => {
    const { pane, send } = rig();
    pane.over = [LIVE_ROW];
    pane.drawsQueuedRow = true;
    // The slash popup fills the rows under the box while the command stands there, and the turn prints above.
    pane.afterInput = (p, what) => {
      if (what.startsWith("paste:/") || what.startsWith("type:/")) p.popup = ["  /compact     Clear the history but keep a summary", "  /config      Open the settings"];
      if (what.endsWith("Enter")) p.popup = null;
    };
    pane.beforeRead = (p, n) => {
      p.transcript.push(`streamed reply row ${String(n)}`);
    };
    const answer = await send("/compact", { mode: "command" });
    expect(answer.receipt).toMatchObject({ outcome: "sent", queued: true, keys: ["probe", "Backspace", "Enter"] });
    expect(pane.over[0]).toBe("❯ /compact");
    neverEscape(pane);
  });

  test("a command in a turn meets a permission dialog drawn under the box after the write: typed_not_submitted(modal_cue), no Enter (review of spec 15)", async () => {
    const { pane, send } = rig();
    pane.over = [LIVE_ROW];
    pane.afterInput = (p, what) => {
      if (what.startsWith("paste:/") || what.startsWith("type:/")) p.popup = DIALOG;
    };
    const answer = await send("/help", { mode: "command" });
    expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "modal_cue" });
    expect(answer.receipt?.keys).not.toContain("Enter");
    neverEscape(pane);
  });

  test("a command on an idle box meets a dialog drawn under the box after the write: typed_not_submitted(modal_cue), no Enter", async () => {
    const { pane, send } = rig();
    pane.afterInput = (p, what) => {
      if (what.startsWith("paste:/") || what.startsWith("type:/")) p.popup = DIALOG;
    };
    const answer = await send("/help", { mode: "command" });
    expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "modal_cue" });
    expect(answer.receipt?.keys).not.toContain("Enter");
  });

  test("a command in a turn on a harness that does not queue commands, with no hold queue: refused turn_running, nothing typed", async () => {
    const { pane, send } = rig({ edit: noCommandQueue });
    pane.over = [LIVE_ROW];
    expect((await send("/compact", { mode: "command" })).receipt).toMatchObject({ outcome: "refused", reason: "turn_running", keys: [] });
    expect(pane.calls).toEqual([]);
  });

  test("a send on a free box carries no queued field", async () => {
    const { send } = rig();
    const answer = await send("please fix the failing test in the parser");
    expect(answer.receipt?.outcome).toBe("sent");
    expect(answer.receipt && "queued" in answer.receipt).toBe(false);
  });

  test("the list of recent sends carries queued", async () => {
    const { pane, send, protocol } = rig();
    pane.over = [LIVE_ROW];
    await send("then give it a title");
    expect(protocol.recent("%1")[0]).toMatchObject({ outcome: "sent", queued: true });
  });

  test("a box holding a command: a send gets the draft offers, and Add to it and Submit go in queued where commands queue", async () => {
    const { pane, send } = rig();
    pane.over = [LIVE_ROW];
    pane.box = "/compact";
    expect((await send("hello")).receipt).toMatchObject({ outcome: "refused", reason: "draft_present" });
    expect((await send("/compact", { mode: "submit" })).receipt).toMatchObject({ outcome: "sent", queued: true, keys: ["Enter"] });
    expect(pane.transcript.at(-1)).toBe("> /compact");
  });

  test("a box holding a command where commands do not queue: a send gets the draft offers, and Add to it and Submit are refused turn_running; Replace goes in queued", async () => {
    const { pane, send } = rig({ edit: noCommandQueue });
    pane.over = [LIVE_ROW];
    pane.box = "/compact";
    expect((await send("hello")).receipt).toMatchObject({ outcome: "refused", reason: "draft_present" });
    expect((await send(" and more", { mode: "append" })).receipt).toMatchObject({ outcome: "refused", reason: "turn_running", keys: [] });
    expect((await send("/compact", { mode: "submit" })).receipt).toMatchObject({ outcome: "refused", reason: "turn_running", keys: [] });
    expect(pane.calls).toEqual([]);
    expect(pane.keysSeen).toEqual([]);
    expect((await send("hello instead", { mode: "replace" })).receipt).toMatchObject({ outcome: "sent", queued: true });
    expect(pane.transcript.at(-1)).toBe("> hello instead");
  });

  test("a popup open at the box during a turn (claude-lab--working-popup-open--w82.txt) is refused at S0, nothing typed", async () => {
    const { pane, send } = rig();
    pane.fixed = readFileSync(join(import.meta.dir, "../../web/src/fixtures/panes/claude-lab--working-popup-open--w82.txt"), "utf8");
    const answer = await send("hello");
    expect(answer.receipt).toMatchObject({ outcome: "refused", keys: [] });
    expect(answer.receipt?.reason).toBe("not_free");
    expect(answer.detail).toBe("Something is open at the input box.");
    expect(answer.receipt?.queued).toBeUndefined();
    expect(pane.calls).toEqual([]);
  });

  test("a dialog that replaces the box while the probe stands there fails the probe, and no key follows it", async () => {
    const { pane, send } = rig();
    pane.over = [LIVE_ROW];
    pane.afterInput = (p, what) => {
      if (what === `type:${PROBE}`) p.dialog = DIALOG;
    };
    const answer = await send("then give it a title");
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "probe_failed" });
    expect(pane.keysSeen).toEqual([]);
  });

  test("a dialog that opens as the Enter goes out ends unknown(dialog_after_enter), pointing at the card", async () => {
    const { pane, send } = rig();
    pane.over = [LIVE_ROW];
    pane.afterInput = (p, what) => {
      if (what === "keys:Enter") p.dialog = DIALOG;
    };
    const answer = await send("then give it a title");
    expect(answer.receipt).toMatchObject({ outcome: "unknown", reason: "dialog_after_enter", keys: ["probe", "Backspace", "Enter"] });
    expect(answer.receipt?.queued).toBeUndefined();
    expect(answer.offers).toEqual(["keys"]);
    expect(answer.surface?.modal).not.toBe("none");
    expect(answer.detail).toBe("A dialog opened as the message went in. Check the card before you answer it.");
  });

  test("a revoked range or a version the binary did not report never queues", async () => {
    const revoked = rig({ status: "revoked" });
    revoked.pane.over = [LIVE_ROW];
    expect((await revoked.send("hello there")).receipt).toMatchObject({ outcome: "refused", reason: "turn_running", keys: [] });
    const unread = rig({ version: "no version here" });
    unread.pane.over = [LIVE_ROW];
    expect((await unread.send("hello there")).receipt).toMatchObject({ outcome: "refused", reason: "turn_running", keys: [] });
    const provisional = rig({ version: "2.1.301" });
    provisional.pane.over = [LIVE_ROW];
    expect((await provisional.send("hello there")).receipt).toMatchObject({ outcome: "sent", queued: true, profileStatus: "provisional" });
  });

  test("the first queued send of a turn: the queued row and its ctrl+enter hint over the spinner end it sent, queued", async () => {
    const { pane, send } = rig();
    pane.over = [LIVE_ROW];
    pane.drawsQueuedRow = true;
    const answer = await send("then give it a title");
    expect(answer.receipt).toMatchObject({ outcome: "sent", queued: true, keys: ["probe", "Backspace", "Enter"] });
    expect(pane.over).toEqual(["❯ then give it a title", "  ctrl+enter to send now", LIVE_ROW]);
  });

  test("a numbered list that streams above the box through S1 and S2 does not end a queued send", async () => {
    const { pane, send } = rig();
    pane.over = [LIVE_ROW];
    pane.drawsQueuedRow = true;
    let item = 0;
    pane.beforeRead = (p) => {
      if (p.calls.some((call) => call.includes("then give"))) p.transcript.push(`${String(++item)}. Step ${String(item)} of the plan`);
    };
    const answer = await send("then give it a title");
    expect(answer.receipt).toMatchObject({ outcome: "sent", queued: true });
    expect(item).toBeGreaterThan(1);
  });

  test("one read with no box in S2 is a torn read: the send waits, reads again and ends sent", async () => {
    const { pane, send } = rig();
    pane.over = [LIVE_ROW];
    pane.drawsQueuedRow = true;
    let torn = 0;
    pane.beforeRead = (p) => {
      p.fixed = null;
      if (p.keysSeen.includes("Enter") && torn === 0) {
        torn++;
        p.fixed = "An answer row mid redraw";
      }
    };
    const answer = await send("then give it a title");
    expect(torn).toBe(1);
    expect(answer.receipt).toMatchObject({ outcome: "sent", queued: true });
  });

  test("two reads in a row with no box in S2 end unknown(dialog_after_enter)", async () => {
    const { pane, send } = rig();
    pane.over = [LIVE_ROW];
    pane.afterInput = (p, what) => {
      if (what === "keys:Enter") p.fixed = "Something took the whole screen";
    };
    const answer = await send("then give it a title");
    expect(answer.receipt).toMatchObject({ outcome: "unknown", reason: "dialog_after_enter" });
  });

  test("on a verified version, Add to it and Replace into a running turn are probed", async () => {
    const append = rig();
    append.pane.over = [LIVE_ROW];
    append.pane.box = "a draft";
    expect((await append.send(" and more", { mode: "append" })).receipt).toMatchObject({ outcome: "sent", queued: true, profileStatus: "verified" });
    expect(append.pane.keysSeen.slice(0, 1)).toEqual(["Backspace"]);
    expect(append.pane.calls[0]).toBe(`type:${PROBE}`);
    const replace = rig();
    replace.pane.over = [LIVE_ROW];
    replace.pane.box = "a draft";
    const answer = await replace.send("something else", { mode: "replace" });
    expect(answer.receipt).toMatchObject({ outcome: "sent", queued: true, profileStatus: "verified" });
    expect(answer.receipt?.keys).toContain("probe");
  });

  test("a version newer than every range, borrowing a revoked range, never queues", async () => {
    const { pane, send } = rig({
      version: "2.1.400",
      edit: (profile) => {
        const [first, ...rest] = profile.versions;
        const revoked = (range: VersionRange): VersionRange => Object.assign({}, range, { status: "revoked" as const });
        return { ...profile, versions: [revoked(first), ...rest.map(revoked)] };
      },
    });
    pane.over = [LIVE_ROW];
    const answer = await send("hello there");
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "turn_running", keys: [], profileStatus: "provisional" });
    expect(pane.calls).toEqual([]);
  });

  // Claude Code 2.1.301 draws no spinner while the answer streams (lab, 2026-10-16): S0 reads idle,
  // and the answer rows scroll up above the box on every read.
  const ANSWER = [
    "● Juno was a search and rescue dog. She worked in the mountains with her handler, Mara.",
    "  She knew the vest meant work.",
    "  Mara and Juno drove to the trailhead. Snow was already falling.",
    '  "Find him," Mara said.',
    "  Juno set off at once. She did not run wildly. She moved in wide, careful loops.",
    "  An hour passed. Then two. The snow grew thick.",
    "  Mara followed. Behind the rocks, under a small ledge, sat a man.",
    '  "I thought no one would come," he whispered.',
  ];
  /** The streamed answer of one fake pane: how many rows it pushed so far. */
  interface Stream {
    rows(): number;
  }
  const streamAnswer = (pane: FakePane, from: (p: FakePane) => boolean): Stream => {
    let next = 0;
    pane.height = 16;
    pane.transcript = ["❯ Write a 300 word story about a working dog, plain text, no tools.", "", ...ANSWER];
    // Each streamed row is new text (a story does not repeat), two rows a read: more than the one row
    // a compare lets the transcript scroll by.
    const row = (): string => `  ${ANSWER[next % ANSWER.length]!.slice(2)} (${String(next++)})`;
    pane.beforeRead = (p) => {
      if (!from(p) || next >= ANSWER.length * 4) return;
      p.transcript.push(row(), row());
    };
    return { rows: () => next };
  };
  const typing = (p: FakePane): boolean => p.calls.length > 0;

  test("a numbered list with a menu and a (y/n) line streaming above the box while Collie types: sent, never left typed (live, 2026-10-17)", async () => {
    for (const version of ["2.1.301", "2.1.302"]) {
      const { pane, send } = rig({ version });
      pane.height = 16;
      pane.drawsQueuedRow = true;
      // The turn's own answer: a menu and a single-key question stand above the box, as on Claude Code
      // 2.1.302 when the list ended in them. No spinner while it streams, so S0 reads the pane free.
      const listRow = (k: number): string => `  ${String(k)}. Fruit number ${String(k)}: it is a fruit with one short sentence about it.`;
      pane.transcript = ["  Menu:", "  1. Apple", "  2. Pear", "  3. Quit", "", "  Confirm (y/n)", "", ...[1, 2, 3, 4, 5, 6].map(listRow)];
      let n = 6;
      pane.beforeRead = (p) => {
        // The list streams on once the text went in (the probe saw a still screen, as live).
        if (!p.calls.some((call) => call.includes("ACK3")) || n >= 40) return;
        n += 2;
        p.transcript.push(listRow(n - 1), listRow(n));
      };
      const answer = await send("Third message while the list streams, reply ACK3 only.");
      expect(answer.receipt, version).toMatchObject({ outcome: "sent" });
      expect(pane.keysSeen.at(-1), version).toBe("Enter");
      expect(pane.box, version).toBe("");
      expect(n, version).toBeGreaterThan(8);
    }
  });

  test("the answer streaming above the box while Collie types (no spinner, S0 idle): sent, and queued by the S2 witness", async () => {
    for (const version of ["2.1.200", "2.1.301"]) {
      const { pane, send } = rig({ version });
      pane.drawsQueuedRow = true;
      const stream = streamAnswer(pane, typing);
      const answer = await send("then give it a title");
      expect(answer.receipt, version).toMatchObject({ outcome: "sent", queued: true });
      expect(pane.keysSeen.at(-1), version).toBe("Enter");
      expect(stream.rows(), version).toBeGreaterThan(2);
    }
  });

  test("the answer streaming above the box, and no queued row in S2: sent, and the receipt does not say queued", async () => {
    const { pane, send } = rig({ version: "2.1.301" });
    streamAnswer(pane, typing);
    pane.afterInput = (p, what) => {
      if (what === "keys:Enter") p.transcript = p.transcript.filter((row) => !row.startsWith("> "));
    };
    const answer = await send("then give it a title");
    expect(answer.receipt).toMatchObject({ outcome: "sent" });
    expect(answer.receipt?.queued).toBeUndefined();
  });

  test("the answer streaming above the box and a row under the box that changes: refused, no Enter", async () => {
    const ends = {
      // Verified: no probe, so S1 sees the row under the box go.
      "2.1.200": { outcome: "typed_not_submitted", reason: "changed" },
      // Provisional: the probe sees it first.
      "2.1.301": { outcome: "refused", reason: "probe_failed" },
    } as const;
    for (const version of ["2.1.200", "2.1.301"] as const) {
      const { pane, send } = rig({ version });
      streamAnswer(pane, typing);
      pane.afterInput = (p, what) => {
        if (what.startsWith("type:") || what.startsWith("paste:")) p.status = [];
      };
      const answer = await send("then give it a title");
      expect(answer.receipt, version).toMatchObject(ends[version]);
      expect(pane.keysSeen.includes("Enter"), version).toBe(false);
    }
  });

  test("the answer streaming above the box and the box gone after Enter: unknown(dialog_after_enter)", async () => {
    const { pane, send } = rig();
    streamAnswer(pane, typing);
    pane.afterInput = (p, what) => {
      if (what === "keys:Enter") p.dialog = DIALOG;
    };
    expect((await send("then give it a title")).receipt).toMatchObject({ outcome: "unknown", reason: "dialog_after_enter" });
  });

  test("the answer streaming above the box and a permission dialog that replaces the box while the text goes in: no Enter", async () => {
    for (const version of ["2.1.200", "2.1.301"]) {
      const { pane, send } = rig({ version });
      streamAnswer(pane, typing);
      pane.afterInput = (p, what) => {
        if (what.startsWith("paste:") || what === "type:then give it a title") p.dialog = DIALOG;
      };
      const answer = await send("then give it a title");
      expect(answer.receipt?.outcome, version).toBe("typed_not_submitted");
      expect(pane.keysSeen.includes("Enter"), version).toBe(false);
    }
  });

  test("the answer streaming above the box while a command is typed: no Enter", async () => {
    const { pane, send } = rig();
    streamAnswer(pane, typing);
    const answer = await send("/compact", { mode: "command" });
    expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "changed" });
    expect(pane.keysSeen).toEqual([]);
  });

  /** What a late queued row reports: how many reads came after Enter. */
  interface LateRow {
    readsAfterEnter(): number;
  }
  /** After Enter: the box empties at once, and the queued row shows only from the `from`-th read on (null: never). */
  const queuedRowLate = (pane: FakePane, from: number | null, text: string): LateRow => {
    let after = 0;
    let entered = false;
    const stream = pane.beforeRead;
    pane.afterInput = (p, what) => {
      if (what !== "keys:Enter") return;
      entered = true;
      p.transcript = p.transcript.filter((row) => !row.startsWith("> "));
    };
    pane.beforeRead = async (p, n) => {
      await stream?.(p, n);
      if (!entered) return;
      after++;
      if (from !== null && after >= from) p.over = [`❯ ${text}`, "  ctrl+enter to send now"];
    };
    return { readsAfterEnter: () => after };
  };

  test("the late witness: the queued row shows only on the read after S2, and the receipt says queued", async () => {
    // The answer streaming, and the first second of a turn (a spinner with no timer, which reads idle).
    for (const turn of ["streaming", "spinner"] as const) {
      const { pane, send } = rig({ version: "2.1.301" });
      if (turn === "streaming") streamAnswer(pane, typing);
      else {
        pane.height = 16;
        pane.over = ["✶ Wibbling…"];
      }
      const late = queuedRowLate(pane, 2, "then give it a title");
      const answer = await send("then give it a title");
      expect(answer.receipt, turn).toMatchObject({ outcome: "sent", queued: true, keys: ["probe", "Backspace", "Enter"] });
      expect(late.readsAfterEnter(), turn).toBe(2);
    }
  });

  test("no late read on a screen that shows no turn: sent, no label", async () => {
    const { pane, send } = rig({ version: "2.1.301" });
    pane.height = 16;
    // As on Claude Code (claude-lab--idle-fresh--w82 against claude-lab--draft-adversarial--w82): the
    // footer follows the box, so S0 and S1 differ under the box on every idle send.
    pane.status = ["  sonnet · lab-project · main · ctx 12%                      ◐ medium · /effort", "  ⏸ manual mode on · ← for agents"];
    pane.statusWithText = ["  sonnet · lab-project · main · ctx 12%                  ctrl+g to edit in nano", "  ⏸ manual mode on"];
    const late = queuedRowLate(pane, 2, "then give it a title");
    const answer = await send("then give it a title");
    expect(answer.receipt).toMatchObject({ outcome: "sent" });
    expect(answer.receipt?.queued).toBeUndefined();
    expect(late.readsAfterEnter()).toBe(1);
  });

  test("the late witness: a prompt edge 60 s later still closes the queued send as effective", async () => {
    const { pane, send, protocol, deps, clock } = rig({ version: "2.1.301" });
    streamAnswer(pane, typing);
    queuedRowLate(pane, 2, "then give it a title");
    const answer = await send("then give it a title");
    expect(answer.receipt).toMatchObject({ outcome: "sent", queued: true });
    clock.now += 60_000;
    expect(protocol.promptEdge("%1", deps.store.hashText("then give it a title"), clock.now)).not.toBeNull();
    expect(deps.store.get(answer.receipt!.requestId)?.receipt?.outcome).toBe("effective");
  });

  test("the late witness that never shows: sent, and the receipt does not say queued", async () => {
    const { pane, send } = rig({ version: "2.1.301" });
    streamAnswer(pane, typing);
    const late = queuedRowLate(pane, null, "then give it a title");
    const answer = await send("then give it a title");
    expect(answer.receipt).toMatchObject({ outcome: "sent" });
    expect(answer.receipt?.queued).toBeUndefined();
    expect(late.readsAfterEnter()).toBe(2);
  });

  test("a dialog on the late read changes nothing: sent, not queued", async () => {
    const { pane, send } = rig({ version: "2.1.301" });
    pane.height = 16;
    pane.over = ["✶ Wibbling…"];
    let after = 0;
    pane.beforeRead = (p) => {
      if (!p.keysSeen.includes("Enter")) return;
      if (++after === 2) p.dialog = DIALOG;
    };
    const answer = await send("then give it a title");
    expect(answer.receipt).toMatchObject({ outcome: "sent" });
    expect(answer.receipt?.queued).toBeUndefined();
    expect(after).toBe(2);
  });

  test("no late read where Enter does not queue, where S0 read running, or where S2 saw the queued row", async () => {
    const submits = rig({ version: "2.1.301", edit: (profile) => ({ ...profile, keys: { ...profile.keys, enterWhileRunning: "submits" } }) });
    const a = queuedRowLate(submits.pane, 2, "then give it a title");
    expect((await submits.send("then give it a title")).receipt?.queued).toBeUndefined();
    expect(a.readsAfterEnter()).toBe(1);

    const running = rig({ version: "2.1.301" });
    running.pane.over = [LIVE_ROW];
    let after = 0;
    running.pane.beforeRead = (p) => {
      if (p.keysSeen.includes("Enter")) after++;
    };
    expect((await running.send("then give it a title")).receipt).toMatchObject({ outcome: "sent", queued: true });
    expect(after).toBe(1);

    const seen = rig({ version: "2.1.301" });
    seen.pane.drawsQueuedRow = true;
    const b = queuedRowLate(seen.pane, 1, "then give it a title");
    expect((await seen.send("then give it a title")).receipt).toMatchObject({ outcome: "sent", queued: true });
    expect(b.readsAfterEnter()).toBe(1);
  });

  // The agents screen's key-hint row under its own box, as the capture holds it (claude-lab--agents-screen--w82).
  const AGENTS_DETAIL = "The typed text went into the agents screen's own box, not the conversation's, so Enter was not pressed.";

  test("a screen that replaces the conversation as the text goes in (claude-lab--agents-screen--w82): no Enter, idle or running", async () => {
    const agents = readFileSync(join(import.meta.dir, "../../web/src/fixtures/panes/claude-lab--agents-screen--w82.txt"), "utf8");
    for (const version of ["2.1.200", "2.1.301"]) {
      for (const running of [false, true]) {
        const label = `${version} ${running ? "running" : "idle"}`;
        const { pane, send } = rig({ version });
        pane.height = 16;
        pane.transcript = [...ANSWER];
        if (running) pane.over = [LIVE_ROW];
        // A conversation with the statusline off: one row under the box, as the agents screen draws one
        // key-hint row under its own box. The row count does not tell them apart; the hint row does.
        pane.status = ["  ⏸ manual mode on · ← 11 agents"];
        // The agents screen has a prompt-shaped box of its own: the typed text lands there.
        pane.beforeWrite = (p, what) => {
          if (what.startsWith("paste:") || what === "type:then give it a title") {
            const text = what.slice(what.indexOf(":") + 1);
            p.fixed = agents.replace("❯ describe a task for a new session", `❯ ${text}`);
          }
        };
        const answer = await send("then give it a title");
        expect(pane.keysSeen.includes("Enter"), label).toBe(false);
        expect(answer.receipt, label).toMatchObject({ outcome: "typed_not_submitted", reason: "changed", detail: AGENTS_DETAIL });
      }
    }
  });

  test("a conversation with the statusline off and a plain hint row under the box: sent, idle or running", async () => {
    for (const version of ["2.1.200", "2.1.301"]) {
      for (const status of ["  ? for shortcuts", "  ⏵⏵ bypass permissions on (shift+tab to cycle)"]) {
        const idle = rig({ version });
        idle.pane.status = [status];
        expect((await idle.send("then give it a title")).receipt, `${version} idle ${status}`).toMatchObject({ outcome: "sent" });

        const running = rig({ version });
        running.pane.over = [LIVE_ROW];
        running.pane.status = [status];
        expect((await running.send("then give it a title")).receipt, `${version} running ${status}`).toMatchObject({ outcome: "sent", queued: true });
      }
    }
  });

  test("the probe lands in the agents screen's box: it fails, one Backspace cleans the box, no Enter", async () => {
    const agents = readFileSync(join(import.meta.dir, "../../web/src/fixtures/panes/claude-lab--agents-screen--w82.txt"), "utf8");
    for (const version of ["2.1.200", "2.1.301"]) {
      const { pane, send } = rig({ version });
      pane.over = [LIVE_ROW];
      pane.status = ["  ⏸ manual mode on · ← 11 agents"];
      // The agents screen comes up as the probe goes in: the probe character stands in its box, and
      // one Backspace takes it out again.
      pane.beforeWrite = (p, what) => {
        if (what === `type:${PROBE}`) p.fixed = agents.replace("❯ describe a task for a new session", `❯ ${PROBE}`);
      };
      pane.afterInput = (p, what) => {
        if (what === "keys:Backspace" && p.fixed !== null) p.fixed = agents;
      };
      const answer = await send("then give it a title");
      expect(answer.receipt, version).toMatchObject({ outcome: "refused", reason: "probe_failed", keys: ["probe", "Backspace"] });
      expect(answer.detail, version).toBe("The probe character went into the agents screen's own box, not the conversation's. One Backspace removed the probe character, so the box is clean again.");
      expect(pane.keysSeen, version).toEqual(["Backspace"]);
      expect(pane.calls.filter((call) => call.startsWith("paste:")), version).toEqual([]);
    }
  });

  // Claude Code 2.1.301's header (claude--v2301-idle) and its footer.
  const plainRows = (name: string): string[] =>
    readFileSync(join(import.meta.dir, `../../web/src/fixtures/panes/${name}`), "utf8")
      .split(/\r?\n/u)
      .map((row) =>
        parseAnsi(row)
          .map((segment) => segment.text)
          .join("")
          .trimEnd(),
      );
  const HEADER = plainRows("claude--v2301-idle.txt").slice(0, 3);

  test("the agents screen under the same header and footer as the conversation, its box without the text: no Enter", async () => {
    const agents = plainRows("claude-lab--agents-screen--w82.txt");
    // Both header rows of the agents screen made equal to the conversation's: only the bottom anchor tells them apart.
    const firstHeader = agents.findIndex((row) => row.includes("Claude Code v"));
    agents[firstHeader] = HEADER[0]!;
    agents[firstHeader + 1] = HEADER[1]!;
    // Its key-hint footer made equal to the conversation's too, so no cue under the box tells them apart.
    const footer = agents.findIndex((row) => row.includes("enter to return"));
    agents[footer] = "  ⏸ manual mode on · ? for shortcuts · ← for agents";
    for (const version of ["2.1.200", "2.1.301"]) {
      const { pane, send } = rig({ version });
      pane.transcript = [...HEADER];
      pane.status = ["  ⏸ manual mode on · ? for shortcuts · ← for agents"];
      // The agents screen comes up as the text goes in; the text stays in the conversation's box under
      // it, and the agents box shows its own placeholder. The frame with the text is gone: no Enter.
      // (One that draws the text in its own box is told apart by its own key-hint row, the test above.)
      pane.beforeWrite = (p, what) => {
        if (what.startsWith("paste:") || what === "type:then give it a title") p.fixed = agents.join("\n");
      };
      const answer = await send("then give it a title");
      expect(pane.keysSeen.includes("Enter"), version).toBe(false);
      expect(answer.receipt?.outcome, version).toBe("typed_not_submitted");
    }
  });

  test("a streaming answer under the header goes in", async () => {
    for (const version of ["2.1.200", "2.1.301"]) {
      const { pane, send } = rig({ version });
      pane.drawsQueuedRow = true;
      streamAnswer(pane, typing);
      pane.transcript = [...HEADER, "", "❯ Write a 300 word story about a working dog, plain text, no tools.", ""];
      expect((await send("then give it a title")).receipt, version).toMatchObject({ outcome: "sent", queued: true });
    }
  });

  test("a short answer that fits in two rows, under the header, goes in", async () => {
    for (const version of ["2.1.200", "2.1.301"]) {
      const { pane, send } = rig({ version });
      pane.drawsQueuedRow = true;
      pane.transcript = [...HEADER, "", "❯ Say hello in two lines."];
      let pushed = false;
      pane.beforeRead = (p) => {
        if (pushed || p.calls.length === 0) return;
        pushed = true;
        p.transcript.push("● Hello there. This is the first row of a short answer,", "  and this is the second row.");
      };
      expect((await send("then give it a title")).receipt, version).toMatchObject({ outcome: "sent", queued: true });
    }
  });

  test("a dialog that draws just before Enter takes it and closes: unknown(dialog_after_enter), pointing at the transcript", async () => {
    for (const turn of ["streaming", "running"] as const) {
      const { pane, send } = rig({ version: "2.1.301" });
      if (turn === "streaming") streamAnswer(pane, typing);
      else pane.over = [LIVE_ROW];
      // The dialog draws in the gap before Enter; Enter answers it, and it closes with the text still in the box.
      pane.beforeWrite = (p, what) => {
        if (what === "keys:Enter") {
          p.enterSubmits = false;
          p.dialog = null;
        }
      };
      const answer = await send("then give it a title");
      expect(answer.receipt, turn).toMatchObject({ outcome: "unknown", reason: "dialog_after_enter" });
      expect(answer.detail, turn).toBe("The submit key did not reach the box. A dialog may have taken it. Check the transcript.");
    }
  });

  test("the answer streaming above the box and a pointer list that takes the place of two status rows: no Enter", async () => {
    const { pane, send } = rig({ version: "2.1.301" });
    pane.status = ["  sonnet · project · main", "  ⏸ manual mode on"];
    streamAnswer(pane, typing);
    pane.afterInput = (p, what) => {
      if (what.startsWith("paste:then") || what.startsWith("paste:")) p.status = ["  ❯ 1. Yes", "    2. No"];
    };
    const answer = await send("then give it a title");
    expect(pane.keysSeen.includes("Enter")).toBe(false);
    expect(answer.receipt?.outcome).toBe("typed_not_submitted");
  });

  test("steadyRow masks a running row's spinner glyph and its bracketed digits, and nothing else", () => {
    expect(steadyRow("* Wibbling… (4s · ↓ 304 tokens)")).toBe(steadyRow("✶ Wibbling… (5s · ↓ 310 tokens)"));
    expect(steadyRow("• Working (8s • esc to interrupt) · 1 background terminal running")).toBe(steadyRow("• Working (9s • esc to interrupt) · 1 background terminal running"));
    // A dialog row that walks like a running row still changes when its words change.
    expect(steadyRow("2. No, tell Claude... (3m)")).not.toBe(steadyRow("2. No, tell Claude to wait... (3m)"));
    expect(steadyRow("2. No, tell Claude... (3m)")).toBe("2. No, tell Claude... (0m)");
    expect(steadyRow("an answer row (12s)")).toBe("an answer row (12s)");
  });

  test("steadyRow masks the braille spinner of a row the profile names as a running row (M56 spec 14)", () => {
    const signs = [/^─+\s+[⠀-⣿]\s+Working\b/u, /^\s?[⠀-⣿]\s+\d+s\s.*▶/u];
    expect(steadyRow(" ⠇ 4s > Haiku 4.5 ▶──5%──", signs)).toBe(steadyRow(" ⠹ 5s > Haiku 4.5 ▶──5%──", signs));
    expect(steadyRow("── ⠴ Working ─────", signs)).toBe(steadyRow("── ⠧ Working ─────", signs));
    expect(steadyRow("── ⠴ Working ─────")).not.toBe(steadyRow("── ⠧ Working ─────"));
    // Another row keeps its glyphs, and a changed word still changes the row.
    expect(steadyRow("⠴ other row", signs)).toBe("⠴ other row");
    expect(steadyRow("── ⠴ Working ─────", signs)).not.toBe(steadyRow("── ⠧ Idle ─────", signs));
  });

  test("steadyRow reads the spinner row before and after its timer shows as one row (Claude Code 2.1.301)", () => {
    expect(steadyRow("✶ Wibbling…")).toBe(steadyRow("* Wibbling… (4s · ↓ 304 tokens)"));
    expect(steadyRow("✻ Julienning… (running UserPromptSubmit hooks… 1/2 · 2s · thinking with high effort)")).toBe(steadyRow("· Julienning…"));
    // Another verb is another row.
    expect(steadyRow("✶ Wibbling…")).not.toBe(steadyRow("✶ Waddling…"));
    // A dialog option row is no spinner row: it reads as it is.
    expect(steadyRow("2. No, tell Claude what to do differently (3m)")).toBe("2. No, tell Claude what to do differently (3m)");
  });

  test("with no frame, the spinner row gaining its timer between prepare and commit is not a moved screen", async () => {
    const { pane, send } = rig({ mode: "generic" });
    pane.transcript.push("✶ Wibbling…");
    const first = await send("also say hello");
    expect(first.receipt).toMatchObject({ outcome: "refused", reason: "unconfirmed" });
    pane.transcript[pane.transcript.length - 1] = "* Wibbling… (4s · ↓ 304 tokens)";
    const commit = await send("also say hello", { rowsHash: first.rowsHash! });
    expect(commit.receipt).toMatchObject({ outcome: "sent", keys: ["probe", "Backspace", "Enter"] });
  });

  test("with no frame, a dialog option row that appears between prepare and commit is a moved screen", async () => {
    const { pane, send } = rig({ mode: "generic" });
    pane.transcript.push("✶ Wibbling…");
    const first = await send("also say hello");
    pane.transcript.push("2. No, tell Claude what to do differently (3m)");
    const commit = await send("also say hello", { rowsHash: first.rowsHash! });
    expect(commit.receipt).toMatchObject({ outcome: "refused", reason: "stale_surface", keys: [] });
  });

  test("a send that S0 reads as idle is queued when S2 shows Claude Code's queued row with its text", async () => {
    const { pane, send } = rig();
    pane.drawsQueuedRow = true;
    const answer = await send("QUEUEDMSG please add a title");
    expect(answer.receipt).toMatchObject({ outcome: "sent", queued: true });
    expect(pane.over).toEqual(["❯ QUEUEDMSG please add a title", "  ctrl+enter to send now"]);
  });

  test("the queued witness needs the hint, and the row must carry the sent text", async () => {
    const noHint = rig();
    noHint.pane.afterInput = (p, what) => {
      if (what === "keys:Enter") p.over = ["❯ QUEUEDMSG please add a title"];
    };
    expect((await noHint.send("QUEUEDMSG please add a title")).receipt?.queued).toBeUndefined();
    const other = rig();
    other.pane.afterInput = (p, what) => {
      if (what === "keys:Enter") p.over = ["❯ another message", "  ctrl+enter to send now"];
    };
    expect((await other.send("QUEUEDMSG please add a title")).receipt?.queued).toBeUndefined();
  });

  test("the queued witness joins a wrapped queued text", async () => {
    const { pane, send } = rig();
    pane.afterInput = (p, what) => {
      if (what === "keys:Enter") p.over = ["❯ a long message that the harness wraps", "  onto a second row", "  ctrl+enter to send now"];
    };
    expect((await send("a long message that the harness wraps onto a second row")).receipt).toMatchObject({ outcome: "sent", queued: true });
  });

  test("with no frame, a running row that ticks between prepare and commit is not a moved screen", async () => {
    const { pane, send } = rig({ mode: "generic" });
    let second = 5;
    pane.transcript.push(`• Working (${String(second)}s • esc to interrupt)`);
    pane.beforeRead = (p) => {
      second++;
      p.transcript[p.transcript.length - 1] = `• Working (${String(second)}s • esc to interrupt)`;
    };
    const first = await send("also say hello");
    expect(first.receipt).toMatchObject({ outcome: "refused", reason: "unconfirmed" });
    const commit = await send("also say hello", { rowsHash: first.rowsHash! });
    expect(commit.receipt).toMatchObject({ outcome: "sent", keys: ["probe", "Backspace", "Enter"] });
  });
});

describe("S0", () => {
  test("a dialog on screen is refused not_free with the Surface, nothing typed", async () => {
    const { pane, send } = rig();
    pane.dialog = DIALOG;
    const answer = await send("hello");
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "not_free", keys: [] });
    expect(answer.surface?.modal).not.toBe("none");
    expect(answer.offers).toEqual(["keys"]);
    expect(pane.calls).toEqual([]);
  });

  test("a draft in the box is refused draft_present with Append, Replace and Cancel", async () => {
    const { pane, send } = rig();
    pane.box = "half a thought";
    const answer = await send("hello");
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "draft_present" });
    expect(answer.offers).toEqual(["append", "replace", "cancel"]);
    expect(pane.calls).toEqual([]);
  });

  test("a running turn on a harness that does not queue is refused turn_running, nothing typed", async () => {
    const { pane, send } = rig({ edit: (profile) => ({ ...profile, keys: { ...profile.keys, enterWhileRunning: "ignored" } }) });
    pane.over = ["✻ Thinking… (12s · esc to interrupt)"];
    const answer = await send("hello");
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "turn_running", keys: [] });
    expect(answer.surface).toMatchObject({ turn: "running", modal: "none", composer: "empty" });
    expect(answer.offers).toEqual(["keys"]);
    expect(pane.calls).toEqual([]);
  });

  test("a timer that ticks between the two reads is not a moved box", async () => {
    const { pane, send } = rig();
    let second = 12;
    pane.over = [`✻ Thinking… (${String(second)}s · ↓ 300 tokens)`];
    pane.beforeRead = (p) => {
      second++;
      p.over = [`✻ Thinking… (${String(second)}s · ↓ ${String(300 + second)} tokens)`];
    };
    expect((await send("hello there, agent")).receipt).toMatchObject({ outcome: "sent", queued: true });
  });

  test("a placeholder that changes on the empty box between the two reads is not a moved box", async () => {
    const { pane, send } = rig();
    pane.placeholder = "Press up to edit queued messages";
    pane.beforeRead = (p, n) => {
      if (n === 2) p.placeholder = 'Try "fix the failing tests"';
    };
    expect((await send("hello there, agent")).receipt).toMatchObject({ outcome: "sent" });
  });

  test("a box that changes between the two reads is refused not_free", async () => {
    const { pane, send } = rig();
    pane.beforeRead = (p, n) => {
      if (n === 2) p.box = "someone typed at the desk";
    };
    const answer = await send("hello");
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "not_free" });
    expect(answer.detail).toMatch(/moved between two reads/u);
  });

  test("a pane that cannot be read is refused pane_gone", async () => {
    const { pane, send } = rig();
    pane.readFails = true;
    expect((await send("hello")).receipt).toMatchObject({ outcome: "refused", reason: "pane_gone" });
  });

  test("a pane that now holds another program is refused pane_gone", async () => {
    const r = rig();
    let calls = 0;
    const deps = { ...r.deps, generation: () => (++calls === 1 ? "gen-1" : "gen-2") };
    const protocol = new SendProtocol(deps);
    const answer = await protocol.handle({ id: "gen-change-01", text: "hello", mode: "send" }, { session: "main", paneId: "%1", harness: "claude" });
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "pane_gone" });
  });

  test("every read is fresh: S0 reads twice after the request arrived, never a cached screen", async () => {
    const { pane, send } = rig();
    await send("hello world");
    // two S0 reads, then S1 and S2 each at least once
    expect(pane.readsSeen).toBeGreaterThanOrEqual(4);
  });
});

describe("the probe", () => {
  test("a dialog that swallows input fails the probe, and no corrective key is sent", async () => {
    const { pane, send } = rig({ version: "2.1.999" });
    pane.swallow = true;
    const answer = await send("hello there");
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "probe_failed", keys: ["probe"] });
    expect(answer.offers).toEqual(["keys"]);
    expect(pane.keysSeen).toEqual([]);
    expect(pane.calls).toEqual([`type:${PROBE}`]);
  });

  test("a field above the box that echoes the probe fails it: the box did not take it", async () => {
    const { pane, send } = rig({ version: "2.1.999" });
    pane.echo = { field: "", changesList: false };
    const answer = await send("hello there");
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "probe_failed" });
    expect(pane.keysSeen).toEqual([]);
  });

  test("a Backspace that does not give the box back fails the probe", async () => {
    const { pane, send } = rig({ version: "2.1.999" });
    pane.backspaceRestores = false;
    const answer = await send("hello there");
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "probe_failed", keys: ["probe", "Backspace"] });
    expect(pane.calls).toEqual([`type:${PROBE}`]);
  });

  test("the probe takes at most three reads", async () => {
    const { pane, send } = rig({ version: "2.1.999" });
    let probeReads = 0;
    pane.beforeRead = (p) => {
      if (p.box.includes(PROBE) || p.calls.length === 1) probeReads++;
    };
    pane.swallow = true;
    await send("hello there");
    expect(probeReads).toBeLessThanOrEqual(3);
  });
});

describe("the write and S1", () => {
  test("a write the multiplexer refuses is refused write_failed, nothing submitted", async () => {
    const r = rig({ paste: false });
    r.pane.typeText = () => Promise.resolve(muxRefused("no room"));
    const protocol = new SendProtocol({ ...r.deps, mux: { readGrid: r.pane.readGrid, typeText: r.pane.typeText } });
    const answer = await protocol.handle({ id: "write-fail-01", text: "hello world", mode: "send" }, { session: "main", paneId: "%1", harness: "claude" });
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "write_failed", keys: [] });
    expect(r.pane.keysSeen).toEqual([]);
  });

  test("a write_failed receipt keeps a fixed Collie sentence, never the multiplexer's words; the log keeps them", async () => {
    const r = rig({ paste: false });
    r.pane.typeText = () => Promise.resolve(muxRefused("tmux: can't find pane: %7 /run/user/1000/tmux-1000/default"));
    const protocol = new SendProtocol({ ...r.deps, mux: { readGrid: r.pane.readGrid, typeText: r.pane.typeText } });
    const logged: string[] = [];
    const warn = spyOn(console, "warn").mockImplementation((...lines: string[]): void => {
      logged.push(lines.join(" "));
    });
    let answer: SendAnswer;
    try {
      answer = await protocol.handle({ id: "write-fail-02", text: "hello world", mode: "send" }, { session: "main", paneId: "%1", harness: "claude" });
    } finally {
      warn.mockRestore();
    }
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "write_failed", detail: "Collie could not type into the pane." });
    const stored = r.deps.store.get("write-fail-02")?.receipt;
    expect(stored?.detail).toBe("Collie could not type into the pane.");
    expect(JSON.stringify(stored)).not.toContain("tmux");
    expect(readFileSync(join(dir, "sends", "write-fail-02.json"), "utf8")).not.toContain("/run/user");
    expect(logged.some((line) => line.includes("write_failed") && line.includes("can't find pane: %7"))).toBe(true);
  });

  test("a box that shows other text ends typed_not_submitted with Submit and Discard, no Enter", async () => {
    const { pane, send } = rig();
    pane.dropLastChar = true;
    const answer = await send("hello world");
    expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "mismatch", keys: [] });
    expect(answer.offers).toEqual(["submit", "discard", "keys"]);
    expect(pane.keysSeen).toEqual([]);
    expect(pane.box).toBe("hello worl");
  });

  test("a modal cue between S0 and S1 ends typed_not_submitted modal_cue, no Enter", async () => {
    const { pane, send } = rig();
    pane.afterInput = (p, what) => {
      if (what.startsWith("paste:")) p.popup = ["  ❯ src/main.ts", "    src/other.ts", "  Enter to select · Esc to cancel"];
    };
    const answer = await send("see the file");
    expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "modal_cue" });
    expect(pane.keysSeen).toEqual([]);
  });

  test("a popup under the box (more rows there) ends typed_not_submitted changed", async () => {
    const { pane, send } = rig();
    pane.afterInput = (p, what) => {
      if (what.startsWith("paste:")) p.popup = ["  src/main.ts", "  src/other.ts"];
    };
    const answer = await send("look at main");
    expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "changed" });
    expect(pane.keysSeen).toEqual([]);
  });

  test("a transcript row that moved while typing ends typed_not_submitted changed, where Enter does not queue", async () => {
    const { pane, send } = rig({ edit: (profile) => ({ ...profile, keys: { ...profile.keys, enterWhileRunning: "submits" } }) });
    pane.transcript = Array.from({ length: 12 }, (_, i) => `transcript row ${String(i)}`);
    pane.afterInput = (p, what) => {
      if (what.startsWith("paste:")) p.transcript[0] = "> a different question";
    };
    expect((await send("hello world")).receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "changed" });
    expect(pane.keysSeen).toEqual([]);
  });

  test("a transcript row that moved while a command was typed ends typed_not_submitted changed, where Enter queues", async () => {
    const { pane, send } = rig();
    pane.transcript = Array.from({ length: 12 }, (_, i) => `transcript row ${String(i)}`);
    pane.afterInput = (p, what) => {
      if (what.startsWith("paste:")) p.transcript[0] = "> a different question";
    };
    expect((await send("/compact", { mode: "command" })).receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "changed" });
    expect(pane.keysSeen).toEqual([]);
  });
});

describe("commit", () => {
  test("submit-sent is on disk before the key", async () => {
    const r = rig();
    let phaseAtEnter: string | undefined;
    r.pane.afterInput = (_p, what) => {
      if (what === "keys:Enter") phaseAtEnter = r.deps.store.list().at(-1)?.phase;
    };
    await r.send("hello world");
    expect(phaseAtEnter).toBe("submit-sent");
  });

  test("a token that ages past 150 ms before the key is refused stale_token: typed_not_submitted, no Enter", async () => {
    const r = rig();
    const realMark = r.deps.store.markSubmitSent.bind(r.deps.store);
    r.deps.store.markSubmitSent = (id: string) => {
      realMark(id);
      r.clock.now += 151;
    };
    const answer = await r.send("hello world");
    expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "stale_token", keys: [] });
    expect(r.pane.keysSeen).toEqual([]);
  });

  test("a person's key between S1 and the commit is refused stale_surface: no Enter", async () => {
    const r = rig();
    const realMark = r.deps.store.markSubmitSent.bind(r.deps.store);
    r.deps.store.markSubmitSent = (id: string) => {
      realMark(id);
      void r.deps.gate.press("%1", ["Down"], "person_tap");
    };
    const answer = await r.send("hello world");
    expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "stale_surface" });
    expect(r.pane.keysSeen).toEqual(["Down"]);
  });
});

describe("S2", () => {
  test("Enter went out but the box never emptied: unknown, never resent", async () => {
    const { pane, send } = rig();
    pane.enterSubmits = false;
    const answer = await send("hello world");
    expect(answer.receipt).toMatchObject({ outcome: "unknown", reason: "no_evidence", keys: ["Enter"] });
    expect(answer.offers).toEqual(["keys"]);
    expect(pane.keysSeen).toEqual(["Enter"]);
  });
});

describe("the offers as new requests", () => {
  test("append: the text goes after the draft, then Enter", async () => {
    const { pane, send } = rig();
    pane.box = "first half";
    const answer = await send(" second half", { mode: "append" });
    expect(answer.receipt).toMatchObject({ outcome: "sent" });
    expect(pane.transcript.at(-1)).toBe("> first half second half");
  });

  test("replace: the draft is cleared with Backspace (never Escape), then the text is sent", async () => {
    const { pane, send } = rig();
    pane.box = "old draft";
    const answer = await send("new words", { mode: "replace" });
    expect(answer.receipt?.outcome).toBe("sent");
    expect(pane.transcript.at(-1)).toBe("> new words");
    expect(pane.keysSeen.filter((k) => k === "Backspace").length).toBeGreaterThanOrEqual("old draft".length);
    neverEscape(pane);
  });

  test("replace: the clear is its own step, so S0 keeps its two reads and its own gap", async () => {
    const r = rig();
    r.pane.box = "old draft";
    let reads = 0;
    r.pane.beforeRead = () => {
      reads++;
      // Every read is slow; two of them fit S0's 1200 ms, the clear's reads would not.
      r.clock.now += 400;
    };
    const answer = await r.send("new words", { mode: "replace" });
    expect(answer.receipt?.outcome).toBe("sent");
    expect(answer.receipt?.gapsMs.s0).toBeLessThanOrEqual(1200);
    expect(answer.receipt?.gapsMs.clear).toBeGreaterThan(0);
    expect(reads).toBeGreaterThan(2);
  });

  test("replace: a clear that runs past its bound ends unknown, and no text is written", async () => {
    const r = rig();
    r.pane.box = "old draft";
    r.pane.backspaceRestores = false;
    const answer = await r.send("new words", { mode: "replace" });
    expect(answer.receipt).toMatchObject({ outcome: "unknown", reason: "no_evidence" });
    expect(r.pane.calls).toEqual([]);
    neverEscape(r.pane);
  });

  test("submit after typed_not_submitted: Enter on the text that is there", async () => {
    const { pane, send } = rig();
    pane.dropLastChar = true;
    await send("hello world");
    pane.dropLastChar = false;
    const answer = await send("hello worl", { mode: "submit" });
    expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["Enter"] });
    expect(Object.keys(answer.receipt?.gapsMs ?? {}).toSorted()).toEqual(["commit", "s0", "s2"]);
    expect(pane.transcript.at(-1)).toBe("> hello worl");
  });

  test("submit is refused when the box no longer holds that text", async () => {
    const { pane, send } = rig();
    pane.box = "something else";
    expect((await send("hello", { mode: "submit" })).receipt).toMatchObject({ outcome: "refused", reason: "not_free" });
    expect(pane.keysSeen).toEqual([]);
  });

  /** Codex on Herdr with a row under the box that changes once the box holds more than the probe: S1 never passes. */
  const stuckCodex = () => {
    const pane = new HerdrCodexPane();
    const render = pane.render.bind(pane);
    pane.render = () => (pane.box.length > 1 ? render().replace("  GPT-6-Luna medium", "  ❯ hello-world.ts") : render());
    return { r: rig({ pane, harness: FRAMELESS }), pane };
  };
  const typedNotSubmitted = async (r: Rig, text: string): Promise<SendAnswer> => {
    const look = await r.send(text);
    return r.send(text, { rowsHash: look.rowsHash! });
  };

  test("typed_not_submitted on a pane with no frame offers Submit and Discard, and carries the rows hash it saw", async () => {
    const { r } = stuckCodex();
    const answer = await typedNotSubmitted(r, "hello there");
    expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "mismatch", keys: ["probe", "Backspace"] });
    expect(answer.offers).toEqual(["submit", "discard", "keys"]);
    expect(answer.rowsHash).toMatch(/^[0-9a-f]+$/u);
  });

  test("submit with no frame: Enter through the gate on the rows the person saw, and sent once the box reads empty again", async () => {
    const { r, pane } = stuckCodex();
    const typed = await typedNotSubmitted(r, "hello there");
    const answer = await r.send("hello there", { mode: "submit", rowsHash: typed.rowsHash! });
    expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["Enter"] });
    expect(pane.transcript.at(-1)).toBe("> hello there");
    neverEscape(pane);
  });

  test("discard with no frame: Backspace as often as the text is long plus the slack, and discarded once the box reads empty", async () => {
    const { r, pane } = stuckCodex();
    const typed = await typedNotSubmitted(r, "hello there");
    pane.keysSeen = [];
    const answer = await r.send("hello there", { mode: "discard", rowsHash: typed.rowsHash! });
    expect(answer.receipt).toMatchObject({ outcome: "discarded" });
    expect(pane.box).toBe("");
    expect(pane.keysSeen).toEqual(Array.from({ length: "hello there".length + 16 }, () => "Backspace"));
    neverEscape(pane);
  });

  /** The box holds "hello ther" (one character short) after the text went in, with the earlier message of the same text standing in the history. */
  const shortBox = async () => {
    const { r, pane } = stuckCodex();
    pane.sent = ["hello there"];
    pane.dropLastChar = true;
    const typed = await typedNotSubmitted(r, "hello there");
    pane.dropLastChar = false;
    expect(typed.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "mismatch" });
    expect(pane.box).toBe("hello ther");
    return { r, pane, typed };
  };

  test("submit with no frame when the box holds a different text (send drill 3, 7b): Enter went, so it is sent, and the detail says the text differed", async () => {
    const { r, pane, typed } = await shortBox();
    const answer = await r.send("hello there", { mode: "submit", rowsHash: typed.rowsHash! });
    expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["Enter"] });
    expect(answer.detail).toBe("The box held a different text than the request when Enter went out.");
    expect(pane.transcript.at(-1)).toBe("> hello ther");
    expect(pane.box).toBe("");
    neverEscape(pane);
  });

  test("discard with no frame when the box holds a different text (send drill 3, 7d): judged by the box being empty after the Backspaces", async () => {
    const { r, pane, typed } = await shortBox();
    pane.keysSeen = [];
    const answer = await r.send("hello there", { mode: "discard", rowsHash: typed.rowsHash! });
    expect(answer.receipt).toMatchObject({ outcome: "discarded" });
    expect(pane.box).toBe("");
    expect(pane.keysSeen).toEqual(Array.from({ length: "hello ther".length + 16 }, () => "Backspace"));
    neverEscape(pane);
  });

  test("submit and discard with no frame need the rows hash, and a screen that moved since is refused with both offers again", async () => {
    const { r, pane } = stuckCodex();
    const typed = await typedNotSubmitted(r, "hello there");
    pane.keysSeen = [];
    expect((await r.send("hello there", { mode: "submit" })).receipt).toMatchObject({ outcome: "refused", reason: "not_free" });
    // The status row under the box changes: inside the rows the hash covers.
    const drawn = pane.render.bind(pane);
    pane.render = () => drawn().replace(" · ~/", " · Reply ready · ~/");
    const moved = await r.send("hello there", { mode: "submit", rowsHash: typed.rowsHash! });
    expect(moved.receipt).toMatchObject({ outcome: "refused", reason: "stale_surface", keys: [] });
    expect(moved.offers).toEqual(["submit", "discard", "keys"]);
    expect(moved.rowsHash).not.toBe(typed.rowsHash);
    expect(pane.keysSeen).toEqual([]);
    expect((await r.send("hello there", { mode: "submit", rowsHash: moved.rowsHash! })).receipt).toMatchObject({ outcome: "sent", keys: ["Enter"] });
  });

  test("submit on a framed box that shows other text goes on the rows hash the person saw; without it, it is refused", async () => {
    const { pane, send } = rig();
    pane.dropLastChar = true;
    const typed = await send("hello world");
    expect(typed.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "mismatch" });
    expect(typed.offers).toEqual(["submit", "discard", "keys"]);
    pane.dropLastChar = false;
    expect((await send("hello world", { mode: "submit" })).receipt).toMatchObject({ outcome: "refused", reason: "not_free", keys: [] });
    const answer = await send("hello world", { mode: "submit", rowsHash: typed.rowsHash! });
    expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["Enter"] });
    expect(pane.transcript.at(-1)).toBe("> hello worl");
    expect(answer.detail).toBe("The box held a different text than the request when Enter went out.");
  });

  test("discard: the box is emptied with Backspace, and the outcome says discarded", async () => {
    const { pane, send } = rig();
    pane.box = "do not send this";
    const answer = await send("do not send this", { mode: "discard" });
    expect(answer.receipt).toMatchObject({ outcome: "discarded" });
    expect(pane.box).toBe("");
    neverEscape(pane);
  });
});

describe("the lock", () => {
  test("a second request on the same pane while one runs is refused busy", async () => {
    const { pane, protocol } = rig();
    let release: () => void = () => undefined;
    pane.beforeRead = (_p, n) => (n === 1 ? new Promise<void>((resolve) => (release = resolve)) : undefined);
    const target = { session: "main", paneId: "%1", harness: "claude" };
    const first = protocol.handle({ id: "lock-first-01", text: "first", mode: "send" }, target);
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await protocol.handle({ id: "lock-second-1", text: "second", mode: "send" }, target);
    expect(second.receipt).toMatchObject({ outcome: "refused", reason: "busy" });
    release();
    expect((await first).receipt?.outcome).toBe("sent");
  });

  test("a request past the sum of the bounds ends unknown, keeps its file and releases the lock", async () => {
    const r = rig();
    r.pane.beforeRead = (_p, n) => {
      if (n === 3) r.clock.now += LOCK_BOUND_MS + 1;
    };
    const answer = await r.send("slow multiplexer");
    expect(answer.receipt).toMatchObject({ outcome: "unknown", reason: "bound" });
    expect(r.deps.store.get(answer.receipt!.requestId)?.phase).toBe("settled");
    r.pane.beforeRead = null;
    // The lock is free again: the next request is read, not refused busy (the text of the first is in the box).
    expect((await r.send("the next one")).receipt).toMatchObject({ outcome: "refused", reason: "draft_present" });
  });

  test("S0 past its own bound (2 reads, 1200 ms) is refused bound before anything is written", async () => {
    const r = rig();
    // Two reads of 900 ms each: 900 + 120 + 900 = 1920 ms, past S0's 1200 ms though far inside the request's bound.
    r.pane.beforeRead = () => {
      r.clock.now += 900;
    };
    const answer = await r.send("slow screen");
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "bound", keys: [], s0: null });
    expect(answer.offers).toEqual(["keys"]);
    expect(r.pane.calls).toEqual([]);
    expect(r.pane.keysSeen).toEqual([]);
    expect(r.deps.store.get(answer.receipt!.requestId)?.phase).toBe("settled");
  });

  test("S0 does not start its second read when the gap alone would cross the bound", async () => {
    const r = rig();
    r.pane.beforeRead = () => {
      r.clock.now += 1100;
    };
    const answer = await r.send("slow screen");
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "bound" });
    expect(r.pane.readsSeen).toBe(1);
  });

  test("S0 within its bound still goes through", async () => {
    const r = rig();
    r.pane.beforeRead = (_p, n) => {
      if (n <= 2) r.clock.now += 500;
    };
    const answer = await r.send("a fair screen");
    expect(answer.receipt?.outcome).toBe("sent");
    expect(answer.receipt?.gapsMs.s0).toBe(1120);
  });

  test("an S0 read that hangs is cut at S0's bound, not the request's", async () => {
    const r = rig();
    r.pane.beforeRead = (_p, n) => (n === 2 ? new Promise<void>(() => undefined) : undefined);
    const started = Date.now();
    const answer = await r.send("hung read");
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "bound" });
    // 1200 ms less the 120 ms gap the fake clock skipped; far under the request's 7600 ms.
    expect(Date.now() - started).toBeLessThan(2500);
    expect(r.pane.calls).toEqual([]);
  });

  test("a lock past its bound is free for the next request", () => {
    const locks = new SessionLocks();
    expect(locks.acquire("k", "a", 100, 0)).toBe(true);
    expect(locks.acquire("k", "b", 200, 50)).toBe(false);
    expect(locks.acquire("k", "b", 300, 101)).toBe(true);
    expect(locks.owns("k", "a", 101)).toBe(false);
  });
});

describe("bounded lock", () => {
  /** A multiplexer call that spends the request's bound down to 300 ms on the fake clock, then never answers. */
  function hangNearTheBound(clock: { now: number }): Promise<void> {
    clock.now += LOCK_BOUND_MS - 500;
    return new Promise<void>(() => undefined);
  }

  test("a hung text write ends unknown inside the bound, and the next tap is accepted", async () => {
    const pane = new FakePane();
    const r = rig({ pane });
    pane.beforeWrite = (_p, what) => (what.includes("this write never answers") ? hangNearTheBound(r.clock) : undefined);
    const started = Date.now();
    const answer = await r.send("this write never answers");
    expect(answer.receipt).toMatchObject({ outcome: "unknown", reason: "bound", keys: [] });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(answer.offers).toEqual(["keys"]);
    expect(r.deps.store.get(answer.receipt!.requestId)?.phase).toBe("settled");
    // The lock was released with the outcome: the next tap is read and answered, never refused busy.
    pane.beforeWrite = null;
    const next = await r.send("the next tap");
    expect(next.receipt?.reason).not.toBe("busy");
    expect(next.receipt?.outcome).toBe("sent");
    neverEscape(pane);
  });

  test("a hung Enter ends unknown inside the bound, resends nothing, and the next tap is accepted", async () => {
    const pane = new FakePane();
    const r = rig({ pane });
    pane.beforeWrite = (_p, what) => (what === "keys:Enter" ? hangNearTheBound(r.clock) : undefined);
    const started = Date.now();
    const answer = await r.send("this Enter never answers");
    expect(answer.receipt).toMatchObject({ outcome: "unknown", reason: "bound" });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(pane.keysSeen.filter((key) => key === "Enter")).toEqual([]);
    pane.beforeWrite = null;
    // The text is still in the box (the Enter never left), so the next tap is refused for the draft, not for the lock.
    const next = await r.send("the next tap");
    expect(next.receipt).toMatchObject({ outcome: "refused", reason: "draft_present" });
    neverEscape(pane);
  });

  test("a read that hangs after Enter ends unknown at S2's bound, and the next tap is accepted", async () => {
    const pane = new FakePane();
    const r = rig({ pane });
    const clock = r.clock;
    let entered = false;
    pane.afterInput = (_p, what) => {
      if (what === "keys:Enter") entered = true;
    };
    // S2 has 3000 ms; the first read after Enter spends all but 300 ms of it on the fake clock, then never answers.
    pane.beforeRead = () => {
      if (!entered) return undefined;
      clock.now += 2700;
      return new Promise<void>(() => undefined);
    };
    const started = Date.now();
    const answer = await r.send("this read never answers");
    expect(answer.receipt).toMatchObject({ outcome: "unknown", reason: "no_evidence" });
    expect(Date.now() - started).toBeLessThan(2000);
    pane.beforeRead = null;
    entered = false;
    expect((await r.send("the next tap")).receipt?.reason).not.toBe("busy");
    neverEscape(pane);
  });

  test("a read that hangs before the write ends the step, never types, and the next tap is accepted", async () => {
    const pane = new FakePane();
    const r = rig({ pane });
    pane.beforeRead = (_p, n) => (n === 2 ? new Promise<void>(() => undefined) : undefined);
    const answer = await r.send("this S0 read never answers");
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "bound", keys: [] });
    expect(pane.calls).toEqual([]);
    pane.beforeRead = null;
    expect((await r.send("the next tap")).receipt?.outcome).toBe("sent");
  });

  test("a second tap inside the bound is refused busy, and the lock is free the moment the first settles", async () => {
    const pane = new FakePane();
    const { protocol } = rig({ pane });
    let release: () => void = () => undefined;
    pane.beforeRead = (_p, n) => (n === 1 ? new Promise<void>((resolve) => (release = resolve)) : undefined);
    const target = { session: "main", paneId: "%1", harness: "claude" };
    const first = protocol.handle({ id: "bound-first-01", text: "first", mode: "send" }, target);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await protocol.handle({ id: "bound-second-1", text: "second", mode: "send" }, target)).receipt).toMatchObject({ outcome: "refused", reason: "busy" });
    release();
    expect((await first).receipt?.outcome).toBe("sent");
    pane.beforeRead = null;
    expect((await protocol.handle({ id: "bound-third-01", text: "third", mode: "send" }, target)).receipt?.reason).not.toBe("busy");
  });
});

describe("the crash case", () => {
  test("submit-sent without a settled outcome reads as unknown after a restart, never resent", async () => {
    const storeDir = join(dir, "crash");
    const before = new RequestStore(storeDir);
    before.accept({ id: "crash-req-001", session: "main", paneId: "%1", paneGeneration: "gen-1", surfaceRevision: 0, mode: "send", text: "hello" });
    before.markSubmitSent("crash-req-001");
    // The bridge died here. A new one starts over the same directory.
    const { pane, protocol } = rig({ storeDir });
    const answer = await protocol.handle({ id: "crash-req-001", text: "hello", mode: "send" }, { session: "main", paneId: "%1", harness: "claude" });
    expect(answer.receipt).toMatchObject({ outcome: "unknown", reason: "crash" });
    expect(answer.replayed).toBe(true);
    // Read, report: the pane as it reads now rides on the answer and on the receipt as S2.
    expect(answer.receipt?.s2).toMatchObject({ revision: expect.any(Number), hash: expect.any(String) });
    expect(answer.surface).toMatchObject({ turn: "idle", modal: "none", composer: "empty" });
    expect(answer.rowsHash).toEqual(expect.any(String));
    expect(answer.detail).toContain("restarted");
    expect(pane.calls).toEqual([]);
    expect(pane.keysSeen).toEqual([]);
  });

  test("a request the start-up recovery settled reads the pane when the phone asks again", async () => {
    const storeDir = join(dir, "crash3");
    const before = new RequestStore(storeDir);
    before.accept({ id: "crash-req-003", session: "main", paneId: "%1", paneGeneration: "gen-1", surfaceRevision: 0, mode: "send", text: "hello" });
    before.markSubmitSent("crash-req-003");
    new RequestStore(storeDir).recover(SendProtocol.crashReceipt);
    const { pane, protocol } = rig({ storeDir });
    pane.box = "hello";
    const answer = await protocol.handle({ id: "crash-req-003", text: "hello", mode: "send" }, { session: "main", paneId: "%1", harness: "claude" });
    expect(answer.receipt).toMatchObject({ outcome: "unknown", reason: "crash" });
    expect(answer.surface).toMatchObject({ composer: "draft" });
    expect(answer.offers).toEqual(["keys"]);
    expect(pane.calls).toEqual([]);
    expect(pane.keysSeen).toEqual([]);
  });

  test("a crash look that cannot read the pane still answers unknown, with no screen", async () => {
    const storeDir = join(dir, "crash4");
    const before = new RequestStore(storeDir);
    before.accept({ id: "crash-req-004", session: "main", paneId: "%1", paneGeneration: "gen-1", surfaceRevision: 0, mode: "send", text: "hello" });
    const { pane, protocol } = rig({ storeDir });
    pane.readFails = true;
    const answer = await protocol.handle({ id: "crash-req-004", text: "hello", mode: "send" }, { session: "main", paneId: "%1", harness: "claude" });
    expect(answer.receipt).toMatchObject({ outcome: "unknown", reason: "crash", s2: null });
    expect(answer.surface).toBeUndefined();
  });

  test("the start-up recovery settles it the same way", () => {
    const store = new RequestStore(join(dir, "crash2"));
    store.accept({ id: "crash-req-002", session: "main", paneId: "%1", paneGeneration: "gen-1", surfaceRevision: 0, mode: "send", text: "hello" });
    store.markSubmitSent("crash-req-002");
    const [settled] = new RequestStore(join(dir, "crash2")).recover(SendProtocol.crashReceipt);
    expect(settled?.receipt).toMatchObject({ outcome: "unknown", reason: "crash" });
  });
});

describe("pure helpers", () => {
  test("boxMatches ignores white space and wrapping, and takes a one-line collapse form", () => {
    const collapse = /\[Pasted text #(?<n>\d+)(?: \+(?<lines>\d+) lines)?\]/uy;
    expect(boxMatches("hello wor ld", "", ["hello world"], collapse)).toBe(true);
    expect(boxMatches("hello world!", "", ["hello world"], collapse)).toBe(false);
    expect(boxMatches("draft more", "draft", [" more"], collapse)).toBe(true);
    expect(boxMatches("[Pasted text #2]", "", ["x".repeat(500)], collapse)).toBe(true);
    expect(boxMatches("[Pasted text #2 +11 lines]", "", ["x".repeat(500)], collapse)).toBe(false);
    expect(boxMatches("a [Pasted text #1] b", "", ["a", "y".repeat(300), "b"], collapse)).toBe(true);
    expect(boxMatches("[Pasted text #2]", "", ["short"], null)).toBe(false);
  });

  test("commandBoxMatches takes the text as written, with its lead cut, or with a mode marker for the lead", () => {
    for (const box of ["!echo ok", "! echo ok", "echo ok", "$ echo ok", "[!] echo ok", "! echo ok"]) expect(commandBoxMatches(box, "", ["!echo ok"], null)).toBe(true);
    for (const box of ["echo okay", "x echo ok", "!echo", ""]) expect(commandBoxMatches(box, "", ["!echo ok"], null)).toBe(false);
  });

  test("locateText takes the lowest row, and with partial the box a Backspace shortened, never the history echo above it", () => {
    const rows = ["› say ok", "• ok", "  Worked for 1s", "› say o", "  GPT-6-Luna medium · ~/repo"];
    // An exact look finds the echo in the history: that is why Submit and Discard ask for the partial one.
    expect(locateText(rows, "say ok")).toMatchObject({ row: 0, head: "› ", partial: false });
    expect(locateText(rows, "say ok", true)).toMatchObject({ row: 3, head: "› ", text: "say o", partial: true });
    expect(locateText(rows.slice(0, 3).concat(["› say ok"]), "say ok", true)).toMatchObject({ row: 3, text: "say ok", partial: false });
    // A footer that only starts alike is not the box: it shares less than all but two characters.
    expect(locateText(["› hello there", "  hello-world.ts"], "hello there", true)).toMatchObject({ row: 0, partial: false });
    expect(locateText(["› zz", "  sa"], "say ok", true)).toBeNull();
  });

  test("probeLanding with freeBelow: the rest of the landing row may change and a row under it may go blank, never show other text", () => {
    const before = ["top", "", "› ", "", "  status", "  ← for agents · ? for shortcuts"];
    expect(probeLanding(before, ["top", "", `› ${PROBE}`, "", "  status", ""], PROBE)).toBeNull();
    expect(probeLanding(before, ["top", "", `› ${PROBE}`, "", "  status", ""], PROBE, { freeBelow: true })).toMatchObject({ row: 2, index: 2 });
    expect(probeLanding(["› Ask anything"], [`› ${PROBE}`], PROBE, { freeBelow: true })).toMatchObject({ row: 0, index: 2 });
    expect(probeLanding(before, ["top", "", `› ${PROBE}`, "", "  ❯ a list entry", ""], PROBE, { freeBelow: true })).toBeNull();
    expect(probeLanding(before, ["top!", "", `› ${PROBE}`, "", "  status", ""], PROBE, { freeBelow: true })).toBeNull();
    expect(probeLanding(before, ["top", "", `› ${PROBE}${PROBE}`, "", "  status", ""], PROBE, { freeBelow: true })).toBeNull();
  });

  test("probeLanding wants exactly one changed row and exactly the probe put in", () => {
    const before = ["top", "", "──", "", "──", "~"];
    expect(probeLanding(before, ["top", "", "──", PROBE, "──", "~"], PROBE)).toMatchObject({ row: 3, index: 0 });
    expect(probeLanding(["›"], [`› ${PROBE}`], PROBE)).toMatchObject({ row: 0, index: 2 });
    expect(probeLanding(before, ["top!", "", "──", PROBE, "──", "~"], PROBE)).toBeNull();
    expect(probeLanding(before, ["top", "", "──", `x${PROBE}`, "──", "~"], PROBE)).toBeNull();
    expect(probeLanding(before, before, PROBE)).toBeNull();
  });
});

const fixture = (name: string): string => readFileSync(join(import.meta.dirname, "..", "..", "web", "src", "fixtures", "panes", name), "utf8");

/** A pane that always shows one captured screen and records every write. */
function still(text: string): FakePane {
  const pane = new FakePane();
  pane.render = () => text;
  return pane;
}

describe("real screens from the fixture corpus", () => {

  test("an idle Claude screen reads free at S0 (prepare offers nothing to confirm)", async () => {
    const { protocol } = rig({ pane: still(fixture("claude-lab--idle-fresh--w82.txt")) });
    const prepared = await protocol.handle({ id: "fixture-prep-1", text: "", mode: "prepare" }, { session: "main", paneId: "%1", harness: "claude" });
    expect(prepared.surface).toMatchObject({ turn: "idle", modal: "none", composer: "empty" });
    expect(prepared.offers).toEqual([]);
  });

  test("an unreadable overlay keeps the manual Send: unconfirmed first, and a hotkey screen fails the probe on commit (M56 spec 06)", async () => {
    const pane = still(fixture("claude--menu-effort-slider--w40-low.txt"));
    const { send } = rig({ pane });
    const first = await send("this must not land");
    expect(first.surface?.modal).toBe("unreadable");
    expect(first.receipt).toMatchObject({ outcome: "refused", reason: "unconfirmed", keys: [] });
    expect(first.offers).toEqual(["commit", "keys"]);
    const commit = await send("this must not land", { rowsHash: first.rowsHash! });
    expect(commit.receipt).toMatchObject({ outcome: "refused", reason: "probe_failed" });
    // The probe character went in and showed nowhere, so no Backspace and no text followed it.
    expect(pane.calls).toEqual([`type:${PROBE}`]);
    expect(pane.keysSeen).toEqual([]);
  });

  test("prepare offers the commit tap on an unreadable overlay and the key pad on a lifted ask", async () => {
    const overlay = rig({ pane: still(fixture("claude--menu-effort-slider--w40-low.txt")) });
    const onOverlay = await overlay.protocol.handle({ id: "fixture-prep-2", text: "", mode: "prepare" }, { session: "main", paneId: "%1", harness: "claude" });
    expect(onOverlay.offers).toEqual(["commit", "keys"]);
    const asked = rig();
    asked.pane.dialog = DIALOG;
    const onAsk = await asked.protocol.handle({ id: "fixture-prep-3", text: "", mode: "prepare" }, { session: "main", paneId: "%1", harness: "claude" });
    expect(onAsk.offers).toEqual(["keys"]);
    const drafted = rig();
    drafted.pane.box = "half a thought";
    const onDraft = await drafted.protocol.handle({ id: "fixture-prep-4", text: "", mode: "prepare" }, { session: "main", paneId: "%1", harness: "claude" });
    expect(onDraft.offers).toEqual(["append", "replace", "cancel"]);
  });

  // Claude Code 2.1.302's Heads up notice above a live box, captured mid-turn under a themed spinner
  // (`Fiddle-faddling… · tool use (4m 32s …)`): the turn reads running, so a send of one of the notice's
  // digits is refused with the notice cause and the key pad alone, as under a plain spinner.
  test("a heads-up notice over the box in a running turn leaves the box free, and a send of one of its digits is refused to the key pad", async () => {
    const captured = rig({ pane: still(fixture("claude--v2302-heads-up-above-box--w142.txt")) });
    const prepared = await captured.protocol.handle({ id: "fixture-notice-1", text: "", mode: "prepare" }, { session: "main", paneId: "%1", harness: "claude" });
    expect(prepared.surface).toMatchObject({ turn: "running", modal: "none", composer: "empty" });
    const digit = await captured.send("1");
    expect(digit.receipt).toMatchObject({ outcome: "refused", reason: "unconfirmed", keys: [] });
    expect(digit.cause).toBe("notice_key");
    expect(digit.offers).toEqual(["keys"]);
    expect(digit.receipt?.detail).toBe("That digit would answer the notice above the box. Answer it on its card, or send the digit once the turn has ended.");
    expect(captured.pane.calls).toEqual([]);
  });

  const NOTICE_ROWS = ["✦ Heads up · With GitHub triggers, anyone who files an issue can put text in front of a session", "  1: Learn more   2: Knew this already   0: Dismiss", ""];

  // The review's F2: the bare read (no frame, the whole screen) saw the notice's key row as a single-key
  // prompt, so a plain send into a running turn was refused `not_free`.
  test("on a heads-up notice under a running turn: hello goes on one tap, and the screen reads no modal", async () => {
    const { pane, protocol, send } = rig();
    pane.over = ["✻ Thinking… (2s · esc to interrupt)", "", ...NOTICE_ROWS];
    const prepared = await protocol.handle({ id: "notice-running-1", text: "", mode: "prepare" }, { session: "main", paneId: "%1", harness: "claude" });
    expect(prepared.surface).toMatchObject({ turn: "running", modal: "none", composer: "empty" });
    const answer = await send("hello");
    expect(answer.receipt).toMatchObject({ outcome: "sent" });
    expect(answer.cause).toBeUndefined();
  });

  test("on a heads-up notice under a running turn: 1 is refused with the notice cause and the key pad alone", async () => {
    const { pane, send } = rig();
    pane.over = ["✻ Thinking… (2s · esc to interrupt)", "", ...NOTICE_ROWS];
    const answer = await send("1");
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "unconfirmed", keys: [] });
    expect(answer.cause).toBe("notice_key");
    expect(answer.offers).toEqual(["keys"]);
    expect(pane.calls).toEqual([]);
  });

  test("on a heads-up notice over a draft: 1 is refused draft_present with its offers", async () => {
    const { pane, send } = rig();
    pane.over = NOTICE_ROWS;
    pane.box = "half a thought";
    const answer = await send("1");
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "draft_present" });
    expect(answer.offers).toEqual(["append", "replace", "cancel"]);
    expect(answer.cause).toBeUndefined();
  });

  test("on a heads-up notice over a draft: Replace with 1 is refused with the notice cause, the draft kept", async () => {
    const { pane, send } = rig();
    pane.over = NOTICE_ROWS;
    pane.box = "half a thought";
    const answer = await send("1", { mode: "replace" });
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "unconfirmed", keys: [] });
    expect(answer.cause).toBe("notice_key");
    expect(answer.offers).toEqual(["keys"]);
    expect(answer.detail).toBe("That digit would answer the notice above the box. Answer it on its card, or send the digit once the turn has ended.");
    expect(pane.box).toBe("half a thought");
  });

  // #486's first known limit: Add to it after a draft_present, on a box the person emptied in the
  // meantime, would leave the digit alone in the box, and the notice would take it.
  test("on a heads-up notice over an emptied box: Append of 1 is refused with the notice cause, nothing typed", async () => {
    const { pane, send } = rig();
    pane.over = NOTICE_ROWS;
    pane.afterInput = answersDigit;
    const answer = await send("1", { mode: "append" });
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "unconfirmed", keys: [] });
    expect(answer.cause).toBe("notice_key");
    expect(answer.offers).toEqual(["keys"]);
    expect(pane.calls).toEqual([]);
    expect(pane.over).toEqual(NOTICE_ROWS);
  });

  test("on a heads-up notice over a draft: Append of 1 joins the draft and goes on one tap", async () => {
    const { pane, send } = rig();
    pane.over = NOTICE_ROWS;
    pane.box = "pick option";
    const answer = await send(" 1", { mode: "append" });
    expect(answer.receipt).toMatchObject({ outcome: "sent" });
    expect(answer.cause).toBeUndefined();
    expect(pane.transcript.at(-1)).toBe("> pick option 1");
  });

  test("on a heads-up notice: hello and 10 go on one tap, 1 goes on the commit with the rows hash", async () => {
    const notice = [
      "✦ Heads up · With GitHub triggers, anyone who files an issue on your public repos can put text in front of a session",
      "  on your main PC.",
      "  1: Learn more   2: Knew this already   0: Dismiss",
      "",
    ];
    for (const text of ["hello", "10"]) {
      const { pane, send } = rig();
      pane.over = notice;
      const answer = await send(text);
      expect(answer.receipt, text).toMatchObject({ outcome: "sent" });
      expect(pane.transcript.at(-1)).toBe(`> ${text}`);
    }
    const { pane, send } = rig();
    pane.over = notice;
    const first = await send("1");
    expect(first.receipt).toMatchObject({ outcome: "refused", reason: "unconfirmed", keys: [] });
    expect(first.cause).toBe("notice_key");
    expect(first.offers).toEqual(["commit", "keys"]);
    expect(first.receipt?.detail).toBe("That digit would answer the notice above the box. Check the pane, then tap Type here.");
    pane.afterInput = answersDigit;
    const commit = await send("1", { rowsHash: first.rowsHash! });
    expect(commit.receipt).toMatchObject({ outcome: "sent" });
    // The digit answered the notice: no Enter followed it, so the agent got no message.
    expect(pane.transcript.at(-1)).not.toBe("> 1");
    expect(pane.keysSeen).toEqual([]);
  });

  // Seen live on 2026-10-17: Claude Code's usage row in the blank row between the key row and the box
  // for about ten seconds after a turn. The profile names it (`idle.noticeGaps`), so the box stays free.
  test("on a heads-up notice with the usage row under its keys: hello goes on one tap", async () => {
    const { pane, send } = rig();
    pane.over = [
      "✦ Heads up · One of the notes says a nightly cleanup task",
      "  deletes everything on your X: drive at 03:00. All your repos",
      "  live on that drive.",
      "  1: Learn more   2: Knew this already   0: Dismiss",
      "  You've used 87% of your weekly limit · resets Oct 22, 1am (Ameri…",
    ];
    const answer = await send("hello");
    expect(answer.receipt).toMatchObject({ outcome: "sent" });
    expect(pane.transcript.at(-1)).toBe("> hello");
  });

  // Lane 8788, 2026-10-19: Claude Code's rating survey stood on the update row right over the box, and
  // every send was refused `unconfirmed` (modal unreadable) until it went. The survey is a notice now
  // (ADR 0109) and the update row a gap the profile names: a sentence goes on one tap, a digit takes the
  // notice path. The field record: ~/.local/state/collie-next/surface/examples/01792385882274-*.json.
  const SURVEY_ROWS = ["● How is Claude doing this session? (optional)", "  1: Bad    2: Fine   3: Good   0: Dismiss"];
  const UPDATE_ROW = `${" ".repeat(40)}✔ Update installed · Restart to update`;

  test("on the rating survey over the update row: a sentence goes on one tap, with or without a blank row between", async () => {
    for (const between of [[UPDATE_ROW], ["", UPDATE_ROW]]) {
      const { pane, send } = rig();
      pane.over = [...SURVEY_ROWS, ...between];
      const answer = await send("ok merge the five, running the crew update now");
      expect(answer.receipt, JSON.stringify(between)).toMatchObject({ outcome: "sent" });
      expect(answer.cause).toBeUndefined();
      expect(pane.transcript.at(-1)).toBe("> ok merge the five, running the crew update now");
    }
  });

  test("on the rating survey over the update row: a digit takes the notice path and answers the survey without Enter", async () => {
    for (const digit of ["0", "1", "2", "3"]) {
      const { pane, send } = rig();
      pane.over = [...SURVEY_ROWS, UPDATE_ROW];
      const first = await send(digit);
      expect(first.receipt, digit).toMatchObject({ outcome: "refused", reason: "unconfirmed", keys: [] });
      expect(first.cause).toBe("notice_key");
      expect(first.offers).toEqual(["commit", "keys"]);
      pane.afterInput = answersDigit;
      const commit = await send(digit, { rowsHash: first.rowsHash! });
      expect(commit.receipt).toMatchObject({ outcome: "sent", keys: [] });
      expect(pane.calls).toEqual([`paste:${digit}`]);
      expect(pane.keysSeen).toEqual([]);
    }
    // A digit the survey does not print is an ordinary message.
    const { pane, send } = rig();
    pane.over = [...SURVEY_ROWS, UPDATE_ROW];
    expect((await send("4")).receipt).toMatchObject({ outcome: "sent" });
    expect(pane.transcript.at(-1)).toBe("> 4");
  });

  test("the field screen's capture reads free with the survey over the titled box, and a digit is refused to the notice path", async () => {
    const captured = rig({ pane: still(fixture("claude--v2303-titled-edge-survey--w160.txt")) });
    const prepared = await captured.protocol.handle({ id: "fixture-survey-1", text: "", mode: "prepare" }, { session: "main", paneId: "%1", harness: "claude" });
    expect(prepared.surface).toMatchObject({ turn: "idle", modal: "none", composer: "empty" });
    const digit = await captured.send("2");
    expect(digit.receipt).toMatchObject({ outcome: "refused", reason: "unconfirmed", keys: [] });
    expect(digit.cause).toBe("notice_key");
    expect(captured.pane.calls).toEqual([]);
  });

  /** The notice's plugin: a box holding one of its digits alone answers it, clearing the box and the notice. */
  function answersDigit(pane: FakePane, what: string): void {
    if (/^(?:type|paste):\d$/u.test(what) && pane.over.length > 0) {
      pane.over = [];
      pane.box = "";
    }
  }

  /** A rig with the notice over an empty box, and the first tap of `digit` refused with its rows hash. */
  async function noticeConfirmed(digit: string): Promise<{ pane: FakePane; commit: () => Promise<SendAnswer> }> {
    const { pane, send } = rig();
    pane.over = NOTICE_ROWS;
    const first = await send(digit);
    expect(first.cause).toBe("notice_key");
    return { pane, commit: () => send(digit, { rowsHash: first.rowsHash! }) };
  }

  test("notice digit commit types the digit without Enter", async () => {
    const { pane, commit } = await noticeConfirmed("1");
    pane.afterInput = answersDigit;
    await commit();
    expect(pane.calls).toEqual(["paste:1"]);
    expect(pane.keysSeen.filter((key) => key === "Enter" || key === "ctrl+enter")).toEqual([]);
  });

  test("notice digit commit is sent when the notice clears and the box empties", async () => {
    const { pane, commit } = await noticeConfirmed("2");
    pane.afterInput = answersDigit;
    const answer = await commit();
    expect(answer.receipt).toMatchObject({ outcome: "sent", keys: [] });
    expect(answer.cause).toBe("notice_key");
    expect(pane.over).toEqual([]);
    expect(pane.box).toBe("");
  });

  test("notice digit commit with the digit left in the box ends typed_not_submitted and presses nothing", async () => {
    const { pane, commit } = await noticeConfirmed("1");
    const answer = await commit();
    expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", keys: [] });
    expect(answer.offers).toEqual(["keys"]);
    expect(answer.detail).toBe("The number is still in the box: the notice did not take it. Check the pane.");
    expect(pane.box).toBe("1");
    expect(pane.keysSeen).toEqual([]);
  });

  test("notice digit commit skips the probe", async () => {
    const { pane, commit } = await noticeConfirmed("0");
    pane.afterInput = answersDigit;
    expect((await commit()).receipt).toMatchObject({ outcome: "sent" });
    // The digit is the first and only thing written: no probe character and no Backspace before it.
    expect(pane.calls).toEqual(["paste:0"]);
    expect(pane.keysSeen).not.toContain("Backspace");
  });

  // The 2026-10-16 incident on lane 8788: the agents panel under a free box, with "↓ to view" on the
  // mode row and "↓ to manage" under the panel. 37 sends were refused `unconfirmed`; a plain send goes in.
  test("a plain send goes in with the agents panel under the box (incident 2026-10-16)", async () => {
    const { pane, send } = rig({ version: "2.1.301" });
    pane.status = [
      "  CTX:8% CACHE:99% LIMITS 5h:9%/4h:21m",
      "  [model] ~/project on main*",
      "  ⏵⏵ bypass permissions on (shift+tab to cycle) · 2 background tasks · ↓ to view · ← 11 agents",
      "",
      "  ● main",
      "  ◯ general-purpose   Reading profileFor in profile.ts      2m 3s · ↓ 120.1k tokens",
      "  ◯ fork-name   a new issue arrived in GitHub, p…      31s · ↓ 40.2k tokens",
      "",
      "  ↓ to manage",
    ];
    const answer = await send("carry on with the review please");
    expect(answer.receipt).toMatchObject({ outcome: "sent" });
    expect(answer.receipt?.keys).toContain("Enter");
  });

  // The review of 2026-10-16: with no `● main` over them, `◯` rows under the box are no panel. The
  // frameless read keeps them in sight, so a send into a turn stops at "Something is open at the input box".
  test("a list of ◯ rows under the box with no ● main over it is no panel: a send into a turn is refused", async () => {
    const { pane, send } = rig({ version: "2.1.301" });
    pane.over = [LIVE_ROW];
    // The popup walks as a footer, so only the frameless read sees it.
    pane.status = ["  ⏵⏵ bypass permissions on (shift+tab to cycle)", "", "  ◯ first choice", "  ◯ second choice", "  Enter to select · Esc to cancel"];
    const answer = await send("this must not land");
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "not_free", keys: [] });
    expect(answer.detail).toBe("Something is open at the input box.");
    expect(pane.keysSeen).toEqual([]);
    // The same turn with the agents panel under the box: the panel is named, and the send queues.
    const panel = rig({ version: "2.1.301" });
    panel.pane.over = [LIVE_ROW];
    panel.pane.status = ["  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents", "", "  ● main", "  ◯ first agent   working   3s · ↓ 1k tokens", "  ◯ second agent   working   9s · ↓ 2k tokens"];
    expect((await panel.send("carry on")).receipt).toMatchObject({ outcome: "sent" });
  });

  for (const name of ["claude--menu-model-picker.txt", "claude--menu-resume-picker--w120-search.txt"]) {
    test(`a send into ${name} is refused with no key and no text`, async () => {
      const pane = still(fixture(name));
      const { send } = rig({ pane });
      const answer = await send("this must not land");
      expect(answer.receipt?.outcome).toBe("refused");
      expect(pane.calls).toEqual([]);
      expect(pane.keysSeen).toEqual([]);
    });
  }
});

// ── counters, the cap and the examples (M56 spec 09) ──

describe("counters, the cap and the examples", () => {
  /** A ledger on the rig's clock, in its own folder. */
  function ledgerFor(options: { cap?: number } = {}): SurfaceLedger {
    return new SurfaceLedger(join(dir, "state"), { now: () => 1_000_000, ...options, warn: () => undefined });
  }
  const rowOf = (ledger: SurfaceLedger, harness: string) => ledger.rows().find((row) => row.harness === harness);

  test("a send from a pane the multiplexer calls by another name of the harness is counted under the profile id (M56 spec 14 review)", async () => {
    const ledger = ledgerFor();
    const { send } = rig({ ledger, mode: "generic", harness: "antigravity", version: "1.1.17" });
    await send("hello there");
    expect(ledger.rows().map((row) => row.harness)).toEqual(["agy"]);
    expect(rowOf(ledger, "agy")).toMatchObject({ version: "1.1.17", profileId: "agy", status: "provisional" });
  });

  test("a send that goes through is counted sent under its harness, version, profile and status", async () => {
    const ledger = ledgerFor();
    const { send } = rig({ ledger });
    await send("please fix the failing test in the parser");
    expect(rowOf(ledger, "claude")).toMatchObject({ version: "2.1.200", profileId: "claude", status: "verified", sent: 1, probed: 0, manual: 0, refused: {} });
  });

  test("a refusal is counted by its reason, and a probed send counts probed", async () => {
    const ledger = ledgerFor();
    const { pane, send } = rig({ ledger, version: "2.1.999" });
    pane.dialog = DIALOG;
    await send("hello");
    pane.dialog = null;
    await send("hello again, agent");
    expect(rowOf(ledger, "claude")).toMatchObject({ status: "provisional", refused: { not_free: 1 }, probed: 1, sent: 1 });
  });

  test("a manual send on a screen whose frame S0 cannot find counts manual, and the first tap does not", async () => {
    const ledger = ledgerFor();
    const { send } = rig({ mode: "generic", ledger });
    const first = await send("hello from the phone");
    expect(rowOf(ledger, FRAMELESS)).toMatchObject({ manual: 0, refused: { unconfirmed: 1 } });
    await send("hello from the phone", { rowsHash: first.rowsHash! });
    expect(rowOf(ledger, FRAMELESS)).toMatchObject({ manual: 1, sent: 1, probed: 1, status: "provisional", profileId: FRAMELESS });
  });

  test("a blind send on a pane with no profile counts sent, never manual and never probed, and the cap never asks", async () => {
    const ledger = ledgerFor({ cap: 0 });
    const { send } = rig({ mode: "generic", ledger, harness: NO_PROFILE });
    expect((await send("ls -la")).receipt).toMatchObject({ outcome: "sent", keys: ["Enter"] });
    expect(rowOf(ledger, NO_PROFILE)).toMatchObject({ manual: 0, sent: 1, probed: 0, status: "-", profileId: "-" });
  });

  // The cap counts sends typed past a screen Collie cannot read. A notice's digit is a screen it reads,
  // so its commit neither meets the cap nor counts toward it, and files nothing for the lab.
  test("a commit of a notice's digit goes past a reached cap and counts no manual send", async () => {
    const ledger = ledgerFor({ cap: 1 });
    const { pane, send } = rig({ ledger });
    // The notice takes the digit: it clears the box and goes, as Claude Code's plugin does.
    pane.afterInput = (p, what) => {
      if (/^(?:type|paste):\d$/u.test(what)) {
        p.over = [];
        p.box = "";
      }
    };
    for (const digit of ["1", "2"]) {
      pane.over = ["✦ Heads up · Something new", "  1: Learn more   2: Knew this already   0: Dismiss", ""];
      const first = await send(digit);
      expect(first.cause).toBe("notice_key");
      const commit = await send(digit, { rowsHash: first.rowsHash! });
      expect(commit.receipt, digit).toMatchObject({ outcome: "sent" });
      expect(commit.cap).toBeUndefined();
    }
    expect(rowOf(ledger, "claude")).toMatchObject({ manual: 0 });
  });

  test("past the cap the commit is refused once more with the count and the version, files the frame hash, and counts no manual send", async () => {
    const ledger = ledgerFor({ cap: 2 });
    const { pane, send, protocol } = rig({ mode: "generic", ledger });
    for (let n = 0; n < 2; n++) {
      const first = await send(`hello from the phone ${String(n)}`);
      expect((await send(`hello from the phone ${String(n)}`, { rowsHash: first.rowsHash! })).receipt?.outcome).toBe("sent");
    }
    const first = await send("one more please");
    const capped = await send("one more please", { rowsHash: first.rowsHash! });
    expect(capped.receipt).toMatchObject({ outcome: "refused", reason: "unconfirmed", keys: [] });
    expect(capped.cap).toEqual({ count: 2, limit: 2, harness: FRAMELESS, version: "2.1.200" });
    expect(capped.detail).toContain(`2 times on ${FRAMELESS} 2.1.200 in the last day`);
    // The receipt carries the numbers, so the session page's list can say the cap's sentence for the row.
    expect(capped.receipt?.cap).toEqual({ count: 2, limit: 2, harness: FRAMELESS, version: "2.1.200" });
    expect(protocol.recent("%1")[0]).toMatchObject({ outcome: "refused", reason: "unconfirmed", cap: { count: 2, limit: 2, harness: FRAMELESS, version: "2.1.200" } });
    expect(protocol.recent("%1").filter((row) => row.cap !== undefined)).toHaveLength(1);
    expect(capped.offers).toEqual(["commit", "keys"]);
    expect(capped.rowsHash).toBe(first.rowsHash);
    // Nothing was typed for the refused commit, and no manual send was counted for it.
    expect(pane.calls.filter((call) => call.includes("one more"))).toEqual([]);
    expect(rowOf(ledger, FRAMELESS)?.manual).toBe(2);
    // One line in the inbox: the version and the frame hash, never the rows or the text.
    const lines = readFileSync(join(dir, "state", "surface", "inbox.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ harness: FRAMELESS, version: "2.1.200", frame: first.rowsHash, count: 2 });
    expect(lines[0]).not.toContain("one more");
    // The extra confirm goes through, probed, and counts.
    const acked = await send("one more please", { rowsHash: first.rowsHash!, capAck: true });
    expect(acked.receipt).toMatchObject({ outcome: "sent", keys: ["probe", "Backspace", "Enter"] });
    expect(rowOf(ledger, FRAMELESS)?.manual).toBe(3);
  });

  test("a harness with no version is named alone in the cap's detail, not as `<harness> -`", async () => {
    const ledger = ledgerFor({ cap: 0 });
    const noVersion = rig({ mode: "generic", ledger, version: "unknown" });
    const first = await noVersion.send("hello from the phone");
    const capped = await noVersion.send("hello from the phone", { rowsHash: first.rowsHash! });
    expect(capped.detail).toContain(`0 times on ${FRAMELESS} in the last day`);
    expect(capped.detail).not.toContain(`${FRAMELESS} -`);
  });

  test("a discard is counted as discarded, never as sent", async () => {
    const ledger = ledgerFor();
    const { pane, send } = rig({ ledger });
    pane.box = "do not send this";
    const answer = await send("do not send this", { mode: "discard" });
    expect(answer.receipt).toMatchObject({ outcome: "discarded" });
    expect(answer.receipt?.reason).toBeUndefined();
    expect(answer.offers).toEqual([]);
    expect(rowOf(ledger, "claude")).toMatchObject({ discarded: 1, sent: 0, effective: 0 });
  });

  test("the cap never touches a free send, and never removes the manual one: the ack always goes through", async () => {
    const ledger = ledgerFor({ cap: 0 });
    const free = rig({ ledger });
    expect((await free.send("a free box sends as ever")).receipt?.outcome).toBe("sent");
    const generic = rig({ mode: "generic", ledger });
    const first = await generic.send("hello from the phone");
    const capped = await generic.send("hello from the phone", { rowsHash: first.rowsHash! });
    expect(capped.cap).toMatchObject({ count: 0, limit: 0 });
    expect((await generic.send("hello from the phone", { rowsHash: first.rowsHash!, capAck: true })).receipt?.outcome).toBe("sent");
  });

  test("a ledger that throws never changes an outcome", async () => {
    const broken = {
      send: () => {
        throw new Error("disk full");
      },
      noteManual: () => {
        throw new Error("disk full");
      },
      capState: () => {
        throw new Error("disk full");
      },
      inbox: () => undefined,
      example: () => {
        throw new Error("disk full");
      },
    };
    const { send, deps } = rig({ mode: "generic" });
    const protocol = new SendProtocol({ ...deps, ledger: broken });
    const target = { session: "main", paneId: "%1", harness: "nothing-known" };
    const first = await protocol.handle({ id: nextId(), text: "hello from the phone", mode: "send" }, target);
    const answer = await protocol.handle({ id: nextId(), text: "hello from the phone", mode: "send", rowsHash: first.rowsHash! }, target);
    expect(answer.receipt?.outcome).toBe("sent");
    void send;
  });

  test("a probed send that went out keeps its S0 bottom cluster as a shape, with the typed text only as a length", async () => {
    const ledger = ledgerFor();
    const { pane, send } = rig({ ledger, version: "2.1.999" });
    pane.transcript = ["> my password is hunter2 and the token is sk-live-abcdef"];
    const answer = await send("this exact typed text must not be stored");
    expect(answer.receipt?.outcome).toBe("sent");
    const files = readdirSync(ledger.examplesDir);
    expect(files).toHaveLength(1);
    const text = readFileSync(join(ledger.examplesDir, files[0]!), "utf8");
    // SAFETY: the file was written by `SurfaceLedger.example` a line above; only fields of the written body are read back.
    const example = JSON.parse(text) as { cluster: string[] };
    expect(example).toMatchObject({ outcome: "sent", text: "<typed:40>", textLength: 40, version: "2.1.999", frame: expect.any(String) });
    expect(text).not.toMatch(/hunter2|sk-live|typed text|password|token/u);
    expect(example.cluster.some((row) => row.includes("─"))).toBe(true);
    expect(example.cluster.join("\n")).toMatch(/aa/u);
  });

  test("a refusal over a screen Collie cannot read keeps a negative example: masked cluster, cue kinds and rows, the text as a length", async () => {
    const ledger = ledgerFor();
    const { send } = rig({ ledger, pane: still(fixture("claude--menu-effort-slider--w40-low.txt")) });
    const answer = await send("this exact typed text must not be stored");
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "unconfirmed" });
    const files = readdirSync(ledger.examplesDir);
    expect(files).toHaveLength(1);
    const text = readFileSync(join(ledger.examplesDir, files[0]!), "utf8");
    // SAFETY: the file was written by `SurfaceLedger.example` a line above; only fields of the written body are read back.
    const example = JSON.parse(text) as { cluster: string[]; cues: { kind: string; at: number | null; row: string }[] };
    expect(example).toMatchObject({ outcome: "refused", reason: "unconfirmed", modal: "unreadable", text: "<typed:40>", textLength: 40 });
    expect(example.cues.length).toBeGreaterThan(0);
    for (const cue of example.cues) {
      expect(cue.kind.length).toBeGreaterThan(0);
      // Masked like the cluster: letters are `a`, digits `0`, other marks `x`.
      expect(cue.row).toMatch(/^[a0x\s\u2500-\u259f]*$/u);
      if (cue.at !== null) expect(example.cluster[cue.at]).toBe(cue.row);
    }
    expect(text).not.toMatch(/typed text|effort|Medium/u);
  });

  test("a refusal over a lifted ask or a draft keeps no example: the reader read those screens", async () => {
    const ledger = ledgerFor();
    const { pane, send } = rig({ ledger });
    pane.dialog = DIALOG;
    expect((await send("not over a dialog")).receipt?.outcome).toBe("refused");
    pane.dialog = null;
    pane.box = "half a thought";
    expect((await send("not over a draft")).receipt?.reason).toBe("draft_present");
    expect(existsSync(ledger.examplesDir)).toBe(false);
  });

  test("a send on the fast path stores no example", async () => {
    const ledger = ledgerFor();
    const { send } = rig({ ledger });
    await send("a verified profile, a free box, a long enough text");
    expect(existsSync(ledger.examplesDir)).toBe(false);
  });

  test("recent lists the pane's settled requests newest first, with no text and no rows", async () => {
    const { protocol, send, pane } = rig();
    pane.dialog = DIALOG;
    await send("refused text must not appear");
    pane.dialog = null;
    await send("a text that goes through");
    const rows = protocol.recent("%1");
    expect(rows.map((row) => row.outcome)).toEqual(["sent", "refused"]);
    expect(rows[1]).toMatchObject({ reason: "not_free", keys: [] });
    expect(JSON.stringify(rows)).not.toMatch(/must not appear|goes through/u);
    expect(protocol.recent("%9")).toEqual([]);
    expect(protocol.recent("%1", 1)).toHaveLength(1);
  });
});

// ── a prompt edge closes a receipt (M56 spec 11) ──

describe("a prompt edge closes a receipt as effective", () => {
  const hashOf = (deps: SendDeps, text: string) => deps.store.hashText(text);

  test("after the receipt settled: the stored receipt becomes effective, once", async () => {
    const { send, protocol, deps, clock } = rig();
    const answer = await send("please fix the failing test in the parser");
    const id = answer.receipt!.requestId;
    expect(answer.receipt?.outcome).toBe("sent");
    expect(protocol.promptEdge("%1", hashOf(deps, "please fix the failing test in the parser"), clock.now)).toBe(id);
    expect(deps.store.get(id)?.receipt?.outcome).toBe("effective");
    expect(protocol.promptEdge("%1", hashOf(deps, "please fix the failing test in the parser"), clock.now)).toBeNull();
  });

  test("while the request still runs: the receipt settles as effective", async () => {
    const { pane, send, protocol, deps, clock } = rig();
    let fired = false;
    pane.afterInput = (_p, what) => {
      if (what !== "keys:Enter" || fired) return;
      fired = true;
      protocol.promptEdge("%1", hashOf(deps, "multi line\nsecond"), clock.now);
    };
    const answer = await send("multi line\nsecond");
    expect(answer.receipt?.outcome).toBe("effective");
    expect(answer.receipt?.reason).toBeUndefined();
    expect(answer.offers).toEqual([]);
  });

  test("a desk-typed prompt with the same text 31 s after a free-box send closes nothing", async () => {
    const { send, protocol, deps, clock } = rig();
    const answer = await send("ok then");
    expect(protocol.promptEdge("%1", hashOf(deps, "ok then"), clock.now + 31_000)).toBeNull();
    expect(protocol.promptEdge("%1", hashOf(deps, "ok then"), clock.now - 60_000)).toBeNull();
    expect(deps.store.get(answer.receipt!.requestId)?.receipt?.outcome).toBe("sent");
  });

  test("closes nothing for another text, another pane, or past the window", async () => {
    const { send, protocol, deps, clock } = rig();
    const answer = await send("the text that was typed");
    const hash = hashOf(deps, "the text that was typed");
    expect(protocol.promptEdge("%1", hashOf(deps, "a different prompt"), clock.now)).toBeNull();
    expect(protocol.promptEdge("%2", hash, clock.now)).toBeNull();
    expect(protocol.promptEdge("%1", hash, clock.now + 11 * 60_000)).toBeNull();
    expect(deps.store.get(answer.receipt!.requestId)?.receipt?.outcome).toBe("sent");
  });

  test("a refused send opens no receipt: an edge finds nothing to close", async () => {
    const { pane, send, protocol, deps, clock } = rig();
    pane.box = "a draft the person typed";
    const answer = await send("hello there");
    expect(answer.receipt?.outcome).toBe("refused");
    expect(protocol.promptEdge("%1", hashOf(deps, "hello there"), clock.now)).toBeNull();
  });
});

// ── the held send (M56 spec 15) ──

describe("the held send (M56 spec 15)", () => {
  const FREE = { revision: 1, turn: "idle", modal: "none", composer: "empty" } as const;
  const RUNNING = { revision: 1, turn: "running", modal: "none", composer: "empty" } as const;
  /** A Claude pane whose turn runs and whose binary reported no version: the profile cannot be trusted with the turn. */
  const untrusted = (options: Parameters<typeof rig>[0] = {}): Rig & { holds: HoldStore } => {
    const clock = options.clock ?? { now: 1_000_000 };
    const holds = options.holds ?? new HoldStore(join(dir, "held"), () => clock.now);
    const r = rig({ version: "no version here", ...options, holds, clock });
    r.pane.over = [LIVE_ROW];
    return { ...r, holds };
  };
  /** Ends the pane's turn: the running row goes, the box stays empty. */
  const turnEnds = (pane: FakePane): void => {
    pane.over = [];
  };
  const tick = async (r: Rig, surface: typeof FREE | typeof RUNNING = FREE): Promise<(SendAnswer | null)[]> => Promise.all(r.protocol.tickHolds("main", () => surface));
  /** Two free polls in a row: the first only counts, the second releases (review of spec 15, H2). */
  const freeTwice = async (r: Rig): Promise<(SendAnswer | null)[]> => {
    expect(await tick(r)).toEqual([]);
    return tick(r);
  };

  test("a send the harness cannot take during its turn is held: receipt held, nothing typed, the text on disk 0600", async () => {
    const r = untrusted();
    const answer = await r.send("then give it a title", { id: "held-000001" });
    expect(answer.receipt).toMatchObject({ requestId: "held-000001", outcome: "held", keys: [] });
    expect(answer.receipt?.reason).toBeUndefined();
    expect(answer.offers).toEqual([]);
    expect(answer.detail).toBe("The agent is working. Collie keeps this and sends it when the turn ends.");
    expect(r.pane.calls).toEqual([]);
    expect(r.pane.keysSeen).toEqual([]);
    expect(r.deps.store.get("held-000001")?.phase).toBe("held");
    const file = join(dir, "held", "held-000001.json");
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ id: "held-000001", text: "then give it a title", state: "held", paneId: "%1" });
    // Windows has no POSIX mode bits, so only the mode expectation waits for another platform.
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(r.protocol.heldOf("main", "%1")).toEqual([
      { requestId: "held-000001", mode: "send", text: "then give it a title", heldAt: 1_000_120, expiresAt: 1_000_120 + 30 * 60 * 1000, state: "held" },
    ]);
    expect(r.protocol.recent("%1")[0]).toMatchObject({ requestId: "held-000001", outcome: "held" });
  });

  test("the same id again while held answers the stored held receipt and holds nothing twice", async () => {
    const r = untrusted();
    await r.send("then give it a title", { id: "held-000002" });
    const again = await r.send("then give it a title", { id: "held-000002" });
    expect(again).toMatchObject({ replayed: true, receipt: { outcome: "held" } });
    expect(r.holds.list()).toHaveLength(1);
  });

  test("nothing is released while the Surface reads the turn; two free polls in a row send it under the same id, a fresh run of the protocol", async () => {
    const ledger = new SurfaceLedger(join(dir, "state"), { now: () => 1_000_000 });
    const r = untrusted({ ledger });
    await r.send("then give it a title", { id: "held-000003" });
    expect(await tick(r, RUNNING)).toEqual([]);
    expect(r.pane.calls).toEqual([]);
    turnEnds(r.pane);
    expect(await tick(r)).toEqual([]);
    expect(r.pane.calls).toEqual([]);
    const [released] = await tick(r);
    expect(released?.receipt).toMatchObject({ requestId: "held-000003", outcome: "sent" });
    expect(released?.receipt?.keys.at(-1)).toBe("Enter");
    expect(r.pane.transcript.at(-1)).toBe("> then give it a title");
    expect(r.deps.store.get("held-000003")).toMatchObject({ phase: "settled", receipt: { outcome: "sent" } });
    expect(r.holds.list()).toEqual([]);
    expect(existsSync(join(dir, "held", "held-000003.json"))).toBe(false);
    expect(r.protocol.heldOf("main", "%1")).toEqual([]);
    const row = ledger.rows()[0]!;
    expect(row).toMatchObject({ held: 1, held_sent: 1, sent: 1 });
    neverEscape(r.pane);
  });

  test("a later send on a pane with held sends joins the end, even on a free pane; the second waits for a running turn, then two free polls", async () => {
    const r = untrusted();
    await r.send("first message", { id: "held-000004" });
    turnEnds(r.pane);
    const second = await r.send("second message", { id: "held-000005" });
    expect(second.receipt).toMatchObject({ outcome: "held", keys: [] });
    expect(second.detail).toBe("Earlier messages wait for this pane. Collie sends this after them.");
    expect(r.pane.calls).toEqual([]);
    expect(r.protocol.heldOf("main", "%1").map((row) => row.requestId)).toEqual(["held-000004", "held-000005"]);
    const [first] = await freeTwice(r);
    expect(first?.receipt).toMatchObject({ requestId: "held-000004", outcome: "sent" });
    expect(r.pane.transcript.at(-1)).toBe("> first message");
    // The release started the wait again: free polls alone send nothing until a turn ran.
    expect(await tick(r)).toEqual([]);
    expect(await tick(r)).toEqual([]);
    expect(await tick(r)).toEqual([]);
    expect(await tick(r, RUNNING)).toEqual([]);
    const [next] = await freeTwice(r);
    expect(next?.receipt).toMatchObject({ requestId: "held-000005", outcome: "sent" });
    expect(r.pane.transcript.slice(-2)).toEqual(["> first message", "> second message"]);
  });

  test("a released send that starts no turn does not stall the next: five free polls a minute apart send it, it never expires (review V1)", async () => {
    const clock = { now: 1_000_000 };
    const r = untrusted({ clock });
    await r.send("first message", { id: "held-000040" });
    turnEnds(r.pane);
    await r.send("second message", { id: "held-000041" });
    const [first] = await freeTwice(r);
    expect(first?.receipt).toMatchObject({ requestId: "held-000040", outcome: "sent" });
    // No poll reads a running turn after it (a /help, or a turn shorter than one poll).
    for (let i = 0; i < 4; i++) {
      clock.now += 60_000;
      expect(await tick(r)).toEqual([]);
    }
    clock.now += 60_000;
    const [next] = await tick(r);
    expect(next?.receipt).toMatchObject({ requestId: "held-000041", outcome: "sent" });
    expect(r.pane.transcript.slice(-2)).toEqual(["> first message", "> second message"]);
    expect(r.holds.list()).toEqual([]);
  });

  /** A pi pane in a turn with a held `/model`: pi sends a command with an Enter that steers a turn. */
  const piHeldCommand = async (id: string): Promise<Rig & { holds: HoldStore; clock: { now: number }; pane: PiPane }> => {
    const clock = { now: 1_000_000 };
    const holds = new HoldStore(join(dir, "held"), () => clock.now);
    const pane = new PiPane("alt+Enter");
    pane.inTurn = true;
    const r = rig({ pane, harness: "pi", version: "0.87.1", holds, clock });
    expect((await r.send("/model", { id, mode: "command" })).receipt).toMatchObject({ outcome: "held", keys: [] });
    expect(holds.get(id)?.waitsForTurn).toBe(true);
    pane.inTurn = false;
    return { ...r, holds, clock, pane };
  };

  test("a held command whose Enter steers (pi) never goes on quiet polls: 40 free polls keep it, then it expires at 10 minutes (review Q1)", async () => {
    const r = await piHeldCommand("held-pi-01");
    for (let i = 0; i < 40; i++) {
      r.clock.now += 10_000;
      expect(await tick(r)).toEqual([]);
    }
    expect(r.holds.get("held-pi-01")?.state).toBe("held");
    expect(r.pane.keysSeen).toEqual([]);
    r.clock.now = 1_000_000 + 10 * 60 * 1000 + 1_000;
    await tick(r);
    expect(r.holds.get("held-pi-01")).toMatchObject({ state: "ended", outcome: "expired" });
    expect(r.pane.keysSeen).toEqual([]);
  });

  test("a held command whose Enter steers (pi) goes out after a poll read a running turn, then two free polls", async () => {
    const r = await piHeldCommand("held-pi-02");
    for (let i = 0; i < 10; i++) {
      r.clock.now += 10_000;
      expect(await tick(r)).toEqual([]);
    }
    expect(await tick(r, RUNNING)).toEqual([]);
    const [released] = await freeTwice(r);
    expect(released?.receipt).toMatchObject({ requestId: "held-pi-02", outcome: "sent" });
    expect(released?.receipt?.keys.at(-1)).toBe("Enter");
  });

  test("a held command on a pane whose version was not read waits for a polled turn too; a held text there keeps the quiet path", async () => {
    const clock = { now: 1_000_000 };
    const holds = new HoldStore(join(dir, "held"), () => clock.now);
    const r = rig({ edit: noCommandQueue, holds, clock, version: "no version here" });
    r.pane.over = [LIVE_ROW];
    await r.send("/compact", { id: "held-uv-01", mode: "command" });
    expect(holds.get("held-uv-01")?.waitsForTurn).toBe(true);
    await r.send("then give it a title", { id: "held-uv-02" });
    expect(holds.get("held-uv-02")?.waitsForTurn).toBeUndefined();
  });

  test("five free polls inside ten seconds do not release the next held send on their own", async () => {
    const clock = { now: 1_000_000 };
    const r = untrusted({ clock });
    await r.send("first message", { id: "held-000042" });
    turnEnds(r.pane);
    await r.send("second message", { id: "held-000043" });
    await freeTwice(r);
    for (let i = 0; i < 5; i++) {
      clock.now += 1_000;
      expect(await tick(r)).toEqual([]);
    }
    clock.now += 6_000;
    const [next] = await tick(r);
    expect(next?.receipt).toMatchObject({ requestId: "held-000043", outcome: "sent" });
  });

  test("a plain send that starts with a reserved lead is refused before it can join a queue", async () => {
    const r = untrusted();
    await r.send("first message", { id: "held-000006" });
    expect((await r.send("/compact")).receipt).toMatchObject({ outcome: "refused", reason: "reserved_lead" });
    expect(r.holds.list()).toHaveLength(1);
  });

  test("a command on a harness that does not queue commands is held and sent as a command once free", async () => {
    const r = rig({ edit: noCommandQueue, holds: new HoldStore(join(dir, "held")) });
    r.pane.over = [LIVE_ROW];
    const answer = await r.send("/compact", { id: "held-000007", mode: "command" });
    expect(answer.receipt).toMatchObject({ outcome: "held", keys: [] });
    expect(answer.detail).toBe("The agent is working. Collie keeps this and sends it when the turn ends.");
    turnEnds(r.pane);
    const [released] = await freeTwice(r);
    expect(released?.receipt).toMatchObject({ requestId: "held-000007", outcome: "sent" });
    expect(r.pane.transcript.at(-1)).toBe("> /compact");
  });

  test("Submit of a box in a turn is not held: the box holds text, which a free pane never has", async () => {
    const r = untrusted();
    r.pane.box = "half a thought";
    expect((await r.send("half a thought", { mode: "submit" })).receipt).toMatchObject({ outcome: "refused", reason: "turn_running", keys: [] });
    expect(r.holds.list()).toEqual([]);
  });

  test("after 30 minutes a held send ends expired, its text kept for a Resend; the counters take it", async () => {
    const clock = { now: 1_000_000 };
    const ledger = new SurfaceLedger(join(dir, "state"), { now: () => clock.now });
    const r = untrusted({ clock, ledger });
    await r.send("then give it a title", { id: "held-000008" });
    clock.now += 30 * 60 * 1000 - 1;
    await tick(r, RUNNING);
    expect(r.holds.get("held-000008")?.state).toBe("held");
    clock.now += 1;
    expect(await tick(r)).toEqual([]);
    expect(r.pane.calls).toEqual([]);
    expect(r.deps.store.get("held-000008")).toMatchObject({ phase: "settled", receipt: { outcome: "expired", keys: [] } });
    expect(r.protocol.heldOf("main", "%1")).toEqual([expect.objectContaining({ requestId: "held-000008", state: "ended", outcome: "expired", text: "then give it a title" })]);
    expect(ledger.rows()[0]).toMatchObject({ held: 1, held_expired: 1 });
  });

  test("Cancel ends a held send cancelled and leaves no file; an ended row is dismissed; the counters take the cancel", async () => {
    const clock = { now: 1_000_000 };
    const ledger = new SurfaceLedger(join(dir, "state"), { now: () => clock.now });
    const r = untrusted({ clock, ledger });
    await r.send("then give it a title", { id: "held-000009" });
    expect(r.protocol.cancelHeld("main", "%2", "held-000009")).toBeNull();
    expect(r.protocol.cancelHeld("other", "%1", "held-000009")).toBeNull();
    const cancelled = r.protocol.cancelHeld("main", "%1", "held-000009");
    expect(cancelled).toMatchObject({ result: "cancelled", receipt: { requestId: "held-000009", outcome: "cancelled" } });
    expect(r.deps.store.get("held-000009")?.receipt?.outcome).toBe("cancelled");
    expect(existsSync(join(dir, "held", "held-000009.json"))).toBe(false);
    turnEnds(r.pane);
    expect(await tick(r)).toEqual([]);
    expect(r.pane.calls).toEqual([]);
    expect(ledger.rows()[0]).toMatchObject({ held: 1, held_cancelled: 1 });

    r.pane.over = [LIVE_ROW];
    await r.send("another one", { id: "held-000010" });
    clock.now += 31 * 60 * 1000;
    await tick(r, RUNNING);
    expect(r.protocol.cancelHeld("main", "%1", "held-000010")).toEqual({ result: "dismissed" });
    expect(r.protocol.heldOf("main", "%1")).toEqual([]);
    expect(r.deps.store.get("held-000010")?.receipt?.outcome).toBe("expired");
  });

  test("Cancel on a held send that is going out now is refused busy, and the send completes", async () => {
    const r = untrusted();
    await r.send("then give it a title", { id: "held-000011" });
    turnEnds(r.pane);
    const seen: (HeldCancelAnswer | null)[] = [];
    r.pane.beforeRead = () => {
      if (seen.length === 0) seen.push(r.protocol.cancelHeld("main", "%1", "held-000011"));
    };
    const [released] = await freeTwice(r);
    expect(seen).toEqual([{ result: "refused", reason: "busy" }]);
    expect(released?.receipt?.outcome).toBe("sent");
    // Cancel after it went out: refused busy, with the stored receipt (review of spec 15, H8).
    expect(r.protocol.cancelHeld("main", "%1", "held-000011")).toMatchObject({ result: "refused", reason: "busy", receipt: { requestId: "held-000011", outcome: "sent" } });
    expect(r.protocol.cancelHeld("main", "%2", "held-000011")).toBeNull();
  });

  test("a pane that closes with a held send ends it refused(pane_gone), the text kept", async () => {
    let generation: string | null = "gen-1";
    const r = untrusted({ generation: () => generation });
    await r.send("then give it a title", { id: "held-000012" });
    generation = null;
    // Two polls with no pane may be a redraw; the third ends it (review of spec 15, H5).
    expect(await tick(r)).toEqual([]);
    expect(await tick(r)).toEqual([]);
    expect(r.holds.get("held-000012")?.state).toBe("held");
    expect(await tick(r)).toEqual([]);
    expect(r.deps.store.get("held-000012")?.receipt).toMatchObject({ outcome: "refused", reason: "pane_gone" });
    expect(r.protocol.heldOf("main", "%1")).toEqual([expect.objectContaining({ state: "ended", outcome: "refused", reason: "pane_gone", text: "then give it a title" })]);
    expect(r.pane.calls).toEqual([]);
  });

  test("a pane that comes back within two polls keeps its held send", async () => {
    let generation: string | null = "claude:-";
    const r = untrusted({ generation: () => generation });
    await r.send("then give it a title", { id: "held-000019" });
    generation = null;
    await tick(r);
    await tick(r);
    generation = "claude:-";
    turnEnds(r.pane);
    const [released] = await freeTwice(r);
    expect(released?.receipt).toMatchObject({ requestId: "held-000019", outcome: "sent" });
  });

  test("a session id that resolves, or a /clear, keeps the held send: the agent is the same, and the release runs on the pane as it is", async () => {
    let generation: string | null = "claude:-";
    const r = untrusted({ generation: () => generation });
    await r.send("then give it a title", { id: "held-000020" });
    generation = "claude:session-a";
    await tick(r, RUNNING);
    generation = "claude:session-b";
    turnEnds(r.pane);
    const [released] = await freeTwice(r);
    expect(released?.receipt).toMatchObject({ requestId: "held-000020", outcome: "sent", paneGeneration: "claude:session-b" });
  });

  test("a pane that holds another agent now ends its held sends refused(pane_gone)", async () => {
    let generation: string | null = "claude:-";
    const r = untrusted({ generation: () => generation });
    await r.send("then give it a title", { id: "held-000021" });
    generation = "codex:-";
    await tick(r);
    expect(r.deps.store.get("held-000021")?.receipt).toMatchObject({ outcome: "refused", reason: "pane_gone" });
  });

  test("a pane that holds another program now ends its held sends refused(pane_gone)", async () => {
    let generation: string | null = "gen-1";
    const r = untrusted({ generation: () => generation });
    await r.send("then give it a title", { id: "held-000013" });
    generation = "gen-2";
    await tick(r);
    expect(r.deps.store.get("held-000013")?.receipt).toMatchObject({ outcome: "refused", reason: "pane_gone" });
  });

  test("a release whose S0 finds the turn running again goes back to its place, the receipt held; after five tries it ends", async () => {
    const r = untrusted();
    await r.send("then give it a title", { id: "held-000014" });
    // The poll read free, the protocol's S0 reads the running row: not yet.
    const [back] = await freeTwice(r);
    expect(back?.receipt).toMatchObject({ outcome: "held", keys: [] });
    expect(r.holds.get("held-000014")).toMatchObject({ state: "held", tries: 1 });
    expect(r.deps.store.get("held-000014")?.phase).toBe("held");
    for (let i = 0; i < 3; i++) await freeTwice(r);
    expect(r.holds.get("held-000014")?.tries).toBe(4);
    const [last] = await freeTwice(r);
    expect(last?.receipt).toMatchObject({ outcome: "refused", reason: "turn_running" });
    expect(r.holds.get("held-000014")).toMatchObject({ state: "ended", outcome: "refused", reason: "turn_running", text: "then give it a title" });
    expect(r.pane.calls).toEqual([]);
  });

  test("a release whose pane is locked by another send goes back to its place", async () => {
    const r = untrusted();
    await r.send("then give it a title", { id: "held-000015" });
    turnEnds(r.pane);
    r.deps.locks.acquire("main\u0000%1", "someone-else", r.clock.now + 60_000, r.clock.now);
    const [back] = await freeTwice(r);
    expect(back?.receipt?.outcome).toBe("held");
    expect(r.holds.get("held-000015")?.tries).toBe(1);
    r.deps.locks.release("main\u0000%1", "someone-else");
    const [sent] = await freeTwice(r);
    expect(sent?.receipt?.outcome).toBe("sent");
  });

  test("the queue is replayed on boot: a new store and protocol over the same state dir release it", async () => {
    const first = untrusted();
    await first.send("then give it a title", { id: "held-000016" });
    // A restart: new stores over the same directories, recovery, then the reconcile.
    const store = new RequestStore(join(dir, "sends"), () => 2_000_000);
    expect(store.recover(SendProtocol.crashReceipt)).toEqual([]);
    const holds = new HoldStore(join(dir, "held"), () => 2_000_000);
    expect(SendProtocol.reconcileHolds(holds, store)).toBe(0);
    expect(holds.list()).toEqual([expect.objectContaining({ id: "held-000016", state: "held", text: "then give it a title" })]);
    const pane = new FakePane();
    const second = rig({ version: "no version here", pane, holds, storeDir: join(dir, "sends"), clock: { now: 2_000_000 } });
    const [released] = await freeTwice(second);
    expect(released?.receipt).toMatchObject({ requestId: "held-000016", outcome: "sent" });
    expect(pane.transcript.at(-1)).toBe("> then give it a title");
  });

  test("a release the bridge died in ends unknown(crash) on boot, its text kept, and is never sent again", async () => {
    const first = untrusted();
    await first.send("then give it a title", { id: "held-000017" });
    // The release had started: the file said running, the request ran as accepted.
    first.holds.markRunning("held-000017");
    first.deps.store.rearm("held-000017");
    const store = new RequestStore(join(dir, "sends"), () => 2_000_000);
    expect(store.recover(SendProtocol.crashReceipt).map((record) => record.id)).toEqual(["held-000017"]);
    const holds = new HoldStore(join(dir, "held"), () => 2_000_000);
    expect(SendProtocol.reconcileHolds(holds, store)).toBe(1);
    expect(holds.get("held-000017")).toMatchObject({ state: "ended", outcome: "unknown", reason: "crash", text: "then give it a title" });
    const second = rig({ version: "no version here", holds, storeDir: join(dir, "sends"), clock: { now: 2_000_000 } });
    expect(await tick(second)).toEqual([]);
    expect(second.pane.calls).toEqual([]);
  });

  test("a release that had not started when the bridge died goes back to waiting", async () => {
    const first = untrusted();
    await first.send("then give it a title", { id: "held-000018" });
    first.holds.markRunning("held-000018");
    const store = new RequestStore(join(dir, "sends"), () => 2_000_000);
    store.recover(SendProtocol.crashReceipt);
    const holds = new HoldStore(join(dir, "held"), () => 2_000_000);
    expect(SendProtocol.reconcileHolds(holds, store)).toBe(1);
    expect(holds.get("held-000018")?.state).toBe("held");
  });

  test("a pane holds at most 32 sends; the next is refused busy, never dropped silently", async () => {
    const r = untrusted();
    for (let i = 0; i < 32; i++) expect((await r.send(`message ${String(i)}`)).receipt?.outcome).toBe("held");
    expect((await r.send("one too many")).receipt).toMatchObject({ outcome: "refused", reason: "busy" });
    expect(r.holds.list()).toHaveLength(32);
  });

  test("Add to it in a turn is not held: it names the draft in the box now (review of spec 15, H3)", async () => {
    const r = untrusted();
    r.pane.box = "half a thought";
    expect((await r.send(" and more", { mode: "append" })).receipt).toMatchObject({ outcome: "refused", reason: "turn_running", keys: [] });
    expect(r.holds.list()).toEqual([]);
  });

  test("a command the profile never lets wait is refused in a turn, neither queued by the harness nor held (H6)", async () => {
    const holds = new HoldStore(join(dir, "held"));
    const r = rig({ holds });
    r.pane.over = [LIVE_ROW];
    for (const text of ["/clear", "/resume", "!git status"]) {
      const answer = await r.send(text, { mode: "command" });
      expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "turn_running", keys: [] });
      expect(answer.detail).toBe("Collie does not queue this command during a turn. Send it when the turn ends.");
    }
    expect(holds.list()).toEqual([]);
    expect(r.pane.calls).toEqual([]);
    // A longer word is another command: `/clearly` is not `/clear`.
    const claude = profileFor("claude", "2.1.301", { log: () => undefined });
    expect(neverHeldEntry("/clearly", claude)).toBeNull();
    expect(neverHeldEntry("/clear all", claude)).toBe("/clear");
    // Codex 0.163.0 lists /logout among its slash commands (its binary's command names, review of spec 15).
    expect(neverHeldEntry("/logout", profileFor("codex", "0.163.0", { log: () => undefined }))).toBe("/logout");
    // /compact stays allowed on both.
    expect(neverHeldEntry("/compact", claude)).toBeNull();
    expect(neverHeldEntry("/compact", profileFor("codex", "0.163.0", { log: () => undefined }))).toBeNull();
  });

  test("a never-held command on a profile that does not queue commands is refused, not held, and joins no queue (H6)", async () => {
    const holds = new HoldStore(join(dir, "held"));
    const r = rig({ edit: noCommandQueue, holds });
    r.pane.over = [LIVE_ROW];
    expect((await r.send("/exit", { mode: "command" })).receipt).toMatchObject({ outcome: "refused", reason: "turn_running", keys: [] });
    expect((await r.send("/compact", { mode: "command" })).receipt?.outcome).toBe("held");
    expect((await r.send("/clear", { mode: "command" })).receipt).toMatchObject({ outcome: "refused", reason: "turn_running", keys: [] });
    expect(holds.list().map((entry) => entry.text)).toEqual(["/compact"]);
  });

  test("Muse: every measured session-acting command in a turn is refused, never held, and never typed after the turn ends (MUSE-08, #519)", async () => {
    // Spellings measured live on Muse 1.4.10 (palette/help, nothing destructive executed):
    // /clear and /new clear to a fresh session, /exit and /quit quit, /logout logs out and exits,
    // /resume swaps session, /fork branches it, /rewind rewinds it, and ! is the shell escape.
    const NEVER = "Collie does not queue this command during a turn. Send it when the turn ends.";
    const holds = new HoldStore(join(dir, "held"));
    const r = rig({ harness: "muse", version: "1.4.7", holds });
    r.pane.placeholder = "Start a message with ! to run a shell command yourself";
    r.pane.over = ["◇ Double checking (2m 40s · esc to interrupt)"];
    for (const text of ["/clear", "/new", "/exit", "/quit", "/logout", "/resume", "/fork", "/rewind", "!git status"]) {
      const answer = await r.send(text, { mode: "command" });
      expect(answer.receipt, text).toMatchObject({ outcome: "refused", reason: "turn_running", keys: [] });
      expect(answer.detail, text).toBe(NEVER);
    }
    expect(holds.list()).toEqual([]);
    expect(r.pane.calls).toEqual([]);
    // Nothing is delivered when the turn ends.
    turnEnds(r.pane);
    await freeTwice(r);
    await tick(r);
    expect(r.pane.calls).toEqual([]);
    expect(r.pane.transcript.join("\n")).not.toContain("/clear");
    // Ordinary sends in a Muse turn still hold and queue; /compact is not session-acting.
    r.pane.over = ["◇ Double checking (2m 40s · esc to interrupt)"];
    expect((await r.send("/compact", { mode: "command" })).receipt?.outcome).toBe("held");
    // A never-held command sent behind an existing hold still refuses, never joins the queue.
    expect((await r.send("/clear", { mode: "command" })).receipt).toMatchObject({ outcome: "refused", reason: "turn_running", keys: [] });
    expect((await r.send("then give it a title")).receipt?.outcome).toBe("held");
    expect(holds.list().map((entry) => entry.text)).toEqual(["/compact", "then give it a title"]);
    // The matcher is per spelling: unmeasured or non-session spellings are not caught.
    const muse = profileFor("muse", "1.4.7", { log: () => undefined });
    expect(loadProfiles().get("muse")?.keys.neverHeld).toEqual(["/clear", "/new", "/exit", "/quit", "/logout", "/resume", "/fork", "/rewind", "!"]);
    expect(neverHeldEntry("/fork fix the parser", muse)).toBe("/fork");
    expect(neverHeldEntry("/compact", muse)).toBeNull();
    expect(neverHeldEntry("/branch", muse)).toBeNull();
    expect(neverHeldEntry("/resume-claude", muse)).toBeNull();
    expect(neverHeldEntry("/clearly", muse)).toBeNull();
  });

  describe("a never-held command on a profile the turn cannot be trusted with (PR 491)", () => {
    const NEVER = "Collie does not queue this command during a turn. Send it when the turn ends.";
    const CODEX_WORKING = "• Working (4s • esc to interrupt)";
    const outcomeOf = (answer: SendAnswer, holds: HoldStore) => ({
      outcome: answer.receipt?.outcome,
      detail: answer.detail,
      held: holds.list().length,
    });

    test("control: the same /clear on a Claude whose version was read is refused, not held", async () => {
      const holds = new HoldStore(join(dir, "held"));
      const r = rig({ holds });
      r.pane.over = [LIVE_ROW];
      const answer = await r.send("/clear", { mode: "command" });
      expect(outcomeOf(answer, holds)).toEqual({ outcome: "refused", detail: NEVER, held: 0 });
    });

    test("Claude, version unread: /clear in a turn is refused, not held", async () => {
      const holds = new HoldStore(join(dir, "held"));
      const r = untrusted({ holds });
      const answer = await r.send("/clear", { id: "never-clr-01", mode: "command" });
      expect(outcomeOf(answer, holds)).toEqual({ outcome: "refused", detail: NEVER, held: 0 });
    });

    test("Claude, version unread: a /clear sent in a turn is never typed after the turn ends", async () => {
      const r = untrusted();
      await r.send("/clear", { id: "never-clr-02", mode: "command" });
      expect(await tick(r, RUNNING)).toEqual([]);
      turnEnds(r.pane);
      await freeTwice(r);
      await tick(r);
      expect(r.pane.transcript).not.toContain("> /clear");
      expect(r.pane.calls).toEqual([]);
    });

    test("Codex, version unread: /new in a turn is refused, and never typed after the turn ends", async () => {
      const clock = { now: 1_000_000 };
      const holds = new HoldStore(join(dir, "held"), () => clock.now);
      const r = rig({ pane: new FakePane("codex"), harness: "codex", version: "no version here", holds, clock });
      r.pane.over = [CODEX_WORKING];
      const answer = await r.send("/new", { id: "never-new-01", mode: "command" });
      await tick(r, RUNNING);
      r.pane.over = [];
      await freeTwice(r);
      await tick(r);
      expect({ ...outcomeOf(answer, holds), typed: r.pane.transcript.includes("› /new") }).toEqual({ outcome: "refused", detail: NEVER, held: 0, typed: false });
    });

    test("Codex, version unread, a running screen with no box to read (gateSteeringTurn): /exit is refused, not held", async () => {
      const holds = new HoldStore(join(dir, "held"));
      const pane = new FakePane("codex");
      pane.fixed = ["a transcript row", "", CODEX_WORKING, "", "a row Collie cannot read as a box"].join("\n");
      const r = rig({ pane, harness: "codex", version: "no version here", holds });
      const answer = await r.send("/exit", { id: "never-ext-01", mode: "command" });
      expect(outcomeOf(answer, holds)).toEqual({ outcome: "refused", detail: NEVER, held: 0 });
    });
  });

  test("a held send never goes into a box that answers the agent's question (idle.answerPrompt); a person's send still may", async () => {
    const capture = (name: string): string => readFileSync(join(import.meta.dir, `../../web/src/fixtures/panes/${name}`), "utf8");
    const clock = { now: 1_000_000 };
    const holds = new HoldStore(join(dir, "held"), () => clock.now);
    const r = rig({ harness: "hermes", version: "0.22.2", holds, clock });
    // Hermes works (`☤`): the message is held.
    r.pane.fixed = capture("hermes--running.txt");
    expect((await r.send("then summarize the changes", { id: "held-answer-01" })).receipt?.outcome).toBe("held");
    // The turn pauses on an open question (`✎`): the Surface reads free, but the box answers it.
    r.pane.fixed = capture("hermes--clarify-other.txt");
    const [released] = await freeTwice(r);
    expect(released?.receipt).toMatchObject({ requestId: "held-answer-01", outcome: "held" });
    expect(holds.get("held-answer-01")?.state).toBe("held");
    expect(r.pane.calls).toEqual([]);
    // The person, looking at the question, may answer it from the phone: that send is typed.
    const direct = rig({ harness: "hermes", version: "0.22.2" });
    direct.pane.fixed = capture("hermes--clarify-other.txt");
    const answer = await direct.send("CockroachDB");
    expect(answer.receipt?.reason).not.toBe("not_free");
    expect(direct.pane.calls.length).toBeGreaterThan(0);
  });

  test("a held Replace waits at an answer box too, and an open question spends none of a request's tries", async () => {
    const capture = (name: string): string => readFileSync(join(import.meta.dir, `../../web/src/fixtures/panes/${name}`), "utf8");
    const clock = { now: 1_000_000 };
    const holds = new HoldStore(join(dir, "held"), () => clock.now);
    const r = rig({ harness: "hermes", version: "0.22.2", holds, clock });
    r.pane.fixed = capture("hermes--running.txt");
    expect((await r.send("then summarize the changes", { id: "held-answer-02", mode: "replace" })).receipt?.outcome).toBe("held");
    r.pane.fixed = capture("hermes--clarify-other.txt");
    // Far past the five tries a pane that is not ready gets: the question stays open for minutes.
    for (let i = 0; i < 30; i++) {
      clock.now += 10_000;
      await tick(r);
    }
    expect(holds.get("held-answer-02")).toMatchObject({ state: "held", tries: 0 });
    expect(r.pane.calls).toEqual([]);
  });

  test("a never-held command on a running screen with no frame is refused, not held", async () => {
    // Hermes mid-redraw: the `☤` row stands, its rules are not drawn yet, so no frame is read and the
    // screen takes the manual path, where the running row is read by the steering-turn gate.
    const capture = readFileSync(join(import.meta.dir, "../../web/src/fixtures/panes/hermes--running.txt"), "utf8");
    const rows = capture.split("\n");
    const sgr = new RegExp(`${String.fromCodePoint(0x1b)}\\[[0-9;]*m`, "gu");
    const isRule = (row: string): boolean => /^─{20,}\s*$/u.test(row.replace(sgr, ""));
    const rules = new Set(rows.map((row, i) => (isRule(row) ? i : -1)).filter((i) => i >= 0).slice(-2));
    const holds = new HoldStore(join(dir, "held"));
    const r = rig({ harness: "hermes", version: "0.22.2", holds });
    r.pane.fixed = rows.filter((_, i) => !rules.has(i)).join("\n");
    const answer = await r.send("/exit", { mode: "command" });
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "turn_running", keys: [] });
    expect(answer.detail).toBe("Collie does not queue this command during a turn. Send it when the turn ends.");
    expect(holds.list()).toEqual([]);
  });

  test("a never-held command is refused, not held, on a harness that takes nothing in a turn", async () => {
    // Hermes's shape: Enter steers a turn and no key queues, so every send in a turn is held, except
    // the commands the profile never lets wait. An untrusted version takes the same path.
    const holds = new HoldStore(join(dir, "held"));
    const r = rig({ edit: steersWithNoQueueKey, holds });
    r.pane.over = [LIVE_ROW];
    for (const text of ["/clear", "/resume", "!git status"]) {
      const answer = await r.send(text, { mode: "command" });
      expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "turn_running", keys: [] });
      expect(answer.detail).toBe("Collie does not queue this command during a turn. Send it when the turn ends.");
    }
    expect((await r.send("/compact", { mode: "command" })).receipt?.outcome).toBe("held");
    expect((await r.send("then give it a title")).receipt?.outcome).toBe("held");
    expect(holds.list().map((entry) => entry.text)).toEqual(["/compact", "then give it a title"]);
    expect(r.pane.calls).toEqual([]);
    const untrustedHolds = new HoldStore(join(dir, "held-untrusted"));
    const u = untrusted({ holds: untrustedHolds });
    expect((await u.send("/clear", { mode: "command" })).receipt).toMatchObject({ outcome: "refused", reason: "turn_running", keys: [] });
    expect(untrustedHolds.list()).toEqual([]);
  });

  test("a held command expires after 10 minutes, a held text after 30 (H6)", async () => {
    const clock = { now: 1_000_000 };
    const holds = new HoldStore(join(dir, "held"), () => clock.now);
    const r = rig({ edit: noCommandQueue, holds, clock, version: "no version here" });
    r.pane.over = [LIVE_ROW];
    await r.send("/compact", { id: "held-cmd-01", mode: "command" });
    await r.send("then give it a title", { id: "held-txt-01" });
    clock.now += 10 * 60 * 1000;
    await tick(r, RUNNING);
    expect(holds.get("held-cmd-01")).toMatchObject({ state: "ended", outcome: "expired" });
    expect(holds.get("held-txt-01")?.state).toBe("held");
  });

  test("a manual send on a pane with held sends joins the queue too (H9)", async () => {
    const r = untrusted();
    await r.send("first message", { id: "held-man-01" });
    turnEnds(r.pane);
    const manual = await r.send("second message", { id: "held-man-02", rowsHash: "abc123" });
    expect(manual.receipt).toMatchObject({ outcome: "held", keys: [] });
    expect(r.pane.calls).toEqual([]);
    expect(r.protocol.heldOf("main", "%1").map((row) => row.requestId)).toEqual(["held-man-01", "held-man-02"]);
  });

  test("the bridge holds at most 256 sends over all panes; the next is refused busy (H9)", async () => {
    const r = untrusted();
    for (let i = 0; i < 256; i++) r.holds.add({ id: `seed-${String(i).padStart(6, "0")}`, session: "main", paneId: `%${String(100 + (i % 16))}`, harness: "claude", mode: "send", text: "x", revision: 0, command: false });
    expect((await r.send("one too many")).receipt).toMatchObject({ outcome: "refused", reason: "busy" });
  });

  test("Resend takes the stored text of an ended row, never one that may have reached the agent or still stands in the box (H7)", async () => {
    const clock = { now: 1_000_000 };
    const r = untrusted({ clock });
    await r.send("then give it a title", { id: "held-res-01" });
    expect(r.protocol.resendSource("main", "%1", "held-res-01")).toBeNull();
    clock.now += 31 * 60 * 1000;
    await tick(r, RUNNING);
    expect(r.protocol.resendSource("main", "%1", "held-res-01")).toEqual({ text: "then give it a title", mode: "send" });
    expect(r.protocol.resendSource("main", "%2", "held-res-01")).toBeNull();
    r.holds.add({ id: "held-res-02", session: "main", paneId: "%1", harness: "claude", mode: "send", text: "maybe in", revision: 0, command: false });
    r.holds.end("held-res-02", "unknown", "no_evidence");
    expect(r.protocol.resendSource("main", "%1", "held-res-02")).toBeNull();
    r.holds.add({ id: "held-res-03", session: "main", paneId: "%1", harness: "claude", mode: "send", text: "in the box", revision: 0, command: false });
    r.holds.end("held-res-03", "typed_not_submitted", "changed");
    expect(r.protocol.resendSource("main", "%1", "held-res-03")).toBeNull();
    expect(r.protocol.dismissHeld("main", "%1", "held-res-01")).toBe(true);
    expect(r.protocol.dismissHeld("main", "%1", "held-res-01")).toBe(false);
  });

  test("on boot, held sends of a session that no longer exists go, and a still-held request settles pane_gone (H9)", async () => {
    const r = untrusted();
    await r.send("then give it a title", { id: "held-gone-01" });
    expect(SendProtocol.dropHoldsOutside(r.holds, r.deps.store, new Set(["main"]))).toBe(0);
    expect(SendProtocol.dropHoldsOutside(r.holds, r.deps.store, new Set(["other"]))).toBe(1);
    expect(r.holds.list()).toEqual([]);
    expect(r.deps.store.get("held-gone-01")?.receipt).toMatchObject({ outcome: "refused", reason: "pane_gone" });
  });

  test("without a hold queue the old refusal stands: turn_running, nothing typed", async () => {
    const r = rig({ version: "no version here" });
    r.pane.over = [LIVE_ROW];
    expect((await r.send("then give it a title")).receipt).toMatchObject({ outcome: "refused", reason: "turn_running", keys: [] });
  });
});

// ── M56 spec 14 review: the omp keys, the probe rule, the frameless gate, the platform keys ──

/**
 * OMP 18.6.1 as the lab read it (2026-10-16): an open box (`╰─` under a status row), Ctrl+Q sends on an
 * idle box and queues in a turn, Enter steers a running turn. A turn shows a blinking `Working…` row and a
 * spinner with the seconds in the status row, which does not blink.
 */
class OmpPane extends FakePane {
  inTurn = false;
  /** The blinking row is on. A turn with the row off shows its spinner in the status row alone. */
  showWorking = true;
  /** Texts Enter sent into the turn: steering, which the send must never do. */
  steered: string[] = [];
  /**
   * The command words OMP runs at once when Enter takes them in a turn, never as steering text (lab,
   * 18.12.2, 2026-10-19: `/goal`). Empty runs none, the shape before the lab.
   */
  runsAtOnce: string[] = [];
  /** Commands Enter ran at once in a turn. */
  ran: string[] = [];

  constructor() {
    super("generic");
    this.transcript = Array.from({ length: 12 }, (_, i) => ` an earlier row of the agent answer ${String(i)}`);
    const base = this.writeKeys;
    this.writeKeys = (paneId, keys) => {
      for (const key of keys) {
        if (key === "ctrl+q" || (key === "Enter" && this.inTurn)) {
          this.keysSeen.push(key);
          const text = this.box.replace(/\n/gu, " ");
          if (key === "Enter" && this.runsAtOnce.includes(text.split(" ")[0] ?? "")) {
            // The command runs before the turn sees it: its status line prints above the box.
            this.ran.push(text);
            this.transcript.push(` ran ${text}`);
          } else if (text.length > 0 && key === "Enter") this.steered.push(text);
          else if (text.length > 0 && this.inTurn) this.queued.push(text);
          else if (text.length > 0) this.transcript.push(` > ${text}`);
          this.box = "";
          this.revision++;
        } else void base(paneId, [key]);
      }
      return Promise.resolve(muxAck());
    };
  }

  override render(): string {
    const rows = [...this.transcript, ""];
    if (this.queued.length > 0) rows.push(`  After yield · ${String(this.queued.length)}`, ...this.queued.map((text, i) => `  ${String(i + 1)}. ${text}`), "  └ Alt+↑ to edit", "");
    if (this.inTurn && this.showWorking) rows.push("  ⎋ Working…                                      Write essay");
    rows.push(this.inTurn ? " ⠼ 4s > ◒ Haiku 4.5 > 📁 ~/work > ⑂ master ?1 > $0.06 ▶──6%─────────────" : " π > ◒ Haiku 4.5 > 📁 ~/work > ⑂ master ?1 > $0.06 ▶──6%─────────────");
    this.box.split("\n").forEach((line, i) => rows.push(i === 0 ? `╰─ ${line}`.trimEnd() : `   ${line}`));
    return rows.join("\n");
  }
}

function omp(options: { version?: string; edit?: (profile: Profile) => Profile; holds?: HoldStore } = {}): Rig & { pane: OmpPane } {
  const pane = new OmpPane();
  const rigOptions: Parameters<typeof rig>[0] = { pane, harness: "omp", version: options.version ?? "18.6.1" };
  if (options.edit !== undefined) rigOptions.edit = options.edit;
  if (options.holds !== undefined) rigOptions.holds = options.holds;
  const made = rig(rigOptions);
  return { ...made, pane };
}

describe("OMP: Ctrl+Q sends, Enter steers (M56 spec 14 review)", () => {
  test("an idle box is sent with Ctrl+Q, never Enter", async () => {
    const { pane, send } = omp();
    const answer = await send("write the summary now");
    expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["probe", "Backspace", "ctrl+q"] });
    expect(pane.keysSeen).not.toContain("Enter");
    expect(pane.transcript.at(-1)).toBe(" > write the summary now");
  });

  test("a command takes Enter, which sends a command on an idle box", async () => {
    const { pane, send } = omp();
    const answer = await send("/model", { mode: "command" });
    expect(answer.receipt?.keys.at(-1)).toBe("Enter");
    expect(pane.keysSeen).not.toContain("ctrl+q");
  });

  test("a turn shown by the status row's spinner alone (the Working row is off): the send queues with Ctrl+Q, never Enter", async () => {
    const { pane, send } = omp();
    pane.inTurn = true;
    pane.showWorking = false;
    const answer = await send("then add a short summary");
    expect(answer.receipt).toMatchObject({ outcome: "sent", queued: true });
    expect(answer.receipt?.keys.at(-1)).toBe("ctrl+q");
    expect(pane.queued).toEqual(["then add a short summary"]);
    expect(pane.keysSeen).not.toContain("Enter");
    expect(pane.steered).toEqual([]);
  });

  test("a turn shown by the Working row alone (the status row at rest): the send queues with Ctrl+Q, never Enter", async () => {
    const { pane, send } = omp();
    pane.inTurn = true;
    const render = pane.render.bind(pane);
    pane.render = () => render().replace(" ⠼ 4s >", " π >");
    const answer = await send("then add a short summary");
    expect(answer.receipt).toMatchObject({ outcome: "sent", queued: true });
    expect(answer.receipt?.keys.at(-1)).toBe("ctrl+q");
    expect(pane.keysSeen).not.toContain("Enter");
    expect(pane.steered).toEqual([]);
  });

  test("the Working row blinks off between the first read and the commit: Enter never goes in", async () => {
    const { pane, send } = omp();
    pane.inTurn = true;
    pane.beforeRead = (p, n) => {
      if (p instanceof OmpPane) p.showWorking = n % 2 === 0;
    };
    const answer = await send("then add a short summary");
    expect(["sent", "refused", "typed_not_submitted", "unknown"]).toContain(String(answer.receipt?.outcome));
    expect(pane.keysSeen).not.toContain("Enter");
    expect(pane.steered).toEqual([]);
  });

  test("a profile with a platform entry presses that platform's submit key", async () => {
    const win = omp({ edit: (profile) => forPlatform({ ...profile, keys: { ...profile.keys, submitByPlatform: { win32: ["Enter"] } } }, "win32") });
    const answer = await win.send("write the summary now");
    expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["probe", "Backspace", "Enter"] });
    expect(win.pane.keysSeen).not.toContain("ctrl+q");
  });
});

describe("OMP runs `/goal` at once in a turn (keys.commandsRunInTurn, lab 18.12.2, 2026-10-19)", () => {
  /** An OMP pane in a turn, its fake running `/goal` at once on Enter as 18.12.2 did in the lab. */
  const goalTurn = (options: Parameters<typeof omp>[0] = {}): Rig & { pane: OmpPane } => {
    const made = omp({ version: "18.12.2", ...options });
    made.pane.inTurn = true;
    made.pane.runsAtOnce = ["/goal"];
    return made;
  };
  /** The profile with its one range revoked. */
  const revoke = (profile: Profile): Profile => ({ ...profile, versions: [{ ...profile.versions[0], status: "revoked" }] });

  test("the shipped profile lists /goal alone, with its lab note", () => {
    const keys = loadProfiles().get("omp")!.keys;
    expect(keys.commandsRunInTurn).toEqual(["/goal"]);
    expect(keys.commandsRunInTurnNote).toContain("18.12.2");
  });

  test("runsInTurnEntry matches the word alone or followed by white space, on a version the turn may trust", () => {
    const log = { log: () => undefined };
    const provisional = profileFor("omp", "18.12.2", log);
    expect(provisional?.status).toBe("provisional");
    expect(runsInTurnEntry("/goal pause", provisional)).toBe("/goal");
    expect(runsInTurnEntry("  /goal  ", provisional)).toBe("/goal");
    expect(runsInTurnEntry("/goal\tresume", provisional)).toBe("/goal");
    expect(runsInTurnEntry("/goals", provisional)).toBeNull();
    expect(runsInTurnEntry("/model", provisional)).toBeNull();
    expect(runsInTurnEntry("pause /goal", provisional)).toBeNull();
    expect(runsInTurnEntry("/goal pause", profileFor("omp", "18.6.1", log))).toBe("/goal");
    // An unread version, a revoked range, and a profile with no list match nothing.
    expect(runsInTurnEntry("/goal pause", profileFor("omp", null, log))).toBeNull();
    const revoked = new Map([["omp", revoke(loadProfiles().get("omp")!)]]);
    expect(runsInTurnEntry("/goal pause", profileFor("omp", "18.6.1", { ...log, profiles: revoked }))).toBeNull();
    expect(runsInTurnEntry("/goal pause", profileFor("omp", "18.12.2", { ...log, profiles: revoked }))).toBeNull();
    expect(runsInTurnEntry("/goal pause", profileFor("pi", "0.87.1", log))).toBeNull();
  });

  test("/goal pause in a turn goes in at once with Enter: probed, sent, never queued, never steered, nothing held", async () => {
    const holds = new HoldStore(join(dir, "held"), () => 1_000_000);
    const { pane, send } = goalTurn({ holds });
    const answer = await send("/goal pause", { mode: "command" });
    expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["probe", "Backspace", "Enter"], version: "18.12.2", profileStatus: "provisional" });
    expect(answer.receipt?.queued).toBeUndefined();
    expect(pane.ran).toEqual(["/goal pause"]);
    expect(pane.steered).toEqual([]);
    expect(pane.queued).toEqual([]);
    expect(pane.keysSeen).not.toContain("ctrl+q");
    expect(holds.list()).toEqual([]);
    neverEscape(pane);
  });

  test("/goal status, /goal resume and a bare /goal go the same way, on the verified range too", async () => {
    for (const version of ["18.6.1", "18.12.2"]) {
      for (const text of ["/goal status", "/goal resume", "/goal"]) {
        const { pane, send } = goalTurn({ version });
        const answer = await send(text, { mode: "command" });
        expect([version, text, answer.receipt?.outcome, answer.receipt?.keys.at(-1)]).toEqual([version, text, "sent", "Enter"]);
        expect(pane.ran).toEqual([text]);
        expect(pane.steered).toEqual([]);
      }
    }
  });

  test("the answer streaming above the box while /goal is typed does not stop it", async () => {
    const { pane, send } = goalTurn();
    let streamed = 0;
    pane.afterInput = (p) => {
      streamed++;
      p.transcript.push(` tick ${String(streamed)} of the streaming answer`);
    };
    const answer = await send("/goal resume", { mode: "command" });
    expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["probe", "Backspace", "Enter"] });
    expect(answer.receipt?.queued).toBeUndefined();
    expect(pane.ran).toEqual(["/goal resume"]);
    expect(pane.steered).toEqual([]);
  });

  test("a command the list does not name is held as before, nothing typed: /model, /goals, a prompt template", async () => {
    for (const text of ["/model", "/goals", "/labnote"]) {
      const holds = new HoldStore(join(dir, `held-${text.slice(1)}`), () => 1_000_000);
      const { pane, send } = goalTurn({ holds });
      const answer = await send(text, { mode: "command" });
      expect([text, answer.receipt?.outcome, answer.receipt?.keys]).toEqual([text, "held", []]);
      expect(holds.list().map((entry) => [entry.text, entry.waitsForTurn])).toEqual([[text, true]]);
      expect(pane.keysSeen).toEqual([]);
      expect(pane.ran).toEqual([]);
    }
  });

  test("without a hold queue a command the list does not name is refused turn_running, nothing typed", async () => {
    const { pane, send } = goalTurn();
    const answer = await send("/model", { mode: "command" });
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "turn_running", keys: [] });
    expect(answer.detail).toBe("A command waits until the turn ends.");
    expect(pane.calls).toEqual([]);
  });

  test("on an idle box /goal pause takes Enter as every command does", async () => {
    const { pane, send } = goalTurn();
    pane.inTurn = false;
    const answer = await send("/goal pause", { mode: "command" });
    expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["probe", "Backspace", "Enter"] });
    expect(answer.receipt?.queued).toBeUndefined();
    expect(pane.transcript.at(-1)).toBe("> /goal pause");
    expect(pane.ran).toEqual([]);
  });

  test("an unread version or a revoked range keeps the hold: the command waits for the turn, never Entered", async () => {
    const cases: { name: string; version: string; edit?: (profile: Profile) => Profile }[] = [
      { name: "unread", version: "no version here" },
      { name: "revoked", version: "18.6.1", edit: revoke },
      { name: "revoked, borrowed", version: "18.12.2", edit: revoke },
    ];
    for (const c of cases) {
      const holds = new HoldStore(join(dir, `held-${c.name}`), () => 1_000_000);
      const options: Parameters<typeof omp>[0] = { version: c.version, holds };
      if (c.edit !== undefined) options.edit = c.edit;
      const { pane, send } = goalTurn(options);
      const answer = await send("/goal pause", { mode: "command" });
      expect([c.name, answer.receipt?.outcome, answer.receipt?.keys]).toEqual([c.name, "held", []]);
      expect(holds.list().map((entry) => entry.waitsForTurn)).toEqual([true]);
      expect(pane.keysSeen).toEqual([]);
    }
  });

  test("a profile without the list holds /goal pause in a turn, the shape before the lab", async () => {
    const holds = new HoldStore(join(dir, "held"), () => 1_000_000);
    const withoutList = (profile: Profile): Profile => {
      const { commandsRunInTurn, commandsRunInTurnNote, ...keys } = profile.keys;
      void commandsRunInTurn;
      void commandsRunInTurnNote;
      return { ...profile, keys };
    };
    const { pane, send } = goalTurn({ holds, edit: withoutList });
    expect((await send("/goal pause", { mode: "command" })).receipt).toMatchObject({ outcome: "held", keys: [] });
    expect(pane.keysSeen).toEqual([]);
  });

  test("a pane with held sends: /goal pause does not wait behind them, and they stay held", async () => {
    const holds = new HoldStore(join(dir, "held"), () => 1_000_000);
    const { pane, send, protocol } = goalTurn({ holds });
    expect((await send("/model", { id: "held-goal-01", mode: "command" })).receipt).toMatchObject({ outcome: "held" });
    const answer = await send("/goal pause", { id: "goal-now-01", mode: "command" });
    expect(answer.receipt).toMatchObject({ requestId: "goal-now-01", outcome: "sent", keys: ["probe", "Backspace", "Enter"] });
    expect(pane.ran).toEqual(["/goal pause"]);
    expect(protocol.heldOf("main", "%1").map((row) => row.requestId)).toEqual(["held-goal-01"]);
    // A command the list does not name still joins the end of the queue.
    expect((await send("/compact", { id: "held-goal-02", mode: "command" })).receipt).toMatchObject({ outcome: "held", keys: [] });
    expect(protocol.heldOf("main", "%1").map((row) => row.requestId)).toEqual(["held-goal-01", "held-goal-02"]);
  });
});

describe("a profile whose probe is provisional never skips the probe (M56 spec 14 review)", () => {
  const LONG = "this text is long enough that a verified profile would send it with no probe at all";

  test("a verified profile on a free screen sends a long text with no probe, a provisional one probes it", async () => {
    const verified = rig();
    expect((await verified.send(LONG)).receipt).toMatchObject({ outcome: "sent", keys: ["Enter"] });
    const provisional = rig({ edit: (profile) => ({ ...profile, probe: { ...profile.probe, status: "provisional" } }) });
    expect((await provisional.send(LONG)).receipt).toMatchObject({ outcome: "sent", keys: ["probe", "Backspace", "Enter"] });
  });

  test("the profiles of every harness with no live send in its range are provisional", () => {
    for (const id of ["grok", "agy", "muse", "opencode", "omp"]) expect(loadProfiles().get(id)?.probe.status, id).toBe("provisional");
    expect(loadProfiles().get("pi")?.probe.status).toBe("verified");
  });
});

describe("a frameless manual send in a turn is refused where Enter is not known to queue (M56 spec 14 review)", () => {
  const cases = [
    { harness: "grok", version: "1.0.46", rows: ["  Ctrl+e:expand thinking  │  Space:prompt  │  Esc:cancel  │  Ctrl+b:send to bg  │  Ctrl+.:shortcuts"] },
    { harness: "agy", version: "1.1.17", rows: ["⣟  Generating...", "└ Tip: Use /btw to ask a question without breaking context.", "esc to cancel     accept-edits · Gemini 3.7 Flash · low"] },
    { harness: "muse", version: "1.4.7", rows: ["◇ Double checking (2m 40s · esc to interrupt)"] },
  ];
  for (const c of cases) {
    test(`${c.harness}: a running sign and no box, two taps: refused turn_running, nothing typed, no Enter`, async () => {
      const pane = new FakePane("generic");
      pane.fixed = ["a transcript row", "", ...c.rows].join("\n");
      const { send, protocol } = rig({ pane, harness: c.harness, version: c.version });
      // The rows hash a person confirmed: the manual path, which a screen with a running sign must not take.
      const prepared = await protocol.handle({ id: `prepare-${c.harness}`, text: "", mode: "prepare" }, { session: "main", paneId: "%1", harness: c.harness });
      expect(prepared.rowsHash).toEqual(expect.any(String));
      const manual = await send("then add a short summary", { rowsHash: prepared.rowsHash! });
      expect(manual.receipt).toMatchObject({ outcome: "refused", reason: "turn_running", keys: [] });
      expect(pane.calls).toEqual([]);
      expect(pane.keysSeen).toEqual([]);
    });
  }
});

describe("the compare of a Codex send reads a changing status row (M56 spec 14 review)", () => {
  const RUNNING = "• Working (4s • esc to interrupt)";
  const signs = (loadProfiles().get("codex")?.idle.runningRows ?? []).map((source) => new RegExp(source, "u"));
  const GLYPHS = ["⠋", "⠙", "⠹", "⠸"];

  test("steadyRow hides the spinner glyph and the digits of a Codex status row that ends in a spinner, and of no other row", () => {
    expect(steadyRow("  GPT-6-Luna low · ~/project2 · ⠋", signs)).toBe(steadyRow("  GPT-6-Luna low · ~/project7 · ⠙", signs));
    expect(steadyRow("  GPT-6-Luna low · ~/project2", signs)).not.toBe(steadyRow("  GPT-6-Luna low · ~/project7", signs));
    expect(steadyRow("  GPT-6-Luna low · ~/project · ⠋", signs)).not.toBe(steadyRow("  GPT-6-Sol low · ~/project · ⠋", signs));
  });

  test("a spinner that ticks in the status row between the reads of a send into a turn does not stop it: Tab, never Enter", async () => {
    const { pane, send } = rig({ pane: new FakePane("codex"), harness: "codex", version: "0.159.2" });
    pane.over = [RUNNING];
    pane.beforeRead = (p, n) => {
      p.codexStatus = `  GPT-6-Luna low · ~/project · ${GLYPHS[n % GLYPHS.length]!}`;
    };
    const answer = await send("then add a short summary");
    expect(answer.receipt).toMatchObject({ outcome: "sent" });
    expect(answer.receipt?.keys.at(-1)).toBe("Tab");
    expect(pane.keysSeen).not.toContain("Enter");
  });
});

// ── an `@` text is a message on pi and OMP (M56 spec 14, verifier) ──

/** pi 0.87.1: a box between two rules, a status row under it. Alt+Enter (Ctrl+Q on Windows) sends and queues, Enter steers a turn. */
class PiPane extends FakePane {
  inTurn = false;
  steered: string[] = [];

  constructor(private readonly sendKey: string) {
    super("claude");
    this.transcript = Array.from({ length: 12 }, (_, i) => `an earlier row of the agent answer ${String(i)}`);
    this.status = ["~/project (main)", "0.0%/200k (auto)"];
    const base = this.writeKeys;
    this.writeKeys = (paneId, keys) => {
      for (const key of keys) {
        if (key === this.sendKey || (key === "Enter" && this.inTurn)) {
          this.keysSeen.push(key);
          const text = this.box.replace(/\n/gu, " ");
          if (text.length > 0 && key === "Enter") this.steered.push(text);
          else if (text.length > 0 && this.inTurn) this.queued.push(text);
          else if (text.length > 0) this.transcript.push(` > ${text}`);
          this.box = "";
          this.revision++;
        } else void base(paneId, [key]);
      }
      return Promise.resolve(muxAck());
    };
  }

  override render(): string {
    this.over = this.inTurn ? ["⠋ Working... (4s • esc to interrupt)"] : [];
    const rows = [...this.transcript, ...this.queued.map((text) => `Follow-up: ${text}`), ...(this.queued.length > 0 ? ["↳ Alt+Up to edit all queued messages"] : [])];
    return [...rows, "", ...this.over, RULE, ...(this.box === "" ? [""] : this.box.split("\n").map((line) => ` ${line}`)), RULE, ...this.status].join("\n");
  }
}

describe("a text that starts with `@` is a message on pi and OMP", () => {
  const AT = "@notes.md what changed in this file?";

  test("pi leaves `@` out of its reserved leads and keeps `/` and `!`", () => {
    expect(loadProfiles().get("pi")?.reservedLeads).toEqual(["/", "!"]);
    expect(loadProfiles().get("omp")?.reservedLeads).toEqual(["/", "!"]);
  });

  for (const [platform, key] of [["linux", "alt+Enter"], ["win32", "ctrl+q"]] as const) {
    test(`pi on ${platform}: an \`@\` text in a turn queues with ${key}, never Enter`, async () => {
      const pane = new PiPane(key);
      pane.inTurn = true;
      const { send } = rig({ pane, harness: "pi", version: "0.87.1", edit: (profile) => forPlatform(profile, platform) });
      const answer = await send(AT);
      expect(answer.receipt).toMatchObject({ outcome: "sent", queued: true });
      expect(answer.receipt?.keys.at(-1)).toBe(key);
      expect(pane.queued).toEqual([AT]);
      expect(pane.keysSeen).not.toContain("Enter");
      expect(pane.steered).toEqual([]);
    });
  }

  test("pi: an `@` text on an idle box is sent with Alt+Enter, and `/model` still takes Enter", async () => {
    const pane = new PiPane("alt+Enter");
    const { send } = rig({ pane, harness: "pi", version: "0.87.1" });
    const answer = await send(AT);
    expect(answer.receipt).toMatchObject({ outcome: "sent" });
    expect(answer.receipt?.keys.at(-1)).toBe("alt+Enter");
    expect(pane.keysSeen).not.toContain("Enter");
    const command = await send("/model", { mode: "command" });
    expect(command.receipt?.keys.at(-1)).toBe("Enter");
  });

  test("omp: an `@` text in a turn queues with ctrl+q, never Enter", async () => {
    const { pane, send } = omp();
    pane.inTurn = true;
    const answer = await send(AT);
    expect(answer.receipt).toMatchObject({ outcome: "sent", queued: true });
    expect(answer.receipt?.keys.at(-1)).toBe("ctrl+q");
    expect(pane.queued).toEqual([AT]);
    expect(pane.keysSeen).not.toContain("Enter");
    expect(pane.steered).toEqual([]);
  });

  test("a `/` text is still a command on pi and OMP: refused in a turn, nothing typed", async () => {
    const pane = new PiPane("alt+Enter");
    pane.inTurn = true;
    const answer = await rig({ pane, harness: "pi", version: "0.87.1" }).send("/model", { mode: "command" });
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "turn_running", keys: [] });
  });
});

describe("a send at a box that is not free is held, not refused (2026-10-17 field case)", () => {
  const FREE = { revision: 1, turn: "idle", modal: "none", composer: "empty" } as const;
  const RUNNING = { revision: 1, turn: "running", modal: "none", composer: "empty" } as const;
  const BOX_HELD = "The input box is not free. Collie keeps this and sends it when the box is free.";
  const queued = (clock = { now: 1_000_000 }): Rig & { holds: HoldStore } => {
    const holds = new HoldStore(join(dir, "held"), () => clock.now);
    return { ...rig({ holds, clock }), holds };
  };
  const tick = async (r: Rig, surface: typeof FREE | typeof RUNNING = FREE): Promise<(SendAnswer | null)[]> => Promise.all(r.protocol.tickHolds("main", () => surface));

  test("a dialog at the box holds the message: receipt held, nothing typed, the box's line as detail", async () => {
    const r = queued();
    r.pane.dialog = DIALOG;
    const answer = await r.send("ok for the open PRs", { id: "box-0000001" });
    expect(answer.receipt).toMatchObject({ requestId: "box-0000001", outcome: "held", keys: [] });
    expect(answer.receipt?.reason).toBeUndefined();
    expect(answer.offers).toEqual([]);
    expect(answer.detail).toBe(BOX_HELD);
    expect(r.pane.calls).toEqual([]);
    expect(r.pane.keysSeen).toEqual([]);
    expect(r.protocol.heldOf("main", "%1").map((row) => row.requestId)).toEqual(["box-0000001"]);
  });

  test("a box that moves between the two S0 reads holds the message too", async () => {
    const r = queued();
    r.pane.beforeRead = (p, n) => {
      if (n === 2) p.box = "someone typed at the desk";
    };
    const answer = await r.send("hello", { id: "box-0000002" });
    expect(answer.receipt).toMatchObject({ outcome: "held", keys: [] });
    expect(answer.detail).toBe(BOX_HELD);
  });

  test("a hold from a box that was not free has no running read: two free polls keep it, five over ten seconds send it", async () => {
    const clock = { now: 1_000_000 };
    const r = queued(clock);
    r.pane.dialog = DIALOG;
    await r.send("ok for the open PRs", { id: "box-0000003" });
    r.pane.dialog = null;
    // A `turn_running` hold goes on the second free poll; this one does not: it read no turn.
    expect(await tick(r)).toEqual([]);
    clock.now += 2500;
    expect(await tick(r)).toEqual([]);
    clock.now += 2500;
    expect(await tick(r)).toEqual([]);
    clock.now += 2500;
    expect(await tick(r)).toEqual([]);
    expect(r.pane.calls).toEqual([]);
    clock.now += 2500;
    const [released] = await tick(r);
    expect(released?.receipt).toMatchObject({ requestId: "box-0000003", outcome: "sent" });
    expect(r.pane.transcript.at(-1)).toBe("> ok for the open PRs");
    expect(r.holds.list()).toEqual([]);
    neverEscape(r.pane);
  });

  test("a hold from a box that was not free goes after a turn a poll reads, then two free polls", async () => {
    const r = queued();
    r.pane.dialog = DIALOG;
    await r.send("ok for the open PRs", { id: "box-0000004" });
    r.pane.dialog = null;
    expect(await tick(r, RUNNING)).toEqual([]);
    expect(await tick(r)).toEqual([]);
    const [released] = await tick(r);
    expect(released?.receipt).toMatchObject({ requestId: "box-0000004", outcome: "sent" });
  });

  test("a release that meets the box still not free goes back to its place, nothing typed", async () => {
    const r = queued();
    r.pane.dialog = DIALOG;
    await r.send("ok for the open PRs", { id: "box-0000005" });
    // The poll's Surface says free, but the dialog is still on the screen the release reads.
    expect(await tick(r, RUNNING)).toEqual([]);
    expect(await tick(r)).toEqual([]);
    const [back] = await tick(r);
    expect(back?.receipt).toMatchObject({ requestId: "box-0000005", outcome: "held", keys: [] });
    expect(r.holds.get("box-0000005")).toMatchObject({ state: "held", tries: 1 });
    expect(r.pane.calls).toEqual([]);
  });

  test("a draft in the box is still refused draft_present with its offers, nothing held", async () => {
    const r = queued();
    r.pane.box = "half a thought";
    const answer = await r.send("hello", { id: "box-0000006" });
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "draft_present", keys: [] });
    expect(answer.offers).toEqual(["append", "replace", "cancel"]);
    expect(r.holds.list()).toEqual([]);
  });

  test("a command at a box that is not free stays a refusal, nothing held", async () => {
    const r = queued();
    r.pane.dialog = DIALOG;
    const answer = await r.send("/compact", { id: "box-0000007", mode: "command" });
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "not_free", keys: [] });
    expect(r.holds.list()).toEqual([]);
  });

  test("a probe that fails on a redrawing screen and is cleaned up with a confirmed box is held, then sent on a stable read (live, 2026-10-17)", async () => {
    const clock = { now: 1_000_000 };
    const holds = new HoldStore(join(dir, "held"), () => clock.now);
    const r = { ...rig({ version: "2.1.999", holds, clock }), holds };
    // The screen redraws once while the probe goes in: the hint under the box vanishes for that read.
    let redraws = 1;
    r.pane.afterInput = (p, what) => {
      if (what === `type:${PROBE}` && redraws > 0) {
        redraws--;
        p.status = [];
      }
    };
    const answer = await r.send("fourth message, reply ACK4 only", { id: "probe-00001" });
    expect(answer.receipt).toMatchObject({ requestId: "probe-00001", outcome: "held", keys: ["probe", "Backspace"] });
    expect(answer.receipt?.reason).toBeUndefined();
    expect(answer.detail).toBe(BOX_HELD);
    expect(r.pane.box).toBe("");
    expect(r.protocol.heldOf("main", "%1").map((row) => row.requestId)).toEqual(["probe-00001"]);
    // The hint is back and the screen holds still: the quiet rule releases it, and it goes out.
    r.pane.status = rig().pane.status;
    let released: SendAnswer | null | undefined;
    for (let i = 0; i < 6 && released === undefined; i++) {
      [released] = await tick(r);
      clock.now += 2500;
    }
    expect(released?.receipt).toMatchObject({ requestId: "probe-00001", outcome: "sent" });
    expect(r.pane.transcript.at(-1)).toBe("> fourth message, reply ACK4 only");
    expect(r.holds.list()).toEqual([]);
  });

  test("a probe whose cleanup is not confirmed stays a refusal, nothing held", async () => {
    const r = queued();
    const twice = rig({ version: "2.1.999", holds: r.holds });
    // The Backspace is taken, but the probe character shows in the box again on the read after it.
    twice.pane.afterInput = (p, what) => {
      if (what === `type:${PROBE}`) p.status = [];
      if (what === "keys:Backspace") p.box = PROBE;
    };
    const answer = await twice.send("hello there", { id: "probe-00002" });
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "probe_failed", keys: ["probe", "Backspace"] });
    expect(answer.detail).toContain("may remain in the box");
    // A probe character that shows twice gets no Backspace at all: refused too.
    const seen = rig({ version: "2.1.999", holds: r.holds });
    seen.pane.transcript.push(`an earlier line that shows ${PROBE}`);
    seen.pane.afterInput = (p, what) => {
      if (what === `type:${PROBE}`) p.status = [];
    };
    expect((await seen.send("hello there", { id: "probe-00003" })).receipt).toMatchObject({ outcome: "refused", reason: "probe_failed", keys: ["probe"] });
    expect(r.holds.list()).toEqual([]);
  });

  test("a command whose probe failed with a clean box stays a refusal", async () => {
    const r = rig({ version: "2.1.999", holds: new HoldStore(join(dir, "held")) });
    r.pane.afterInput = (p, what) => {
      if (what === `type:${PROBE}`) p.status = [];
    };
    expect((await r.send("/compact", { id: "probe-00004", mode: "command" })).receipt).toMatchObject({ outcome: "refused", reason: "probe_failed" });
  });

  test("a manual send (Type here) whose probe fails clean stays refused, nothing held (review, 2026-10-17)", async () => {
    const holds = new HoldStore(join(dir, "held"));
    const framed = rig({ holds });
    framed.pane.transcript = Array.from({ length: 12 }, (_, i) => `transcript row ${String(i)}`);
    framed.pane.over = ["● How is the agent doing this session? (optional)", "  1: Bad    2: Fine    3: Good    0: Dismiss"];
    const look = await framed.send("carry on");
    expect(look.surface?.modal).toBe("unreadable");
    framed.pane.afterInput = (p, what) => {
      if (what === `type:${PROBE}`) p.transcript.splice(2, 0, "a new row of output");
    };
    const answer = await framed.send("carry on", { rowsHash: look.rowsHash! });
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "probe_failed", keys: ["probe", "Backspace"] });
    expect(answer.detail).toContain("the box is clean again");
    expect(holds.list()).toEqual([]);
  });

  test("a pane with no profile never holds: its send goes in blind, with no read for a hold to wait on", async () => {
    const holds = new HoldStore(join(dir, "held"));
    const r = rig({ harness: NO_PROFILE, holds });
    // The screen would move between the two S0 reads (not_free, the reason a profiled pane holds); no read is taken.
    r.pane.beforeRead = (p, n) => {
      if (n === 2) p.transcript.push("a row that came in");
    };
    const answer = await r.send("hello");
    expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["Enter"] });
    expect(holds.list()).toEqual([]);
  });

  test("a Replace whose text starts with a reserved lead is a command: no hold at a box that is not free", async () => {
    const r = queued();
    r.pane.box = "half a thought";
    r.pane.dialog = DIALOG;
    const answer = await r.send("/compact", { id: "box-0000008", mode: "replace" });
    expect(answer.receipt?.outcome).toBe("refused");
    expect(r.holds.list()).toEqual([]);
    // The same Replace with a plain text is held.
    const plain = await r.send("a plain thought", { id: "box-0000009", mode: "replace" });
    expect(plain.receipt?.outcome).toBe("held");
  });

  test("with no hold queue a box that is not free is refused as before", async () => {
    const r = rig();
    r.pane.dialog = DIALOG;
    expect((await r.send("hello")).receipt).toMatchObject({ outcome: "refused", reason: "not_free", keys: [] });
  });
});

describe("a refusal receipt keeps its line and the Surface words (2026-10-17 field case)", () => {
  test("a box that moved between two reads: the line and four words on the receipt and on disk, never the text", async () => {
    const r = rig();
    r.pane.beforeRead = (p, n) => {
      if (n === 2) p.box = "someone typed at the desk";
    };
    const answer = await r.send("a private sentence", { id: "detail-00001" });
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "not_free", detail: "The input box moved between two reads." });
    expect(answer.receipt?.saw).toEqual({ turn: "idle", modal: "none", composer: "draft" });
    const stored = new RequestStore(join(dir, "sends"), () => r.clock.now).get("detail-00001")?.receipt;
    expect(stored).toMatchObject({ detail: "The input box moved between two reads.", saw: { turn: "idle", modal: "none", composer: "draft" } });
    const file = readFileSync(join(dir, "sends", "detail-00001.json"), "utf8");
    expect(file).not.toContain("a private sentence");
    expect(file).not.toContain("someone typed at the desk");
  });

  test("a dialog at the box: the plain line and the modal word", async () => {
    const r = rig();
    r.pane.dialog = DIALOG;
    const answer = await r.send("hello");
    expect(answer.receipt?.detail).toBe(answer.detail ?? "");
    expect(answer.receipt?.saw?.modal).not.toBe("none");
  });

  test("a send that went keeps neither a line nor the words", async () => {
    const r = rig();
    const sent = await r.send("hello there, agent");
    expect(sent.receipt?.outcome).toBe("sent");
    expect(sent.receipt?.detail).toBeUndefined();
    expect(sent.receipt?.saw).toBeUndefined();
  });
});

describe("the turn ends while Collie types (live, 2026-10-17, round 3)", () => {
  const listRow = (k: number): string => `  ${String(k)}. Fruit number ${String(k)}: it is a fruit with one short sentence about it.`;

  test("running at S0, idle at S1 with the finished answer and a (y/n) line above the box: sent", async () => {
    for (const version of ["2.1.301", "2.1.302"]) {
      const { pane, send } = rig({ version });
      pane.height = 16;
      pane.drawsQueuedRow = true;
      pane.transcript = ["> Write a numbered list of 40 fruits", "", ...[1, 2, 3, 4, 5, 6, 7, 8].map(listRow)];
      pane.over = [LIVE_ROW];
      let ended = false;
      pane.afterInput = (p, what) => {
        // The answer finishes as the text goes in: the last rows, the menu and the question, then the finished row.
        if (ended || !what.includes("ACK4")) return;
        ended = true;
        p.over = [];
        p.transcript.push(...[9, 10, 11, 12].map(listRow), "  1. Apple", "  2. Pear", "  3. Quit", "", "  Confirm (y/n)", "", "\u273b Cooked for 5s \u00b7 done 12:17 PM");
      };
      const answer = await send("Fourth message, reply ACK4 only.");
      expect(ended, version).toBe(true);
      expect(answer.receipt, version).toMatchObject({ outcome: "sent" });
      expect(pane.keysSeen.at(-1), version).toBe("Enter");
      expect(pane.box, version).toBe("");
    }
  });

  /** A capture's rows with the fake pane's box drawn into its box row. */
  const captured = (name: string): ((box: string) => string) => {
    const rows = readFileSync(join(import.meta.dir, `../../web/src/fixtures/panes/${name}`), "utf8").split("\r\n");
    const boxRow = rows.findIndex((row, i) => i > 0 && row.includes("\u276f\u00a0") && rows[i - 1]!.includes("\u2500".repeat(20)));
    expect(boxRow).toBeGreaterThan(0);
    return (box) => {
      const shown = [...rows];
      if (box !== "") shown[boxRow] = `\u276f\u00a0${box}`;
      return shown.join("\r\n");
    };
  };
  const ENDING = captured("claude--v2302-turn-ending-stop-hooks--w119.txt");
  const ENDED = captured("claude--v2302-turn-ended-yn--w119.txt");
  const TEXT = "Fourth message, reply ACK4 only.";
  /** A list streaming above two queued messages, its last row still growing; `from` says when the stream starts. */
  const streamingWithQueue = (pane: FakePane, from: (call: string) => boolean): void => {
    pane.height = 40;
    pane.drawsQueuedRow = true;
    pane.transcript = ["> Write a numbered list of 120 fruits", "", ...Array.from({ length: 40 }, (_, i) => listRow(i + 1)), "  41."];
    pane.over = ["", "\u276f Second message sent during the turn, reply with the word ACK only.", "", "\u276f Third message while the list streams, reply ACK3 only.", "  ctrl+enter to send now", ""];
    let n = 40;
    pane.beforeRead = (p) => {
      if (!p.calls.some(from) || n >= 120) return;
      n += 3;
      p.transcript.splice(-1, 1, listRow(n - 2), listRow(n - 1), listRow(n), `  ${String(n + 1)}.`);
    };
  };


  test("real 2.1.302 screens: the Stop hooks row at S0, the finished turn with its menu and Confirm (y/n) at S1: sent", async () => {
    const { pane, send } = rig({ version: "2.1.302" });
    pane.beforeRead = (p) => {
      p.fixed = p.calls.some((call) => call.includes("ACK4")) ? ENDED(p.box) : ENDING(p.box);
    };
    const answer = await send(TEXT);
    expect(answer.receipt).toMatchObject({ outcome: "sent" });
    expect(pane.keysSeen.at(-1)).toBe("Enter");
    expect(pane.box).toBe("");
  });

  test("the list streams above two queued messages over the box while Collie types (no spinner, S0 idle): sent, never left typed (live replay, 2026-10-17)", async () => {
    for (const version of ["2.1.301", "2.1.302"]) {
      const { pane, send } = rig({ version });
      pane.height = 40;
      pane.drawsQueuedRow = true;
      // The answer's last row is still growing ("  41."), and the queued messages stand under it, over
      // the box: the growing row is not the last row above the box (lane 8788, 120-row list). The list
      // streams once the text went in (the probe saw a still screen).
      streamingWithQueue(pane, (call) => call.includes("ACK4"));
      const answer = await send(TEXT);
      expect(answer.receipt, version).toMatchObject({ outcome: "sent" });
      expect(pane.keysSeen.at(-1), version).toBe("Enter");
    }
  });

  test("the probe while the list streams above two queued messages, a row still growing: it passes, and the send goes in (2026-10-17, round 4)", async () => {
    for (const version of ["2.1.301", "2.1.302"]) {
      const { pane, send } = rig({ version });
      streamingWithQueue(pane, (call) => call.startsWith("type:"));
      const answer = await send(TEXT);
      expect(answer.receipt, version).toMatchObject({ outcome: "sent", keys: ["probe", "Backspace", "Enter"] });
    }
  });

  test("the probe with the frame gone at its read fails as before, no Backspace", async () => {
    const { pane, send } = rig({ version: "2.1.302" });
    pane.afterInput = (p, what) => {
      if (what === `type:${PROBE}`) p.fixed = ["", "  Your conversation moved to the background.", "", "  Nothing is selected."].join("\n");
    };
    const answer = await send(TEXT);
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "probe_failed", keys: ["probe"] });
    expect(pane.keysSeen).toEqual([]);
  });

  test("the probe with a dialog under the box at its read fails as before, and one Backspace cleans the box", async () => {
    const { pane, send } = rig({ version: "2.1.302" });
    pane.afterInput = (p, what) => {
      if (what === `type:${PROBE}`) p.popup = [...DIALOG];
    };
    const answer = await send(TEXT);
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "probe_failed" });
    expect(pane.keysSeen).not.toContain("Enter");
    expect(pane.calls).toEqual([`type:${PROBE}`]);
  });

  test("the frame with the text gone at S1 (the screen replaced): typed_not_submitted, no Enter, and the receipt names the rule", async () => {
    const { pane, send, deps } = rig({ version: "2.1.302" });
    pane.beforeRead = (p) => {
      // Another screen took the place, with plain rows and no box (a list or a menu there would read as a dialog).
      p.fixed = p.calls.some((call) => call.includes("ACK4")) ? ["", "  Your conversation moved to the background.", "", "  Nothing is selected."].join("\r\n") : ENDING(p.box);
    };
    const answer = await send(TEXT, { id: "typed-00001" });
    expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "changed" });
    expect(pane.keysSeen).not.toContain("Enter");
    expect(pane.box).toBe(TEXT);
    const stored = deps.store.get("typed-00001")?.receipt;
    expect(stored?.detail).toBe("The frame with the typed text was gone, or the rows under the box changed, so Enter was not pressed.");
    expect(stored?.saw).toEqual({ turn: "unknown", modal: "unknown", composer: "unknown", reason: "no-match" });
    expect(JSON.stringify(stored)).not.toContain("ACK4");
  });

  test("a dialog at S1: typed_not_submitted, no Enter, the text stays, and the receipt says a dialog came", async () => {
    const { pane, send, deps } = rig({ version: "2.1.302" });
    pane.over = [LIVE_ROW];
    pane.afterInput = (p, what) => {
      if (what.includes("ACK4")) p.dialog = DIALOG;
    };
    const answer = await send(TEXT, { id: "typed-00002" });
    expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "modal_cue" });
    expect(pane.keysSeen).not.toContain("Enter");
    expect(pane.box).toBe(TEXT);
    expect(deps.store.get("typed-00002")?.receipt?.detail).toBe("Something opened at the box after the text was typed, so Enter was not pressed.");
  });
});

describe("real Claude Code 2.1.302 turns with a list on screen (captured 2026-10-17)", () => {
  /** A fixture whose box row draws what the fake pane's box holds, so the probe and the text land in it. */
  const liveFixture = (pane: FakePane, name: string): void => {
    const rows = readFileSync(join(import.meta.dir, `../../web/src/fixtures/panes/${name}`), "utf8").split("\r\n");
    const boxRow = rows.findIndex((row, i) => i > 0 && row.includes("❯ ") && rows[i - 1]!.includes("─".repeat(20)));
    expect(boxRow).toBeGreaterThan(0);
    pane.beforeRead = (p) => {
      const shown = [...rows];
      if (p.box !== "") shown[boxRow] = `❯ ${p.box}`;
      p.fixed = shown.join("\r\n");
    };
  };

  for (const name of ["claude--v2302-working-list-echo--w119.txt", "claude--v2302-working-agents-panel--w119.txt"]) {
    test(`${name}: a send during the turn is taken, sent or held, never refused not_free`, async () => {
      const holds = new HoldStore(join(dir, "held"));
      const r = rig({ version: "2.1.302", holds });
      liveFixture(r.pane, name);
      const answer = await r.send("then give it a title");
      expect(["sent", "held"]).toContain(answer.receipt?.outcome ?? "none");
      expect(answer.receipt?.reason).not.toBe("not_free");
      if (answer.receipt?.outcome === "sent") expect(r.pane.keysSeen.at(-1)).toBe("Enter");
      else expect(r.pane.box).toBe("");
    });
  }

  test("claude--v2302-working-list-echo--w119.txt: the list above an idle-reading box is no dialog, the send goes in", async () => {
    const r = rig({ version: "2.1.302" });
    liveFixture(r.pane, "claude--v2302-working-list-echo--w119.txt");
    expect((await r.send("then give it a title")).receipt).toMatchObject({ outcome: "sent" });
  });
});

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
    expect(answer.receipt).toMatchObject({ outcome: "sent", queued: true });
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
    expect(answer.receipt).toMatchObject({ outcome: "sent", queued: true });
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
  const OPENED = "Something opened at the box after the text was typed, so Enter was not pressed.";

  /**
   * A capture of the typed command's list, split at the box (lab, 2026-10-17): the screen with the fake
   * box drawn into the box row, the list under it only while the box holds a slash command, and pi's
   * footer rows under that. Once Enter took the command the screen is `opened`, the capture of the
   * screen the command opens. `list` rewrites the list rows, read as plain text.
   */
  const captured = (pane: FakePane, name: string, opened: string, options: { list?: (rows: string[]) => string[] } = {}): void => {
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
      p.fixed = [...head, ...(p.box.startsWith("/") ? under : []), ...rows.slice(footer)].join("\r\n");
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
      // These profiles find a box past a list only when the list is the box's own, so a list that points
      // elsewhere reads as something opened at the box, the detail of any other cue, not the list notice.
      expect(deps.store.get(id)?.receipt?.detail).toBe(OPENED);
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
      if (options.running === true) above.push(`  1. ${taken}`, "  └ Alt+↑ to edit");
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

describe("S1 reads the turn again before the commit key (PR 491): a turn starts between S0 and the Enter", () => {
  const TURN_STARTED = "A turn started while the text was typed, so Enter was not pressed. The text is in the box. Submit it when the turn ends.";

  test("pi: /model typed on an idle box, a turn starts while it goes in: Enter must not steer the turn", async () => {
    const pane = new PiPane("alt+Enter");
    const { send } = rig({ pane, harness: "pi", version: "0.87.1" });
    pane.afterInput = (_p, what) => {
      if (what === "type:/model" || what === "paste:/model") pane.inTurn = true;
    };
    const answer = await send("/model", { mode: "command" });
    expect({ steered: pane.steered, outcome: answer.receipt?.outcome }).toEqual({ steered: [], outcome: "typed_not_submitted" });
  });

  test("omp: /model typed on an idle box, a turn starts while it goes in: Enter must not steer the turn", async () => {
    const { pane, send } = omp();
    pane.afterInput = (_p, what) => {
      if (what === "type:/model" || what === "paste:/model") pane.inTurn = true;
    };
    const answer = await send("/model", { mode: "command" });
    expect({ steered: pane.steered, outcome: answer.receipt?.outcome }).toEqual({ steered: [], outcome: "typed_not_submitted" });
  });

  test("omp: /goal pause typed on an idle box, a turn starts while it goes in (the status row's spinner): it takes Enter, which OMP runs at once, never steering", async () => {
    const { pane, send } = omp({ version: "18.12.2" });
    pane.runsAtOnce = ["/goal"];
    pane.showWorking = false;
    pane.afterInput = (_p, what) => {
      if (what === "type:/goal pause" || what === "paste:/goal pause") pane.inTurn = true;
    };
    const answer = await send("/goal pause", { mode: "command" });
    expect({ steered: pane.steered, ran: pane.ran, outcome: answer.receipt?.outcome, key: answer.receipt?.keys.at(-1) }).toEqual({ steered: [], ran: ["/goal pause"], outcome: "sent", key: "Enter" });
    expect(answer.receipt?.queued).toBeUndefined();
  });

  test("codex: /new (never held) typed on an idle box, a turn starts while it goes in: no Enter into the turn", async () => {
    const pane = new FakePane("codex");
    const { send } = rig({ pane, harness: "codex", version: "0.159.2" });
    pane.afterInput = (p, what) => {
      if (what === "type:/new" || what === "paste:/new") p.over = ["• Working (0s • esc to interrupt)"];
    };
    const answer = await send("/new", { mode: "command" });
    expect({ enter: pane.keysSeen.includes("Enter"), outcome: answer.receipt?.outcome }).toEqual({ enter: false, outcome: "typed_not_submitted" });
  });

  test("claude: /clear (never held) typed on an idle box, a turn starts while it goes in: no Enter (Claude would queue /clear)", async () => {
    const { pane, send } = rig();
    pane.afterInput = (p, what) => {
      if (what === "type:/clear" || what === "paste:/clear") p.over = [LIVE_ROW];
    };
    const answer = await send("/clear", { mode: "command" });
    expect({ enter: pane.keysSeen.includes("Enter"), outcome: answer.receipt?.outcome }).toEqual({ enter: false, outcome: "typed_not_submitted" });
    expect(answer.receipt).toMatchObject({ reason: "changed", detail: TURN_STARTED });
  });

  test("claude, version unread: a message typed on an idle box, a turn starts while it goes in: no Enter (S0 would have held it)", async () => {
    const { pane, send } = rig({ version: "no version here" });
    pane.afterInput = (p, what) => {
      if (what.endsWith("then give it a title")) p.over = [LIVE_ROW];
    };
    const answer = await send("then give it a title");
    expect({ enter: pane.keysSeen.includes("Enter"), outcome: answer.receipt?.outcome }).toEqual({ enter: false, outcome: "typed_not_submitted" });
  });

  test("pi on a full screen (the turn's Working row scrolls the transcript up one row): Enter must not steer the turn", async () => {
    const pane = new PiPane("alt+Enter");
    const render = pane.render.bind(pane);
    pane.render = () => render().split("\n").slice(-16).join("\n");
    const { send } = rig({ pane, harness: "pi", version: "0.87.1" });
    pane.afterInput = (_p, what) => {
      if (what === "type:/model" || what === "paste:/model") pane.inTurn = true;
    };
    const answer = await send("/model", { mode: "command" });
    expect({ steered: pane.steered, outcome: answer.receipt?.outcome }).toEqual({ steered: [], outcome: "typed_not_submitted" });
  });

  test("omp on a full screen (the turn's Working row scrolls the transcript up one row): Enter must not steer the turn", async () => {
    const { pane, send } = omp();
    const render = pane.render.bind(pane);
    pane.render = () => render().split("\n").slice(-16).join("\n");
    pane.afterInput = (_p, what) => {
      if (what === "type:/model" || what === "paste:/model") pane.inTurn = true;
    };
    const answer = await send("/model", { mode: "command" });
    expect({ steered: pane.steered, outcome: answer.receipt?.outcome }).toEqual({ steered: [], outcome: "typed_not_submitted" });
  });

  test("unchanged: a message on a Claude whose version was read, a turn starts while it goes in: Enter still goes out (Claude queues it)", async () => {
    // The same screens as the unread-version case above, where S1 reads the turn; here the rule allows the send.
    const { pane, send } = rig();
    pane.afterInput = (p, what) => {
      if (what.endsWith("then give it a title")) p.over = [LIVE_ROW];
    };
    const answer = await send("then give it a title");
    expect({ enter: pane.keysSeen.includes("Enter"), outcome: answer.receipt?.outcome }).toEqual({ enter: true, outcome: "sent" });
  });

  test("codex: /status (a command Codex queues) typed on an idle box, a turn starts while it goes in: it takes Tab, as at S0, never Enter", async () => {
    const pane = new FakePane("codex");
    const { send } = rig({ pane, harness: "codex", version: "0.159.2" });
    pane.afterInput = (p, what) => {
      if (what === "type:/status" || what === "paste:/status") p.over = ["• Working (0s • esc to interrupt)"];
    };
    const answer = await send("/status", { mode: "command" });
    expect({ enter: pane.keysSeen.includes("Enter"), last: answer.receipt?.keys.at(-1), queued: pane.queued }).toEqual({ enter: false, last: "Tab", queued: ["/status"] });
  });

  test("omp, no box found (the manual send, two taps): /model typed, a running row draws under it: Enter must not steer the turn", async () => {
    const pane = new FakePane("generic");
    const { send, protocol } = rig({ pane, harness: "omp", version: "18.11.3" });
    const prepared = await protocol.handle({ id: "prepare-omp-s1", text: "", mode: "prepare" }, { session: "main", paneId: "%1", harness: "omp" });
    expect(prepared.surface?.reason).toBe("no-match");
    pane.afterInput = (p, what) => {
      if (what === "type:/model" || what === "paste:/model") p.footer = "⠋ Working... (4s • esc to interrupt)";
    };
    const answer = await send("/model", { mode: "command", rowsHash: prepared.rowsHash! });
    expect({ enter: pane.keysSeen.includes("Enter"), outcome: answer.receipt?.outcome, detail: answer.detail }).toEqual({ enter: false, outcome: "typed_not_submitted", detail: TURN_STARTED });
  });

  test("control: pi, a turn start that also adds two transcript rows above the band: the S1 compare keeps Enter back on its own", async () => {
    const pane = new PiPane("alt+Enter");
    const render = pane.render.bind(pane);
    pane.render = () => render().split("\n").slice(-16).join("\n");
    const { send } = rig({ pane, harness: "pi", version: "0.87.1" });
    pane.afterInput = (p, what) => {
      if (what === "type:/model" || what === "paste:/model") {
        pane.inTurn = true;
        p.transcript.push(" > a queued prompt that started the turn", "");
      }
    };
    const answer = await send("/model", { mode: "command" });
    expect({ steered: pane.steered, outcome: answer.receipt?.outcome }).toEqual({ steered: [], outcome: "typed_not_submitted" });
  });
});
