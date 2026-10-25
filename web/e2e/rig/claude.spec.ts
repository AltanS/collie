// Claude Code in the browser leg: the five scenarios on one session, on Haiku, and case 22 (Model from
// the belt over a draft), which spends no model turn. About 6 model turns.
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { devices, type Locator, type Page } from "@playwright/test";

import { asJsonObject } from "../../src/lib/json";
import { harnessDirs } from "./harnesses";
import {
  NotReached,
  coldPageHasOlder,
  PHONE_DEVICE,
  ScreenWatch,
  askOn,
  capture,
  captureScreen,
  expect,
  freeSurface,
  jsonRows,
  message,
  openSession,
  phoneContext,
  phoneOn,
  resetBox,
  runScenario,
  sendFromComposer,
  settledReceipt,
  spendTurn,
  tap,
  tapWords,
  test,
  waitIdle,
  type Rig,
  type Session,
  type TapLog,
  type TapRecorder,
} from "./leg";

const H = "claude" as const;
const PHONE = devices[PHONE_DEVICE];
const session: Session = { paneId: null, startNote: "not started" };

/** How long a reply on Haiku may take before the case gives up on it. */
const REPLY_MS = 120_000;

/** The note case 4 sends while the long reply streams, and its echo in Claude's transcript. */
const STREAM_NOTE = "Stream note: reply with only the word PINEAPPLE-OK.";
const STREAM_NOTE_ECHO = /^❯\s+Stream note: reply with only the word PINEAPPLE-OK\./gmu;

/** The draft case 22 puts in Claude's box: one word of letters, typed through the keys route. */
const BELT_DRAFT = "beltdraft";

/** Prompts the Load older case seeds: the live page holds the last six, so the seventh is the older page. */
const HISTORY_PROMPTS = 7;

