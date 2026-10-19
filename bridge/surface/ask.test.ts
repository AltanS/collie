// Ask v1 against scripted screens (M56 spec 08). The screens are real captures from the fixture
// corpus; a scripted multiplexer swaps them as keys arrive, and answers every read at revision 0, as
// Herdr does. Covered: the dialog changes between the lift and the answer; two permissions in a row;
// the /model picker followed by "Switch model?"; a menu whose highlighted row does not move; the same
// id twice; the unread card; the read back before Enter; the ask lifetime; the pane generation.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { muxAck, muxOk, type MuxAck, type MuxGrid, type MuxGridRequest, type MuxOutcome } from "../mux/types.ts";
import { parseAnsi } from "../../web/src/lib/ansi.ts";
import { splitLines } from "../../web/src/lib/blocks.ts";
import type { Answer, AskReply } from "../../web/src/lib/surface/ask.ts";
import { surfaceOfScreen } from "../../web/src/lib/surface/fold.ts";
import { liftDialog, readerBlocks } from "../../web/src/lib/surface/lift.ts";
import { loadProfiles, profileFor, resetProfileLog } from "../../web/src/lib/surface/profile.ts";
import { askOf, type Ask } from "../../web/src/lib/surface/surface.ts";
import type { AgentView } from "../types.ts";
import { ASK_LIFETIME_MS, AskAnswerer, AskBook, askBinding, NO_EDGE_DETAIL, planFor, planKeysFor } from "./ask.ts";
import { KeyGate, type TokenOrigin, type KeyToken } from "./key-gate.ts";
import { RowRing, SessionLocks } from "./protocol.ts";
import { RequestStore } from "./requests.ts";
import { SurfaceShadow } from "./shadow.ts";

const FIXTURES = join(import.meta.dir, "..", "..", "web", "src", "fixtures", "panes");
const fx = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

const PICKER = fx("claude--menu-model-picker.txt");
const SWITCH_YES = fx("claude--v2289-switch-model-yes.txt");
const SWITCH_NO = fx("claude--v2289-switch-model-no.txt");
const BASH = fx("claude--permission-bash.txt");
const EDIT = fx("claude--permission-edit.txt");
const IDLE = fx("claude--v2301-idle.txt");
const UNREAD = fx("claude-lab--tasks-panel--w40.txt");
const W82 = fx("claude-lab--permission-bash-v2291--w82.txt");
const BG_RM = fx("claude--v2303-permission-bash-bg-agent-rm--w160.txt");
const BG_RM_W80 = fx("claude--v2303-permission-bash-bg-agent-rm--w80.txt");
const RESUME_FIRST = fx("claude--v2303-menu-resume-picker--w160-first.txt");
const RESUME_SECOND = fx("claude--v2303-menu-resume-picker--w160-second.txt");

const HARNESS = "claude";
const PANE = "%1";
const GEN = "claude:session-1";

/** A pane that shows one capture at a time and swaps it as keys arrive. Every read is revision 0. */
class ScriptPane {
  screen: string;
  keysSeen: string[] = [];
  reads = 0;
  /** What a key does to the screen. The default does nothing: a dialog that ignores the key. */
  onKeys: (keys: readonly string[], pane: ScriptPane) => void = () => undefined;
  /** Runs before every read; may change the screen. */
  beforeRead: ((pane: ScriptPane, n: number) => void) | null = null;

  constructor(screen: string) {
    this.screen = screen;
  }

  readGrid = (paneId: string, request: MuxGridRequest): Promise<MuxOutcome<MuxGrid>> => {
    void request;
    this.reads++;
    this.beforeRead?.(this, this.reads);
    return Promise.resolve(muxOk({ paneId, text: this.screen, truncated: false, revision: 0 }));
  };

  writeKeys = (paneId: string, keys: readonly string[]): Promise<MuxAck> => {
    void paneId;
    this.keysSeen.push(...keys);
    this.onKeys(keys, this);
    return Promise.resolve(muxAck());
  };
}

/** A gate where a person presses a key at the desk right before the next commit token is minted. */
class DeskGate extends KeyGate {
  deskBefore: string | null = null;
  override mint(paneId: string, keys: readonly string[], revision: number, origin?: TokenOrigin): KeyToken {
    if (this.deskBefore !== null && keys.includes(this.deskBefore)) {
      this.deskBefore = null;
      void this.press(paneId, ["Up"], "person_tap");
    }
    return super.mint(paneId, keys, revision, origin);
  }
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "collie-ask-"));
  resetProfileLog();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** The pane generation the rig answers; a test sets it to null or another value. */
interface Generation {
  value: string | null;
}

interface Rig {
  pane: ScriptPane;
  gate: DeskGate;
  store: RequestStore;
  book: AskBook;
  answerer: AskAnswerer;
  clock: { now: number };
  generation: Generation;
  /** One poll: lift the screen as the shadow does and publish it, the ask the phone would see. */
  poll: () => Ask | null;
  answer: (ask: Ask, optionId: string, over?: Partial<Answer>) => Promise<AskReply>;
}

