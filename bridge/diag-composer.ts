import { appendFile, chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";

import type { JsonValue } from "./json.ts";
import { stateFileIo } from "./launchers-added.ts";

// ── THE COMPOSER DIAGNOSTIC: WHERE THE REPLY BOX WAS WHEN IT WAS NOT ON SCREEN ───────────────────
//
// An installed Android app sometimes comes back from a long break with the reply box (the composer)
// below the visible screen. The phone cannot say why: the layout height and the visible height
// disagree, and nothing reached the bridge. So when the phone finds the box really is off screen
// (web/src/lib/composer-offscreen.ts) it sends ONE record of heights, and this file keeps it.
//
// ── WHAT A RECORD IS ─────────────────────────────────────────────────────────────────────────────
// Numbers, booleans and three small enums, a FIXED key set, nothing else. No text, no pane id, no
// session name, no URL, no user agent. {@link parseComposerDiag} refuses a body that has another key,
// a string where a number goes, a fraction, or a number out of its range: the point of a strict
// validator is that this route cannot be turned into a place to put words.
//
// ── THE FILE ─────────────────────────────────────────────────────────────────────────────────────
// `<stateDir>/diag-composer.jsonl`, owner-only (0600) in an owner-only folder (0700), absent until the
// first record. One JSON object per line: the record, plus the server's time, this bridge's version
// and the device label the pairing registry holds for the token. At most {@link DIAG_COMPOSER_MAX_LINES}
// lines and {@link DIAG_COMPOSER_MAX_BYTES} bytes: the oldest lines go first. It is read by a person on
// the host, never sent anywhere: no network, no Matomo, no push.

/** The file's name inside the state dir. */
export const DIAG_COMPOSER_FILE = "diag-composer.jsonl";
/** The most lines the file keeps. */
export const DIAG_COMPOSER_MAX_LINES = 500;
/** The most bytes the file keeps. */
export const DIAG_COMPOSER_MAX_BYTES = 256 * 1024;
/** The longest request body the route reads. A record is about 400 bytes. */
export const DIAG_COMPOSER_BODY_MAX = 2048;
/** The longest device label a line keeps. */
const MAX_LABEL_CHARS = 80;
/** The version of the line this build writes. */
export const DIAG_COMPOSER_VERSION = 1;

/** What woke the check that found the box off screen. */
export const COMPOSER_TRIGGERS = ["foreground", "pageshow", "resize", "delayed"] as const;
export type ComposerTrigger = (typeof COMPOSER_TRIGGERS)[number];
/** What the viewport pin (web/src/lib/viewport-pin.ts) did last. */
export const COMPOSER_PIN_ACTIONS = ["none", "pinned", "released"] as const;
export type ComposerPinAction = (typeof COMPOSER_PIN_ACTIONS)[number];
/** Which kind of pane view the box belongs to. */
export const COMPOSER_PANE_KINDS = ["agent", "shell", "screenless"] as const;
export type ComposerPaneKind = (typeof COMPOSER_PANE_KINDS)[number];

const PX_HEIGHT: readonly [number, number] = [0, 20_000];
const PX_SIGNED: readonly [number, number] = [-1_000_000, 1_000_000];

/** Each integer field and the range it may hold. Pixels, except `visualScalePct` and the one time. */
const INT_FIELDS = {
  innerHeight: PX_HEIGHT,
  visualHeight: PX_HEIGHT,
  visualOffsetTop: PX_SIGNED,
  /** The visual viewport's scale as a whole percent: 100 is not zoomed. */
  visualScalePct: [1, 2000],
  screenHeight: PX_HEIGHT,
  clientHeight: PX_HEIGHT,
  scrollTop: PX_SIGNED,
  composerTop: PX_SIGNED,
  composerBottom: PX_SIGNED,
  scrollerHeight: PX_HEIGHT,
  scrollerTop: PX_SIGNED,
  /** Milliseconds since the page last came to the foreground: seven days at most. */
  msSinceForeground: [0, 7 * 24 * 60 * 60 * 1000],
} as const satisfies Record<string, readonly [number, number]>;

const BOOL_FIELDS = ["standalone", "pinRecent", "keyboardOpen"] as const;

/** One record as the phone sends it and the file keeps it. */
export interface ComposerDiag {
  readonly innerHeight: number;
  readonly visualHeight: number;
  readonly visualOffsetTop: number;
  readonly visualScalePct: number;
  readonly screenHeight: number;
  readonly clientHeight: number;
  readonly scrollTop: number;
  readonly composerTop: number;
  readonly composerBottom: number;
  readonly scrollerHeight: number;
  readonly scrollerTop: number;
  readonly msSinceForeground: number;
  readonly standalone: boolean;
  readonly pinRecent: boolean;
  readonly keyboardOpen: boolean;
  readonly trigger: ComposerTrigger;
  readonly pinAction: ComposerPinAction;
  readonly paneKind: ComposerPaneKind;
}

/** Every key a record holds, and no other. The phone's test pins the same set. */
export const COMPOSER_DIAG_KEYS: readonly string[] = [
  ...Object.keys(INT_FIELDS),
  ...BOOL_FIELDS,
  "trigger",
  "pinAction",
  "paneKind",
].toSorted();

function isRecordObject(value: JsonValue | undefined): value is { [key: string]: JsonValue | undefined } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function oneOf<T extends string>(allowed: readonly T[], value: JsonValue | undefined): T | null {
  return allowed.find((a) => a === value) ?? null;
}

/**
 * The record a body holds, or null. Strict on purpose: the key set is fixed and complete, an integer
 * is an integer in its range, a boolean is a boolean, an enum is one of its words.
 */
export function parseComposerDiag(body: JsonValue | undefined): ComposerDiag | null {
  if (!isRecordObject(body)) return null;
  const keys = Object.keys(body).toSorted();
  if (keys.length !== COMPOSER_DIAG_KEYS.length || keys.some((k, i) => k !== COMPOSER_DIAG_KEYS[i])) return null;
  // SAFETY: every key of INT_FIELDS is assigned in the loop below, or the function returns null first.
  const ints = {} as Record<keyof typeof INT_FIELDS, number>;
  // SAFETY: `Object.entries` loses the key union of INT_FIELDS, whose keys are all of it.
  const intFields = Object.entries(INT_FIELDS) as [keyof typeof INT_FIELDS, readonly [number, number]][];
  for (const [name, [lo, hi]] of intFields) {
    const v = body[name];
    if (typeof v !== "number" || !Number.isInteger(v) || v < lo || v > hi) return null;
    ints[name] = v;
  }
  for (const name of BOOL_FIELDS) {
    if (typeof body[name] !== "boolean") return null;
  }
  const trigger = oneOf(COMPOSER_TRIGGERS, body.trigger);
  const pinAction = oneOf(COMPOSER_PIN_ACTIONS, body.pinAction);
  const paneKind = oneOf(COMPOSER_PANE_KINDS, body.paneKind);
  if (trigger === null || pinAction === null || paneKind === null) return null;
  return {
    ...ints,
    standalone: body.standalone === true,
    pinRecent: body.pinRecent === true,
    keyboardOpen: body.keyboardOpen === true,
    trigger,
    pinAction,
    paneKind,
  };
}

/** The disk half, behind an interface so the cap is testable without the real state dir. */
export interface DiagIo {
  /** The file's text, or null when it is absent. */
  read(): Promise<string | null>;
  /** Add to the end, creating the file owner-only. */
  append(text: string): Promise<void>;
  /** Replace the whole file atomically, owner-only. */
  replace(text: string): Promise<void>;
}

/** The real io over `<stateDir>/diag-composer.jsonl`. */
export function diagFileIo(stateDir: string): DiagIo {
  const file = join(stateDir, DIAG_COMPOSER_FILE);
  const atomic = stateFileIo(stateDir, file);
  let tightened = false;
  return {
    read: () => atomic.read(),
    replace: (text) => atomic.write(text),
    async append(text) {
      await mkdir(stateDir, { recursive: true, mode: 0o700 });
      await appendFile(file, text, { mode: 0o600 });
      // `mode` applies only when the append creates the file; a file made some other way is made
      // owner-only once per process.
      if (!tightened) {
        tightened = true;
        await chmod(file, 0o600).catch(() => undefined);
      }
    },
  };
}

export interface ComposerDiagStoreOptions {
  /** This bridge's version, written on each line. */
  version: string;
  now?: () => number;
  /** Test seams: the caps. */
  maxLines?: number;
  maxBytes?: number;
}

/** What the file knows about itself between writes: how many lines and bytes it holds. */
interface Held {
  lines: number;
  bytes: number;
}

/** The file-backed store the server builds once. A write never throws: it answers whether it landed. */
export class ComposerDiagStore {
  private queue: Promise<unknown> = Promise.resolve();
  private held: Held | null = null;
  private readonly now: () => number;
  private readonly maxLines: number;
  private readonly maxBytes: number;

  constructor(
    private readonly io: DiagIo,
    private readonly opts: ComposerDiagStoreOptions,
  ) {
    this.now = opts.now ?? (() => Date.now());
    this.maxLines = opts.maxLines ?? DIAG_COMPOSER_MAX_LINES;
    this.maxBytes = opts.maxBytes ?? DIAG_COMPOSER_MAX_BYTES;
  }

  /** Keep one record, under the device label the pairing registry names (or null). */
  record(diag: ComposerDiag, device: string | null): Promise<"written" | "unwritable"> {
    const run = this.queue.then(() => this.write(diag, device));
    this.queue = run.catch(() => undefined);
    return run.catch(() => "unwritable" as const);
  }

  private async write(diag: ComposerDiag, device: string | null): Promise<"written"> {
    const line = `${JSON.stringify({
      v: DIAG_COMPOSER_VERSION,
      at: new Date(this.now()).toISOString(),
      version: this.opts.version,
      device: device === null ? null : device.slice(0, MAX_LABEL_CHARS),
      ...diag,
    })}\n`;
    const size = Buffer.byteLength(line);
    const held = this.held ?? (await this.load());
    if (held.lines + 1 <= this.maxLines && held.bytes + size <= this.maxBytes) {
      await this.io.append(line);
      this.held = { lines: held.lines + 1, bytes: held.bytes + size };
      return "written";
    }
    // Over a cap: rewrite the file with the newest lines and this one, oldest dropped first.
    const rows = ((await this.io.read()) ?? "").split("\n").filter((row) => row !== "");
    rows.push(line.trimEnd());
    let bytes = rows.reduce((sum, row) => sum + Buffer.byteLength(row) + 1, 0);
    let from = 0;
    while (from < rows.length - 1 && (rows.length - from > this.maxLines || bytes > this.maxBytes)) {
      bytes -= Buffer.byteLength(rows[from]!) + 1;
      from++;
    }
    await this.io.replace(`${rows.slice(from).join("\n")}\n`);
    this.held = { lines: rows.length - from, bytes };
    return "written";
  }

  private async load(): Promise<Held> {
    const text = (await this.io.read()) ?? "";
    const held = { lines: text.split("\n").filter((row) => row !== "").length, bytes: Buffer.byteLength(text) };
    this.held = held;
    return held;
  }
}