test.describe("claude", () => {
  // Not serial: a failed scenario must not skip the next one. The session survives a worker restart
  // because openSession keeps its pane id in the run folder.
  test.describe.configure({ mode: "default" });

  test.beforeAll(async () => {
    Object.assign(session, await openSession(H));
  });

  test("1 model picker: the first tap on 'Use this session only' commits", async ({ browser, rig }) => {
    await runScenario(H, "picker", session, async (pane, trail) => {
      const { context, page, recorder } = await phoneOn(browser, rig, pane, PHONE);
      recorder.watchAsks(pane);
      const watch = new ScreenWatch(rig, pane).start();
      const log = trail.log;
      const notes = trail.notes;
      try {
        // Round A: open, commit at once. The Claude 2.1.302 timed-notice case (dbbcd10e) lives here.
        const a = await pickerRound(rig, page, recorder, watch, pane, log, false);
        notes.push(`straight commit: ${a.words}`);
        // Round B, the scenario as a person does it: a choice (one row up, back down to Haiku), then
        // the commit. Each move is confirmed on the phone's own card before the next tap.
        const b = await pickerRound(rig, page, recorder, watch, pane, log, true);
        notes.push(`choice then commit: ${b.words}`);
        const shot = await capture(page, "claude-1-picker");
        const screen = await captureScreen(rig, pane, "claude-1-picker");
        const verdict = a.taps === 1 && a.confirmed && b.taps === 1 && b.confirmed && log.every((l) => l.worked) ? "pass" : "fail";
        // Every tap counts: round A is Model + commit, round B is Model + Move up + Move down + commit.
        return { verdict, taps: log.length, minTaps: 6, note: notes.join("; "), taps_log: log, captures: [shot, screen] };
      } finally {
        watch.stop();
        await context.close();
      }
    });
  });

  test("2 permission card: Yes from the phone runs the command", async ({ browser, rig }) => {
    await runScenario(H, "permission", session, async (pane, trail) => {
      spendTurn(H, "permission: touch request");
      const { context, page, recorder } = await phoneOn(browser, rig, pane, PHONE);
      const log = trail.log;
      const proof = join(harnessDirs(H).project, "phone-said-yes.txt");
      try {
        log.push(await sendFromComposer(page, recorder, "Run this exact shell command with the Bash tool and nothing else: touch phone-said-yes.txt", "send the request"));
        const card = page.getByRole("group", { name: "Do you want to proceed?" });
        await expect(card, "no permission card on the phone").toBeVisible({ timeout: 60_000 });
        const { taps, confirmed } = await tapUntil(recorder, card.getByRole("button", { name: "Yes", exact: true }), "Yes", log, async () => (await rig.until(async () => existsSync(proof), (made) => made, 15_000)) === true);
        await waitIdle(rig, pane, REPLY_MS);
        const cardGone = !(await card.isVisible());
        const shot = await capture(page, "claude-2-permission");
        const verdict = confirmed && taps === 1 && log.every((l) => l.worked) ? "pass" : "fail";
        trail.notes.push(confirmed ? "the command ran (file made)" : "the file was not made", `card ${cardGone ? "gone" : "still up"}`, ...log.map(tapWords));
        return { verdict, taps: log.length, minTaps: 2, note: trail.notes.join("; "), taps_log: log, captures: [shot] };
      } finally {
        await context.close();
      }
    });
  });

  test("3 pick-many question: toggles, then Submit through 'Type something'", async ({ browser, rig }) => {
    await runScenario(H, "pick-many", session, async (pane, trail) => {
      spendTurn(H, "pick-many: AskUserQuestion multiSelect");
      const { context, page, recorder } = await phoneOn(browser, rig, pane, PHONE);
      const log = trail.log;
      const notes = trail.notes;
      try {
        log.push(await sendFromComposer(page, recorder, 'Use the AskUserQuestion tool exactly once: one question, header Fruits, text "Which fruits do you like?", multiSelect true, options Apple, Banana, Cherry. Do nothing else.', "send the request"));
        const card = page.getByRole("group", { name: "Which fruits do you like?" });
        await expect(card, "no pick-many card on the phone").toBeVisible({ timeout: 60_000 });
        for (const fruit of ["Apple", "Cherry"]) {
          const box = card.getByRole("checkbox", { name: new RegExp(`^${fruit}\\b`) });
          const t = await tap(recorder, box, fruit);
          log.push(t);
          const ticked = await expect(box)
            .toBeChecked({ timeout: 8000 })
            .then(() => true)
            .catch(() => false);
          const onScreen = (await rig.screenUntil(pane, new RegExp(`\\[✔\\] ${fruit}`), 8000)) !== null;
          if (!ticked || !onScreen) notes.push(`${fruit}: phone ${ticked ? "ticked" : "not ticked"}, screen ${onScreen ? "ticked" : "not ticked"}`);
        }
        // Submit walks the pointer down past "Type something" to Submit (7c23d9fd), then presses Enter.
        log.push(await tap(recorder, card.getByRole("button", { name: message("dialog.submitChip"), exact: true }), "Submit"));
        // A wizard question ends on a review page; a plain one answers at once.
        const review = page.getByRole("group", { name: "Ready to submit your answers?" });
        const answered = /Which fruits do you like\?\s*→\s*Apple, Cherry/;
        const reviewShown = await review
          .waitFor({ state: "visible", timeout: 10_000 })
          .then(() => true)
          .catch(() => false);
        if (reviewShown) log.push(await tap(recorder, review.getByRole("button", { name: "Submit answers", exact: true }), "Submit answers"));
        const done = (await rig.screenUntil(pane, answered, 20_000, 120)) !== null;
        await waitIdle(rig, pane, REPLY_MS);
        const shot = await capture(page, "claude-3-pick-many");
        const screen = await captureScreen(rig, pane, "claude-3-pick-many");
        const min = reviewShown ? 5 : 4;
        notes.push(done ? "Claude got Apple, Cherry" : "the answer did not reach Claude");
        notes.push(log.map(tapWords).join("; "));
        const verdict = done && log.length === min && log.every((l) => l.worked) ? "pass" : "fail";
        return { verdict, taps: log.length, minTaps: min, note: notes.join("; "), taps_log: log, captures: [shot, screen] };
      } finally {
        await context.close();
      }
    });
  });

  test("4 send while the agent streams a long reply", async ({ browser, rig }) => {
    await runScenario(H, "stream-send", session, async (pane, trail) => {
      spendTurn(H, "stream: 120 fruits");
      const { context, page, recorder } = await phoneOn(browser, rig, pane, PHONE);
      const log = trail.log;
      const notes = trail.notes;
      try {
        // Long enough that Haiku still streams when the note goes out: a list that ends in a few
        // seconds turns the case into a send at the turn's end.
        log.push(await sendFromComposer(page, recorder, "List 150 different fruits, one per line, numbered 1 to 150, each with one short sentence about its taste. No other text.", "send the long prompt"));
        const streaming = await rig.screenUntil(pane, /^\s*(?:⏺|●)?\s*1[0-9]\.\s+\S/m, 60_000, 120);
        if (streaming === null) throw new NotReached("the long reply never started streaming");
        const turn = (await rig.pane(pane))?.surface?.turn ?? "?";
        spendTurn(H, "stream: the note sent mid-stream");
        const t = await sendFromComposer(page, recorder, STREAM_NOTE, "send while streaming");
        log.push(t);
        notes.push(`sent while the Surface read turn=${turn}: ${tapWords(t)}`);
        let sent = t.answers.find((answer) => answer.path === "/api/send");
        // Claude queues Enter during a turn (profile `enterWhileRunning: "queues"`): the first tap presses
        // Enter into Claude's own queue, the receipt says `sent` with `queued`, and the Chat draws Claude's
        // queued row with Send now. A hold here is the 1.24.1 defect (the prompt echo read as a menu), so
        // it fails the case. Only a turn that already ended before the tap may take the note as a plain send.
        const firstOutcome = sent?.outcome ?? "none";
        const queued = firstOutcome === "sent" && /"queued":\s*true/u.test(sent?.receipt ?? "");
        const idleSend = !queued && (firstOutcome === "sent" || firstOutcome === "effective") && !/"turn":"running"/u.test(sent?.receipt ?? "");
        if (firstOutcome === "held") notes.push("HELD: the send was kept for the turn's end instead of going into Claude's queue");
        let queuedRow = false;
        if (queued) {
          queuedRow = await page
            .locator('[data-slot="stream-queued"]')
            .filter({ hasText: "PINEAPPLE-OK" })
            .first()
            .waitFor({ state: "visible", timeout: 20_000 })
            .then(() => true)
            .catch(() => false);
          notes.push(queuedRow ? "the Chat drew Claude's queued row with the note" : "no queued row with the note in the Chat (the queue may have drained first)");
        } else if (idleSend) {
          notes.push("the turn had ended before the tap: the note went in as a plain send");
        }
        const submit = page.getByRole("button", { name: message("composer.protocol.submit"), exact: true });
        if (sent?.outcome === "typed_not_submitted" && (await submit.isVisible().catch(() => false))) {
          // What a person does next: the phone says Enter was not pressed and offers Submit.
          const again = await tap(recorder, submit, "Submit (typed, not sent)");
          log.push(again);
          notes.push(`the phone offered Submit: ${tapWords(again)}`);
          sent = again.answers.find((answer) => answer.path === "/api/send") ?? sent;
        }
        // Any held-send card on the pane: a send kept back, whatever holds it, or one that ended unsent.
        const heldCard = await page
          .locator('[data-slot="held-card"]')
          .isVisible()
          .catch(() => false);
        if (heldCard) notes.push("the phone showed the held card (a hold fails this case)");
        const settled = sent?.requestId === null || sent?.requestId === undefined ? null : await settledReceipt(rig, pane, sent.requestId, 180_000);
        notes.push(`receipt settled: ${settled === null ? "no" : `${settled.outcome}${settled.reason === undefined ? "" : ` (${settled.reason})`}`}`);
        // The note itself carries the word, so only Claude's own reply line counts.
        const reply = (await rig.screenUntil(pane, /^\s*(?:⏺|●)\s*PINEAPPLE-OK/m, REPLY_MS, 200)) !== null;
        notes.push(reply ? "Claude answered the note" : "no answer to the note on screen");
        await waitIdle(rig, pane, REPLY_MS);
        // The note lands once, after the turn: one echo of it in the transcript, never a second.
        const echoes = (await rig.screen(pane, 400)).match(STREAM_NOTE_ECHO)?.length ?? 0;
        notes.push(`the note is in the transcript ${String(echoes)} time(s)`);
        const shot = await capture(page, "claude-4-stream-send");
        const screen = await captureScreen(rig, pane, "claude-4-stream-send");
        const wentIn = settled !== null && (settled.outcome === "sent" || settled.outcome === "effective");
        // The first tap must do it: into Claude's queue, seen as its row in the Chat or, when a fast answer
        // drained the queue before the check, as the note landed in the transcript after the turn; or a
        // plain send on a turn that had ended. A send that needed the Submit offer, or a hold, fails the case.
        const drained = queued && !queuedRow && echoes >= 1;
        if (drained) notes.push("the queue drained before the Chat check: the note landed after the turn");
        const firstTap = (queued && (queuedRow || drained)) || idleSend;
        const verdict = t.worked && firstTap && !heldCard && wentIn && reply && echoes === 1 ? "pass" : "fail";
        return { verdict, taps: log.length, minTaps: 2, note: notes.join("; "), taps_log: log, captures: [shot, screen] };
      } finally {
        await context.close();
      }
    });
  });

  test("5 Load older with an empty phone cache: the pin leaves the row free", async ({ browser, rig }) => {
    await runScenario(H, "load-older", session, async (pane, trail) => {
      // History deeper than the first page. Since 1.23.0 a page is the last six prompts with all that
      // follows each (at least 40 rows, at most 400), so the cold page starts at the SECOND of seven
      // prompts and the first one is the older page. Each prompt reads four tiny files in one message
      // and replies with a marker: about ten rows a prompt, well over the 40-row floor, one cheap turn.
      const project = harnessDirs(H).project;
      for (let i = 1; i <= 4; i++) writeFileSync(join(project, `note-${String(i).padStart(2, "0")}.txt`), `note ${String(i)}\n`);
      const deep = await rig.get(`/api/pane/${encodeURIComponent(pane)}/chat`).catch(() => null);
      if (!coldPageHasOlder(asJsonObject(deep))) {
        const seed = await phoneOn(browser, rig, pane, PHONE);
        try {
          for (let n = 1; n <= HISTORY_PROMPTS; n++) {
            spendTurn(H, `load-older: history prompt ${String(n)} of ${String(HISTORY_PROMPTS)}`);
            const t = await sendFromComposer(seed.page, seed.recorder, `Use the Read tool on each of the 4 files note-01.txt to note-04.txt, one Read call per file, all in a single message. Then reply with exactly DONE-${String(n)} and nothing else.`, `send history prompt ${String(n)}`);
            if (!t.worked) throw new Error(`history prompt ${String(n)} was refused: ${tapWords(t)}`);
            // Claude's own reply line: the prompt row above it also holds the marker, after "❯ ".
            await rig.screenUntil(pane, new RegExp(`^\\s*(?:⏺|●)\\s*DONE-${String(n)}\\b`, "m"), 180_000, 200);
            await waitIdle(rig, pane, REPLY_MS);
          }
        } finally {
          await seed.context.close();
        }
      }
      const cold = asJsonObject(await rig.get(`/api/pane/${encodeURIComponent(pane)}/chat`)) ?? {};
      const upserts = jsonRows(cold.upserts);
      if (!coldPageHasOlder(cold)) throw new NotReached(`the session holds no more than one page (${String(upserts.length)} turns)`);
      const lastPrompt = asJsonObject(cold.lastPrompt);
      const reported = lastPrompt !== undefined && !upserts.some((row) => row.uuid === lastPrompt.uuid);
      // Since the six-prompt pages (1.23.0) the last prompt sits on the first page by construction, so
      // the case checks the Load older row itself: attached, nothing covers its centre, a tap adds older
      // rows, and the pin leaves the row free before and after. (A reported pin, 3f522a27, now needs one
      // turn of more than 400 rows.)
      // A FRESH context: the phone holds no history of this session, so its thread is the newest page.
      const context = await phoneContext(browser, rig, PHONE);
      const page = await context.newPage();
      const notes: string[] = [`cold page: ${String(upserts.length)} turns, last prompt ${reported ? "outside it (reported pin)" : "on it"}`];
      const log = trail.log;
      try {
        const olderReads: number[] = [];
        page.on("response", (response) => {
          const url = new URL(response.url());
          if (url.pathname.endsWith("/chat") && url.searchParams.has("before")) olderReads.push(response.status());
        });
        await page.goto(`/pane/${encodeURIComponent(pane)}`);
        const loadOlder = page.getByRole("button", { name: message("chat.scrollback.loadOlder"), exact: true });
        await expect(loadOlder, "no Load older row in the Chat thread").toBeAttached({ timeout: 20_000 });
        // The reader at the very top, where the row is.
        await loadOlder.scrollIntoViewIfNeeded();
        await page.waitForTimeout(800);
        const pin = page.getByRole("button", { name: new RegExp(`^${message("chat.pin.label")}:`) });
        const pinShown = await pin.isVisible().catch(() => false);
        const row = await loadOlder.boundingBox();
        const pinBox = pinShown ? await pin.boundingBox() : null;
        const covered = row !== null && pinBox !== null && pinBox.y < row.y + row.height && row.y < pinBox.y + pinBox.height;
        const hit =
          row === null
            ? "no box"
            : await page.evaluate(([x, y]) => {
                const el = document.elementFromPoint(x!, y!);
                const button = el?.closest("button");
                return button === null || button === undefined ? (el?.tagName ?? "nothing") : (button.textContent ?? "").trim().slice(0, 40);
              }, [row.x + row.width / 2, row.y + row.height / 2]);
        notes.push(`pin ${pinShown ? "shown" : "not shown"}${covered ? ", OVER the Load older row" : ""}; a tap at the row's centre lands on "${hit}"`);
        const before = await page.locator("[data-block]").count();
        const shotBefore = await capture(page, "claude-5-load-older-before");
        const t0 = Date.now();
        await loadOlder.tap({ timeout: 5000 }).catch((err) => notes.push(`the tap did not land: ${String(err).split("\n")[0]}`));
        log.push({ label: "Load older", at: new Date(t0).toISOString(), answers: [], worked: true, screenStillMs: null });
        const grew = await expect
          .poll(async () => page.locator("[data-block]").count(), { timeout: 15_000 })
          .toBeGreaterThan(before)
          .then(() => true)
          .catch(() => false);
        const after = await page.locator("[data-block]").count();
        notes.push(`older read ${olderReads.length === 0 ? "never sent" : `answered ${olderReads.join(",")}`}; thread blocks ${String(before)} -> ${String(after)}`);
        // The row stays free afterwards: when more older turns remain the Load older row is still there,
        // and the pin, shown now that the reader is below the first prompt, must not sit over it.
        await page.waitForTimeout(500);
        const rowAgain = (await loadOlder.count()) > 0;
        if (rowAgain) await loadOlder.scrollIntoViewIfNeeded().catch(() => undefined);
        const rowBox = rowAgain ? await loadOlder.boundingBox() : null;
        const pinNow = (await pin.isVisible().catch(() => false)) ? await pin.boundingBox() : null;
        const coveredAfter = rowBox !== null && pinNow !== null && pinNow.y < rowBox.y + rowBox.height && rowBox.y < pinNow.y + pinNow.height;
        notes.push(`after the tap: pin ${pinNow === null ? "not shown" : "shown"}, Load older row ${rowAgain ? (coveredAfter ? "covered by the pin" : "clear of the pin") : "gone (no older turns left)"}`);
        const shotAfter = await capture(page, "claude-5-load-older-after");
        const verdict = !covered && !coveredAfter && hit.includes(message("chat.scrollback.loadOlder")) && olderReads.includes(200) && grew ? "pass" : "fail";
        return { verdict, taps: 1, minTaps: 1, note: notes.join("; "), taps_log: log, captures: [shotBefore, shotAfter] };
      } finally {
        await context.close();
      }
    });
  });

  test("22 Model from the belt over a draft: Replace empties the box and opens the picker", async ({ browser, rig }) => {
    await runScenario(H, "belt-model-draft", session, async (pane, trail) => {
      const { context, page, recorder } = await phoneOn(browser, rig, pane, PHONE);
      recorder.watchAsks(pane);
      const log = trail.log;
      const notes = trail.notes;
      try {
        // A draft sits in Claude's box, typed outside the phone (the keys route), as walky case 9 types
        // one. One word of letters, so it is easy to find on the screen and needs no space key.
        await rig.keys(pane, [...BELT_DRAFT]);
        const drafted = await rig.until(() => rig.pane(pane), (p) => p?.surface?.composer === "draft", 8000);
        if (drafted === null) throw new NotReached("the draft did not show in Claude's box");
        // The field case: the belt's Model pill onto that draft. The bridge refuses it draft_present
        // before any key and offers Replace and Cancel, never Add ("draft/model" is no message).
        const model = await tap(recorder, page.getByRole("group", { name: "Harness shortcuts" }).getByRole("button", { name: "Model", exact: true }), "Model shortcut");
        log.push(model);
        const refusal = model.answers.find((answer) => answer.path === "/api/send");
        const refusedDraft = refusal?.outcome === "refused" && refusal.reason === "draft_present";
        notes.push(tapWords(model));
        const strip = page.getByTestId("send-offers");
        const stripShown = await strip
          .waitFor({ state: "visible", timeout: 10_000 })
          .then(() => true)
          .catch(() => false);
        const offer = (key: "composer.protocol.append" | "composer.protocol.replace" | "composer.protocol.cancel") => strip.getByRole("button", { name: message(key), exact: true });
        const hasReplace = stripShown && (await offer("composer.protocol.replace").isVisible().catch(() => false));
        const hasCancel = stripShown && (await offer("composer.protocol.cancel").isVisible().catch(() => false));
        const hasAdd = stripShown && (await offer("composer.protocol.append").count()) > 0;
        const sentence = await page
          .getByText(message("composer.protocol.draftCommand"), { exact: true })
          .isVisible()
          .catch(() => false);
        notes.push(`offers ${stripShown ? `${hasReplace ? "Replace" : "no Replace"}, ${hasCancel ? "Cancel" : "no Cancel"}, ${hasAdd ? "ADD" : "no Add"}` : "not shown"}; the notice ${sentence ? "names only Replace and Cancel" : "does not say Replace it, or cancel"}`);
        const shotOffer = await capture(page, "claude-22-belt-model-offer");
        // No Replace on the strip is the bug itself: the case fails, it is not "not reached".
        if (!hasReplace) return { verdict: "fail", taps: log.length, minTaps: 2, note: notes.join("; "), taps_log: log, captures: [shotOffer] };
        // Replace: one tap, a new request. The bridge empties the box with Backspace and sends /model.
        const replace = await tap(recorder, offer("composer.protocol.replace"), "Replace");
        log.push(replace);
        notes.push(tapWords(replace));
        const card = page.getByRole("group", { name: "Select model" });
        const cardShown = await card
          .waitFor({ state: "visible", timeout: 15_000 })
          .then(() => true)
          .catch(() => false);
        const picker = (await rig.until(() => rig.pane(pane), (p) => askOn(p)?.kind === "menu", 10_000)) !== null;
        const screen = await rig.screen(pane, 80);
        const draftGone = !screen.includes(BELT_DRAFT);
        notes.push(`picker ${picker ? "open on the pane" : "NOT open on the pane"}, card ${cardShown ? "on the phone" : "NOT on the phone"}, the draft ${draftGone ? "is gone" : "IS STILL ON THE SCREEN"}`);
        const shot = await capture(page, "claude-22-belt-model-picker");
        const shotScreen = await captureScreen(rig, pane, "claude-22-belt-model-picker");
        // Leave the pane idle for the next case: close the picker outside the phone, as resetBox does.
        if (picker) {
          await rig.keys(pane, ["Escape"]);
          const idle = (await rig.until(() => rig.pane(pane), freeSurface, 8000)) !== null;
          notes.push(`picker closed outside the phone (Escape), box ${idle ? "free" : "NOT free"}`);
        }
        // Two taps and no more: Model (refused draft_present, by design) and Replace, which must work at once.
        const verdict = refusedDraft && hasReplace && hasCancel && !hasAdd && sentence && replace.worked && cardShown && picker && draftGone && log.length === 2 ? "pass" : "fail";
        return { verdict, taps: log.length, minTaps: 2, note: notes.join("; "), taps_log: log, captures: [shotOffer, shot, shotScreen] };
      } finally {
        await context.close();
      }
    });
  });
});

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────

