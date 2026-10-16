// The Send Protocol against a scripted fake multiplexer (M56 spec 05): every step's refusal, every
// outcome, the probe against a dialog that swallows input and one that echoes it, the collapse form,
// a modal cue between S0 and S1, the lock bound, the crash case, the same id twice, and bracketed
// paste on and off. The fake draws a box the way the Claude profile reads one (a rule, the prompt
// glyph, a rule, a status row), or, for a harness with no profile, a bare editor between two rules.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { muxAck, muxOk, muxRefused, muxUnreachable, type MuxAck, type MuxGrid, type MuxGridRequest, type MuxOutcome } from "../mux/types.ts";
import { profileFor, resetProfileLog } from "../../web/src/lib/surface/profile.ts";
import type { SendAnswer } from "../../web/src/lib/surface/send.ts";
import { KeyGate } from "./key-gate.ts";
import { boxMatches, GENERIC_PROBE, LOCK_BOUND_MS, probeLanding, RowRing, SendProtocol, SessionLocks, type SendDeps, type SendRequest } from "./protocol.ts";
import { RequestStore } from "./requests.ts";

const RULE = "─".repeat(40);
const WIDTH = 38;
const PROBE = "⌁";
const DIALOG = [" Do you want to proceed?", " ❯ 1. Yes", "   2. No", " Esc to cancel · Enter to select"];

type Mode = "claude" | "generic";

/** A pane that reacts to text and keys like a harness's input box, with knobs for every failure. */
class FakePane {
  revision = 1;
  transcript = ["> an earlier question", "An answer from the agent, two rows", "of it."];
  box = "";
  placeholder = 'Try "fix the failing tests"';
  status = ["  sonnet · project · main"];
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
  collapseOver = 120;
  pastes = 0;
  readFails = false;
  readsSeen = 0;
  calls: string[] = [];
  keysSeen: string[] = [];
  /** Runs after every text write or key, for scripted changes. */
  afterInput: ((pane: FakePane, what: string) => void) | null = null;
  /** Runs before every read; may change the screen or return a promise to hold the read. */
  beforeRead: ((pane: FakePane, n: number) => Promise<void> | void) | null = null;

  constructor(readonly mode: Mode = "claude") {}

  private bump(): void {
    this.revision++;
  }

  private boxRows(): string[] {
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
    const rows = [...this.transcript, ""];
    if (this.echo !== null) rows.push(` Search: ${this.echo.field}`, ...this.list, "");
    if (this.dialog !== null) {
      rows.push(...this.dialog);
      return rows.join("\n");
    }
    rows.push(...this.over, RULE, ...this.boxRows(), RULE);
    if (this.mode === "generic") rows.push(this.footer);
    else rows.push(...(this.popup ?? this.status));
    return rows.join("\n");
  }

  private take(text: string, pasted: boolean): void {
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
    this.calls.push(`type:${text}`);
    this.take(text, text.length > 200);
    this.afterInput?.(this, `type:${text}`);
    return Promise.resolve(muxAck());
  };

  pasteText = (paneId: string, text: string): Promise<MuxAck> => {
    void paneId;
    this.calls.push(`paste:${text}`);
    this.take(text, true);
    this.afterInput?.(this, `paste:${text}`);
    return Promise.resolve(muxAck());
  };

  writeKeys = (paneId: string, keys: readonly string[]): Promise<MuxAck> => {
    void paneId;
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
      } else if (key === "Enter" && this.enterSubmits) {
        if (this.box.length > 0) this.transcript.push(`> ${this.box.replace(/\n/gu, " ")}`);
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

function rig(options: { mode?: Mode; version?: string; harness?: string; paste?: boolean; pane?: FakePane; storeDir?: string } = {}): Rig {
  const pane = options.pane ?? new FakePane(options.mode ?? "claude");
  const clock = { now: 1_000_000 };
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
    profile: (harness: string) => Promise.resolve(profileFor(harness, version, { log: () => undefined })),
    generation: () => "gen-1",
    now,
    sleep: (ms: number) => {
      clock.now += ms;
      return Promise.resolve();
    },
  };
  const protocol = new SendProtocol(deps);
  const harness = options.harness ?? (options.mode === "generic" ? "nothing-known" : "claude");
  const send = (text: string, over: Partial<SendRequest> = {}): Promise<SendAnswer> =>
    protocol.handle({ id: nextId(), text, mode: "send", ...over }, { session: "main", paneId: "%1", harness });
  return { pane, protocol, deps, clock, send };
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
});

