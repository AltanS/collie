// The Send Protocol against the scripted fake multiplexer: part harness-cases. The rig is `protocol.rig.ts`;
// the other parts sit beside this file as `protocol.<topic>.test.ts`.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { forPlatform, loadProfiles, profileFor, type Profile } from "../../web/src/lib/surface/profile.ts";
import { type SendAnswer } from "../../web/src/lib/surface/send.ts";
import { parseAnsi } from "../../web/src/lib/ansi.ts";
import { splitLines } from "../../web/src/lib/blocks.ts";
import { findInputFrame } from "../../web/src/lib/surface/frame.ts";
import { surfaceOfScreen } from "../../web/src/lib/surface/fold.ts";
import { isFree, type Surface } from "../../web/src/lib/surface/surface.ts";
import { boxMatches, boxMatchesTail, neverHeldEntry, runsInTurnEntry, SendProtocol, STALE_SCREEN, steadyRow, type SendRequest } from "./protocol.ts";
import { HoldStore } from "./holds.ts";
import { OFFERED, ClaudeComposerOmpPane, FakePane, FieldOmpPane, OmpPane, PROBE, PiPane, type Rig, StaleOmpPane, TallOmpPane, dir, fixture, neverEscape, nextId, omp, rig, still, surfaceFixture, useScratchDir, withoutScroll, words } from "./protocol.rig.ts";

useScratchDir();

describe("a draft is a reading until the probe proves it: the stale screen (2026-10-25)", () => {
  const staleRig = (): Rig & { pane: StaleOmpPane; frames: string[] } => {
    const pane = new StaleOmpPane();
    const made = omp({ pane });
    const frames: string[] = [];
    const protocol = new SendProtocol({ ...made.deps, staleFrame: (paneId, frame) => void frames.push(`${paneId}:${frame}`) });
    const where = { session: "main", paneId: "%1", harness: "omp" };
    const send = async (text: string, over: Partial<SendRequest> = {}): Promise<SendAnswer> => {
      if (over.rowsHash === OFFERED) over = { ...over, rowsHash: (await protocol.handle({ id: nextId(), text: "", mode: "prepare" }, where)).rowsHash };
      return protocol.handle({ id: nextId(), text, mode: "send", ...over }, where);
    };
    return { ...made, protocol, send, pane, frames };
  };

  test("the stale screen reads a draft today: idle, no dialog, and the old text in the bottom frame", async () => {
    const { protocol } = staleRig();
    const prepared = await protocol.handle({ id: "stale-prep-1", text: "", mode: "prepare" }, { session: "main", paneId: "%1", harness: "omp" });
    expect(prepared.surface).toMatchObject({ turn: "idle", modal: "none", composer: "draft" });
  });

  test("(a) a stale box that stays: refused probe_failed with the stale-screen sentence, the key pad the only offer, nothing deleted", async () => {
    const { pane, send, frames } = staleRig();
    pane.box = "words I typed at the desk";
    const answer = await send("hello there");
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "probe_failed", keys: ["probe", "Backspace"] });
    expect(answer.receipt?.detail).toBe(STALE_SCREEN);
    expect(answer.receipt?.gapsMs.proof).toBeGreaterThan(0);
    expect(answer.offers).toEqual(["keys"]);
    expect(answer.cause).toBe("stale_screen");
    // The one Backspace took only the probe out of the live editor; no clear key, no second probe.
    expect(pane.calls).toEqual(["type:⌁"]);
    expect(pane.keysSeen).toEqual(["Backspace"]);
    expect(pane.box).toBe("words I typed at the desk");
    expect(pane.stale).toBe("and what about the design");
    expect(pane.transcript.some((row) => row.includes("hello there"))).toBe(false);
    // The bridge's Surface is told which rows were proven stale.
    expect(frames).toHaveLength(1);
  });

  test("(b) a screen that drew again by itself before the second S0 read: the send goes on from it and lands once", async () => {
    const { pane, send, frames } = staleRig();
    pane.mendsOnItsOwn = true;
    const answer = await send("hello there");
    expect(answer.receipt).toMatchObject({ outcome: "sent" });
    expect(answer.receipt?.keys.slice(0, 2)).toEqual(["probe", "Backspace"]);
    expect(pane.transcript.filter((row) => row === " > hello there")).toHaveLength(1);
    expect(pane.box).toBe("");
    expect(frames).toEqual([]);
  });

  test("(c) a real draft is refused as before: the probe and one Backspace are the only extra keys", async () => {
    const pane = new StaleOmpPane();
    pane.stale = null;
    pane.box = "half a thought";
    const { send } = omp({ pane });
    const answer = await send("hello there");
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "draft_present", keys: ["probe", "Backspace"] });
    expect(answer.offers).toEqual(["append", "replace", "cancel"]);
    expect(pane.calls).toEqual(["type:⌁"]);
    expect(pane.keysSeen).toEqual(["Backspace"]);
    expect(pane.box).toBe("half a thought");
  });

  test("(d) Replace and Discard on a stale frame press no clear key: the only Backspace takes the probe back", async () => {
    for (const mode of ["replace", "discard"] as const) {
      const { pane, send } = staleRig();
      pane.box = "my real words";
      const answer = await send(mode === "discard" ? "and what about the design" : "new words", mode === "discard" ? { mode } : { mode, rowsHash: OFFERED });
      expect(answer.receipt, mode).toMatchObject({ outcome: "refused", reason: "probe_failed" });
      expect(answer.offers, mode).toEqual(["keys"]);
      expect(pane.keysSeen, mode).toEqual(["Backspace"]);
      expect(pane.box, mode).toBe("my real words");
      expect(pane.stale, mode).toBe("and what about the design");
    }
  });

  test("(d) Replace on a stale frame that drew again by itself empties the live draft, not the old one, and sends once", async () => {
    const { pane, send } = staleRig();
    pane.mendsOnItsOwn = true;
    pane.box = "my real words";
    const answer = await send("new words", { mode: "replace", rowsHash: OFFERED });
    expect(answer.receipt).toMatchObject({ outcome: "sent" });
    expect(pane.transcript.filter((row) => row === " > new words")).toHaveLength(1);
    // Three Backspaces take a probe back (the one that stood in the live editor, the second proof's, the
    // send's own); the clear's cover the live draft and its slack, sized by what the drawn box showed.
    const presses = pane.keysSeen.filter((key) => key === "Backspace").length;
    expect(presses).toBe(3 + "my real words".length + 16);
    expect(pane.box).toBe("");
  });

  test("the real capture: the probe shows nowhere a read finds and the screen stays still, so nothing is deleted", async () => {
    const pane = still(fixture("omp--v18-6-1-stale-frame-below-live--w120.txt"));
    const { send } = rig({ pane, harness: "omp", version: "18.6.1" });
    const answer = await send("Reply with only the word: yes", { id: "stale-real-1", mode: "replace", rowsHash: OFFERED });
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "probe_failed", keys: ["probe"] });
    expect(answer.receipt?.detail).toStartWith(STALE_SCREEN);
    expect(answer.receipt?.detail).toContain("⌁");
    expect(answer.offers).toEqual(["keys"]);
    expect(pane.keysSeen).toEqual([]);
  });
});

