// The rig of the invariant suites (M102 spec 15): a fake multiplexer that keeps a log of every write,
// a Send Protocol wired to it, and the two roads a test drives (a person's two taps with the override,
// and a send Collie makes on its own). The suites assert on the log, never on what a reader read.
//
// Not a test file: invariants.gates.test.ts and invariants.mutation.test.ts import it.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { muxAck, muxOk, type MuxAck, type MuxGrid, type MuxGridRequest, type MuxOutcome } from "../mux/types.ts";
import { loadProfiles, profileFor, type Profile, type ProfileForOptions } from "../../web/src/lib/surface/profile.ts";
import type { SendAnswer } from "../../web/src/lib/surface/send.ts";
import type { Surface } from "../../web/src/lib/surface/surface.ts";
import { KeyGate } from "./key-gate.ts";
import { RowRing, SendProtocol, SessionLocks, type SendDeps, type SendRequest, type SharedPaneLock } from "./protocol.ts";
import { HoldStore } from "./holds.ts";
import { RequestStore } from "./requests.ts";

const RULE = "─".repeat(40);
const GREY = "\u001b[38;2;136;136;136m";
const RESET = "\u001b[0m";

/** One write that reached the fake multiplexer. `keys` is one named key; text writes keep their text. */
export interface Write {
  readonly kind: "type" | "paste" | "block" | "keys";
  readonly value: string;
}

/**
 * What the pane draws. `box`: an input box (two grey rules, the prompt glyph, a status row) that the
 * profile the gates suite names finds. `bare`: the same transcript with no box, so no profile finds a frame
 * (the null frame). `fixed`: a capture of the corpus, as it is.
 */
export type PaneDraw = { readonly kind: "box" } | { readonly kind: "bare" } | { readonly kind: "fixed"; readonly text: string; readonly echoes: boolean };

/**
 * A pane that reacts to text the way a terminal does, and logs every write. In `box` the text lands in
 * the box and Enter moves it to the transcript. In `bare`, and in a `fixed` capture that echoes, the text
 * lands at the end of the last row and Enter starts a new row. A `fixed` capture that does not echo is a
 * dialog that swallows keys: nothing changes on screen.
 */
export class LogPane {
  revision = 1;
  transcript = ["> an earlier question", "An answer from the agent, two rows", "of it."];
  box = "";
  tail = "";
  readonly log: Write[] = [];
  /** Every read waits this long on the rig's clock first: the slow multiplexer of the chaos leg. */
  readDelayMs = 0;
  /** The rig's clock, so a slow read moves it. */
  clock: { now: number } | null = null;
  /**
   * The bridge stops here (M102 spec 16, a crash between the text and Enter): a write this names never
   * reaches the pane and its call never answers, as a killed process's call never does.
   */
  stopAt: ((write: Write) => boolean) | null = null;
  /** The bridge stops right after this write: it reaches the pane, and its call never answers (2026-11-17). */
  stopAfter: ((write: Write) => boolean) | null = null;
  /** The answer of a write that landed: a call that never answers once {@link stopAfter} names it. */
  private landed(write: Write): Promise<MuxAck> {
    return this.stopAfter?.(write) === true ? new Promise<MuxAck>(() => undefined) : Promise.resolve(muxAck());
  }
  /** Calls that never answer, so a stopped bridge's run stays pending. */
  private stopped(write: Write): Promise<MuxAck> | null {
    return this.stopAt?.(write) === true ? new Promise<MuxAck>(() => undefined) : null;
  }

  constructor(readonly draw: PaneDraw) {}

  render(): string {
    const { draw } = this;
    if (draw.kind === "fixed") return draw.echoes && this.tail !== "" ? `${draw.text.replace(/\n+$/u, "")}${this.tail}` : draw.text;
    if (draw.kind === "bare") return [...this.transcript, "", `$ ${this.tail}`].join("\n");
    const prompt = this.box === "" ? `❯ \u001b[2mTry "fix the failing tests"${RESET}` : `❯ ${this.box}`;
    return [...this.transcript, "", `${GREY}${RULE}${RESET}`, prompt, `${GREY}${RULE}${RESET}`, "  sonnet · project · main"].join("\n");
  }

  private take(text: string): void {
    const { draw } = this;
    if (draw.kind === "fixed" && !draw.echoes) return;
    if (draw.kind === "box") this.box += text;
    else this.tail += text;
    this.revision++;
  }

