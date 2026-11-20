// The shared rig of the Send Protocol tests (M56 spec 05), split out of `protocol.test.ts` so no test
// file passes the size cap: the fake multiplexer pane that reacts like a harness's input box, with
// knobs for every failure, and `rig()`, which builds a `SendProtocol` over it. Not a test file. The
// fake draws a box the way the Claude profile reads one (a rule, the prompt glyph, a rule, a status
// row), or, for a harness with no profile, a bare editor between two rules.

import { afterEach, beforeEach, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { muxAck, muxOk, muxUnreachable, type MuxAck, type MuxGrid, type MuxGridRequest, type MuxOutcome } from "../mux/types.ts";
import { loadProfiles, profileFor, resetProfileLog, type Profile, type ProfileForOptions, type ProfileStatus, type VersionRange } from "../../web/src/lib/surface/profile.ts";
import { type SendAnswer } from "../../web/src/lib/surface/send.ts";
import { KeyGate } from "./key-gate.ts";
import { GENERIC_PROBE, RowRing, SendProtocol, SessionLocks, type SendDeps, type SendRequest } from "./protocol.ts";
import { RequestStore } from "./requests.ts";
import { SurfaceLedger } from "./counters.ts";
import { HoldStore } from "./holds.ts";

// `import.meta.url`, not `import.meta.dir`: `bridge/root.test.ts` bans the latter in every file that is not a `*.test.ts`,
// and this module only ever runs from the checkout.
const HERE = fileURLToPath(new URL(".", import.meta.url));

const RULE = "─".repeat(40);
const WIDTH = 38;
export const PROBE = "⌁";
/** A harness with no profile: a send on it goes in blind, with no read (a bare shell is one, harness ""). */
export const NO_PROFILE = "nothing-known";
/**
 * A harness with a profile whose frame S0 never finds: the screen reads unknown(no-match), so a send
 * takes the two-tap manual Send and is probed against the probe's own landing spot. Its keys are the
 * generic ones (Enter, Backspace with slack 16, the generic probe, no paste). Codex
 * screens below stand in for such a pane: Codex has a profile since M56 spec 13.
 */
export const FRAMELESS = "frameless-test";

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
export const DIALOG = [" Do you want to proceed?", " ❯ 1. Yes", "   2. No", " Esc to cancel · Enter to select"];

type Mode = "claude" | "generic" | "codex" | "muse";

/** A pane that reacts to text and keys like a harness's input box, with knobs for every failure. */
export class FakePane {
  revision = 1;
  transcript = ["> an earlier question", "An answer from the agent, two rows", "of it."];
  box = "";
  placeholder = 'Try "fix the failing tests"';
  /** How the empty box's placeholder is painted: the faint attribute, or a grey of its own (Muse's tip). */
  placeholderPaint: "dim" | "fg" = "dim";
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
  /** The most lines a {@link pasteBlock} paste may hold and still land literally. */
  blockLiteralLines = 3;
  /** The image files a {@link pasteBlock} paste takes off, each drawn as `[Image #N]` before the rest. */
  imageFiles: readonly string[] = [];
  /** Claude Code 2.1.312 (lab, 2026-10-30): an upload path is attached only when it is the whole paste; among other text it stays text. */
  imagesOnlyAlone = false;
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
   * Codex and Muse modes: the texts queued with Tab during a turn. Codex 0.163.0 draws a header, one
   * `↳` row per text and the edit hint (lab, M56 spec 13, 2026-10-16); Muse Code 1.4.10 draws its
   * `◆ Queued input` header over one `└` row for the text (lab, 2026-10-18; several at once unmeasured).
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

  /** Codex and Muse modes: a turn runs while a running row stands over the box, or while {@link turn} says so. */
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
    if (this.box === "") return [`❯ ${this.placeholderPaint === "fg" ? "\u001b[38;2;175;177;179m" : "\u001b[2m"}${this.placeholder}\u001b[0m`];
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
    // Muse mode: the queued block between the running rows and the box (muse--queued-input-1410.txt).
    const museQueued = this.mode === "muse" && this.queued.length > 0 ? ["", "◆ Queued input · ↑ to edit", ...this.queued.map((text) => `└ ${text}`)] : [];
    // Claude Code paints its rules grey, so a Claude read is styled even while the box holds a typed
    // draft: the read-with-no-styling paths (M78 spec 06) stay off unless a test strips the colour.
    const rule = this.mode === "claude" ? `\u001b[38;2;136;136;136m${RULE}\u001b[0m` : RULE;
    rows.push(...this.over, ...museQueued, rule, ...this.boxRows(), rule);
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
    // A paste that is one image file and nothing else is attached, on 2.1.305 and 2.1.312 alike.
    if (this.imageFiles.includes(text.trim()) && this.dialog === null && !this.swallow) {
      this.box += `[Image #${String(++this.pastes)}]`;
      this.bump();
    } else {
      this.take(text, true);
    }
    this.afterInput?.(this, `paste:${text}`);
    return Promise.resolve(muxAck());
  };

  /**
   * One bracketed paste of the whole text (`pasteBlock`), as Claude Code 2.1.304 took it in the lab
   * (2026-10-20): a paste with more than {@link blockLiteralLines} lines, or longer than
   * {@link collapseOver}, folds into ONE `[Pasted text #N +M lines]` row, M being its line breaks;
   * a short one lands literally, line breaks and all.
   */
  pasteBlock = (paneId: string, text: string): Promise<MuxAck> => {
    void paneId;
    this.calls.push(`block:${text}`);
    if (this.now !== null) this.lastWriteAt = this.now();
    // Claude cuts the paste at each newline and at a space before an absolute path, and attaches the
    // pieces that are image files (lab, 2.1.305); the kept pieces stay, joined by newlines.
    const pieces = text.split(/\n| (?=\/)/u);
    const kept = this.imagesOnlyAlone && pieces.length > 1 ? pieces : pieces.filter((piece) => !this.imageFiles.includes(piece.trim()));
    for (let i = kept.length; i < pieces.length; i++) this.box += `[Image #${String(++this.pastes)}]`;
    if (kept.length < pieces.length) text = kept.join("\n");
    const breaks = text.split("\n").length - 1;
    if (breaks + 1 > this.blockLiteralLines || text.length > this.collapseOver) {
      this.box += breaks > 0 ? `[Pasted text #${String(++this.pastes)} +${String(breaks)} lines]` : `[Pasted text #${String(++this.pastes)}]`;
    } else {
      this.box += text;
    }
    this.bump();
    this.afterInput?.(this, `block:${text}`);
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
          const chip = /\[Pasted text #\d+(?: \+\d+ lines)?\]$/u.exec(this.box);
          this.box = chip === null ? [...this.box].slice(0, -1).join("") : this.box.slice(0, chip.index);
        }
      } else if (key === "ctrl+j") {
        this.box += "\n";
      } else if (key === "Tab" && this.mode === "codex") {
        // Codex 0.150.0, 0.159.2 and 0.163.0 (lab, 2026-10-16): Tab queues a draft during a turn, sends it when idle, and does nothing on an empty box.
        if (this.box.length > 0 && this.running()) this.queued.push(this.box.replace(/\n/gu, " "));
        else if (this.box.length > 0) this.transcript.push(`› ${this.box.replace(/\n/gu, " ")}`);
        this.box = "";
      } else if (key === "Tab" && this.mode === "muse") {
        // Muse Code 1.4.10 (lab, 2026-10-18): Tab queues a draft during a turn and does nothing to an idle draft.
        if (this.box.length > 0 && this.running()) {
          this.queued.push(this.box.replace(/\n/gu, " "));
          this.box = "";
        }
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

/** The scratch folder of the running test; set by the hooks that {@link useScratchDir} registers. */
export let dir: string;

/** Registers the per-test scratch folder hooks in the test file that calls it. */
export function useScratchDir(): void {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "collie-protocol-"));
    resetProfileLog();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
}