function rig(screen: string, harness: string = HARNESS, version = "2.1.200"): Rig {
  const pane = new ScriptPane(screen);
  const clock = { now: 2_000_000 };
  const now = (): number => clock.now;
  const gate = new DeskGate(pane, now);
  const store = new RequestStore(join(dir, "sends"), now);
  const book = new AskBook(now, "test-salt");
  const generation: Generation = { value: GEN };
  const answerer = new AskAnswerer({
    mux: pane,
    gate,
    store,
    locks: new SessionLocks(),
    book,
    ring: new RowRing(),
    profile: (name) => Promise.resolve(profileFor(name, version, { log: () => undefined })),
    generation: () => generation.value,
    now,
    sleep: (ms) => {
      clock.now += ms;
      return Promise.resolve();
    },
  });
  const poll = (): Ask | null => {
    const rows = splitLines(parseAnsi(pane.screen));
    return book.publish(PANE, generation.value ?? "gone", liftDialog(readerBlocks(rows, harness)));
  };
  const answer = (ask: Ask, optionId: string, over: Partial<Answer> = {}): Promise<AskReply> =>
    answerer.handle({ askId: ask.id, hash: ask.hash, optionId, origin: "person_tap", ...over }, { session: "main", paneId: PANE, harness });
  return { pane, gate, store, book, answerer, clock, generation, poll, answer };
}

function idOf(ask: Ask, label: string): string {
  const option = ask.options.find((o) => o.label === label);
  if (option === undefined) throw new Error(`no option ${label} in ${ask.options.map((o) => o.label).join(", ")}`);
  return option.id;
}

function neverEnter(pane: ScriptPane): void {
  expect(pane.keysSeen.filter((key) => key === "Enter")).toEqual([]);
}

describe("the ask book", () => {
  test("the same dialog keeps its id across polls; the id is bound to the generation, the hash and the block text, never the revision", () => {
    const { poll, book, generation } = rig(BASH);
    const a = poll()!;
    const b = poll()!;
    expect(a.id).toMatch(/^ask-[0-9a-f]{14}$/u);
    expect(b.id).toBe(a.id);
    const entry = book.entry(a.id)!;
    const rows = splitLines(parseAnsi(BASH));
    const dialog = liftDialog(readerBlocks(rows, HARNESS))!;
    expect(entry.binding).toBe(askBinding(GEN, dialog));
    expect(askBinding("claude:session-2", dialog)).not.toBe(entry.binding);
    // Another generation on the same pane is another ask, even with the same screen.
    generation.value = "claude:session-2";
    expect(poll()!.id).not.toBe(a.id);
  });

  test("a spent id never comes back: the same screen after an answer gets a new id", () => {
    const { poll, book } = rig(BASH);
    const a = poll()!;
    book.spend(a.id);
    const b = poll()!;
    expect(b.id).not.toBe(a.id);
    expect(b.hash).toBe(a.hash);
  });

  test("ids from two books (a restart) never repeat for the same screen", () => {
    const a = new AskBook(() => 0, "boot-1");
    const b = new AskBook(() => 0, "boot-2");
    const dialog = liftDialog(readerBlocks(splitLines(parseAnsi(BASH)), HARNESS))!;
    expect(a.publish(PANE, GEN, dialog)!.id).not.toBe(b.publish(PANE, GEN, dialog)!.id);
  });

  test("the poll's Surface carries the book's id, so the phone's id is the one the route knows", async () => {
    const { pane, book, answerer } = rig(BASH);
    const shadow = new SurfaceShadow({ mux: pane, pollMs: 1000, version: () => Promise.resolve("2.1.200"), compare: false, asks: { book, generation: () => GEN } });
    // SAFETY: the shadow reads only `paneId` and `agent` of an AgentView (shadow.ts `observePane`).
    await shadow.observe([{ paneId: PANE, agent: HARNESS } as AgentView]);
    const surface = shadow.surfaceOf(PANE)!;
    expect(askOf(surface.modal)?.id).toBe(book.currentAsk(PANE)!.id);
    pane.onKeys = (_keys, p) => {
      p.screen = IDLE;
    };
    const ask = book.currentAsk(PANE)!;
    const reply = await answerer.handle({ askId: ask.id, hash: ask.hash, optionId: idOf(ask, "Yes"), origin: "person_tap" }, { session: "main", paneId: PANE, harness: HARNESS });
    expect(reply.receipt).toMatchObject({ outcome: "sent", keys: ["1"] });
  });
});

// The bullet of the tool row above the dialog blinks on a live Claude: "●" and " " take turns about
// once a second. It sits outside the dialog block, so it must never change the ask.
function blink(screen: string): string {
  const rows = screen.split("\n");
  const at = rows.findIndex((row) => row.includes("●") && row.includes("Bash"));
  if (at < 0) throw new Error("no tool row with a bullet");
  rows[at] = rows[at]!.replace("●", " ");
  return rows.join("\n");
}