describe("a harness with no profile", () => {
  test("the screen is unknown(no-match): the first tap is refused unconfirmed with the rows hash", async () => {
    const { pane, send } = rig({ mode: "generic" });
    const answer = await send("hello from the phone");
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "unconfirmed", profileId: null, keys: [] });
    expect(answer.rowsHash).toMatch(/^[0-9a-f]{14}$/u);
    expect(answer.surface).toMatchObject({ turn: "unknown", modal: "unknown", composer: "unknown", reason: "no-match" });
    expect(answer.offers).toEqual(["commit", "keys"]);
    expect(pane.calls).toEqual([]);
  });

  test("prepare reads and hands back the rows hash, and writes nothing", async () => {
    const { pane, protocol } = rig({ mode: "generic" });
    const prepared = await protocol.handle({ id: "unused-prepare", text: "", mode: "prepare" }, { session: "main", paneId: "%1", harness: "nothing-known" });
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

  test("multi-line text on a pane with no profile is refused: its newline key is unknown", async () => {
    const { pane, send } = rig({ mode: "generic" });
    expect((await send("a\nb", { rowsHash: "whatever" })).receipt).toMatchObject({ outcome: "refused", reason: "not_free" });
    expect(pane.calls).toEqual([]);
  });

  test("a search field that echoes the probe and narrows its list fails the probe; no corrective key", async () => {
    const { pane, send } = rig({ mode: "generic" });
    const first = await send("hello");
    pane.echo = { field: "", changesList: true };
    pane.list = ["  first match", "  second match"];
    const again = await send("hello", { rowsHash: first.rowsHash! });
    // The rows moved (the field drew): the commit is stale first.
    expect(again.receipt?.reason).toBe("stale_surface");
    const answer = await send("hello", { rowsHash: again.rowsHash! });
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "probe_failed", keys: ["probe"] });
    expect(pane.keysSeen).toEqual([]);
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

  test("a running turn is refused not_free", async () => {
    const { pane, send } = rig();
    pane.over = ["✻ Thinking… (12s · esc to interrupt)"];
    expect((await send("hello")).receipt).toMatchObject({ outcome: "refused", reason: "not_free" });
    expect(pane.calls).toEqual([]);
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

  test("a transcript row that moved while typing ends typed_not_submitted changed", async () => {
    const { pane, send } = rig();
    pane.transcript = Array.from({ length: 12 }, (_, i) => `transcript row ${String(i)}`);
    pane.afterInput = (p, what) => {
      if (what.startsWith("paste:")) p.transcript[0] = "> a different question";
    };
    expect((await send("hello world")).receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "changed" });
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

  test("discard: the box is emptied with Backspace, and the outcome says discarded", async () => {
    const { pane, send } = rig();
    pane.box = "do not send this";
    const answer = await send("do not send this", { mode: "discard" });
    expect(answer.receipt).toMatchObject({ outcome: "sent", reason: "discarded" });
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

  test("probeLanding wants exactly one changed row and exactly the probe put in", () => {
    const before = ["top", "", "──", "", "──", "~"];
    expect(probeLanding(before, ["top", "", "──", PROBE, "──", "~"], PROBE)).toMatchObject({ row: 3, index: 0 });
    expect(probeLanding(["›"], [`› ${PROBE}`], PROBE)).toMatchObject({ row: 0, index: 2 });
    expect(probeLanding(before, ["top!", "", "──", PROBE, "──", "~"], PROBE)).toBeNull();
    expect(probeLanding(before, ["top", "", "──", `x${PROBE}`, "──", "~"], PROBE)).toBeNull();
    expect(probeLanding(before, before, PROBE)).toBeNull();
  });
});

describe("real screens from the fixture corpus", () => {
  const fixture = (name: string): string => readFileSync(join(import.meta.dirname, "..", "..", "web", "src", "fixtures", "panes", name), "utf8");

  /** A pane that always shows one captured screen and records every write. */
  function still(text: string): FakePane {
    const pane = new FakePane();
    pane.render = () => text;
    return pane;
  }

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