export interface Rig {
  pane: FakePane;
  protocol: SendProtocol;
  deps: SendDeps & { gate: KeyGate; store: RequestStore; locks: SessionLocks; ring: RowRing };
  clock: { now: number };
  send: (text: string, over?: Partial<SendRequest>) => Promise<SendAnswer>;
}

export let ids = 0;
export function nextId(): string {
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

/**
 * A rig `send`'s rows hash that stands for the person's tap on an offer: the rig reads the screen with a
 * `prepare` first and sends its hash, as the phone sends the hash of the offer it showed (ADR 0166).
 */
export const OFFERED = "offered";

export function rig(
  options: {
    mode?: Mode;
    version?: string | null;
    harness?: string;
    paste?: boolean;
    /** The multiplexer frames a whole-text paste itself (Herdr's `pasteBlock`). */
    block?: boolean;
    /** The paths the protocol takes for image files on disk. */
    imageFiles?: readonly string[];
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
  const mux =
    options.paste === false
      ? { readGrid: pane.readGrid, typeText: pane.typeText }
      : options.block === true
        ? { readGrid: pane.readGrid, typeText: pane.typeText, pasteText: pane.pasteText, pasteBlock: pane.pasteBlock }
        : { readGrid: pane.readGrid, typeText: pane.typeText, pasteText: pane.pasteText };
  const gate = new KeyGate(pane, now);
  const store = new RequestStore(options.storeDir ?? join(dir, "sends"), now);
  const locks = new SessionLocks();
  const ring = new RowRing();
  const version = options.version === null ? null : (options.version ?? "2.1.200");
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
    imageFile: (path: string) => (options.imageFiles ?? []).includes(path),
    now,
    sleep: (ms: number) => {
      clock.now += ms;
      return Promise.resolve();
    },
  };
  const protocol = new SendProtocol(deps);
  const harness = options.harness ?? (options.mode === "generic" ? FRAMELESS : "claude");
  const where = { session: "main", paneId: "%1", harness };
  const send = async (text: string, over: Partial<SendRequest> = {}): Promise<SendAnswer> => {
    // The person's tap on an offer (ADR 0166): the rows hash of the screen they saw, read by a `prepare` first.
    if (over.rowsHash === OFFERED) over = { ...over, rowsHash: (await protocol.handle({ id: nextId(), text: "", mode: "prepare" }, where)).rowsHash };
    return protocol.handle({ id: nextId(), text, mode: "send", ...over }, where);
  };
  return { pane, protocol, deps, clock, send };
}

/** A profile whose harness does not queue a command entered during a turn (no `keys.commandWhileRunning`). */
export function noCommandQueue(profile: Profile): Profile {
  const { commandWhileRunning, ...keys } = profile.keys;
  void commandWhileRunning;
  return { ...profile, keys };
}

/** A profile whose harness takes nothing in a turn: Enter steers it and no key queues (Hermes's shape). */
export function steersWithNoQueueKey(profile: Profile): Profile {
  const { commandWhileRunning, queueKey, queueKeyByPlatform, ...keys } = profile.keys;
  void commandWhileRunning;
  void queueKey;
  void queueKeyByPlatform;
  return { ...profile, keys: { ...keys, enterWhileRunning: "steers" } };
}

export function neverEscape(pane: FakePane): void {
  expect(pane.keysSeen.filter((key) => /^esc(ape)?$/iu.test(key))).toEqual([]);
}

// ── the happy paths ──

/** A plain shell pane as the dev lane read it on v1.22.4 (Herdr agent `shell`): the Bluefin motd, then a starship prompt. */
export const SHELL_SCREEN = "shell--starship-bluefin-motd--w117.txt";

/** A plain shell's screen (starship at its prompt): what the blind road types into. */
export function shellText(): string {
  return readFileSync(join(HERE, "..", "..", "web", "src", "fixtures", "panes", SHELL_SCREEN), "utf8");
}

/** The welcome picture a fresh Codex 0.163.0 session draws above the box, as the M56 lab read it on 2026-10-16. */
export const CODEX_WELCOME: string[] = ["               ⣀⣤⣤⣤⣀⣀", "            ⣠⣶⣿⣿⣿⣿⣿⣿⣿⣿⣦⣤⣤⣤⣤⣤⣤⡀", "          ⢀⣾⣿⣿⠿⠋⠉⠉⢉⣭⣿⣿⣿⣿⣿⠿⣿⣿⣿⣿⣷⣄", "         ⣀⣾⣿⣿⠃ ⣀⣴⣾⣿⣿⡿⠟⠋ ⣀⡀ ⠈⠙⢿⣿⣿⣧", "      ⣀⣶⣿⣿⣿⣿⡇ ⢸⣿⣿⡿⠛⠉⢀⣠⣴⣿⣿⣿⣷⣦⣀⠈⢻⣿⣿⡇", "     ⣰⣿⣿⡿⢿⣿⣿⡇ ⢸⣿⣿⢀⣤⣶⣿⣿⣿⠟⠛⠻⣿⣿⣿⣿⣮⣿⣿⡷", "    ⢰⣿⣿⡟⠁⢸⣿⣿⡇ ⢸⣿⣿⣿⣿⠿⠿⣿⣿⣿⣦⣄⡀⠈⠛⠿⣿⣿⣿⣧⡀", "    ⣾⣿⣿⠃ ⢸⣿⣿⡇ ⢸⣿⣿⠋⠁  ⠈⠙⢻⣿⣿⣿⣶⣤⡀ ⠹⢿⣿⣷⡄", "    ⢸⣿⣿⣇ ⠸⣿⣿⣷⣦⣼⣿⣿      ⢸⣿⣿⠻⢿⣿⣿⡇ ⠘⣿⣿⣿", "    ⠈⢿⣿⣿⣦⡀⠈⠛⠿⣿⣿⣿⣿⣄⡀  ⢀⣠⣼⣿⣿  ⣿⣿⡇  ⣿⣿⣿⠇", "      ⢻⣿⣿⣿⣷⣦⣀⠈⠙⠻⣿⣿⣿⣶⣶⣿⣿⣿⣿⣿  ⣿⣿⡇ ⣠⣿⣿⣿", "      ⢸⣿⣿⡿⢿⣿⣿⣿⣦⣠⣴⣿⣿⣿⡿⠟⠋⢸⣿⣿  ⣿⣿⣷⣴⣿⣿⣿⠃", "      ⠘⣿⣿⣷ ⠈⠛⢿⣿⣿⣿⠿⠋⠉ ⣠⣴⣿⣿⣿  ⣿⣿⣿⣿⣿⠟⠁", "       ⠻⣿⣿⣿⣤⣀ ⠈⠉ ⢀⣤⣶⣿⣿⣿⠿⠟⠁ ⣰⣿⣿⡟⠋⠁", "        ⠈⠿⣿⣿⣿⣿⣶⣾⣿⣿⣿⣿⠟⠋⠁  ⣠⣼⣿⣿⡟", "           ⠙⠛⠛⠛⠻⠛⢿⣿⣿⣿⣿⣷⣾⣿⣿⣿⡿⠏", "                  ⠈⠙⠛⠿⠿⠿⠿⠛⠉"];

/**
 * Codex 0.163.0 as the lab read it (2026-10-16, tmux 3.7c, 100 columns), home path cut: no frame, a
 * dim placeholder on the `›` row, the status row, and the hint row `← for agents · ? for shortcuts`,
 * which Codex hides as soon as the box holds one character (also seen on 0.162.1 in the send drill).
 * `logo` stands for the welcome art a fresh session shows above the box until the box holds a character.
 */
export class CodexPane extends FakePane {
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
export class HerdrCodexPane extends FakePane {
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

// ── refusals, step by step ──

// ── a send into a running turn ──

/** The live running row of Claude Code 2.1.301 (claude--v2301-working-quiet--w100.txt): no interrupt hint. */
export const LIVE_ROW = "* Wibbling… (4s · ↓ 304 tokens)";

export const fixture = (name: string): string => readFileSync(join(HERE, "..", "..", "web", "src", "fixtures", "panes", name), "utf8");

/** A pane that always shows one captured screen and records every write. */
export function still(text: string): FakePane {
  const pane = new FakePane();
  pane.render = () => text;
  return pane;
}

// ── counters, the cap and the examples (M56 spec 09) ──

// ── a prompt edge closes a receipt (M56 spec 11) ──

// ── the agent's own word settles an unknown (M102 spec 13) ──

// ── the held send (M56 spec 15) ──

// ── M56 spec 14 review: the omp keys, the probe rule, the frameless gate, the platform keys ──

/**
 * OMP 18.6.1 as the lab read it (2026-10-16): an open box (`╰─` under a status row), Ctrl+Q sends on an
 * idle box and queues in a turn, Enter steers a running turn. A turn shows a blinking `Working…` row and a
 * spinner with the seconds in the status row, which does not blink.
 */
export class OmpPane extends FakePane {
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
  /** Draw the steered texts in a `Steering · N` block, the steer witness of the profile (the lab screens). */
  drawsSteers = false;
  /** The status row over the box, instead of the default preset's. */
  statusRow: string | null = null;

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
    const steering = this.drawsSteers ? this.steered : [];
    if (steering.length > 0 || this.queued.length > 0) {
      // OMP stacks its two blocks over one hint (lab, 18.6.1, 2026-10-23).
      if (steering.length > 0) rows.push(`  Steering · ${String(steering.length)}`, ...steering.map((text, i) => `  ${String(i + 1)}. ${text}`));
      if (this.queued.length > 0) rows.push(`  After yield · ${String(this.queued.length)}`, ...this.queued.map((text, i) => `  ${String(i + 1)}. ${text}`));
      rows.push("  └ Alt+↑ to edit", "");
    }
    if (this.inTurn && this.showWorking) rows.push("  ⎋ Working…                                      Write essay");
    rows.push(this.statusRow ?? (this.inTurn ? " ⠼ 4s > ◒ Haiku 4.5 > 📁 ~/work > ⑂ master ?1 > $0.06 ▶──6%─────────────" : " π > ◒ Haiku 4.5 > 📁 ~/work > ⑂ master ?1 > $0.06 ▶──6%─────────────"));
    this.box.split("\n").forEach((line, i) => rows.push(i === 0 ? `╰─ ${line}`.trimEnd() : `   ${line}`));
    return rows.join("\n");
  }
}

export function omp<P extends OmpPane = OmpPane>(options: { version?: string; edit?: (profile: Profile) => Profile; holds?: HoldStore; pane?: P } = {}): Rig & { pane: P } {
  // SAFETY: without a pane of its own the rig makes the plain OmpPane, which is P's default.
  const pane = options.pane ?? (new OmpPane() as P);
  const rigOptions: Parameters<typeof rig>[0] = { pane, harness: "omp", version: options.version ?? "18.6.1" };
  if (options.edit !== undefined) rigOptions.edit = options.edit;
  if (options.holds !== undefined) rigOptions.holds = options.holds;
  const made = rig(rigOptions);
  return { ...made, pane };
}

/**
 * Altan's OMP 18.6.1 pane under Herdr, 2026-10-25 (fixture omp--v18-6-1-stale-frame-below-live--w120):
 * the live editor is drawn higher up, under the answer, and the bottom of the screen still shows the
 * frame of an earlier layout with an old draft in it. Keys go to the live editor. Collie never redraws
 * a pane (ADR 0008); `mendsOnItsOwn` is the program drawing one frame at the bottom by itself, with the
 * live editor's text in it, right after the probe's Backspace.
 */
export class StaleOmpPane extends OmpPane {
  /** The old draft the stale bottom frame shows; null once the screen was drawn again. */
  stale: string | null = "and what about the design";
  /** The program draws its screen again by itself after the first Backspace. False: the stale rows stay. */
  mendsOnItsOwn = false;

  constructor() {
    super();
    const base = this.writeKeys;
    this.writeKeys = async (paneId, keys) => {
      const ack = await base(paneId, keys);
      if (this.mendsOnItsOwn && keys.includes("Backspace")) this.stale = null;
      return ack;
    };
  }

  override render(): string {
    if (this.stale === null) return super.render();
    const rows = [...this.transcript, `╰─ ${this.box}`.trimEnd(), "", "                                          Clarify Explanation Input"];
    rows.push(" π > ◒ Haiku 4.5 > 📁 ~/work > ⑂ master ?1 > $0.06 ▶──6%─────────────", `╰─ ${this.stale}`);
    return rows.join("\n");
  }
}

/** OMP 18.12.6 with `composer.shape: field` (omp-gang 11-geometry, W5): ▐ rows closed by ▌, a blank row and the status row under. */
export class FieldOmpPane extends OmpPane {
  override render(): string {
    const rows = [...this.transcript, ""];
    const lines = this.box === "" ? [""] : this.box.split("\n");
    for (const line of lines) rows.push(`▐ ${line}`.padEnd(129) + "▌");
    rows.push("", " π · ◒ Haiku 4.5 · 📁 …/11-geometry/state2/harness/omp/project · ◫ 4.7%/200K ⟲ ");
    return rows.join("\n");
  }
}

/** OMP 18.12.6 with `composer.shape: claude` (omp-gang 04-readers, G, 2026-10-26): a rule, `❯` on the first row, two spaces on the rest, a rule, the status row. */
export class ClaudeComposerOmpPane extends OmpPane {
  override render(): string {
    const rows = [...this.transcript, ""];
    const rule = "─".repeat(120);
    rows.push(rule);
    this.box.split("\n").forEach((line, i) => rows.push(`${i === 0 ? "❯" : " "} ${line}`.trimEnd()));
    rows.push(rule, " π · ◒ Haiku 4.5 · 📁 …g3/04-readers/state/harness/omp/project · ◫ 4.7%/200K ⟲");
    return rows.join("\n");
  }
}

/**
 * OMP's editor at its height cap (omp gang 2026-10-25, reports 01, 06 and 07): the draft wraps at
 * `width` columns, and past `cap` rows only the last ones show, the first of them on the `╰─` row.
 * A null cap grows the box with its draft.
 */
export class TallOmpPane extends OmpPane {
  constructor(
    readonly width = 80,
    readonly cap: number | null = 17,
  ) {
    super();
    // OMP showed a 12,000-character paste literally in its box (reports 01 and 07): it folds none.
    this.collapseOver = Number.POSITIVE_INFINITY;
  }

  override render(): string {
    const draft = this.box;
    this.box = "";
    const rows = super.render().split("\n");
    this.box = draft;
    // The empty box's own `╰─` row; the draft's rows take its place.
    rows.pop();
    if (draft === "") return [...rows, "╰─"].join("\n");
    const wrapped = draft.split("\n").flatMap((line) => (line.length === 0 ? [""] : (line.match(new RegExp(`.{1,${String(this.width)}}`, "gu")) ?? [""])));
    const shown = this.cap === null ? wrapped : wrapped.slice(-this.cap);
    return [...rows, ...shown.map((row, i) => (i === 0 ? `╰─ ${row}` : `   ${row}`).trimEnd())].join("\n");
  }
}

/** A capture from `web/src/fixtures/surface/`: screens the Send Protocol reads that the phone's adapter corpus does not pin. */
export const surfaceFixture = (name: string): string => readFileSync(join(HERE, "..", "..", "web", "src", "fixtures", "surface", name), "utf8");

/** A one-line text of at least `length` characters: numbered words, so no two rows read alike. */
export function words(length: number, lead = "w"): string {
  let text = "";
  for (let i = 0; text.length < length; i++) text += `${i === 0 ? "" : " "}${lead}${String(i)}`;
  return text;
}

/** The omp profile with no `idle.frame.scroll`: its box would grow with the draft. */
export function withoutScroll(profile: Profile): Profile {
  const { scroll, ...frame } = profile.idle.frame;
  void scroll;
  return { ...profile, idle: { ...profile.idle, frame } };
}

// ── an `@` text is a message on pi and OMP (M56 spec 14, verifier) ──

/** pi 0.87.1: a box between two rules, a status row under it. Alt+Enter (Ctrl+Q on Windows) sends and queues, Enter steers a turn. */
export class PiPane extends FakePane {
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

// ── ADR 0122: a queued send is a card until the journal shows it; Stop may give it back ──

/**
 * OMP's editor with its queue prefix (omp gang 13-drafts, 2026-10-25, 18.6.1 and 18.12.6): a box that
 * starts with a bare `->` or `=>` gets a newline put back behind it after every edit, so Backspace never
 * removes the prefix, and the box draws the `Queueing ➤` label over the rest. Ctrl+C empties the box;
 * on an empty box it is the first tap of OMP's quit.
 */
export class QueueingOmpPane extends OmpPane {
  /** Ctrl+C presses on a box that held text. */
  clears = 0;
  /** Ctrl+C presses on an empty box: the program would be one tap from quitting. */
  emptyPresses = 0;
  /** A Ctrl+C that leaves the box alone (a key the profile named wrongly). */
  deafCtrlC = false;

  constructor() {
    super();
    const base = this.writeKeys;
    this.writeKeys = (paneId, keys) => {
      for (const key of keys) {
        if (key === "ctrl+c") {
          this.keysSeen.push(key);
          if (this.box === "") this.emptyPresses++;
          else if (!this.deafCtrlC) {
            this.box = "";
            this.clears++;
          }
          this.revision++;
        } else {
          const bare = this.box === "->" || this.box === "=>";
          void base(paneId, [key]);
          this.normalise(bare);
        }
      }
      return Promise.resolve(muxAck());
    };
    const type = this.typeText;
    this.typeText = (paneId, text) => {
      const bare = this.box === "->" || this.box === "=>";
      const done = type(paneId, text);
      this.normalise(bare);
      return done;
    };
  }

  /** The newline OMP puts behind a prefix that just formed, or behind one typed with its text. */
  private normalise(hadBarePrefix: boolean): void {
    if (hadBarePrefix || this.box.includes("\n")) return;
    const prefix = ["->", "=>"].find((candidate) => this.box.startsWith(candidate));
    if (prefix !== undefined) this.box = `${prefix}\n${this.box.slice(2)}`;
  }

  override render(): string {
    const prefix = ["->", "=>"].find((candidate) => this.box.startsWith(candidate));
    if (prefix === undefined) return super.render();
    const draft = this.box;
    this.box = `Queueing ➤${draft.slice(2)}`;
    const rows = super.render();
    this.box = draft;
    return rows;
  }
}

// ── the version of the pane's own program (ADR 0124, amended 2026-10-26) ──

// ── the agents panel under the box redraws while Collie types (2026-11-13, field: lane 8788) ──

// ── a send of the same text finishes what an earlier send left typed (2026-11-13) ──

// ── a WalkyTalky message that stops before Enter takes its own text out of the box (2026-11-13) ──

// ── the audit's siblings: the command settle key and the rows hash leave chrome rows out (2026-11-13) ──

// ── the person's word on a receipt (M102 spec 01) ──