function liftOf(screen: string) {
  return liftDialog(readerBlocks(splitLines(parseAnsi(screen)), HARNESS))!;
}

describe("the ask binding covers the dialog block only", () => {
  test("a blink of the tool row's bullet above the dialog leaves the binding and the hash unchanged", () => {
    const before = liftOf(W82);
    const after = liftOf(blink(W82));
    expect(blink(W82)).not.toBe(W82);
    expect(after.region).not.toBeNull();
    expect(after.hash).toBe(before.hash);
    expect(askBinding(GEN, after)).toBe(askBinding(GEN, before));
    // The block runs from the dialog's top edge to the footer: the header, the subject, the question, the labels, the hints.
    expect(before.region!.split("\n")[0]).toMatch(/^─+$/u);
    expect(before.region).toContain("Bash command");
    expect(before.region).toContain("touch /tmp/claude-lab/project/scratch-one.txt");
    expect(before.region).toContain("Do you want to proceed?");
    expect(before.region!.trimEnd().split("\n").at(-1)).toContain("Esc to cancel");
    expect(before.region).not.toContain("Waiting");
  });

  test("a changed option label changes the binding", () => {
    const before = liftOf(W82);
    const after = liftOf(W82.replace("Yes, and switch to auto mode", "Yes, and switch to plan mode"));
    expect(askBinding(GEN, after)).not.toBe(askBinding(GEN, before));
    expect(after.hash).not.toBe(before.hash);
  });

  test("the ask keeps its id across blinks, and a tap after a blink is sent", async () => {
    const { pane, poll, answer } = rig(W82);
    const ask = poll()!;
    pane.screen = blink(W82);
    expect(poll()!.id).toBe(ask.id);
    pane.screen = W82;
    expect(poll()!.id).toBe(ask.id);
    // The check read sees the other phase of the blink.
    pane.beforeRead = (p) => {
      p.screen = blink(W82);
    };
    pane.onKeys = (_keys, p) => {
      p.beforeRead = null;
      p.screen = IDLE;
    };
    const reply = await answer(ask, idOf(ask, "Yes"));
    expect(reply.receipt).toMatchObject({ outcome: "sent", keys: ["1"] });
  });

  test("with no top edge found, a tap is refused and no key is sent: never a bind to the rows above", async () => {
    const rows = W82.split("\n");
    const edge = rows.findIndex((row) => row.includes("─".repeat(20)));
    expect(edge).toBeGreaterThan(0);
    const edgeless = [...rows.slice(0, edge), ...rows.slice(edge + 1)].join("\n");
    const dialog = liftOf(edgeless);
    expect(dialog.region).toBeNull();
    const { pane, poll, answer } = rig(edgeless);
    const ask = poll()!;
    const reply = await answer(ask, idOf(ask, "Yes"));
    expect(reply.receipt).toMatchObject({ outcome: "refused", reason: "no_plan", keys: [] });
    expect(reply.detail).toBe(NO_EDGE_DETAIL);
    expect(pane.keysSeen).toEqual([]);
  });
});

// The 2026-10-19 incident (2.1.303): a background agent's Bash permission with the dangerous-rm
// warning and a tall command. The dialog's edge sat past the old scan window, the lift had no region,
// and both taps were refused `no_plan` with no key sent.
describe("a background agent's Bash permission with a tall command", () => {
  test.each([
    ["w160", BG_RM],
    ["w80", BG_RM_W80],
  ])("%s: the lift has a region from the edge, and each option has a digit plan", (_width, screen) => {
    const dialog = liftOf(screen);
    expect(dialog.kind).toBe("permission");
    expect(dialog.labels).toEqual(["Yes", "No"]);
    expect(dialog.region).not.toBeNull();
    expect(dialog.region!.split("\n")[0]).toMatch(/^─+$/u);
    expect(dialog.region).toContain("Dangerous rm operation on possibly-empty variable path");
    expect(planFor(dialog, 0)).toEqual({ walk: [], commit: ["1"], label: "Yes" });
    expect(planFor(dialog, 1)).toEqual({ walk: [], commit: ["2"], label: "No" });
  });

  test.each([
    ["Yes", "1"],
    ["No", "2"],
  ])("a tap on %s sends its digit through the gate", async (label, key) => {
    const { pane, poll, answer } = rig(BG_RM, HARNESS, "2.1.303");
    pane.onKeys = (keys, p) => {
      if (keys.join(",") === key) p.screen = IDLE;
    };
    const ask = poll()!;
    expect(ask.kind).toBe("permission");
    const reply = await answer(ask, idOf(ask, label));
    expect(reply.receipt).toMatchObject({ outcome: "sent", keys: [key] });
    expect(pane.keysSeen).toEqual([key]);
  });
});