describe("OMP: a send under the status rows the profile did not read before (omp gang 11-geometry, 2026-10-25)", () => {
  // The full preset at 80 columns keeps ─5%─┃200K─ of its gauge, and the ascii preset starts on [high] and draws
  // its rule with dashes. Both read as no box (unknown), and a plain send was refused `unconfirmed`.
  const ROWS = [
    ["the full preset at 80 columns", " π / 🖥 example / ◒ Haiku 4.5 / 📁 …eometry/state2/harness/omp/project ─5%─┃200K─"],
    ["the ascii preset", " [high] Haiku 4.5 > [D] …/state2/harness/omp/project ---5%--------------------|--------200K-"],
    ["the ascii preset at 80 columns", " [high] Haiku 4.5 > [D] …g/11-geometry/state/harness/omp/project -4%------|200K-"],
  ] as const;

  for (const version of ["18.6.1", "18.12.6"]) {
    for (const [label, row] of ROWS) {
      test(`${version}, ${label}: a plain send goes out in one tap`, async () => {
        const { pane, send } = omp({ version });
        pane.statusRow = row;
        const answer = await send("Reply with only the word: yes");
        expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["probe", "Backspace", "ctrl+q"] });
        expect(pane.transcript).toContain(" > Reply with only the word: yes");
        expect(pane.box).toBe("");
      });
    }
  }
});

describe("OMP 18.12.6: composer.shape field (omp gang 11-geometry, W5)", () => {
  test("a plain send under the borderless ▐ box goes out in one tap", async () => {
    const { pane, send } = omp({ version: "18.12.6", pane: new FieldOmpPane() });
    const prepared = await send("", { mode: "prepare" });
    expect(prepared.surface).toMatchObject({ turn: "idle", modal: "none", composer: "empty" });
    const answer = await send("Reply with only the word: yes");
    expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["probe", "Backspace", "ctrl+q"] });
    expect(pane.transcript).toContain(" > Reply with only the word: yes");
    expect(pane.box).toBe("");
  });

  test("a two-line draft in that box is read as a draft", async () => {
    const { pane, send } = omp({ version: "18.12.6", pane: new FieldOmpPane() });
    pane.box = "first line\nsecond line";
    const prepared = await send("", { mode: "prepare" });
    expect(prepared.surface).toMatchObject({ turn: "idle", modal: "none", composer: "draft" });
  });
});

describe("OMP 18.12.6: a two-line draft under composer.shape claude (omp-gang 04-readers, G)", () => {
  test("the send is refused true and the detail says what was read: the box shape, not something that opened", async () => {
    const { pane, send, deps } = omp({ version: "18.12.6", pane: new ClaudeComposerOmpPane() });
    const answer = await send("first line\nsecond line", { id: "claude-shape-two-lines" });
    expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "modal_cue" });
    const detail = deps.store.get("claude-shape-two-lines")?.receipt?.detail ?? "";
    expect(detail).toContain("The box shape could not be read");
    expect(detail).toContain("known gap");
    expect(detail).not.toContain("Something is open");
    expect(pane.keysSeen).not.toContain("ctrl+q");
    expect(pane.keysSeen).not.toContain("Enter");
  });
});

describe("OMP: commands that end the process are never held (omp gang 03)", () => {
  const NEVER = "Collie does not queue this command during a turn. Send it when the turn ends.";

  test("/exit, /quit, /q and /restart in a turn are refused turn_running, never held, never typed after the turn ends (18.6.1 held /exit, then omp quit)", async () => {
    const holds = new HoldStore(join(dir, "held"));
    for (const version of ["18.6.1", "18.12.6"]) {
      const { pane, send, ...made } = omp({ version, holds });
      pane.inTurn = true;
      for (const text of ["/exit", "/quit", "/q", "/restart", "/exit now"]) {
        const answer = await send(text, { mode: "command" });
        expect(answer.receipt, `${version} ${text}`).toMatchObject({ outcome: "refused", reason: "turn_running", keys: [] });
        expect(answer.detail, `${version} ${text}`).toBe(NEVER);
      }
      expect(holds.list(), version).toEqual([]);
      expect(pane.keysSeen, version).toEqual([]);
      expect(pane.queued, version).toEqual([]);
      void made;
    }
  });

  test("the list is data in omp.json, per spelling: a longer word is another command, and /compact is not on it", () => {
    expect(loadProfiles().get("omp")?.keys.neverHeld).toEqual(["/exit", "/quit", "/q", "/restart"]);
    const profile = profileFor("omp", "18.12.6", { log: () => undefined });
    expect(neverHeldEntry("/q", profile)).toBe("/q");
    expect(neverHeldEntry("/quote", profile)).toBeNull();
    expect(neverHeldEntry("/quit now", profile)).toBe("/quit");
    expect(neverHeldEntry("/exits", profile)).toBeNull();
    expect(neverHeldEntry("/restarting", profile)).toBeNull();
    expect(neverHeldEntry("/compact", profile)).toBeNull();
    expect(neverHeldEntry("/goal pause", profile)).toBeNull();
  });

  test("another command in an OMP turn keeps its own refusal: only the listed spellings carry the never-held wording", async () => {
    const { pane, send } = omp();
    pane.inTurn = true;
    const exit = await send("/exit", { mode: "command" });
    expect(exit.detail).toBe(NEVER);
    const model = await send("/model", { mode: "command" });
    expect(model.receipt).toMatchObject({ outcome: "refused", reason: "turn_running" });
    expect(model.detail).toBe("A command waits until the turn ends.");
    expect(pane.keysSeen).toEqual([]);
  });
});