  readGrid = async (paneId: string, request: MuxGridRequest): Promise<MuxOutcome<MuxGrid>> => {
    void request;
    if (this.readDelayMs > 0 && this.clock !== null) this.clock.now += this.readDelayMs;
    await Promise.resolve();
    return muxOk({ paneId, text: this.render(), truncated: false, revision: this.revision });
  };

  typeText = (paneId: string, text: string): Promise<MuxAck> => {
    void paneId;
    const stop = this.stopped({ kind: "type", value: text });
    if (stop !== null) return stop;
    this.log.push({ kind: "type", value: text });
    this.take(text);
    return this.landed({ kind: "type", value: text });
  };

  pasteText = (paneId: string, text: string): Promise<MuxAck> => {
    void paneId;
    const stop = this.stopped({ kind: "paste", value: text });
    if (stop !== null) return stop;
    this.log.push({ kind: "paste", value: text });
    this.take(text);
    return this.landed({ kind: "paste", value: text });
  };

  writeKeys = (paneId: string, keys: readonly string[]): Promise<MuxAck> => {
    void paneId;
    const stop = keys.map((key) => this.stopped({ kind: "keys", value: key })).find((call) => call !== null);
    if (stop !== undefined && stop !== null) return stop;
    for (const key of keys) {
      this.log.push({ kind: "keys", value: key });
      const { draw } = this;
      if (draw.kind === "fixed" && !draw.echoes) continue;
      if (key === "Backspace") {
        if (draw.kind === "box") this.box = [...this.box].slice(0, -1).join("");
        else this.tail = [...this.tail].slice(0, -1).join("");
      } else if (key === "Enter") {
        if (draw.kind === "box") {
          if (this.box !== "") this.transcript.push(`> ${this.box}`);
          this.box = "";
        } else {
          this.tail = "";
        }
      } else if (key === "ctrl+j") {
        this.take("\n");
      }
      this.revision++;
    }
    const last = keys[keys.length - 1];
    return last === undefined ? Promise.resolve(muxAck()) : this.landed({ kind: "keys", value: last });
  };
}


export interface InvariantRig {
  readonly pane: LogPane;
  readonly protocol: SendProtocol;
  readonly clock: { now: number };
  readonly store: RequestStore;
  /** The hold queue, when the rig was asked for one. */
  readonly holds: HoldStore | undefined;
  /** One request, with a fresh id unless the test names one. */
  handle(request: Partial<SendRequest> & { readonly text: string }): Promise<SendAnswer>;
  /** Remove the rig's folder. */
  dispose(): void;
}

let serial = 0;

/** A fresh request id. */
export function nextId(): string {
  serial++;
  return `inv-${String(serial).padStart(7, "0")}`;
}

export interface RigOptions {
  readonly draw: PaneDraw;
  /** The multiplexer's agent string; a harness with no profile takes the blind road. */
  readonly harness: string;
  /** A version range that replaces the profile's own, so a lab run that moves the profile does not move the cases. */
  readonly pinVersions?: Profile["versions"];
  readonly version?: string | null;
  /** The Surface every read is folded to (the seam), with the read's own revision. Absent: what the readers read. */
  readonly surface?: Surface;
  /** The pane's generation; null is a pane that is gone. */
  readonly generation?: string | null;
  /** A hold queue (M56 spec 15), so a send the screen cannot take now is held. */
  readonly holds?: boolean;
  /** Another bridge on the same multiplexer (M102 spec 16): the pane and the clock it shares. */
  readonly pane?: LogPane;
  readonly clock?: { now: number };
  /** The machine-wide pane lock this bridge shares (pane-lock.ts); absent: the in-memory lock alone. */
  readonly paneLock?: SharedPaneLock;
  /** The request store's folder, kept by a restart (M102 spec 16); absent: a fresh folder of the rig's own. */
  readonly storeDir?: string;
}