// The 2026-10-19 incident (2.1.303, 160 columns): the /resume picker's title counts the pointer,
// `(1 of 50)` then `(2 of 50)` after one Down, and the verify read refused the walked tap
// `ask_mismatch` with no Enter.
describe("the /resume picker with a counted title", () => {
  test("a tap on the second session walks Down, reads the pointer back on it, and sends Enter", async () => {
    const { pane, poll, answer } = rig(RESUME_FIRST, HARNESS, "2.1.303");
    pane.onKeys = (keys, p) => {
      if (keys.join(",") === "Down") p.screen = RESUME_SECOND;
      if (keys.join(",") === "Enter") p.screen = IDLE;
    };
    const ask = poll()!;
    expect(ask.kind).toBe("question");
    const reply = await answer(ask, idOf(ask, "website refactoring"));
    expect(reply.receipt).toMatchObject({ outcome: "sent", keys: ["Down", "Enter"] });
    expect(pane.keysSeen).toEqual(["Down", "Enter"]);
  });
});

describe("answers that go through", () => {
  test("a permission: the hash check, one key through the gate, sent, with the receipt on disk", async () => {
    const { pane, poll, answer, store, gate } = rig(BASH);
    pane.onKeys = (keys, p) => {
      if (keys.join(",") === "1") p.screen = IDLE;
    };
    const ask = poll()!;
    expect(ask.kind).toBe("permission");
    const reply = await answer(ask, idOf(ask, "Yes"));
    expect(reply.receipt).toMatchObject({
      askId: ask.id,
      session: "main",
      paneId: PANE,
      paneGeneration: GEN,
      harness: HARNESS,
      kind: "permission",
      hash: ask.hash,
      optionId: "1",
      origin: "person_tap",
      keys: ["1"],
      outcome: "sent",
    });
    expect(reply.receipt!.check).toMatchObject({ revision: 0, hash: expect.any(String) });
    expect(reply.receipt!.readBack).toEqual(reply.receipt!.check);
    expect(reply.receipt!.after).not.toBeNull();
    expect(pane.keysSeen).toEqual(["1"]);
    // The receipt is stored beside the sends, with the option by id and never a label.
    const stored = store.getAsk(ask.id)!;
    expect(stored.receipt).toEqual(reply.receipt!);
    const onDisk = readdirSync(join(dir, "sends")).filter((name) => name.startsWith("ask."));
    expect(onDisk).toEqual([`ask.${ask.id}.json`]);
    expect(readFileSync(join(dir, "sends", onDisk[0]!), "utf8")).not.toContain("mkfifo");
    // The key left through the gate on a person's token.
    expect(gate.sentBy()).toEqual({ person_tap: 1, legacy_reply: 0, protocol: 0 });
  });

  test("two permissions in a row: each gets its own id, each answer sends its own key once", async () => {
    const { pane, poll, answer } = rig(BASH);
    pane.onKeys = (keys, p) => {
      if (p.screen === BASH && keys.join(",") === "1") p.screen = EDIT;
      else if (p.screen === EDIT && keys.join(",") === "3") p.screen = IDLE;
    };
    const first = poll()!;
    const one = await answer(first, idOf(first, "Yes"));
    expect(one.receipt).toMatchObject({ outcome: "sent", keys: ["1"] });
    const second = poll()!;
    expect(second.id).not.toBe(first.id);
    expect(second.hash).not.toBe(first.hash);
    const two = await answer(second, idOf(second, "No"));
    expect(two.receipt).toMatchObject({ outcome: "sent", keys: ["3"] });
    // A late repeat of the first tap is its first receipt again, and sends nothing.
    const late = await answer(first, idOf(first, "Yes"));
    expect(late.replayed).toBe(true);
    expect(late.receipt).toEqual(one.receipt!);
    expect(pane.keysSeen).toEqual(["1", "3"]);
  });

  test("read back: the walk goes first, a read shows the pointer on the chosen row, then Enter on that read", async () => {
    const { pane, poll, answer } = rig(SWITCH_YES);
    pane.onKeys = (keys, p) => {
      if (keys.join(",") === "Down" && p.screen === SWITCH_YES) p.screen = SWITCH_NO;
      else if (keys.join(",") === "Enter") p.screen = PICKER;
    };
    const ask = poll()!;
    expect(ask.options.map((o) => o.label)).toEqual(["Yes, switch to Fable 5.1", "No, go back"]);
    const reply = await answer(ask, idOf(ask, "No, go back"));
    expect(reply.receipt).toMatchObject({ outcome: "sent", keys: ["Down", "Enter"] });
    expect(pane.keysSeen).toEqual(["Down", "Enter"]);
    // The commit was bound to the read back, not to the check: the screen moved between the two.
    expect(reply.receipt!.readBack).not.toBeNull();
    expect(reply.receipt!.readBack!.hash).not.toBe(reply.receipt!.check!.hash);
  });

  test("read back: a pointed row with no walk is committed on the check read, which already shows the pointer on it", async () => {
    const { pane, poll, answer } = rig(SWITCH_YES);
    pane.onKeys = (keys, p) => {
      if (keys.join(",") === "Enter") p.screen = IDLE;
    };
    const ask = poll()!;
    const reply = await answer(ask, idOf(ask, "Yes, switch to Fable 5.1"));
    expect(reply.receipt).toMatchObject({ outcome: "sent", keys: ["Enter"] });
    expect(reply.receipt!.readBack).toEqual(reply.receipt!.check);
  });

  test("a menu footer key is sent as the footer named it", async () => {
    const { pane, poll, answer } = rig(PICKER);
    pane.onKeys = (keys, p) => {
      if (keys.join(",") === "Escape") p.screen = IDLE;
    };
    const ask = poll()!;
    expect(ask.kind).toBe("menu");
    const reply = await answer(ask, idOf(ask, "Cancel"));
    expect(reply.receipt).toMatchObject({ outcome: "sent", keys: ["Escape"] });
  });
});