describe("a draft taller than OMP's box (omp gang 2026-10-25)", () => {
  test("a 3,000-character send into a box that keeps its last 17 rows matches by those rows and goes once; the receipt says only the end was compared", async () => {
    const pane = new TallOmpPane();
    const { send } = omp({ pane });
    const text = words(3000);
    const answer = await send(text);
    expect(answer.receipt).toMatchObject({ outcome: "sent" });
    expect(answer.receipt?.keys.at(-1)).toBe("ctrl+q");
    expect(answer.receipt?.detail).toBe("The box showed only the last rows of this long text. Collie compared those with the end of the text.");
    expect(pane.transcript.filter((row) => row === ` > ${text}`)).toHaveLength(1);
    expect(pane.box).toBe("");
    expect(pane.steered).toEqual([]);
  });

  test("the same send on a profile whose box does not scroll still mismatches: no Enter, the text stays in the box", async () => {
    const pane = new TallOmpPane();
    const { send } = omp({ pane, edit: withoutScroll });
    const text = words(3000);
    const answer = await send(text);
    expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "mismatch" });
    expect(pane.keysSeen).not.toContain("ctrl+q");
    expect(pane.box).toBe(text);
  });

  test("a box under its scroll height that lost the head of the text mismatches: only a box at the cap is read by its tail", async () => {
    const pane = new TallOmpPane();
    const { send } = omp({ pane });
    const text = words(600);
    pane.afterInput = (p, what) => {
      if (what.startsWith("type:") || what.startsWith("paste:")) p.box = p.box.length > 100 ? p.box.slice(60) : p.box;
    };
    const answer = await send(text);
    expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "mismatch" });
    expect(pane.keysSeen).not.toContain("ctrl+q");
  });

  test("the real 2,000-character box (07 F1) reads as scrolled, and its rows match only the end of the text they show", () => {
    const rows = splitLines(parseAnsi(surfaceFixture("omp--draft-scrolled-2000-chars--v18.6.1.txt")));
    const frame = findInputFrame(rows, loadProfiles().get("omp")!.idle)!;
    expect(frame.scrolled).toBe(true);
    const tail = `${Array.from({ length: 402 }, (_, i) => `w${String(i)}`).join(" ")}  END`;
    const text = `Reply with the single word JULIET. MARKER: ${tail}`;
    expect(boxMatches(frame.interior.text, "", [text], null)).toBe(false);
    expect(boxMatchesTail(frame.interior.text, "", [text])).toBe(true);
    expect(boxMatchesTail(frame.interior.text, "", [text.replace("w400", "w4OO")])).toBe(false);
    expect(boxMatchesTail(frame.interior.text, "", [`${text} more`])).toBe(false);
    // A box that holds all of the text is no tail of it.
    expect(boxMatchesTail(frame.interior.text, "", [frame.interior.text])).toBe(false);
  });

  test("Discard of a 5,000-character draft Collie typed empties the box in one request, with no more keys than its length and the slack", async () => {
    const pane = new TallOmpPane();
    const { send } = omp({ pane });
    const text = words(5000);
    pane.box = text;
    const answer = await send(text, { mode: "discard" });
    expect(answer.receipt).toMatchObject({ outcome: "discarded" });
    expect(pane.box).toBe("");
    const presses = pane.keysSeen.filter((key) => key === "Backspace").length;
    expect(presses).toBeGreaterThanOrEqual(text.length);
    expect(presses).toBeLessThanOrEqual(text.length + 16);
    expect(pane.transcript.some((row) => row.includes("w1"))).toBe(false);
  });

  test("Replace on a draft at the box's scroll height that Collie did not type is refused before any key: nothing deleted (06 C5)", async () => {
    const pane = new TallOmpPane(120);
    const draft = Array.from({ length: 26 }, (_, i) => `draft line ${String(i + 1)}: the quick brown fox jumps over the lazy dog ${String(i + 1)}`).join("\n");
    pane.box = draft;
    const { send } = omp({ pane });
    const answer = await send("Reply with only the word: yes", { mode: "replace", rowsHash: OFFERED });
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "draft_present", keys: [] });
    expect(answer.receipt?.detail).toContain("Nothing was deleted");
    expect(answer.offers).toEqual(["keys"]);
    expect(pane.keysSeen).toEqual([]);
    expect(pane.box).toBe(draft);
  });

  test("Replace on the real 26-line screen at the cap (06 C5) is refused with nothing pressed", async () => {
    const pane = still(surfaceFixture("omp--draft-scrolled-26-lines--v18.6.1.txt"));
    const { send } = rig({ pane, harness: "omp", version: "18.6.1" });
    const answer = await send("Reply with only the word: yes", { id: "tall-replace-1", mode: "replace", rowsHash: OFFERED });
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "draft_present", keys: [] });
    expect(pane.keysSeen).toEqual([]);
    expect(pane.calls).toEqual([]);
  });

  test("Replace on a 1,600-character draft that fits the box empties it and sends the new text once (six rounds of 256 left 64 characters before)", async () => {
    const pane = new TallOmpPane(120);
    pane.box = words(1600, "d");
    const { send } = omp({ pane });
    const answer = await send("Reply with the word LIMA only.", { mode: "replace", rowsHash: OFFERED });
    expect(answer.receipt).toMatchObject({ outcome: "sent" });
    expect(answer.receipt?.detail).toBeUndefined();
    expect(pane.transcript.filter((row) => row === " > Reply with the word LIMA only.")).toHaveLength(1);
    expect(pane.transcript.filter((row) => row.includes("d1"))).toEqual([]);
    expect(pane.box).toBe("");
  });

  test("Discard of a draft longer than one request empties is refused before any key", async () => {
    const pane = new TallOmpPane();
    const { send } = omp({ pane });
    const text = words(17_000);
    pane.box = text;
    const answer = await send(text, { mode: "discard" });
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "draft_present", keys: [] });
    expect(answer.receipt?.detail).toContain("longer than Collie empties in one request");
    expect(pane.keysSeen).toEqual([]);
    expect(pane.box).toBe(text);
  });
});

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
    expect(answer.receipt).toMatchObject({ outcome: "sent" });
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
    expect(answer.receipt).toMatchObject({ outcome: "sent" });
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

  test("a text with a line break never runs in turn: /goal pause then more text matches nothing, on the OMP profile", () => {
    const log = { log: () => undefined };
    const match = profileFor("omp", "18.12.2", log);
    expect(runsInTurnEntry("/goal pause", match)).toBe("/goal");
    expect(runsInTurnEntry("/goal pause\nmore text", match)).toBeNull();
    expect(runsInTurnEntry("/goal pause\r\nmore text", match)).toBeNull();
    expect(runsInTurnEntry("/goal\nmore text", match)).toBeNull();
    expect(runsInTurnEntry("/goal pause\n", match)).toBeNull();
  });

  test("/goal pause with a draft already in the box is refused draft_present, nothing typed", async () => {
    const { pane, send } = goalTurn();
    pane.box = "half a thought";
    const answer = await send("/goal pause", { mode: "command" });
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "draft_present", keys: [] });
    expect(pane.ran).toEqual([]);
    expect(pane.keysSeen).toEqual([]);
  });

  test("/goal pause with an OMP approval dialog on screen is refused not_free, nothing typed", async () => {
    const pane = new FakePane("generic");
    pane.fixed = readFileSync(join(import.meta.dir, "../../web/src/fixtures/panes/omp--approval-bash.txt"), "utf8").replace(/\r\n/gu, "\n");
    const { send } = rig({ pane, harness: "omp", version: "18.12.2" });
    const answer = await send("/goal pause", { mode: "command" });
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "not_free", keys: [] });
    expect(pane.calls).toEqual([]);
    expect(pane.keysSeen).toEqual([]);
  });

  test("an OMP 18.12.6 approval panel on screen is a lifted ask: a plain send and a command are refused not_free (not unconfirmed), nothing typed", async () => {
    const screen = readFileSync(join(import.meta.dir, "../../web/src/fixtures/panes/omp--v18-12-6-approval-bash--w120.txt"), "utf8").replace(/\r\n/gu, "\n");
    const pane = new FakePane("generic");
    pane.fixed = screen;
    const { send } = rig({ pane, harness: "omp", version: "18.12.6" });
    const plain = await send("hello while asking");
    // The Surface reads the dialog as an ask, where it read `unreadable` and refused `unconfirmed` before.
    expect(plain.receipt).toMatchObject({ outcome: "refused", reason: "not_free", keys: [], saw: { modal: "ask" } });
    const command = await send("/goal pause", { mode: "command" });
    expect(command.receipt).toMatchObject({ outcome: "refused", reason: "not_free", keys: [] });
    expect(pane.calls).toEqual([]);
    expect(pane.keysSeen).toEqual([]);
  });

  test("the shipped Claude profile has no in-turn command list: /goal pause matches nothing", () => {
    const log = { log: () => undefined };
    expect(runsInTurnEntry("/goal pause", profileFor("claude", "2.1.301", log))).toBeNull();
    expect(loadProfiles().get("claude")!.keys.commandsRunInTurn).toBeUndefined();
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

// The same send, replayed from a real OMP 18.12.2 (captured 2026-10-22, Herdr 0.9.5, 119 columns, a local
// fake model endpoint, no model call). Each screen the Send Protocol reads is a file in
// web/src/fixtures/panes/omp--v18-12-2-goal-*--w119.txt, read off the pane as the bridge reads it
// (`pane.read` visible, format ansi). The pane below answers each read with the capture taken at that
// step of the lab's send: the probe typed, the text typed, Enter pressed. Nothing on a screen is drawn
// by the test.
// Tester 14 (omp 18.12.6, 2026-10-25): `/plan` as a command with plan mode on ended `typed_not_submitted /
// changed` twice. The transcript is shorter than the pane, so blank rows fill the gap over the box. The
// typed command's list took its ten rows from those blank rows, the transcript stayed where it was, and
// the volatile band over the box (six rows counted up from its edge, blank or not) reached three lines
// higher, into the transcript. The compare of the rows above read that as a changed screen. The captures
// are the lab's three reads of one send, cut to their last 40 rows.
describe("OMP 18.12.6 `/plan` with plan mode on, replayed from the real capture (omp gang tester 14, 2026-10-25)", () => {
  // Kept beside this test, not in web/src/fixtures/panes: the web corpus sweeps read every `omp--` file there
  // as a conversation screen, and these three end in a list under the box.
  const FIXTURES = join(import.meta.dir, "fixtures");
  const capture = (name: string): string => readFileSync(join(FIXTURES, `omp--v18-12-6-plan-on-${name}--w120.txt`), "utf8");
  /** An OMP pane whose every read is one of the captures: the empty box, the probe in it, `/plan` typed, or the read after Enter. */
  const replay = (typed: string): FakePane => {
    const empty = capture("empty");
    const probe = empty.replace(/^╰─.*$/mu, `╰─ ${PROBE}`);
    const pane = new FakePane("generic");
    let entered = false;
    pane.afterInput = (_p, what) => {
      if (what === "keys:Enter") entered = true;
    };
    pane.beforeRead = (p) => {
      if (entered) p.fixed = capture("slash-plan-sent");
      else if (p.box === "") p.fixed = empty;
      else if (p.box === PROBE) p.fixed = probe;
      else if (p.box === "/plan") p.fixed = typed;
      else throw new Error(`the lab never saw the box hold ${JSON.stringify(p.box)}`);
    };
    return pane;
  };

  test("the captures are the lab's: plan mode on, the list under the box pointing at /plan, ten rows from the blank gap", () => {
    const empty = capture("empty").split("\n");
    const typed = capture("slash-plan").split("\n");
    expect(empty.some((row) => row.includes("🗺 Plan >"))).toBe(true);
    expect(typed.some((row) => row.startsWith("╰─ /plan"))).toBe(true);
    expect(typed.some((row) => row.startsWith("❯ 🗺  plan"))).toBe(true);
    expect(typed.length).toBe(empty.length);
  });

  test("/plan goes out once with the command keys: probed, typed, one Enter, sent", async () => {
    const pane = replay(capture("slash-plan"));
    const answer = await rig({ pane, harness: "omp", version: "18.12.6" }).send("/plan", { mode: "command" });
    expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["probe", "Backspace", "Enter"] });
    expect(pane.keysSeen.filter((key) => key === "Enter")).toHaveLength(1);
  });

  test("a row that is NEW above the box still stops it: a dialog line in the transcript is a changed screen, nothing is pressed", async () => {
    const typed = capture("slash-plan").replace("Plan mode requires a task to plan.", "Allow this tool call? (y/n)");
    expect(typed).not.toBe(capture("slash-plan"));
    const pane = replay(typed);
    const answer = await rig({ pane, harness: "omp", version: "18.12.6" }).send("/plan", { mode: "command" });
    expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "changed" });
    expect(pane.keysSeen).not.toContain("Enter");
  });
});