/** A Send Protocol over a {@link LogPane}. */
export function invariantRig(options: RigOptions): InvariantRig {
  const dir = mkdtempSync(join(tmpdir(), "collie-invariants-"));
  const pane = options.pane ?? new LogPane(options.draw);
  const clock = options.clock ?? { now: 1_000_000 };
  pane.clock = clock;
  const now = (): number => clock.now;
  const gate = new KeyGate(pane, now);
  if (options.paneLock !== undefined) gate.share(options.paneLock);
  const version = options.version === null ? null : (options.version ?? "2.1.200");
  const forced = options.surface;
  const store = new RequestStore(options.storeDir ?? join(dir, "sends"), now);
  const holds = options.holds === true ? new HoldStore(join(dir, "held"), now) : undefined;
  const deps: SendDeps = {
    mux: { readGrid: pane.readGrid, typeText: pane.typeText, pasteText: pane.pasteText },
    gate,
    store,
    holds,
    locks: new SessionLocks(options.paneLock),
    ring: new RowRing(),
    profile: (harness: string) => {
      const loaded: Profile | undefined = loadProfiles().get(harness);
      const pin = options.pinVersions;
      const base = pin !== undefined && loaded !== undefined ? { ...loaded, versions: pin } : loaded;
      const lookup: ProfileForOptions = base === undefined ? { log: () => undefined } : { log: () => undefined, profiles: new Map([[harness, base]]) };
      return Promise.resolve(profileFor(harness, version, lookup));
    },
    generation: () => (options.generation === undefined ? "gen-1" : options.generation),
    now,
    sleep: (ms: number) => {
      clock.now += ms;
      return Promise.resolve();
    },
    surfaceSeam: forced === undefined ? undefined : (read: Surface) => ({ ...forced, revision: read.revision }),
  };
  const protocol = new SendProtocol(deps);
  const harness = options.harness;
  return {
    pane,
    protocol,
    clock,
    store,
    holds,
    handle: (request) => protocol.handle({ id: nextId(), mode: "send", ...request }, { session: "main", paneId: "%1", harness }),
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** The writes of one request: the log from `from` on. */
export function writesSince(pane: LogPane, from: number): readonly Write[] {
  return pane.log.slice(from);
}

/** How many times the text went in: whole-text writes that hold it. */
export function textWrites(writes: readonly Write[], text: string): number {
  return writes.filter((write) => write.kind !== "keys" && write.value.includes(text)).length;
}

/** The named keys of a write log. */
export function keysOf(writes: readonly Write[]): readonly string[] {
  return writes.filter((write) => write.kind === "keys").map((write) => write.value);
}

/**
 * The bytes I7 forbids on a menu: Enter, a digit or a letter. Collie's probe character (`⌁`) is none of
 * them, and Backspace and Escape are not either. A text write counts when it holds a digit or a letter.
 */
export function menuBytes(writes: readonly Write[]): readonly Write[] {
  return writes.filter((write) => (write.kind === "keys" ? write.value === "Enter" || /^[\p{L}\p{N}]$/u.test(write.value) : /[\p{L}\p{N}]/u.test(write.value)));
}

/**
 * The person's two taps (M56 spec 06, M102 spec 01): `prepare` reads the rows and hands back their hash,
 * then the commit carries that hash and the override. A first answer that carries no hash leaves the
 * commit without one. Returns both answers and the writes of the commit alone.
 */
export async function personOverride(rig: InvariantRig, text: string): Promise<{ readonly prepare: SendAnswer; readonly commit: SendAnswer; readonly writes: readonly Write[]; readonly id: string }> {
  const prepare = await rig.handle({ text: "", mode: "prepare", fromPhone: true });
  const from = rig.pane.log.length;
  const id = nextId();
  const rowsHash = prepare.rowsHash ?? undefined;
  const commit = await rig.handle(rowsHash === undefined ? { id, text, mode: "send", fromPhone: true, override: true } : { id, text, mode: "send", fromPhone: true, override: true, rowsHash });
  return { prepare, commit, writes: writesSince(rig.pane, from), id };
}

/** The same commit again under the same id: a retry the phone makes after a lost answer. */
export async function retrySame(rig: InvariantRig, id: string, text: string, rowsHash: string | undefined): Promise<{ readonly answer: SendAnswer; readonly writes: readonly Write[] }> {
  const from = rig.pane.log.length;
  const answer = await rig.handle(rowsHash === undefined ? { id, text, mode: "send", fromPhone: true, override: true } : { id, text, mode: "send", fromPhone: true, override: true, rowsHash });
  return { answer, writes: writesSince(rig.pane, from) };
}

/** A send Collie makes on its own: no `fromPhone`, no override (a WalkyTalky message, a hook, the CLI). */
export async function collieOwn(rig: InvariantRig, text: string): Promise<{ readonly answer: SendAnswer; readonly writes: readonly Write[] }> {
  const from = rig.pane.log.length;
  const answer = await rig.handle({ text, mode: "send" });
  return { answer, writes: writesSince(rig.pane, from) };
}

/** A person's plain first tap from the phone: no hash, no override. */
export async function personTap(rig: InvariantRig, text: string): Promise<{ readonly answer: SendAnswer; readonly writes: readonly Write[] }> {
  const from = rig.pane.log.length;
  const answer = await rig.handle({ text, mode: "send", fromPhone: true });
  return { answer, writes: writesSince(rig.pane, from) };
}