describe("codex asks (M56 spec 13)", () => {
  const CODEX_APPROVAL = fx("codex--v0156-approval-exec-2opt.txt");
  const CODEX_PATCH = fx("codex--v0156-approval-patch.txt");
  const CODEX_TRUST = fx("codex--v0156-trust.txt");
  // The same trust prompt with the pointer moved to its second row, as Down draws it.
  const CODEX_TRUST_QUIT = CODEX_TRUST.replace("\u203a 1. Trust and continue", "  1. Trust and continue").replace("  2. Quit", "\u203a 2. Quit");
  const CODEX_IDLE = fx("codex--v0162-idle.txt");
  const codex = (screen: string): Rig => rig(screen, "codex", "0.159.2");

  test("codex: an exec approval lifts as a permission, and Yes sends its digit through the gate, with the hash check and the read back in the receipt", async () => {
    const { pane, poll, answer } = codex(CODEX_APPROVAL);
    pane.onKeys = (keys, p) => {
      if (keys.join(",") === "1") p.screen = CODEX_IDLE;
    };
    const ask = poll()!;
    expect(ask.kind).toBe("permission");
    expect(ask.options.map((o) => o.label)).toEqual(["Yes, proceed", "No, and tell Codex what to do differently"]);
    const reply = await answer(ask, idOf(ask, "Yes, proceed"));
    expect(reply.receipt).toMatchObject({ harness: "codex", hash: ask.hash, outcome: "sent", keys: ["1"] });
    expect(reply.receipt!.check).toMatchObject({ revision: 0, hash: expect.any(String) });
    expect(reply.receipt!.readBack).toEqual(reply.receipt!.check);
    expect(reply.receipt!.after).not.toBeNull();
    expect(pane.keysSeen).toEqual(["1"]);
  });

  test("codex: a question dialog answers with the bare digit, one question or each step of two (lab, 0.163.0, K12)", async () => {
    // Lab, Codex 0.163.0, 2026-10-16: a bare digit commits the option at once. On a one-question
    // dialog it answers it; on a two-question dialog it answers the first and opens the second, and
    // on the last it submits all. It never only moves the highlight, so no Enter follows.
    const fruit = fx("codex--ask-fruit.txt");
    const q1 = fx("codex--ask-wizard-q1.txt");
    const q2 = fx("codex--ask-wizard-q2.txt");
    const one = codex(fruit);
    one.pane.onKeys = (keys, p) => {
      if (keys.join(",") === "2") p.screen = CODEX_IDLE;
    };
    const fruitAsk = one.poll()!;
    expect(fruitAsk.kind).toBe("question");
    expect((await one.answer(fruitAsk, idOf(fruitAsk, "Pear"))).receipt).toMatchObject({ outcome: "sent", keys: ["2"] });
    neverEnter(one.pane);
    const two = codex(q1);
    two.pane.onKeys = (keys, p) => {
      if (keys.join(",") === "2") p.screen = q2;
      else if (keys.join(",") === "1") p.screen = CODEX_IDLE;
    };
    const first = two.poll()!;
    expect((await two.answer(first, idOf(first, "Spaces"))).receipt).toMatchObject({ outcome: "sent", keys: ["2"] });
    const second = two.poll()!;
    expect(second.options.map((o) => o.label)).toContain("No");
    expect((await two.answer(second, idOf(second, "Yes (Recommended)"))).receipt).toMatchObject({ outcome: "sent", keys: ["1"] });
    neverEnter(two.pane);
  });

  test("codex: a patch approval's No sends the profile's cancel key", async () => {
    const { pane, poll, answer } = codex(CODEX_PATCH);
    pane.onKeys = (keys, p) => {
      if (keys.join(",") === "Escape") p.screen = CODEX_IDLE;
    };
    const ask = poll()!;
    const reply = await answer(ask, idOf(ask, "No, and tell Codex what to do differently"));
    expect(reply.receipt).toMatchObject({ outcome: "sent", keys: ["Escape"] });
    neverEnter(pane);
  });

  test("codex: the trust prompt's second row walks Down, reads the pointer back on Quit, then commits", async () => {
    const { pane, poll, answer } = codex(CODEX_TRUST);
    pane.onKeys = (keys, p) => {
      if (keys.join(",") === "Down" && p.screen === CODEX_TRUST) p.screen = CODEX_TRUST_QUIT;
      else if (keys.join(",") === "Enter") p.screen = CODEX_IDLE;
    };
    const ask = poll()!;
    const reply = await answer(ask, idOf(ask, "Quit"));
    expect(reply.receipt).toMatchObject({ outcome: "sent", keys: ["Down", "Enter"] });
    expect(reply.receipt!.readBack!.hash).not.toBe(reply.receipt!.check!.hash);
  });

  test("codex: a walk whose pointer never moves is refused ask_mismatch, with no Enter", async () => {
    const { pane, poll, answer } = codex(CODEX_TRUST);
    const ask = poll()!;
    const reply = await answer(ask, idOf(ask, "Quit"));
    expect(reply.receipt).toMatchObject({ outcome: "refused", reason: "ask_mismatch" });
    expect(pane.keysSeen).toEqual(["Down"]);
    neverEnter(pane);
  });

  test("codex: the plan's generic keys become the profile's navigation keys, and other keys stay", () => {
    const navigation = { up: "k", down: "j", confirm: "Return", cancel: "q" };
    expect(planKeysFor({ walk: ["Down", "Down"], commit: ["Enter"], label: "Quit" }, navigation)).toEqual({ walk: ["j", "j"], commit: ["Return"], label: "Quit" });
    expect(planKeysFor({ walk: [], commit: ["Escape"], label: "No" }, navigation).commit).toEqual(["q"]);
    expect(planKeysFor({ walk: [], commit: ["1"], label: "Yes" }, navigation).commit).toEqual(["1"]);
    expect(planKeysFor({ walk: ["Up"], commit: ["Enter"], label: "x" }, null)).toEqual({ walk: ["Up"], commit: ["Enter"], label: "x" });
    expect(loadProfiles().get("codex")!.keys.navigation).toEqual({ up: "Up", down: "Down", confirm: "Enter", cancel: "Escape" });
  });
});