/**
 * True when Claude printed "Set model to … for this session only" under the LAST `/model` line and
 * no picker is open: an earlier round's line further up never counts for this one.
 */
function committedAfterLastModel(tail: string): boolean {
  const rows = tail.split("\n");
  const last = rows.findLastIndex((row) => /^❯\s*\/model\b/.test(row.trim()));
  if (last < 0 || rows.slice(last).some((row) => row.includes("Select model"))) return false;
  return rows.slice(last + 1).some((row) => /Set model to .+ for this session only/.test(row));
}

/** Tap until `confirmed` says the screen shows the result, at most three times, as a person would. */
async function tapUntil(recorder: TapRecorder, target: Locator, label: string, log: TapLog[], confirmed: () => Promise<boolean>): Promise<{ taps: number; confirmed: boolean }> {
  let taps = 0;
  while (taps < 3) {
    if (!(await target.isVisible().catch(() => false))) break;
    taps++;
    log.push(await tap(recorder, target, `${label} #${String(taps)}`));
    if (await confirmed()) return { taps, confirmed: true };
  }
  return { taps, confirmed: false };
}

/**
 * One round of the /model picker from the phone: open it with the Model shortcut, optionally move one
 * row up and back down, then tap "Use this session only" until the screen confirms (max three taps).
 */
