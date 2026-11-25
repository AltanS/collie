// The Send Protocol against the scripted fake multiplexer: part corpus. The rig is `protocol.rig.ts`;
// the other parts sit beside this file as `protocol.<topic>.test.ts`.

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Profile } from "../../web/src/lib/surface/profile.ts";
import { type SendAnswer } from "../../web/src/lib/surface/send.ts";
import { parseAnsi } from "../../web/src/lib/ansi.ts";
import { lineText, splitLines } from "../../web/src/lib/blocks.ts";
import { normalizePrompt } from "../../web/src/lib/surface/edges.ts";
import { SendProtocol, type SendDeps } from "./protocol.ts";
import { SurfaceLedger } from "./counters.ts";
import { OFFERED, DIALOG, FRAMELESS, FakePane, LIVE_ROW, NO_PROFILE, PROBE, dir, fixture, nextId, rig, shellText, still, useScratchDir } from "./protocol.rig.ts";

useScratchDir();

describe("real screens from the fixture corpus", () => {

  test("an idle Claude screen reads free at S0 (prepare offers nothing to confirm)", async () => {
    const { protocol } = rig({ pane: still(fixture("claude-lab--idle-fresh--w82.txt")) });
    const prepared = await protocol.handle({ id: "fixture-prep-1", text: "", mode: "prepare" }, { session: "main", paneId: "%1", harness: "claude" });
    expect(prepared.surface).toMatchObject({ turn: "idle", modal: "none", composer: "empty" });
    expect(prepared.offers).toEqual([]);
  });

  // Muse Code 1.4.10 with a message in its own queue (lab, 2026-10-18): the `Queued input` rows over
  // the box are the MUSE-07 witness drawing, and the screen still reads a running turn, never free.
  test("Muse 1.4.10 drawing a queued input reads a running turn over an empty box (muse--queued-input-1410)", async () => {
    const { protocol } = rig({ pane: still(fixture("muse--queued-input-1410.txt")), harness: "muse", version: "1.4.10" });
    const prepared = await protocol.handle({ id: "fixture-muse-queue-1", text: "", mode: "prepare" }, { session: "main", paneId: "%1", harness: "muse" });
    expect(prepared.surface).toMatchObject({ turn: "running", modal: "none", composer: "empty" });
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
    expect(digit.receipt?.detail).toBe("That message would answer the notice above the box. Answer it on its card, or send it once the turn has ended.");
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
    const answer = await send("1", { mode: "replace", rowsHash: OFFERED });
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "unconfirmed", keys: [] });
    expect(answer.cause).toBe("notice_key");
    expect(answer.offers).toEqual(["keys"]);
    expect(answer.detail).toBe("That message would answer the notice above the box. Answer it on its card, or send it once the turn has ended.");
    expect(pane.box).toBe("half a thought");
  });

  // #486's first known limit: Add to it after a draft_present, on a box the person emptied in the
  // meantime, would leave the digit alone in the box, and the notice would take it.
  test("on a heads-up notice over an emptied box: Append of 1 is refused with the notice cause, nothing typed", async () => {
    const { pane, send } = rig();
    pane.over = NOTICE_ROWS;
    pane.afterInput = answersDigit;
    const answer = await send("1", { mode: "append", rowsHash: OFFERED });
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
    const answer = await send(" 1", { mode: "append", rowsHash: OFFERED });
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
    expect(first.receipt?.detail).toBe("That message would answer the notice above the box. Check the pane, then tap Type here.");
    pane.afterInput = answersDigit;
    const commit = await send("1", { rowsHash: first.rowsHash! });
    expect(commit.receipt).toMatchObject({ outcome: "sent" });
    // The digit answered the notice: no Enter followed it, so the agent got no message.
    expect(pane.transcript.at(-1)).not.toBe("> 1");
    expect(pane.keysSeen).toEqual([]);
  });

  // Claude Code 2.1.304's follow-ups to the notice (ADR 0109, addendum 2026-10-20): after Dismiss a
  // `✦ Dismissed.` row with its keys on the head's own row, after Learn more an explanation between the
  // head and its keys. Both stand over a live box, so a sentence and a number go on one tap, and one of
  // the printed digits takes the notice path.
  const DISMISSED = "claude--v2304-heads-up-dismissed--w135.txt";
  const EXPLAINED = "claude--v2304-heads-up-explained--w135.txt";

  /** A fixture's notice as plain rows, from its head row down to the row over the box's top edge. */
  function noticeRowsOf(name: string): string[] {
    const rows = splitLines(parseAnsi(fixture(name))).map((line) => lineText(line).trimEnd());
    const head = rows.findIndex((row) => row.startsWith("✦ "));
    const top = rows.findIndex((row, i) => i > head && /^─{8,}$/u.test(row));
    return rows.slice(head, top);
  }

  for (const name of [DISMISSED, EXPLAINED]) {
    test(`on the follow-up in ${name}: hello and 10 go on one tap`, async () => {
      for (const text of ["hello", "10"]) {
        const { pane, send } = rig();
        pane.over = noticeRowsOf(name);
        const answer = await send(text);
        expect(answer.receipt, text).toMatchObject({ outcome: "sent" });
        expect(answer.cause, text).toBeUndefined();
        expect(pane.transcript.at(-1)).toBe(`> ${text}`);
      }
    });
  }

  for (const [name, digit] of [[DISMISSED, "0"], [EXPLAINED, "1"]] as const) {
    test(`on the follow-up in ${name}: ${digit} is refused with the notice cause`, async () => {
      const captured = rig({ pane: still(fixture(name)) });
      const answer = await captured.send(digit);
      expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "unconfirmed", keys: [] });
      expect(answer.cause).toBe("notice_key");
      expect(answer.offers).toEqual(["commit", "keys"]);
      expect(captured.pane.calls).toEqual([]);
    });
  }

  const AUTH_BOX_FIXTURES = [
    "claude--v2307-auth-refresh-before-output--w61.txt",
    "claude--v2307-auth-refresh-output--w61.txt",
    "claude--v2309-auth-refresh-locked--w120.txt",
    "claude--v2309-auth-refresh-locked--w52.txt",
    "claude--v2309-auth-refresh-locked--w80.txt",
    "claude--v2309-auth-refresh-output--w40.txt",
    "claude--v2309-auth-refresh-output--w52.txt",
    "claude--v2309-auth-refresh-output--w64.txt",
    "claude--v2309-auth-refresh-output--w120.txt",
  ];

  function authBoxRowsOf(name: string): string[] {
    const rows = splitLines(parseAnsi(fixture(name))).map((line) => lineText(line).trimEnd());
    const top = rows.findIndex((row) => row.startsWith("╭"));
    const bottom = rows.findIndex((row, i) => i > top && row.startsWith("╰"));
    return rows.slice(top, bottom + 1);
  }

  for (const name of AUTH_BOX_FIXTURES) {
    test(`over the Authentication box in ${name}: hello and 1 go on one tap`, async () => {
      for (const text of ["hello", "1"]) {
        const { pane, send } = rig();
        pane.over = authBoxRowsOf(name);
        const answer = await send(text);
        expect(answer.receipt, text).toMatchObject({ outcome: "sent" });
        expect(answer.cause, text).toBeUndefined();
        expect(pane.transcript.at(-1)).toBe(`> ${text}`);
      }
    });

    test(`a capture of the Authentication box in ${name} reads free at the first look`, async () => {
      const { protocol } = rig({ pane: still(fixture(name)) });
      const prepared = await protocol.handle({ id: "fixture-auth-box", text: "", mode: "prepare" }, { session: "main", paneId: "%1", harness: "claude" });
      expect(prepared.surface).toMatchObject({ turn: "idle", modal: "none", composer: "empty" });
      expect(prepared.offers).toEqual([]);
    });
  }

  // Seen live on 2026-10-17: Claude Code's usage row in the blank row between the key row and the box
  // for about ten seconds after a turn. The profile names it (`idle.noticeGaps`), so the box stays free.
  // Seen live on 2026-11-03, Claude Code 2.1.317 with `verbose` on: the session's token count in the
  // same place, right-aligned, for as long as the notice stays.
  test("on a heads-up notice with the usage row or the verbose token count under its keys: hello goes on one tap", async () => {
    for (const gap of ["  You've used 87% of your weekly limit · resets Oct 22, 1am (Ameri…", `${" ".repeat(60)}230267 tokens`]) {
      const { pane, send } = rig();
      pane.over = [
        "✦ Heads up · One of the notes says a nightly cleanup task",
        "  deletes everything on your X: drive at 03:00. All your repos",
        "  live on that drive.",
        "  1: Learn more   2: Knew this already   0: Dismiss",
        gap,
      ];
      const answer = await send("hello");
      expect(answer.receipt, gap.trim()).toMatchObject({ outcome: "sent" });
      expect(pane.transcript.at(-1)).toBe("> hello");
    }
  });

  // Lane 8788, 2026-10-19: Claude Code's rating survey stood on the update row right over the box, and
  // every send was refused `unconfirmed` (modal unreadable) until it went. The survey is a notice now
  // (ADR 0109) and the update row a gap the profile names: a sentence goes on one tap, a digit takes the
  // notice path. The field record: ~/.local/state/collie-next/surface/examples/01792385882274-*.json.
  const SURVEY_ROWS = ["● How is Claude doing this session? (optional)", "  1: Bad    2: Fine   3: Good   0: Dismiss"];
  const UPDATE_ROW = `${" ".repeat(40)}✔ Update installed · Restart to update`;
  // 2026-10-31, Claude Code 2.1.314: where it offers the `/restart` command, the row names it, and a
  // send under the survey was refused `unconfirmed` (single-key cue, modal unreadable) again.
  const RESTART_COMMAND_ROW = `${" ".repeat(40)}✔ Update installed · /restart to apply`;
  // 2026-11-02, Claude Code 2.1.316: once the context is past 100k tokens and the session has sat idle
  // for 75 minutes, the idle /clear hint takes the same line, alone when no update is installed and ahead
  // of the update item when one is, and stays there. The survey under it read as a dialog again.
  const IDLE_HINT_ROW = `${" ".repeat(40)}new task? /clear to save 292.5k tokens · ✔ Update installed · /restart to apply`;
  const IDLE_HINT_ALONE_ROW = `${" ".repeat(40)}new task? /clear to save 292.5k tokens`;

  test("on the rating survey over the update row: a sentence goes on one tap, with or without a blank row between", async () => {
    for (const between of [[UPDATE_ROW], ["", UPDATE_ROW], [RESTART_COMMAND_ROW], [IDLE_HINT_ROW], [IDLE_HINT_ALONE_ROW]]) {
      const { pane, send } = rig();
      pane.over = [...SURVEY_ROWS, ...between];
      const answer = await send("ok merge the five, running the crew update now");
      expect(answer.receipt, JSON.stringify(between)).toMatchObject({ outcome: "sent" });
      expect(answer.cause).toBeUndefined();
      expect(pane.transcript.at(-1)).toBe("> ok merge the five, running the crew update now");
    }
  });

  test("on the rating survey over the update row: a digit takes the notice path and answers the survey without Enter", async () => {
    for (const [digit, update] of ["0", "1", "2", "3"].flatMap((d) => [UPDATE_ROW, RESTART_COMMAND_ROW, IDLE_HINT_ROW, IDLE_HINT_ALONE_ROW].map((row) => [d, row] as const))) {
      const { pane, send } = rig();
      pane.over = [...SURVEY_ROWS, update];
      const first = await send(digit);
      expect(first.receipt, `${digit} ${update.trim()}`).toMatchObject({ outcome: "refused", reason: "unconfirmed", keys: [] });
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

  // 2026-11-24, Claude Code 2.1.330 and 2.1.331 on macOS: the bullet is `⏺`, not `●`. Under the idle
  // /clear hint and the update item every send was refused `unconfirmed` (single-key cue, modal
  // unreadable), five times in four days on one pane, walky talky deliveries among them.
  const onMac = (rows: readonly string[]) => rows.map((row) => row.replace(/^●/u, "⏺"));
  const MAC_UPDATE_ROWS = [UPDATE_ROW, RESTART_COMMAND_ROW, IDLE_HINT_ROW, IDLE_HINT_ALONE_ROW];

  test("on macOS's ⏺ rating survey: a sentence goes on one tap", async () => {
    for (const update of MAC_UPDATE_ROWS) {
      const { pane, send } = rig();
      pane.over = [...onMac(SURVEY_ROWS), update];
      const answer = await send("ok merge the five, running the crew update now");
      expect(answer.receipt, update.trim()).toMatchObject({ outcome: "sent" });
      expect(answer.cause).toBeUndefined();
      expect(pane.transcript.at(-1)).toBe("> ok merge the five, running the crew update now");
    }
  });

  test("on macOS's ⏺ rating survey: a digit takes the notice path", async () => {
    for (const [digit, update] of ["0", "1", "2", "3"].flatMap((d) => MAC_UPDATE_ROWS.map((row) => [d, row] as const))) {
      const { pane, send } = rig();
      pane.over = [...onMac(SURVEY_ROWS), update];
      const first = await send(digit);
      expect(first.receipt, `${digit} ${update.trim()}`).toMatchObject({ outcome: "refused", reason: "unconfirmed", keys: [] });
      expect(first.cause).toBe("notice_key");
      expect(first.offers).toEqual(["commit", "keys"]);
    }
  });

  // 2026-11-05, Claude Code 2.1.317 (issue 705): Claude's right-aligned context field, `N% until
  // auto-compact`, sits on the row under the survey's keys. All ten sends on that box were refused
  // `unconfirmed` or `stale_surface` (modal unreadable, the single-key cue on the key row).
  const CONTEXT_ROW = `${" ".repeat(100)}4% until auto-compact`;

  test("on the rating survey over the context row: a sentence goes on one tap, a digit takes the notice path", async () => {
    for (const between of [[CONTEXT_ROW], ["", CONTEXT_ROW], [`${" ".repeat(100)}27% until auto`]]) {
      const { pane, send } = rig();
      pane.over = [...SURVEY_ROWS, ...between];
      const answer = await send("ok merge the five, running the crew update now");
      expect(answer.receipt, JSON.stringify(between)).toMatchObject({ outcome: "sent" });
      expect(answer.cause).toBeUndefined();
      expect(pane.transcript.at(-1)).toBe("> ok merge the five, running the crew update now");
    }
    const { pane, send } = rig();
    pane.over = [...SURVEY_ROWS, CONTEXT_ROW];
    const first = await send("2");
    expect(first.receipt).toMatchObject({ outcome: "refused", reason: "unconfirmed", keys: [] });
    expect(first.cause).toBe("notice_key");
    expect(first.offers).toEqual(["commit", "keys"]);
  });

  for (const name of ["claude--v2317-survey-context-row--w160.txt", "claude--v2317-survey-context-row-plain--w160.txt"]) {
    test(`the capture ${name} reads free with the survey over the context row, and a digit is refused to the notice path`, async () => {
      const captured = rig({ pane: still(fixture(name)) });
      const prepared = await captured.protocol.handle({ id: "fixture-survey-ctx", text: "", mode: "prepare" }, { session: "main", paneId: "%1", harness: "claude" });
      expect(prepared.surface).toMatchObject({ turn: "idle", modal: "none", composer: "empty" });
      const digit = await captured.send("2");
      expect(digit.receipt).toMatchObject({ outcome: "refused", reason: "unconfirmed", keys: [] });
      expect(digit.cause).toBe("notice_key");
      expect(captured.pane.calls).toEqual([]);
    });
  }

  test("the field screen's capture reads free with the survey over the titled box, and a digit is refused to the notice path", async () => {
    const captured = rig({ pane: still(fixture("claude--v2303-titled-edge-survey--w160.txt")) });
    const prepared = await captured.protocol.handle({ id: "fixture-survey-1", text: "", mode: "prepare" }, { session: "main", paneId: "%1", harness: "claude" });
    expect(prepared.surface).toMatchObject({ turn: "idle", modal: "none", composer: "empty" });
    const digit = await captured.send("2");
    expect(digit.receipt).toMatchObject({ outcome: "refused", reason: "unconfirmed", keys: [] });
    expect(digit.cause).toBe("notice_key");
    expect(captured.pane.calls).toEqual([]);
  });

  // 2026-10-21, Claude Code 2.1.306: after a key on the rating survey it asks whether Anthropic may read
  // the transcript, keys `y`, `n`, `d`, read like the survey's digits (the box's whole value, lowercased).
  // Every send was refused `unconfirmed` (modal unreadable) until it was answered by hand.
  const TRANSCRIPT_ROWS = [
    "● Can Anthropic look at your session transcript to help us improve Claude Code?",
    "  Learn more: https://code.claude.com/docs/en/data-usage#session-quality-surveys",
    "  y: Yes    n: No     d: Don't ask again",
  ];

  test("on the transcript question: a sentence goes on one tap", async () => {
    const { pane, send } = rig();
    pane.over = [...TRANSCRIPT_ROWS, ""];
    const answer = await send("done reviewing, ship FIX-2 to the frontend dev");
    expect(answer.receipt).toMatchObject({ outcome: "sent" });
    expect(answer.cause).toBeUndefined();
    expect(pane.transcript.at(-1)).toBe("> done reviewing, ship FIX-2 to the frontend dev");
  });

  test("on macOS's ⏺ transcript question: a sentence goes on one tap, and a printed letter takes the notice path", async () => {
    const sentence = rig();
    sentence.pane.over = [...onMac(TRANSCRIPT_ROWS), ""];
    expect((await sentence.send("done reviewing, ship FIX-2 to the frontend dev")).receipt).toMatchObject({ outcome: "sent" });

    for (const letter of ["y", "n", "d"]) {
      const { pane, send } = rig();
      pane.over = [...onMac(TRANSCRIPT_ROWS), ""];
      const first = await send(letter);
      expect(first.receipt, letter).toMatchObject({ outcome: "refused", reason: "unconfirmed", keys: [] });
      expect(first.cause, letter).toBe("notice_key");
    }
  });

  test("on the transcript question: a printed letter, in either case, takes the notice path", async () => {
    for (const letter of ["y", "n", "d", "Y", "N", "D"]) {
      const { pane, send } = rig();
      pane.over = [...TRANSCRIPT_ROWS, ""];
      const first = await send(letter);
      expect(first.receipt, letter).toMatchObject({ outcome: "refused", reason: "unconfirmed", keys: [] });
      expect(first.cause, letter).toBe("notice_key");
      expect(pane.calls, letter).toEqual([]);
    }
    // A letter the question does not print is an ordinary message.
    const { pane, send } = rig();
    pane.over = [...TRANSCRIPT_ROWS, ""];
    expect((await send("x")).receipt).toMatchObject({ outcome: "sent" });
    expect(pane.transcript.at(-1)).toBe("> x");
  });

  test("on the transcript question: Y in a running turn, Replace and Append is refused to the key pad", async () => {
    const running = rig();
    running.pane.over = ["✻ Thinking… (2s · esc to interrupt)", "", ...TRANSCRIPT_ROWS];
    const turn = await running.send("Y");
    expect(turn.receipt).toMatchObject({ outcome: "refused", reason: "unconfirmed", keys: [] });
    expect(turn.cause).toBe("notice_key");
    expect(running.pane.calls).toEqual([]);

    const replacing = rig();
    replacing.pane.over = TRANSCRIPT_ROWS;
    replacing.pane.box = "half a thought";
    const replace = await replacing.send("Y", { mode: "replace", rowsHash: OFFERED });
    expect(replace.receipt).toMatchObject({ outcome: "refused", reason: "unconfirmed", keys: [] });
    expect(replace.cause).toBe("notice_key");
    expect(replacing.pane.box).toBe("half a thought");

    const appending = rig();
    appending.pane.over = TRANSCRIPT_ROWS;
    const append = await appending.send("Y", { mode: "append", rowsHash: OFFERED });
    expect(append.receipt).toMatchObject({ outcome: "refused", reason: "unconfirmed", keys: [] });
    expect(append.cause).toBe("notice_key");
    expect(appending.pane.calls).toEqual([]);
  });

  test("the transcript question's capture reads free, and a printed letter is refused to the notice path", async () => {
    const captured = rig({ pane: still(fixture("claude--v2306-transcript-survey--w153.txt")) });
    const prepared = await captured.protocol.handle({ id: "fixture-transcript-1", text: "", mode: "prepare" }, { session: "main", paneId: "%1", harness: "claude" });
    expect(prepared.surface).toMatchObject({ turn: "idle", modal: "none", composer: "empty" });
    const letter = await captured.send("n");
    expect(letter.receipt).toMatchObject({ outcome: "refused", reason: "unconfirmed", keys: [] });
    expect(letter.cause).toBe("notice_key");
    expect(captured.pane.calls).toEqual([]);
  });

  // The review of #559: the lines of a send are written one at a time, so a first line that is one of the
  // notice's keys stands alone in the box until the newline key follows it, and the notice may take it
  // (`y` shares the transcript, `d` turns the question off for good). Such a send takes the notice rule
  // too, letters and digits alike; a first line that only starts with a key is an ordinary message.
  test("on the transcript question: a send whose first line is a printed letter takes the notice path", async () => {
    for (const text of ["y\nship it", "Y\nship it", "  n  \nand the rest", "d\n\nlater"]) {
      const { pane, send } = rig();
      pane.over = [...TRANSCRIPT_ROWS, ""];
      const first = await send(text);
      expect(first.receipt, text).toMatchObject({ outcome: "refused", reason: "unconfirmed", keys: [] });
      expect(first.cause, text).toBe("notice_key");
      expect(first.offers, text).toEqual(["commit", "keys"]);
      expect(pane.calls, text).toEqual([]);
    }
  });

  test("on a heads-up notice: a send whose first line is a printed digit takes the notice path", async () => {
    const { pane, send } = rig();
    pane.over = NOTICE_ROWS;
    const first = await send("1\nship it");
    expect(first.receipt).toMatchObject({ outcome: "refused", reason: "unconfirmed", keys: [] });
    expect(first.cause).toBe("notice_key");
    expect(first.offers).toEqual(["commit", "keys"]);
    expect(pane.calls).toEqual([]);

    const running = rig();
    running.pane.over = ["✻ Thinking… (2s · esc to interrupt)", "", ...NOTICE_ROWS];
    const turn = await running.send("0\nship it");
    expect(turn.receipt).toMatchObject({ outcome: "refused", reason: "unconfirmed", keys: [] });
    expect(turn.cause).toBe("notice_key");
    expect(turn.offers).toEqual(["keys"]);
    expect(running.pane.calls).toEqual([]);
  });

  test("on the transcript question: Replace and Append whose first line is a printed letter are refused to the key pad", async () => {
    const replacing = rig();
    replacing.pane.over = TRANSCRIPT_ROWS;
    replacing.pane.box = "half a thought";
    const replace = await replacing.send("y\nship it", { mode: "replace", rowsHash: OFFERED });
    expect(replace.receipt).toMatchObject({ outcome: "refused", reason: "unconfirmed", keys: [] });
    expect(replace.cause).toBe("notice_key");
    expect(replacing.pane.box).toBe("half a thought");

    const appending = rig();
    appending.pane.over = TRANSCRIPT_ROWS;
    const append = await appending.send("n\nship it", { mode: "append", rowsHash: OFFERED });
    expect(append.receipt).toMatchObject({ outcome: "refused", reason: "unconfirmed", keys: [] });
    expect(append.cause).toBe("notice_key");
    expect(appending.pane.calls).toEqual([]);
  });

  test("a first line that only starts with a printed key goes on one tap", async () => {
    for (const text of ["yes\nship it", "y.\nship it", "n o\nship it"]) {
      const { pane, send } = rig();
      pane.over = [...TRANSCRIPT_ROWS, ""];
      const answer = await send(text);
      expect(answer.receipt, text).toMatchObject({ outcome: "sent" });
      expect(answer.cause, text).toBeUndefined();
    }
    const { pane, send } = rig();
    pane.over = NOTICE_ROWS;
    const answer = await send("10\nship it");
    expect(answer.receipt).toMatchObject({ outcome: "sent" });
    expect(answer.cause).toBeUndefined();
    expect(pane.transcript.at(-1)).toBe("> 10 ship it");
  });

  /** The transcript question's hook: a box holding one of its letters alone answers it. */
  function answersLetter(pane: FakePane): void {
    if (pane.over.length > 0 && ["y", "n", "d"].includes(pane.box.trim().toLowerCase())) {
      pane.over = [];
      pane.box = "";
    }
  }

  test("a confirmed send whose first line is a printed letter is typed in full, and no Enter follows when the question took the letter", async () => {
    const { pane, send } = rig();
    pane.over = [...TRANSCRIPT_ROWS, ""];
    const first = await send("y\nship it");
    expect(first.cause).toBe("notice_key");
    pane.afterInput = answersLetter;
    const commit = await send("y\nship it", { rowsHash: first.rowsHash! });
    expect(commit.receipt?.outcome).toBe("typed_not_submitted");
    expect(pane.keysSeen.filter((key) => key === "Enter" || key === "ctrl+enter")).toEqual([]);
    expect(pane.transcript.at(-1)).not.toBe("> y ship it");
  });

  test("a confirmed send whose first line is a printed letter goes in whole when the question leaves the letter", async () => {
    const { pane, send } = rig();
    pane.over = [...TRANSCRIPT_ROWS, ""];
    const first = await send("y\nship it");
    const commit = await send("y\nship it", { rowsHash: first.rowsHash! });
    expect(commit.receipt).toMatchObject({ outcome: "sent" });
    expect(commit.cause).toBeUndefined();
    expect(pane.transcript.at(-1)).toBe("> y ship it");
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
    expect(answer.detail).toBe("The key is still in the box: the notice did not take it. Check the pane.");
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
    const macPanel = rig({ version: "2.1.322" });
    macPanel.pane.over = [LIVE_ROW];
    macPanel.pane.status = ["  ↑/↓ to select                                             ◐ medium · /effort", "", "❯ ⏺ main", "  ◯ first agent   working   3s · ↓ 1k tokens", "  ◯ second agent   working   9s · ↓ 2k tokens"];
    expect((await macPanel.send("carry on")).receipt).toMatchObject({ outcome: "sent" });
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
    const { pane, send } = rig({ mode: "generic", ledger, harness: NO_PROFILE });
    pane.fixed = shellText();
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
    const { pane, send, deps } = rig({ mode: "generic" });
    // A shell's screen: the blind road types into it (an agent's box there is refused, M100 spec 06).
    pane.fixed = shellText();
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

  test("recent lists the pane's settled requests newest first, each with the line Sent would keep, and no rows", async () => {
    const { protocol, send, pane } = rig();
    pane.dialog = DIALOG;
    await send("refused text is listed too");
    pane.dialog = null;
    await send("a text that goes through");
    // A text Sent's rule refuses (a secret word) is listed with no line.
    await send("the api_key goes in here");
    const rows = protocol.recent("%1");
    expect(rows.map((row) => row.outcome)).toEqual(["sent", "sent", "refused"]);
    expect(rows[0]!.line).toBeUndefined();
    expect(rows[1]).toMatchObject({ line: "a text that goes through" });
    expect(rows[2]).toMatchObject({ reason: "not_free", keys: [], line: "refused text is listed too" });
    expect(JSON.stringify(rows)).not.toMatch(/api_key|rows|plainRaw/u);
    expect(protocol.recent("%9")).toEqual([]);
    expect(protocol.recent("%1", 1)).toHaveLength(1);
  });
});

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

describe("a prompt event settles an unknown send inside its window (M102 spec 13)", () => {
  const TEXT = "please fix the parser test";
  /** A pane that keeps the text in its box after Enter: S2 finds no evidence, the send ends unknown. */
  const stuck = (options: Parameters<typeof rig>[0] = {}) => {
    const r = rig(options);
    r.pane.afterInput = (p, what) => {
      if (what.endsWith("Enter")) p.box = TEXT;
    };
    return r;
  };
  /** The Claude profile with its prompt event taken out of the edge map. */
  const noPromptEvent = (profile: Profile): Profile => {
    const events = Object.fromEntries(Object.entries(profile.edges?.events ?? {}).filter(([, kind]) => kind !== "prompt"));
    return { ...profile, edges: { rereadMs: profile.edges?.rereadMs ?? 700, settleMs: profile.edges?.settleMs ?? 1500, events } };
  };

  test("unknown on a harness whose profile names a prompt event: the receipt waits 30 s for it, and the event settles it effective", async () => {
    const { send, protocol, deps, clock } = stuck();
    const answer = await send(TEXT);
    const id = answer.receipt!.requestId;
    expect(answer.receipt).toMatchObject({ outcome: "unknown", reason: "no_evidence" });
    const until = answer.receipt!.awaitingEventUntil!;
    expect(until).toBeGreaterThan(clock.now);
    expect(until - clock.now).toBeLessThanOrEqual(30_000);
    expect(protocol.recent("%1").find((row) => row.requestId === id)?.awaitingEventUntil).toBe(until);
    expect(protocol.promptEdge("%1", deps.store.hashText(TEXT), clock.now + 1_000)).toBe(id);
    const settled = deps.store.get(id)?.receipt;
    expect(settled?.outcome).toBe("effective");
    expect(settled?.reason).toBeUndefined();
    expect(settled?.awaitingEventUntil).toBeUndefined();
    // A retry under the same id answers the settled receipt; nothing is typed again.
    const replay = await send(TEXT, { id });
    expect(replay.replayed).toBe(true);
    expect(replay.receipt?.outcome).toBe("effective");
  });

  test("an event past the window settles nothing: the receipt stays unknown, it only cost the wait", async () => {
    const { send, protocol, deps } = stuck();
    const answer = await send(TEXT);
    const until = answer.receipt!.awaitingEventUntil!;
    expect(protocol.promptEdge("%1", deps.store.hashText(TEXT), until + 1)).toBeNull();
    expect(deps.store.get(answer.receipt!.requestId)?.receipt?.outcome).toBe("unknown");
  });

  test("an event whose text the agent changed (trimmed inside, a fold, a rewritten command) settles nothing", async () => {
    const { send, protocol, deps, clock } = stuck();
    const answer = await send(TEXT);
    for (const changed of ["please fix the  parser test", "[Pasted text #1 +2 lines]", "/please fix the parser test", `${TEXT}\nand one more queued line`]) {
      expect(protocol.promptEdge("%1", deps.store.hashText(changed), clock.now + 1_000)).toBeNull();
    }
    expect(deps.store.get(answer.receipt!.requestId)?.receipt?.outcome).toBe("unknown");
  });

  test("outer white space and CR line ends are the same text on both sides", async () => {
    const { send, protocol, deps, clock } = stuck();
    const answer = await send(TEXT);
    expect(protocol.promptEdge("%1", deps.store.hashText(normalizePrompt(`  ${TEXT}\r\n`)), clock.now + 1_000)).toBe(answer.receipt!.requestId);
  });

  test("a harness whose profile names no prompt event: the unknown carries no window", async () => {
    const { send } = stuck({ edit: noPromptEvent });
    const answer = await send(TEXT);
    expect(answer.receipt?.outcome).toBe("unknown");
    expect(answer.receipt?.awaitingEventUntil).toBeUndefined();
  });

  test("a sent receipt carries no window, and a refused one opens none", async () => {
    const { pane, send } = rig();
    const sent = await send("a text that goes through");
    expect(sent.receipt?.outcome).toBe("sent");
    expect(sent.receipt?.awaitingEventUntil).toBeUndefined();
    pane.box = "a draft the person typed";
    const refused = await send("hello there");
    expect(refused.receipt?.outcome).toBe("refused");
    expect(refused.receipt?.awaitingEventUntil).toBeUndefined();
  });
});