describe("changed, replaced and repeated asks are refused with no key", () => {
  test("the dialog changes between the lift and the answer: refused ask_changed, the new ask has a new id, nothing sent", async () => {
    const { pane, poll, answer, book } = rig(BASH);
    const ask = poll()!;
    pane.screen = EDIT;
    const reply = await answer(ask, idOf(ask, "Yes"));
    expect(reply.receipt).toMatchObject({ outcome: "refused", reason: "ask_changed", keys: [] });
    expect(reply.ask).toBeDefined();
    expect(reply.ask!.id).not.toBe(ask.id);
    expect(reply.ask!.options.map((o) => o.label)).toContain("Yes, allow all edits during this session (shift+tab)");
    expect(book.currentAsk(PANE)!.id).toBe(reply.ask!.id);
    expect(pane.keysSeen).toEqual([]);
    // The old tap, sent again, is the same refusal and still no key.
    const again = await answer(ask, idOf(ask, "Yes"));
    expect(again.replayed).toBe(true);
    expect(again.receipt).toEqual(reply.receipt!);
    expect(pane.keysSeen).toEqual([]);
  });

  test("the /model picker followed by Switch model?: the picker's old tap never answers the confirmation", async () => {
    const { pane, poll, answer } = rig(PICKER);
    pane.onKeys = (keys, p) => {
      if (p.screen === PICKER && keys.join(",") === "s") p.screen = SWITCH_YES;
      else if (p.screen === SWITCH_YES && keys.join(",") === "Down") p.screen = SWITCH_NO;
      else if (p.screen === SWITCH_NO && keys.join(",") === "Enter") p.screen = PICKER;
    };
    const picker = poll()!;
    // Two taps on the picker card: the first goes, the second is a different option on the same id.
    const first = await answer(picker, idOf(picker, "Use this session only"));
    expect(first.receipt).toMatchObject({ outcome: "sent", keys: ["s"] });
    const second = await answer(picker, idOf(picker, "Set as default"));
    expect(second.receipt).toMatchObject({ outcome: "refused", reason: "ask_answered", keys: [] });
    expect(pane.keysSeen).toEqual(["s"]);
    // The next poll lifts Switch model? under its own new id; the picker's id answers nothing more.
    const confirm = poll()!;
    expect(confirm.id).not.toBe(picker.id);
    expect(confirm.options.map((o) => o.label)).toEqual(["Yes, switch to Fable 5.1", "No, go back"]);
    // The confirmation answered on its own id: No, go back walks, reads back and commits.
    const back = await answer(confirm, idOf(confirm, "No, go back"));
    expect(back.receipt).toMatchObject({ outcome: "sent", keys: ["Down", "Enter"] });
    expect(pane.keysSeen).toEqual(["s", "Down", "Enter"]);
  });

  test("a picker id minted before the confirmation came up is refused ask_changed on the confirmation screen", async () => {
    const { pane, poll, answer } = rig(PICKER);
    const picker = poll()!;
    // The desk pressed `s`: the confirmation is up before the phone's tap on Set as default lands.
    pane.screen = SWITCH_YES;
    const reply = await answer(picker, idOf(picker, "Set as default"));
    expect(reply.receipt).toMatchObject({ outcome: "refused", reason: "ask_changed", keys: [] });
    expect(reply.ask!.options.map((o) => o.label)).toEqual(["Yes, switch to Fable 5.1", "No, go back"]);
    neverEnter(pane);
    expect(pane.keysSeen).toEqual([]);
  });

  test("read back: a menu whose highlighted row does not move is refused ask_mismatch, the arrows went and Enter did not", async () => {
    const { pane, poll, answer } = rig(SWITCH_YES);
    // The dialog ignores Down: the pointer stays on Yes.
    const ask = poll()!;
    const reply = await answer(ask, idOf(ask, "No, go back"));
    expect(reply.receipt).toMatchObject({ outcome: "refused", reason: "ask_mismatch", keys: ["Down"] });
    expect(pane.keysSeen).toEqual(["Down"]);
    neverEnter(pane);
  });

  test("read back: a desk key between the read back and Enter makes the token stale, and Enter is not sent", async () => {
    const { pane, poll, answer, gate } = rig(SWITCH_YES);
    pane.onKeys = (keys, p) => {
      if (keys.join(",") === "Down") p.screen = SWITCH_NO;
    };
    gate.deskBefore = "Enter";
    const ask = poll()!;
    const reply = await answer(ask, idOf(ask, "No, go back"));
    expect(reply.receipt).toMatchObject({ outcome: "refused", reason: "stale_surface", keys: ["Down"] });
    expect(pane.keysSeen).toEqual(["Down", "Up"]);
    neverEnter(pane);
  });

  test("the same id twice: the same answer returns the first receipt, another answer is refused ask_answered", async () => {
    const { pane, poll, answer } = rig(BASH);
    pane.onKeys = (_keys, p) => {
      p.screen = IDLE;
    };
    const ask = poll()!;
    const first = await answer(ask, idOf(ask, "Yes"));
    const same = await answer(ask, idOf(ask, "Yes"));
    expect(same.replayed).toBe(true);
    expect(same.receipt).toEqual(first.receipt!);
    const other = await answer(ask, idOf(ask, "No"));
    expect(other.receipt).toMatchObject({ outcome: "refused", reason: "ask_answered", keys: [] });
    const otherHash = await answer(ask, idOf(ask, "Yes"), { hash: "0123456789abcd" });
    expect(otherHash.receipt).toMatchObject({ outcome: "refused", reason: "ask_answered", keys: [] });
    expect(pane.keysSeen).toEqual(["1"]);
  });

  test("two taps at once on one id: one answer runs, the other waits for it and gets its receipt", async () => {
    const { pane, poll, answer } = rig(BASH);
    pane.onKeys = (_keys, p) => {
      p.screen = IDLE;
    };
    const ask = poll()!;
    const [a, b] = await Promise.all([answer(ask, "1"), answer(ask, "1")]);
    expect(a.receipt).toEqual(b.receipt!);
    expect(pane.keysSeen).toEqual(["1"]);
  });

  test("an id the bridge never minted is refused ask_unknown, nothing is stored and nothing sent; the live ask rides along", async () => {
    const { pane, poll, answer, store } = rig(BASH);
    const live = poll()!;
    const made = { ...live, id: "ask-00000000000000" };
    const reply = await answer(made, "1");
    expect(reply.receipt).toMatchObject({ outcome: "refused", reason: "ask_unknown", keys: [] });
    expect(reply.ask?.id).toBe(live.id);
    expect(store.getAsk(made.id)).toBeNull();
    expect(pane.keysSeen).toEqual([]);
  });

  test("a hash that is not the ask's is refused ask_changed with no key; the screen's ask rides along under a new id", async () => {
    const { pane, poll, answer } = rig(BASH);
    const ask = poll()!;
    const reply = await answer(ask, "1", { hash: "00000000000000" });
    expect(reply.receipt).toMatchObject({ outcome: "refused", reason: "ask_changed", keys: [] });
    expect(pane.keysSeen).toEqual([]);
    // The id is spent: the reply names the same dialog under a new id, and that id answers it.
    expect(reply.ask?.hash).toBe(ask.hash);
    expect(reply.ask?.id).not.toBe(ask.id);
    pane.onKeys = (_keys, p) => {
      p.screen = IDLE;
    };
    const next = await answer(reply.ask!, "1");
    expect(next.receipt).toMatchObject({ outcome: "sent", keys: ["1"] });
  });

  test("an id answered before hands back the dialog still on the screen under a new id, no key", async () => {
    const { pane, poll, answer } = rig(BASH);
    const ask = poll()!;
    await answer(ask, "1", { hash: "00000000000000" });
    const again = await answer(ask, "1");
    expect(again.receipt).toMatchObject({ outcome: "refused", reason: "ask_answered", keys: [] });
    expect(again.ask?.hash).toBe(ask.hash);
    expect(again.ask?.id).not.toBe(ask.id);
    expect(pane.keysSeen).toEqual([]);
  });

  test("a pane that holds another program now is refused pane_gone with no key", async () => {
    const { pane, poll, answer, generation } = rig(BASH);
    const ask = poll()!;
    generation.value = "claude:session-2";
    const reply = await answer(ask, "1");
    expect(reply.receipt).toMatchObject({ outcome: "refused", reason: "pane_gone", keys: [] });
    expect(pane.keysSeen).toEqual([]);
  });

  test("a focused text field in the dialog has no plan: refused no_plan with no key", () => {
    const dialog = liftDialog(readerBlocks(splitLines(parseAnsi(fx("claude--v2283-permission-amend-focused.txt"))), HARNESS));
    expect(dialog).not.toBeNull();
    expect(planFor(dialog!, 0)).toBeNull();
  });
});