async function pickerRound(rig: Rig, page: Page, recorder: TapRecorder, watch: ScreenWatch, pane: string, log: TapLog[], choose: boolean): Promise<{ taps: number; confirmed: boolean; words: string }> {
  const words: string[] = [];
  const reset = await resetBox(rig, pane);
  if (reset !== null) words.push(reset);
  const open = await tap(recorder, page.getByRole("group", { name: "Harness shortcuts" }).getByRole("button", { name: "Model", exact: true }), "Model shortcut");
  log.push(open);
  if (open.answers.some((answer) => answer.outcome === "typed_not_submitted")) {
    // The phone says "Your text is in the box, but Enter was not pressed" and offers Submit.
    words.push(`Model shortcut: ${tapWords(open)}, the phone offered Submit`);
    log.push(await tap(recorder, page.getByRole("button", { name: message("composer.protocol.submit"), exact: true }), "Submit (typed, not sent)"));
  } else if (!open.worked) {
    words.push(`Model shortcut: ${tapWords(open)}`);
  }
  const card = page.getByRole("group", { name: "Select model" });
  await expect(card, "the picker card did not show on the phone").toBeVisible({ timeout: 15_000 });
  await rig.until(() => rig.pane(pane), (p) => askOn(p)?.kind === "menu", 10_000);
  const notice = /You've used \d+% of your/.test(await rig.tail(pane, 30));
  words.push(`limit notice ${notice ? "on" : "off"} screen`);
  const pointer = async () => /❯\s*\d+\.\s+(\S+)/.exec(await card.innerText())?.[1] ?? null;
  if (choose) {
    for (const [name, key] of [
      ["Move up", "dialog.menu.moveUp"],
      ["Move down", "dialog.menu.moveDown"],
    ] as const) {
      const was = await pointer();
      const t = await tap(recorder, card.getByRole("button", { name: message(key), exact: true }), name, { screenStillMs: watch.stillMs() });
      log.push(t);
      const moved = await expect
        .poll(pointer, { timeout: 8000 })
        .not.toBe(was)
        .then(() => true)
        .catch(() => false);
      if (!t.worked || !moved) words.push(`${name} ${t.worked ? "accepted" : "refused"}, card ${moved ? "moved" : "did not move"}`);
    }
    words.push(`pointer ends on ${(await pointer()) ?? "?"}`);
  }
  const commit = card.getByRole("button", { name: "Use this session only", exact: true });
  let taps = 0;
  let confirmed = false;
  while (taps < 3 && !confirmed && (await commit.isVisible().catch(() => false))) {
    taps++;
    const still = watch.stillMs();
    const t = await tap(recorder, commit, `Use this session only #${String(taps)}`, { screenStillMs: still });
    log.push(t);
    confirmed = (await rig.until(() => rig.tail(pane, 40), committedAfterLastModel, 6000)) !== null;
    if (!t.worked) {
      // Evidence for the report: what the phone showed while the tap was refused.
      await capture(page, `claude-1-picker-refused-${choose ? "b" : "a"}${String(taps)}`);
      const held = recorder.askAt(Date.parse(t.at));
      words.push(
        `commit tap ${String(taps)} ${tapWords(t)}; the screen was still ${String(still)} ms; the phone held ask ${held?.askId ?? "none"} since ${held === null ? "?" : String(Date.parse(t.at) - held.at)} ms`,
      );
    }
  }
  words.push(confirmed ? `committed after ${String(taps)} tap(s)` : `not committed after ${String(taps)} tap(s)`);
  if (confirmed) {
    // The result in the session: the phone's Chat thread shows Claude's own line.
    const shown = await page
      .getByText(/Set model to .+ for this session only/)
      .last()
      .isVisible()
      .catch(() => false);
    words.push(`phone ${shown ? "shows" : "does not show"} the result`);
    // Leave the box empty for the next round: the confirmation line clears itself.
    await rig.until(() => rig.pane(pane), (p) => askOn(p) === null, 8000);
  } else {
    await rig.keys(pane, ["Escape"]);
  }
  return { taps, confirmed, words: words.join(", ") };
}