// M80 spec 04 (lab, 2026-11-01): the canary's `15-rule` message to pi 1.4.0, over tmux at 120 columns and over
// Herdr alike, ended typed_not_submitted (mismatch) with the whole text in the box. The rows of the
// message stood in the box as typed; the frame reader took its last typed rule (20 cells) for the box's
// top edge, so the box read `end`. The captures are the lab's reads of one send through this protocol: the
// empty box, the probe in it, the text typed, and the read after Enter (taken once the reader was fixed).
// Kept beside this test like the OMP captures above. The lab's project path is shortened to `~/project`.
describe("pi 1.4.0, a message with rule rows (`────`), replayed from the real capture (M80 spec 04)", () => {
  const FIXTURES = join(import.meta.dir, "fixtures");
  const capture = (name: string): string => readFileSync(join(FIXTURES, `pi--v140-rule-rows-${name}--w120.txt`), "utf8");
  // eslint-disable-next-line no-control-regex
  const SGR = /\u001b\[[0-9;:]*m/gu;
  const RULE20 = "────────────────────";
  const TEXT = `Reply with only OK.\n${RULE20}\nsome text\n${RULE20}\nend`;
  /** A pi pane whose every read is a capture: the empty box, the probe, the typed text (or `typed`), or the read after alt+Enter. */
  const replay = (typed: string): FakePane => {
    const pane = new FakePane("claude");
    let entered = false;
    pane.afterInput = (_p, what) => {
      if (what.startsWith("keys:") && what.includes("alt+Enter")) entered = true;
    };
    pane.beforeRead = (p) => {
      if (entered) p.fixed = capture("sent");
      else if (p.box === "") p.fixed = capture("empty");
      else if (p.box === PROBE) p.fixed = capture("probe");
      else if (p.box === TEXT) p.fixed = typed;
      else throw new Error(`the lab never saw the box hold ${JSON.stringify(p.box)}`);
    };
    return pane;
  };

  test("rule rows to pi: the capture holds the message's rows in the box, its two rules narrower than the box edges", () => {
    const rows = capture("typed").replace(SGR, "").split("\n");
    const edges = rows.filter((row) => /^─{100,}$/u.test(row.trimEnd()));
    expect(edges).toHaveLength(2);
    expect(rows.filter((row) => row.trimEnd() === RULE20)).toHaveLength(2);
    expect(rows.findIndex((row) => row.startsWith("Reply with only OK."))).toBe(rows.indexOf(edges[0]!) + 1);
  });

  test("rule rows to pi: the typed rules are draft rows, not the box's top edge; sent with one alt+Enter", async () => {
    const pane = replay(capture("typed"));
    const answer = await rig({ pane, harness: "pi", version: "1.4.0" }).send(TEXT);
    expect(answer.receipt).toMatchObject({ outcome: "sent" });
    expect(answer.receipt?.reason).toBeUndefined();
    expect(answer.receipt?.keys.at(-1)).toBe("alt+Enter");
    expect(pane.keysSeen.filter((key) => key === "alt+Enter")).toHaveLength(1);
    neverEscape(pane);
  });

  test("rule rows to pi, a box with a different word: a mismatch, never submitted", async () => {
    const typed = capture("typed").replace("some text", "some test");
    expect(typed).not.toBe(capture("typed"));
    const pane = replay(typed);
    const answer = await rig({ pane, harness: "pi", version: "1.4.0" }).send(TEXT);
    expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "mismatch" });
    expect(pane.keysSeen).not.toContain("alt+Enter");
  });

  test("rule rows to pi, a box with one row missing: a mismatch, never submitted", async () => {
    const rows = capture("typed").split("\n");
    const at = rows.findIndex((row) => row.replace(SGR, "").startsWith("some text"));
    expect(at).toBeGreaterThan(0);
    const pane = replay(["", ...rows.slice(0, at), ...rows.slice(at + 1)].join("\n"));
    const answer = await rig({ pane, harness: "pi", version: "1.4.0" }).send(TEXT);
    expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "mismatch" });
    expect(pane.keysSeen).not.toContain("alt+Enter");
  });
});