describe("timeouts: an ask that left the screen", () => {
  test("older than the profile's ask lifetime and off the screen: voided, the answer is refused ask_gone with no key", async () => {
    const { pane, poll, answer, clock } = rig(BASH);
    const ask = poll()!;
    expect(loadProfiles().get(HARNESS)!.ask?.lifetimeMs).toBe(ASK_LIFETIME_MS);
    pane.screen = IDLE;
    clock.now += ASK_LIFETIME_MS + 1;
    expect(poll()).toBeNull();
    const reply = await answer(ask, "1");
    expect(reply.receipt).toMatchObject({ outcome: "refused", reason: "ask_gone", keys: [] });
    expect(reply.detail).toContain("gone");
    expect(pane.keysSeen).toEqual([]);
  });

  test("younger than its lifetime, one poll that misses it keeps the id; the answer reads the screen and finds it gone", async () => {
    const { pane, poll, answer } = rig(BASH);
    const ask = poll()!;
    pane.screen = IDLE;
    expect(poll()).toBeNull();
    pane.screen = BASH;
    expect(poll()!.id).toBe(ask.id);
    pane.screen = IDLE;
    const reply = await answer(ask, "1");
    expect(reply.receipt).toMatchObject({ outcome: "refused", reason: "ask_gone", keys: [] });
    expect(pane.keysSeen).toEqual([]);
  });
});

