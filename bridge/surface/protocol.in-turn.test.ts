// The Send Protocol against the scripted fake multiplexer: part in-turn. The rig is `protocol.rig.ts`;
// the other parts sit beside this file as `protocol.<topic>.test.ts`.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Profile, type VersionRange } from "../../web/src/lib/surface/profile.ts";
import { parseAnsi } from "../../web/src/lib/ansi.ts";
import { steadyRow } from "./protocol.ts";
import { HoldStore } from "./holds.ts";
import { OFFERED, CODEX_WELCOME, DIALOG, FakePane, LIVE_ROW, PROBE, type Rig, dir, neverEscape, noCommandQueue, rig, useScratchDir } from "./protocol.rig.ts";

useScratchDir();

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
    expect(answer.receipt).toMatchObject({ outcome: "sent" });
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
    expect(answer.receipt).toMatchObject({ outcome: "sent" });
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
    expect(answer.receipt).toMatchObject({ outcome: "sent" });
    expect(answer.receipt?.keys.at(-1)).toBe("Tab");
    expect(pane.keysSeen).not.toContain("Enter");
  });

  test("Submit of a draft while the answer streams with no working row presses Tab, never Enter (K1)", async () => {
    const { pane, send } = codex();
    pane.box = "half a thought";
    streams(pane);
    const answer = await send("half a thought", { mode: "submit" });
    expect(answer.receipt).toMatchObject({ outcome: "sent" });
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
    const added = await send(" and the rest", { mode: "append", rowsHash: OFFERED });
    expect(added.receipt).toMatchObject({ outcome: "sent", queued: true });
    expect(added.receipt?.keys.at(-1)).toBe("Tab");
    expect(pane.queued).toEqual(["half a thought and the rest"]);
    expect(pane.keysSeen).not.toContain("Enter");
  });

  test("Replace on a draft in a running Codex box goes in queued with Tab", async () => {
    const { pane, send } = codex();
    pane.over = [CODEX_RUNNING];
    pane.box = "half a thought";
    const replaced = await send("a new thought", { mode: "replace", rowsHash: OFFERED });
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

describe("muse: Tab queues in a turn, Enter steers it (MUSE-06/07, #519)", () => {
  // Lab, Muse Code 1.4.10 (1.4.10-R6427.1), 2026-10-18, live pane: Enter during a turn steered it
  // (the text joined the running turn and answered before it); Tab during a turn queued natively —
  // `◆ Queued input · ↑ to edit` over `└ <text>` over the box (muse--queued-input-1410.txt), the turn
  // undisturbed, the text submitted by Muse once the turn ended; Tab on an idle draft did nothing.
  // A slash command during a turn was not measured, so muse.json declares no `commandWhileRunning`:
  // commands stay Collie-held, and the never-held spellings refuse before any queueing (MUSE-08).
  const MUSE_RUNNING = ["◈ Running command · Run sleep 60 — running (19s · esc to interrupt)", "└ (ctrl+b to send to background)"];
  const muse = (options: Parameters<typeof rig>[0] = {}): Rig => {
    const r = rig({ pane: new FakePane("muse"), harness: "muse", version: "1.4.10", ...options });
    r.pane.placeholder = "Start a message with ! to run a shell command yourself";
    return r;
  };

  test("a free Muse box: Enter sends, no queued field, Tab never pressed", async () => {
    const { pane, send } = muse();
    const answer = await send("please list the files in this folder");
    expect(answer.receipt).toMatchObject({ outcome: "sent", profileId: "muse", keys: ["probe", "Backspace", "Enter"] });
    expect(answer.receipt && "queued" in answer.receipt).toBe(false);
    expect(pane.transcript.at(-1)).toBe("> please list the files in this folder");
    expect(pane.keysSeen).not.toContain("Tab");
    neverEscape(pane);
  });

  test("a multiline Muse draft is the box's own wrapped text, not a dialog: Enter sends (live 2026-10-21)", async () => {
    const { pane, send } = muse();
    const answer = await send("first line of a long draft\nsecond line continues here\nthird line continues here");
    expect(answer.receipt).toMatchObject({ outcome: "sent", profileId: "muse", keys: ["probe", "Backspace", "ctrl+j", "ctrl+j", "Enter"] });
    expect(pane.transcript.at(-1)).toBe("> first line of a long draft second line continues here third line continues here");
    expect(pane.keysSeen).not.toContain("Tab");
    neverEscape(pane);
  });

  test("a running turn: probed, Tab only, and the queued rows Muse draws make the receipt say queued (MUSE-07)", async () => {
    const holds = new HoldStore(join(dir, "held"));
    const { pane, send } = muse({ holds });
    pane.over = [...MUSE_RUNNING];
    const answer = await send("then add a short summary");
    expect(answer.receipt).toMatchObject({ outcome: "sent", queued: true, keys: ["probe", "Backspace", "Tab"] });
    expect(pane.keysSeen).not.toContain("Enter");
    expect(pane.queued).toEqual(["then add a short summary"]);
    expect(pane.box).toBe("");
    // The harness's own queue holds it: Collie holds nothing.
    expect(holds.list()).toEqual([]);
    expect(pane.render().split("\n")).toEqual(expect.arrayContaining(["◆ Queued input · ↑ to edit", "└ then add a short summary"]));
    neverEscape(pane);
  });

  test("a second send into the same Muse turn queues too, under the standing queued rows", async () => {
    const { pane, send } = muse();
    pane.over = [...MUSE_RUNNING];
    expect((await send("first follow-up")).receipt).toMatchObject({ outcome: "sent", queued: true });
    expect((await send("second follow-up")).receipt).toMatchObject({ outcome: "sent", queued: true });
    expect(pane.keysSeen.filter((key) => key === "Enter")).toEqual([]);
    expect(pane.keysSeen.filter((key) => key === "Tab")).toHaveLength(2);
    expect(pane.queued).toEqual(["first follow-up", "second follow-up"]);
  });

  test("the Muse witness needs the Queued input header, and the row under it must carry the sent text", async () => {
    const noHeader = muse();
    noHeader.pane.over = [...MUSE_RUNNING];
    noHeader.pane.afterInput = (p, what) => {
      if (what === "keys:Tab") {
        p.queued = [];
        p.over = [...MUSE_RUNNING, "└ then add a short summary"];
      }
    };
    expect((await noHeader.send("then add a short summary")).receipt?.queued).toBeUndefined();
    const other = muse();
    other.pane.over = [...MUSE_RUNNING];
    other.pane.afterInput = (p, what) => {
      if (what === "keys:Tab") p.queued = ["another message"];
    };
    expect((await other.send("then add a short summary")).receipt?.queued).toBeUndefined();
  });

  test("a command in a Muse turn is Collie-held, not queued by Muse: Tab never pressed (commands unmeasured)", async () => {
    const holds = new HoldStore(join(dir, "held"));
    const { pane, send } = muse({ holds });
    pane.over = [...MUSE_RUNNING];
    const answer = await send("/compact", { mode: "command" });
    expect(answer.receipt).toMatchObject({ outcome: "held", keys: [] });
    expect(holds.list().map((entry) => entry.text)).toEqual(["/compact"]);
    expect(pane.queued).toEqual([]);
    expect(pane.calls).toEqual([]);
    expect(pane.keysSeen).toEqual([]);
  });

  test("a never-held Muse command in a turn refuses before any queueing, and ordinary text still queues (MUSE-08)", async () => {
    const holds = new HoldStore(join(dir, "held"));
    const { pane, send } = muse({ holds });
    pane.over = [...MUSE_RUNNING];
    for (const text of ["/clear", "!git status"]) {
      const answer = await send(text, { mode: "command" });
      expect(answer.receipt, text).toMatchObject({ outcome: "refused", reason: "turn_running", keys: [] });
      expect(answer.detail, text).toBe("Collie does not queue this command during a turn. Send it when the turn ends.");
    }
    expect(holds.list()).toEqual([]);
    expect(pane.calls).toEqual([]);
    expect(pane.keysSeen).toEqual([]);
    const answer = await send("then add a short summary");
    expect(answer.receipt).toMatchObject({ outcome: "sent" });
    expect(pane.queued).toEqual(["then add a short summary"]);
    expect(holds.list()).toEqual([]);
  });

  test("Tab queues only in a turn: a turn that ends before Tab leaves the text in the box, and S2 ends it unknown, never sent", async () => {
    // Unlike Codex's Tab, Muse's does not submit at idle (lab, 2026-10-18), so the box keeps the text
    // and the standing S2 rule for a commit key that did not empty it applies; the draft survives.
    const { pane, send } = muse();
    pane.over = [...MUSE_RUNNING];
    pane.afterInput = (p, what) => {
      if (what.startsWith("paste:then")) p.over = [];
    };
    const answer = await send("then add a short summary");
    expect(answer.receipt).toMatchObject({ outcome: "unknown", reason: "dialog_after_enter", keys: ["probe", "Backspace", "Tab"] });
    expect(answer.detail).toBe("The submit key did not reach the box. A dialog may have taken it. Check the transcript.");
    expect(answer.receipt?.queued).toBeUndefined();
    expect(pane.box).toBe("then add a short summary");
    expect(pane.queued).toEqual([]);
    expect(pane.keysSeen).not.toContain("Enter");
  });

  test("a Muse screen with no box and a running row: the two-tap send presses Tab, never Enter; with no box there is no witness, so no queued label", async () => {
    const frameless = (profile: Profile): Profile => ({ ...profile, idle: { ...profile.idle, frame: { ...profile.idle.frame, top: { ...profile.idle.frame.top, pattern: "(?!)" } } } });
    const { pane, send } = muse({ edit: frameless });
    pane.over = [...MUSE_RUNNING];
    const first = await send("then add a short summary");
    expect(first.receipt?.keys).toEqual([]);
    expect(first.rowsHash).toEqual(expect.any(String));
    const manual = await send("then add a short summary", { rowsHash: first.rowsHash! });
    expect(manual.receipt).toMatchObject({ outcome: "sent" });
    expect(manual.receipt?.keys.at(-1)).toBe("Tab");
    expect(manual.receipt?.queued).toBeUndefined();
    expect(pane.keysSeen).not.toContain("Enter");
    expect(pane.queued).toEqual(["then add a short summary"]);
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
    const added = await send(" and the rest", { mode: "append", rowsHash: OFFERED });
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
    expect((await send(" and more", { mode: "append", rowsHash: OFFERED })).receipt).toMatchObject({ outcome: "refused", reason: "turn_running", keys: [] });
    expect((await send("/compact", { mode: "submit" })).receipt).toMatchObject({ outcome: "refused", reason: "turn_running", keys: [] });
    expect(pane.calls).toEqual([]);
    expect(pane.keysSeen).toEqual([]);
    expect((await send("hello instead", { mode: "replace", rowsHash: OFFERED })).receipt).toMatchObject({ outcome: "sent", queued: true });
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
    expect(answer.receipt).toMatchObject({ outcome: "sent" });
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
    expect(answer.receipt).toMatchObject({ outcome: "sent" });
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
    expect((await append.send(" and more", { mode: "append", rowsHash: OFFERED })).receipt).toMatchObject({ outcome: "sent", queued: true, profileStatus: "verified" });
    expect(append.pane.keysSeen.slice(0, 1)).toEqual(["Backspace"]);
    expect(append.pane.calls[0]).toBe(`type:${PROBE}`);
    const replace = rig();
    replace.pane.over = [LIVE_ROW];
    replace.pane.box = "a draft";
    const answer = await replace.send("something else", { mode: "replace", rowsHash: OFFERED });
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
    expect(answer.receipt).toMatchObject({ outcome: "sent" });
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
    expect(answer.receipt).toMatchObject({ outcome: "sent" });
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