// M80 spec 06 (lab, 2026-11-01): a two-paragraph message to Claude Code 2.1.316 while its turn runs, over
// tmux at 100 columns. The turn was held by a local stand-in for the model API, so no model turn ran. tmux
// keeps focus-events off by default, and Claude then draws a notice row under its footer while the turn runs.
// Once the box holds the two paragraphs, Claude swaps its footer for "ctrl+g to edit in nano" and drops that
// notice: the rows under the box went from 2 to 1 and the send ended typed_not_submitted (changed). The box
// itself always held the text: its continuation rows are indented two cells and the paragraphs are parted
// by a blank row, and the compare reads past white space. The same send with focus-events on, into an idle
// box, and over Herdr was sent. The captures are the lab's reads of one send through this protocol, taken
// once the profile named the notice as a hint row. The lab's project path is shortened to `~/project`.
describe("Claude Code 2.1.316, two paragraphs into a running turn, replayed from the real capture (M80 spec 06)", () => {
  const FIXTURES = join(import.meta.dir, "fixtures");
  const capture = (name: string): string => readFileSync(join(FIXTURES, `claude--v2316-two-paragraphs-${name}--w100.txt`), "utf8");
  // eslint-disable-next-line no-control-regex
  const SGR = /\u001b\[[0-9;:]*m/gu;
  const TEXT =
    "also the mobile layout looks off when the sheet opens over the keyboard, the header slides under the status bar and the close button is out of reach\n\nmenu should be one tap from the composer, not two";
  const replay = (typed: string): FakePane => {
    const pane = new FakePane("claude");
    // The lab's Claude drew the 196 characters as typed: the fake folds no paste.
    pane.collapseOver = 100_000;
    let entered = false;
    pane.afterInput = (_p, what) => {
      if (what === "keys:Enter") entered = true;
    };
    pane.beforeRead = (p) => {
      if (entered) p.fixed = capture("queued");
      else if (p.box === "") p.fixed = capture("running");
      else if (p.box === PROBE) p.fixed = capture("probe");
      else if (p.box === TEXT) p.fixed = typed;
      else throw new Error(`the lab never saw the box hold ${JSON.stringify(p.box)}`);
    };
    return pane;
  };
  const plainRows = (name: string): string[] => capture(name).replace(SGR, "").split("\n");

  test("two paragraphs to claude: the captures show the indented rows, the blank row between, and the notice gone with the draft", () => {
    const typed = plainRows("typed");
    const first = typed.findIndex((row) => row.startsWith("❯ also the mobile layout"));
    expect(typed[first + 1]).toMatch(/^ {2}\S/u);
    expect(typed[first + 2]!.trim()).toBe("");
    expect(typed[first + 3]).toMatch(/^ {2}menu should be one tap/u);
    expect(plainRows("running").some((row) => row.includes("tmux focus-events off"))).toBe(true);
    expect(typed.some((row) => row.includes("tmux focus-events off"))).toBe(false);
    expect(typed.some((row) => row.includes("ctrl+g to edit in nano"))).toBe(true);
  });

  test("two paragraphs to claude mid-turn: the box holds the text, the notice under the footer is a hint row; queued with one Enter", async () => {
    const pane = replay(capture("typed"));
    const answer = await rig({ pane, version: "2.1.316" }).send(TEXT);
    expect(answer.receipt).toMatchObject({ outcome: "sent" });
    expect(answer.receipt?.reason).toBeUndefined();
    expect(pane.keysSeen.filter((key) => key === "Enter")).toHaveLength(1);
    neverEscape(pane);
  });

  test("two paragraphs to claude mid-turn, a box with a different word: a mismatch, never submitted", async () => {
    const typed = capture("typed").replace("menu should be", "menu could be");
    expect(typed).not.toBe(capture("typed"));
    const pane = replay(typed);
    const answer = await rig({ pane, version: "2.1.316" }).send(TEXT);
    expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "mismatch" });
    expect(pane.keysSeen).not.toContain("Enter");
  });

  test("two paragraphs to claude mid-turn, a box with one row missing: a mismatch, never submitted", async () => {
    const rows = capture("typed").split("\n");
    const at = rows.findIndex((row) => row.replace(SGR, "").startsWith("  the status bar and the close button"));
    expect(at).toBeGreaterThan(0);
    const pane = replay(["", ...rows.slice(0, at), ...rows.slice(at + 1)].join("\n"));
    const answer = await rig({ pane, version: "2.1.316" }).send(TEXT);
    expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "mismatch" });
    expect(pane.keysSeen).not.toContain("Enter");
  });

  test("two paragraphs to claude mid-turn, a row NEW under the footer: still the screen changed, never submitted", async () => {
    const rows = capture("typed").split("\n");
    const footer = plainRows("typed").findIndex((row) => row.includes("ctrl+g to edit in nano"));
    expect(footer).toBeGreaterThan(0);
    expect(rows[footer + 1]).toBe("");
    rows[footer + 1] = "  Background task finished";
    const pane = replay(rows.join("\n"));
    const answer = await rig({ pane, version: "2.1.316" }).send(TEXT);
    expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "changed" });
    expect(pane.keysSeen).not.toContain("Enter");
  });
});