describe("the unread card is modal unreadable", () => {
  test("no ask is minted, the Surface is unreadable, an answer sends nothing, and Esc is a person's key through the gate", async () => {
    const { pane, poll, answer, gate } = rig(UNREAD);
    expect(poll()).toBeNull();
    const rows = splitLines(parseAnsi(UNREAD));
    const { surface } = surfaceOfScreen({ seq: 0, source: "screen", at: 0, revision: 0, rows, ask: null }, loadProfiles().get(HARNESS)!.idle);
    expect(surface.modal).toBe("unreadable");
    const reply = await answer({ id: "ask-0123456789abcd", kind: "menu", options: [{ id: "1", label: "Esc" }], channel: "keys", hash: "00" }, "1");
    expect(reply.receipt).toMatchObject({ outcome: "refused", reason: "ask_unknown", keys: [] });
    expect(pane.keysSeen).toEqual([]);
    // The card's Esc is the keys route's `press`: a person's key, no revision check, counted as such.
    await gate.press(PANE, ["Escape"], "person_tap");
    expect(pane.keysSeen).toEqual(["Escape"]);
    expect(gate.sentBy()).toEqual({ person_tap: 1, legacy_reply: 0, protocol: 0 });
  });
});

describe("crash recovery", () => {
  test("an answer accepted and never settled reads as unknown after a restart, and a repeat returns that receipt", async () => {
    const { poll, store, answerer, pane } = rig(BASH);
    const ask = poll()!;
    store.acceptAsk({ id: ask.id, session: "main", paneId: PANE, paneGeneration: GEN, hash: ask.hash, optionId: "1" });
    const recovered = store.recoverAsks(AskAnswerer.crashReceipt);
    expect(recovered.map((r) => r.receipt?.reason)).toEqual(["crash"]);
    const reply = await answerer.handle({ askId: ask.id, hash: ask.hash, optionId: "1", origin: "person_tap" }, { session: "main", paneId: PANE, harness: HARNESS });
    expect(reply.replayed).toBe(true);
    expect(reply.receipt).toMatchObject({ outcome: "unknown", reason: "crash", keys: [] });
    expect(pane.keysSeen).toEqual([]);
  });
});