describe("OMP 18.12.2 `/goal` in a goal turn, replayed from the real capture (lab 2026-10-22)", () => {
  const PANES = join(import.meta.dir, "../../web/src/fixtures/panes");
  /** A capture's text, line breaks as the bridge's read takes them. */
  const capture = (name: string): string => readFileSync(join(PANES, `omp--v18-12-2-goal-${name}--w119.txt`), "utf8").replace(/\r\n/gu, "\n");
  const OMP = loadProfiles().get("omp")!;
  const surfaceOf = (name: string): Surface =>
    surfaceOfScreen({ seq: 0, source: "screen", at: 0, revision: 1, rows: splitLines(parseAnsi(capture(name))), ask: null }, OMP.idle).surface;

  /** The captures of one send in the lab: what the screen read before, with the probe, with the text typed, and after Enter. */
  interface Stages {
    before: string;
    probe: string;
    typed: string;
    /** The reads after Enter, in the order the lab took them; the last one stands for every later read. */
    after: string[];
  }
  const PAUSE: Stages = { before: "turn-running", probe: "turn-running-probe", typed: "pause-typed", after: ["pause-result", "pause-result-later"] };
  const RESUME: Stages = { before: "resume-before", probe: "resume-probe", typed: "resume-typed", after: ["resume-result"] };
  const BARE: Stages = { before: "bare-before", probe: "bare-probe", typed: "bare-typed", after: ["bare-menu"] };

  /** An OMP pane whose every read is one of the captures: the empty box, the probe in the box, the text in the box, or a read after Enter. */
  const replay = (stages: Stages, text: string): FakePane => {
    const pane = new FakePane("generic");
    let entered = false;
    let after = 0;
    pane.afterInput = (_p, what) => {
      if (what === "keys:Enter") entered = true;
    };
    pane.beforeRead = (p) => {
      if (entered) {
        p.fixed = capture(stages.after[Math.min(after++, stages.after.length - 1)]!);
      } else if (p.box === "") p.fixed = capture(stages.before);
      else if (p.box === PROBE) p.fixed = capture(stages.probe);
      else if (p.box === text) p.fixed = capture(stages.typed);
      else throw new Error(`the lab never saw the box hold ${JSON.stringify(p.box)}`);
    };
    return pane;
  };
  const sendOn = async (stages: Stages, text: string, options: { holds?: HoldStore; edit?: (profile: Profile) => Profile } = {}): Promise<{ answer: SendAnswer; pane: FakePane }> => {
    const pane = replay(stages, text);
    const made = rig({ pane, harness: "omp", version: "18.12.2", ...options });
    return { answer: await made.send(text, { mode: "command" }), pane };
  };

  test("the captured screens carry OMP's own words, version and width", () => {
    // eslint-disable-next-line no-control-regex
    const plain = (name: string): string => capture(name).replace(/\u001b\[[0-9;:]*m/gu, "");
    expect(plain("turn-running")).toContain("v18.12.2");
    expect(plain("turn-running")).toContain("⎋ Working…");
    expect(plain("turn-running")).toContain("🎯 Goal");
    expect(plain("pause-result")).toContain("Goal mode paused.");
    expect(plain("pause-result")).toContain("⏸ Goal");
    expect(plain("pause-result")).toContain("⎋ Working…");
    expect(plain("resume-before")).toContain("⏸ Goal");
    expect(plain("resume-result")).toContain("Goal mode resumed.");
    expect(plain("resume-result")).toContain("🎯 Goal");
    for (const entry of ["Show details", "Adjust budget…", "Pause", "Drop", "↑/↓ navigate  ⏎ select  ⎋ cancel"]) expect(plain("bare-menu")).toContain(entry);
  });

  test("the reader sees a running turn and a free box on the screen before /goal pause, and again before /goal resume", () => {
    for (const name of ["turn-running", "resume-before", "bare-before"]) {
      const surface = surfaceOf(name);
      expect([name, surface.turn, surface.modal, surface.composer]).toEqual([name, "running", "none", "empty"]);
      expect(isFree(surface), name).toBe(false);
    }
  });

  test("the screens after /goal pause and /goal resume still read a running turn: the goal turn goes on", () => {
    for (const name of ["pause-result", "pause-result-later", "resume-result"]) {
      const surface = surfaceOf(name);
      expect([name, surface.turn, surface.modal, surface.composer]).toEqual([name, "running", "none", "empty"]);
    }
  });

  test("the screen after a bare /goal is a menu the reader does not call free", () => {
    const surface = surfaceOf("bare-menu");
    expect(surface.modal).not.toBe("none");
    expect(isFree(surface)).toBe(false);
  });

  test("/goal pause is sent in the turn as a command: probe, Backspace, Enter, never the queue key, receipt sent", async () => {
    const holds = new HoldStore(join(dir, "held"), () => 1_000_000);
    const { answer, pane } = await sendOn(PAUSE, "/goal pause", { holds });
    expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["probe", "Backspace", "Enter"], version: "18.12.2", profileStatus: "provisional" });
    expect(answer.receipt?.queued).toBeUndefined();
    expect(pane.calls[0]).toBe(`type:${PROBE}`);
    expect(pane.keysSeen).toEqual(["Backspace", "Enter"]);
    expect(pane.keysSeen).not.toContain("ctrl+q");
    expect(holds.list()).toEqual([]);
    neverEscape(pane);
  });

  // What the first version of this change missed: with `/goal pause` typed OMP draws the argument's list
  // under the box, the pointer on `pause`. Without `commandList.argumentList` that pointer is on another
  // command, and S1 leaves the text typed.
  test("without commandList.argumentList the real screen's list reads as another command and Enter is never pressed", async () => {
    const withoutFlag = (profile: Profile): Profile => {
      const list = profile.idle.volatile.below.commandList!;
      const { argumentList, ...rest } = list;
      void argumentList;
      return { ...profile, idle: { ...profile.idle, volatile: { ...profile.idle.volatile, below: { ...profile.idle.volatile.below, commandList: rest } } } };
    };
    const { answer, pane } = await sendOn(PAUSE, "/goal pause", { edit: withoutFlag });
    expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "modal_cue", keys: ["probe", "Backspace"] });
    expect(pane.keysSeen).toEqual(["Backspace"]);
  });

  test("/goal resume on the paused screen goes the same way", async () => {
    const { answer, pane } = await sendOn(RESUME, "/goal resume");
    expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["probe", "Backspace", "Enter"], version: "18.12.2" });
    expect(answer.receipt?.queued).toBeUndefined();
    expect(pane.keysSeen).toEqual(["Backspace", "Enter"]);
    neverEscape(pane);
  });

  test("a bare /goal goes the same way, and the menu it opens is on the next screen", async () => {
    const { answer, pane } = await sendOn(BARE, "/goal");
    expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["probe", "Backspace", "Enter"], version: "18.12.2" });
    expect(pane.keysSeen).toEqual(["Backspace", "Enter"]);
    neverEscape(pane);
  });

  test("a command the list does not name is held on the same running screen, and nothing is typed", async () => {
    for (const text of ["/model", "/goals", "/compact"]) {
      const holds = new HoldStore(join(dir, `held-${text.slice(1)}`), () => 1_000_000);
      const { answer, pane } = await sendOn(PAUSE, text, { holds });
      expect([text, answer.receipt?.outcome, answer.receipt?.keys]).toEqual([text, "held", []]);
      expect(holds.list().map((entry) => [entry.text, entry.waitsForTurn])).toEqual([[text, true]]);
      expect(pane.calls).toEqual([]);
      expect(pane.keysSeen).toEqual([]);
    }
  });

  test("with no hold queue a command the list does not name is refused turn_running on the same screen, nothing typed", async () => {
    const { answer, pane } = await sendOn(PAUSE, "/model");
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "turn_running", keys: [] });
    expect(pane.calls).toEqual([]);
  });

  test("an unread version keeps /goal pause held on the real screen: the list applies only where the turn is trusted", async () => {
    const holds = new HoldStore(join(dir, "held-unread"), () => 1_000_000);
    const pane = replay(PAUSE, "/goal pause");
    const made = rig({ pane, harness: "omp", version: "no version here", holds });
    const answer = await made.send("/goal pause", { mode: "command" });
    expect([answer.receipt?.outcome, answer.receipt?.keys]).toEqual(["held", []]);
    expect(pane.calls).toEqual([]);
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

  // A failed probe is no proof (#831's review, 2026-11-20): its clean Backspace only says the box is as
  // it was. Add to it and Replace over a draft stay refused, the draft kept, and nothing of the text goes in.
  test("an idle draft whose proof changed more than the box: Add to it and Replace are refused draft_present, the draft kept", async () => {
    for (const mode of ["append", "replace"] as const) {
      const provisional = rig({ version: "2.1.999", edit: (profile) => ({ ...profile, probe: { ...profile.probe, status: "provisional" } }) });
      provisional.pane.box = "half a thought";
      provisional.pane.afterInput = (p, what) => {
        if (what === `type:${PROBE}`) p.status = [];
      };
      const answer = await provisional.send(" and the rest", { mode, rowsHash: OFFERED });
      expect(answer.receipt, mode).toMatchObject({ outcome: "refused", reason: "draft_present", keys: ["probe", "Backspace"] });
      expect(answer.offers, mode).toEqual(["append", "replace", "cancel"]);
      expect(provisional.pane.calls, mode).toEqual([`type:${PROBE}`]);
      expect(provisional.pane.box, mode).toBe("half a thought");
    }
  });

  test("Add to it into a running turn whose probe changed more than the box is refused, nothing typed and no Enter", async () => {
    const provisional = rig({ version: "2.1.999", edit: (profile) => ({ ...profile, probe: { ...profile.probe, status: "provisional" } }) });
    provisional.pane.box = "half a thought";
    provisional.pane.over = ["✻ Thinking… (2s · esc to interrupt)"];
    provisional.pane.afterInput = (p, what) => {
      if (what === `type:${PROBE}`) p.status = [];
    };
    const answer = await provisional.send(" and the rest", { mode: "append", rowsHash: OFFERED });
    expect(answer.receipt).toMatchObject({ outcome: "refused", keys: ["probe", "Backspace"] });
    expect(provisional.pane.calls).toEqual([`type:${PROBE}`]);
    expect(provisional.pane.keysSeen).toEqual(["Backspace"]);
    expect(provisional.pane.box).toBe("half a thought");
  });

  test("the profiles of every harness with no live send in its range are provisional", () => {
    for (const id of ["grok", "agy", "muse", "opencode", "omp"]) expect(loadProfiles().get(id)?.probe.status, id).toBe("provisional");
    expect(loadProfiles().get("pi")?.probe.status).toBe("verified");
  });
});

describe("a frameless manual send in a turn is refused where Enter is not known to queue (M56 spec 14 review)", () => {
  // Grok left this list on 2026-11-16: the harness lab on 1.0.77 measured that its Enter queues in a turn.
  const cases = [
    { harness: "agy", version: "1.1.17", rows: ["⣟  Generating...", "└ Tip: Use /btw to ask a question without breaking context.", "esc to cancel     accept-edits · Gemini 3.7 Flash · low"] },
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

describe("a text that starts with `@` is a message on pi and OMP", () => {
  const AT = "@notes.md what changed in this file?";

  test("pi leaves `@` out of its reserved leads and keeps `/` and `!`", () => {
    expect(loadProfiles().get("pi")?.reservedLeads).toEqual(["/", "!"]);
    expect(loadProfiles().get("omp")?.reservedLeads).toEqual(["/", "!", "->", "=>"]);
  });

  for (const [platform, key] of [["linux", "alt+Enter"], ["win32", "ctrl+q"]] as const) {
    test(`pi on ${platform}: an \`@\` text in a turn queues with ${key}, never Enter`, async () => {
      const pane = new PiPane(key);
      pane.inTurn = true;
      const { send } = rig({ pane, harness: "pi", version: "0.87.1", edit: (profile) => forPlatform(profile, platform) });
      const answer = await send(AT);
      expect(answer.receipt).toMatchObject({ outcome: "sent" });
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
    expect(answer.receipt).toMatchObject({ outcome: "sent" });
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
