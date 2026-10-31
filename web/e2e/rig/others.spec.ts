// pi and omp in the browser leg. Scenario 1 needs no model turn and always runs. Scenarios 2 to 5
// spend turns, so they run only when harnesses.ts says the harness has a working provider (a key file
// in COLLIE_RIG_KEY_FILE); otherwise they report "not reached" with the reason.
//
// What Collie lifts for these two (web/src/lib/harness/pi/ASK_NOTES.md, omp/ASK_NOTES.md, ADR 0077):
// a pick-one question and a permission select are cards; a pick-many question and the /model
// selector are raw, with the "Collie cannot read this dialog" card and the Keys board. So scenario 1
// drives the selector through the Keys board, and scenario 3 asks a pick-one question.
//
// History for scenario 5 costs seven model turns: since 1.23.0 a page is the last six prompts with all
// that follows each (at least 40 rows), so the cold page starts at the second prompt and the first
// is the older page. After the first prompt come 45 shell lines (`!echo`) sent through the bridge's
// send API; pi and omp record each as a note of its own and run it without the model, and they pad
// the rows past the 40-row floor.
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { devices, type Page } from "@playwright/test";

import { asJsonObject, asJsonString } from "../../src/lib/json";
import { SETUPS, harnessDirs, type HarnessId } from "./harnesses";
import {
  NotReached,
  coldPageHasOlder,
  PHONE_DEVICE,
  capture,
  captureScreen,
  expect,
  message,
  openSession,
  phoneContext,
  phoneOn,
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
  type Trail,
} from "./leg";
import { muxOf, sleep } from "./rig-lib";

const PHONE = devices[PHONE_DEVICE];
const REPLY_MS = 120_000;

/** Prompts the Load older case seeds: the live page holds the last six, so the seventh is the older page. */
const HISTORY_PROMPTS = 7;

/**
 * Lines for a check that looks for a reply anywhere on the screen. On the Herdr core a read without
 * `purpose=older` is the screen alone, cut to its last `lines` rows, and the rig's core terminal is
 * 120 rows tall (hc's size when no viewer is attached). pi keeps its editor at the foot of that screen
 * and draws the conversation from the top, so the last 60 rows held only blank rows and the editor
 * (M79 report 06). More lines than the screen has reads all of it on the core; on Herdr it reads more
 * history, which a check split at the last prompt does not mind.
 */
const WHOLE_SCREEN = 200;

/**
 * The Load older case's budget on the Herdr core. It seeds 52 sends (7 prompts and 45 shell lines), and
 * a Collie send costs about 6.4 s on the core against well under a second on Herdr: the core answers a
 * key about 3 s after a raw write (hc 0.1.14), and the Send Protocol's box probe and its submit are a
 * write and a key each. The 52 sends alone are over 5.5 minutes, past the leg's 6 (M79 report 06).
 */
const CORE_LOAD_OLDER_MS = 12 * 60_000;

interface Plan {
  /** A row the selector prints only while it is open, at any of its levels. */
  readonly selectorOpen: RegExp;
  /** The Keys board keys that commit the pointed model, in order, from the selector's first level. */
  readonly commitKeys: readonly string[];
  /** The footer once the session runs on the committed model. */
  readonly footer: RegExp;
  /** The permission request, the folder or file it touches, and how the screen shows the answer. */
  readonly permission: {
    readonly prompt: string;
    readonly option: RegExp;
    /** The Keys board keys that give the same answer when the phone shows the dialog raw. */
    readonly rawKeys: readonly string[];
    readonly prepare: (project: string) => void;
    readonly took: (project: string, screen: string) => boolean;
  };
  /** The pick-one question and the option the phone taps. */
  readonly question: { readonly prompt: string; readonly option: string };
}

const PLANS = {
  pi: {
    selectorOpen: /Enter to select · Ctrl\+S to set as default/,
    commitKeys: ["Enter"],
    footer: /anthropic\/claude-haiku-4\.5/,
    // permission-gate.ts asks before `chmod … 777` (and `rm -rf`, which the phone's own destructive
    // guard would hold for a second tap). The phone answers No, so the mode stays 644.
    permission: {
      prompt: "Run this exact bash command and nothing else: chmod 777 gate-probe.txt",
      option: /^No$/,
      // The pointer starts on Yes.
      rawKeys: ["Down", "Enter"],
      prepare: (project) => {
        writeFileSync(join(project, "gate-probe.txt"), "gate probe\n");
        chmodSync(join(project, "gate-probe.txt"), 0o644);
      },
      took: (project, screen) => (statSync(join(project, "gate-probe.txt")).mode & 0o777) === 0o644 && /Blocked by user/.test(screen),
    },
    question: { prompt: 'Use the question tool exactly once: ask "Which fruit do you like?" with the options Apple, Banana, Cherry. Do nothing else.', option: "Cherry" },
  },
  omp: {
    // Three levels: providers, the provider's models, the roles of the pointed model. Enter goes one
    // level down, Enter on the role row assigns `default`, and Esc closes the selector.
    selectorOpen: /⎋ close|→ \[ ● default/,
    commitKeys: ["Enter", "Enter", "Enter", "Esc"],
    footer: /Haiku 4\.5/,
    // omp's tool approval (approval.ts): the rig's config sets `tools.approvalMode: write`, so a bash
    // call asks. The phone approves a harmless touch.
    permission: {
      prompt: "Run this exact bash command and nothing else: touch phone-said-yes.txt",
      option: /^Approve\b/,
      // The pointer starts on Approve.
      rawKeys: ["Enter"],
      prepare: () => undefined,
      took: (project) => existsSync(join(project, "phone-said-yes.txt")),
    },
    // omp draws an option's `preview` behind a rail the Ask reader declines (omp/ASK_NOTES.md), so the
    // phone shows the unread-dialog card. The field is optional, yet Haiku filled it on 2026-10-18:
    // the prompt rules it out, so the case tests the card and not the model's mood.
    question: { prompt: 'Use the ask tool exactly once: ask "Which fruit do you like?" with the options Apple, Banana, Cherry. Give no option a preview. Do nothing else.', option: "Cherry" },
  },
} satisfies Record<"pi" | "omp", Plan>;

for (const harness of ["pi", "omp"] as const) {
  const plan = PLANS[harness];
  const session: Session = { paneId: null, startNote: "not started" };

  test.describe(harness, () => {
    test.describe.configure({ mode: "default" });

    test.beforeAll(async () => {
      Object.assign(session, await openSession(harness));
    });

    test(`1 model picker (${harness}): open it, move, commit from the phone`, async ({ browser, rig }) => {
      await runScenario(harness, "picker", session, async (pane, trail) => {
        const { context, page, recorder } = await phoneOn(browser, rig, pane, PHONE);
        try {
          return await pickerByKeys(harness, plan, rig, page, recorder, pane, trail);
        } finally {
          await context.close();
        }
      });
    });

    test(`2 permission card (${harness})`, async ({ browser, rig }) => {
      await runScenario(harness, "permission", session, async (pane, trail) => {
        const project = harnessDirs(harness).project;
        spendTurn(harness, "permission request");
        plan.permission.prepare(project);
        const { context, page, recorder } = await phoneOn(browser, rig, pane, PHONE);
        try {
          trail.log.push(await sendFromComposer(page, recorder, plan.permission.prompt, "send the request"));
          const option = page.getByRole("button", { name: plan.permission.option });
          const unread = page.getByRole("group", { name: message("unreadDialog.caption") });
          await option
            .first()
            .or(unread)
            .first()
            .waitFor({ state: "visible", timeout: 60_000 })
            .catch(() => undefined);
          const shown = await option.first().isVisible().catch(() => false);
          if (!shown && (await unread.isVisible().catch(() => false))) {
            // The dialog is up and the phone cannot read it. A person answers it on the Keys board.
            trail.notes.push("no card: the phone shows the unread-dialog card for the permission dialog");
            await tap(recorder, page.getByRole("group", { name: "Controls" }).getByRole("button", { name: message("composer.controls.keys"), exact: true }), "Keys", { expectAnswer: false });
            for (const key of plan.permission.rawKeys) trail.log.push(await tap(recorder, page.getByRole("button", { name: key, exact: true }).last(), `Keys: ${key}`));
            await waitIdle(rig, pane, REPLY_MS);
            const took = plan.permission.took(project, await rig.screen(pane, 120));
            trail.captures.push(await capture(page, `${harness}-2-permission`), await captureScreen(rig, pane, `${harness}-2-permission`));
            trail.notes.push(took ? "the Keys answer took effect" : "the Keys answer did not show on screen or disk", ...trail.log.map(tapWords));
            return { verdict: "fail", taps: trail.log.length, minTaps: 2, note: trail.notes.join("; "), taps_log: trail.log, captures: trail.captures };
          }
          if (!shown) {
            await waitIdle(rig, pane, REPLY_MS);
            return { verdict: "n/a", taps: null, note: `${harness} ran it without a card to answer (no permission prompt in this config); ${trail.log.map(tapWords).join("; ")}` };
          }
          const t = await tap(recorder, option.first(), "permission answer");
          trail.log.push(t);
          await waitIdle(rig, pane, REPLY_MS);
          const took = plan.permission.took(project, await rig.screen(pane, 120));
          trail.captures.push(await capture(page, `${harness}-2-permission`));
          trail.notes.push(took ? "the answer took effect" : "the answer did not show on screen or disk", ...trail.log.map(tapWords));
          return { verdict: took && trail.log.every((l) => l.worked) ? "pass" : "fail", taps: trail.log.length, minTaps: 2, note: trail.notes.join("; "), taps_log: trail.log, captures: trail.captures };
        } finally {
          await context.close();
        }
      });
    });

    test(`3 question (${harness}): a pick-one card; pick-many is raw by design`, async ({ browser, rig }) => {
      await runScenario(harness, "pick-many", session, async (pane, trail) => {
        spendTurn(harness, "question request");
        const { context, page, recorder } = await phoneOn(browser, rig, pane, PHONE);
        try {
          trail.log.push(await sendFromComposer(page, recorder, plan.question.prompt, "send the request"));
          // The card's button reads the label, then the option's description when the tool gave one.
          const option = page.getByRole("button", { name: new RegExp(`^${plan.question.option}\\b`) });
          await expect(option, "no question card on the phone").toBeVisible({ timeout: 60_000 });
          const t = await tap(recorder, option, plan.question.option);
          trail.log.push(t);
          await waitIdle(rig, pane, REPLY_MS);
          const answered = new RegExp(plan.question.option).test((await rig.screen(pane, WHOLE_SCREEN)).split("Which fruit do you like?").at(-1) ?? "");
          trail.captures.push(await capture(page, `${harness}-3-question`), await captureScreen(rig, pane, `${harness}-3-question`));
          trail.notes.push("pick-one (pick-many is not lifted for this harness)", answered ? `${harness} got ${plan.question.option}` : "the answer did not show", ...trail.log.map(tapWords));
          return { verdict: answered && trail.log.every((l) => l.worked) ? "pass" : "fail", taps: trail.log.length, minTaps: 2, note: trail.notes.join("; "), taps_log: trail.log, captures: trail.captures };
        } finally {
          await context.close();
        }
      });
    });

    test(`4 send while streaming (${harness})`, async ({ browser, rig }) => {
      await runScenario(harness, "stream-send", session, async (pane, trail) => {
        spendTurn(harness, "stream: 150 fruits");
        const { context, page, recorder } = await phoneOn(browser, rig, pane, PHONE);
        try {
          trail.log.push(await sendFromComposer(page, recorder, "List 150 different fruits, one per line, numbered 1 to 150, each with one short sentence about its taste. No other text.", "send the long prompt"));
          if ((await rig.screenUntil(pane, /^\s*1[0-9]\.\s+\S/m, 60_000, 120)) === null) throw new NotReached("the long reply never started streaming");
          spendTurn(harness, "stream: the note sent mid-stream");
          const t = await sendFromComposer(page, recorder, "Stream note: reply with only the word PINEAPPLE-OK.", "send while streaming");
          trail.log.push(t);
          const sent = t.answers.find((answer) => answer.path === "/api/send");
          const settled = sent?.requestId === null || sent?.requestId === undefined ? null : await settledReceipt(rig, pane, sent.requestId, 180_000);
          const reply = (await rig.screenUntil(pane, /^\s*PINEAPPLE-OK\s*$/m, REPLY_MS, 200)) !== null;
          await waitIdle(rig, pane, REPLY_MS);
          trail.captures.push(await capture(page, `${harness}-4-stream-send`));
          const wentIn = settled !== null && (settled.outcome === "sent" || settled.outcome === "effective");
          trail.notes.push(tapWords(t), `receipt settled: ${settled?.outcome ?? "no"}`, reply ? "the note was answered" : "no answer to the note on screen");
          return { verdict: t.worked && wentIn && reply ? "pass" : "fail", taps: trail.log.length, minTaps: 2, note: trail.notes.join("; "), taps_log: trail.log, captures: trail.captures };
        } finally {
          await context.close();
        }
      });
    });

    test(`5 Load older with an empty phone cache (${harness})`, async ({ browser, rig }) => {
      if (muxOf("lead") === "herdr-core") test.setTimeout(CORE_LOAD_OLDER_MS);
      await runScenario(harness, "load-older", session, async (pane, trail) => {
        if (!SETUPS[harness].turns) throw new NotReached(SETUPS[harness].noTurnsReason);
        // Since 1.23.0 a page is the last six prompts with all that follows each (at least 40 rows), so
        // the history is seven prompts: the first, 45 shell lines (no model turn, they pad the rows past
        // the 40-row floor) and six more. The cold page then starts inside the shell lines and the
        // first prompt sits on the older page.
        const deep = asJsonObject(await rig.get(`/api/pane/${encodeURIComponent(pane)}/chat`).catch(() => null));
        if (!coldPageHasOlder(deep)) {
          const seed = await phoneOn(browser, rig, pane, PHONE);
          try {
            for (let n = 1; n <= HISTORY_PROMPTS; n++) {
              spendTurn(harness, `load-older: history prompt ${String(n)} of ${String(HISTORY_PROMPTS)}`);
              trail.log.push(await sendFromComposer(seed.page, seed.recorder, `Reply with exactly DONE-${String(n)} and nothing else.`, `send history prompt ${String(n)}`));
              await rig.screenUntil(pane, new RegExp(`^\\s*DONE-${String(n)}\\s*$`, "m"), REPLY_MS, WHOLE_SCREEN);
              await waitIdle(rig, pane, REPLY_MS);
              if (n === 1) {
                const lines = await seedShellLines(rig, pane, 45);
                trail.notes.push(`history: ${String(HISTORY_PROMPTS)} prompts and ${String(lines)} of 45 shell lines sent through the API (no model turn)`);
              }
            }
          } finally {
            await seed.context.close();
          }
        }
        const cold = asJsonObject(await rig.get(`/api/pane/${encodeURIComponent(pane)}/chat`));
        if (!coldPageHasOlder(cold)) throw new NotReached(`the session holds no more than one page; ${trail.notes.join("; ")}`);
        const coldRows = Array.isArray(cold?.upserts) ? cold.upserts.length : 0;
        trail.notes.push(`cold page: ${String(coldRows)} turns`);
        const context = await phoneContext(browser, rig, PHONE);
        const page = await context.newPage();
        try {
          await page.goto(`/pane/${encodeURIComponent(pane)}`);
          const loadOlder = page.getByRole("button", { name: message("chat.scrollback.loadOlder"), exact: true });
          await expect(loadOlder).toBeAttached({ timeout: 20_000 });
          await loadOlder.scrollIntoViewIfNeeded();
          const pin = page.getByRole("button", { name: new RegExp(`^${message("chat.pin.label")}:`) });
          const row = await loadOlder.boundingBox();
          const pinBox = (await pin.isVisible().catch(() => false)) ? await pin.boundingBox() : null;
          const covered = row !== null && pinBox !== null && pinBox.y < row.y + row.height && row.y < pinBox.y + pinBox.height;
          // Nothing covers the row's centre: the tap lands on the Load older button itself.
          const hit =
            row === null
              ? "no box"
              : await page.evaluate(([x, y]) => {
                  const el = document.elementFromPoint(x!, y!);
                  const button = el?.closest("button");
                  return button === null || button === undefined ? (el?.tagName ?? "nothing") : (button.textContent ?? "").trim().slice(0, 40);
                }, [row.x + row.width / 2, row.y + row.height / 2]);
          trail.notes.push(`pin ${pinBox === null ? "not shown" : "shown"}${covered ? ", OVER the Load older row" : ""}; a tap at the row's centre lands on "${hit}"`);
          const before = await page.locator("[data-block]").count();
          await loadOlder.tap({ timeout: 5000 });
          const grew = await expect
            .poll(async () => page.locator("[data-block]").count(), { timeout: 15_000 })
            .toBeGreaterThan(before)
            .then(() => true)
            .catch(() => false);
          trail.captures.push(await capture(page, `${harness}-5-load-older`));
          trail.notes.push(grew ? "an older page loaded" : "no older page loaded");
          // The row stays free afterwards: when more older turns remain the Load older row is still there,
          // and the pin, shown now that the reader is below the first prompt, must not sit over it.
          await page.waitForTimeout(500);
          const rowAgain = (await loadOlder.count()) > 0;
          if (rowAgain) await loadOlder.scrollIntoViewIfNeeded().catch(() => undefined);
          const rowBox = rowAgain ? await loadOlder.boundingBox() : null;
          const pinNow = (await pin.isVisible().catch(() => false)) ? await pin.boundingBox() : null;
          const coveredAfter = rowBox !== null && pinNow !== null && pinNow.y < rowBox.y + rowBox.height && rowBox.y < pinNow.y + pinNow.height;
          trail.notes.push(`after the tap: pin ${pinNow === null ? "not shown" : "shown"}, Load older row ${rowAgain ? (coveredAfter ? "covered by the pin" : "clear of the pin") : "gone (no older turns left)"}`);
          return { verdict: !covered && !coveredAfter && hit.includes(message("chat.scrollback.loadOlder")) && grew ? "pass" : "fail", taps: 1, minTaps: 1, note: trail.notes.join("; "), captures: trail.captures };
        } finally {
          await context.close();
        }
      });
    });
  });
}

/**
 * Scenario 1 for pi and omp: open /model with the Model shortcut (and the phone's own Submit when the
 * shortcut's text was typed but not submitted), then move and commit through the Keys board, the
 * phone's way into a selector Collie shows raw.
 */
async function pickerByKeys(harness: HarnessId, plan: Plan, rig: Rig, page: Page, recorder: TapRecorder, pane: string, trail: Trail) {
  const log = trail.log;
  const notes = trail.notes;
  const open = await tap(recorder, page.getByRole("group", { name: "Harness shortcuts" }).getByRole("button", { name: "Model", exact: true }), "Model shortcut");
  log.push(open);
  let opened = (await rig.until(() => rig.tail(pane, 40), (text) => plan.selectorOpen.test(text), 4000)) !== null;
  if (!opened) {
    // The phone offers Submit after "typed, not submitted"; a person taps it.
    const submit = page.getByRole("button", { name: message("composer.protocol.submit"), exact: true });
    if (await submit.isVisible().catch(() => false)) {
      log.push(await tap(recorder, submit, "Submit (typed, not sent)"));
      opened = (await rig.until(() => rig.tail(pane, 40), (text) => plan.selectorOpen.test(text), 5000)) !== null;
    }
  }
  const keysButton = page.getByRole("group", { name: "Controls" }).getByRole("button", { name: message("composer.controls.keys"), exact: true });
  if (!opened) {
    // Still the slash list over the box: the Keys board's Enter picks its first row, /model.
    await tap(recorder, keysButton, "Keys", { expectAnswer: false });
    log.push(await tap(recorder, page.getByRole("button", { name: "Enter", exact: true }), "Keys: Enter"));
    opened = (await rig.until(() => rig.tail(pane, 40), (text) => plan.selectorOpen.test(text), 5000)) !== null;
  }
  const openTaps = log.length;
  notes.push(`opening took ${String(openTaps)} tap(s): ${log.map(tapWords).join(", ")}`);
  if (!opened) {
    trail.captures.push(await capture(page, `${harness}-1-picker`), await captureScreen(rig, pane, `${harness}-1-picker`));
    return { verdict: "fail" as const, taps: log.length, minTaps: 1, note: `${notes.join("; ")}; the selector did not open`, taps_log: log, captures: trail.captures };
  }
  const unread = await page
    .getByRole("group", { name: message("unreadDialog.caption") })
    .isVisible()
    .catch(() => false);
  notes.push(unread ? "the phone shows the unread-dialog card (the selector is raw by design)" : "no unread-dialog card");
  // The choice: one row down and back up, each seen on the screen before the next key.
  if (!(await page.getByRole("button", { name: "Down", exact: true }).isVisible().catch(() => false))) await tap(recorder, keysButton, "Keys", { expectAnswer: false });
  for (const key of ["Down", "Up"]) {
    const was = await rig.tail(pane, 40);
    const t = await tap(recorder, page.getByRole("button", { name: key, exact: true }), `Keys: ${key}`);
    log.push(t);
    const moved = (await rig.until(() => rig.tail(pane, 40), (text) => text !== was, 4000)) !== null;
    if (!t.worked || !moved) notes.push(`${key}: ${t.worked ? "accepted" : "refused"}, screen ${moved ? "moved" : "did not move"}`);
  }
  if (harness === "omp" && !SETUPS.omp.turns) {
    // omp lists providers it has no credential for; a commit would pick a model it cannot use.
    log.push(await tap(recorder, page.getByRole("button", { name: "Esc", exact: true }).last(), "Keys: Esc"));
    trail.captures.push(await capture(page, `${harness}-1-picker`), await captureScreen(rig, pane, `${harness}-1-picker`));
    notes.push(`commit not reached: ${SETUPS.omp.noTurnsReason}, the selector offers no usable model`);
    return { verdict: openTaps === 1 && log.every((l) => l.worked) ? ("not reached" as const) : ("fail" as const), taps: log.length, minTaps: 3 + plan.commitKeys.length, note: notes.join("; "), taps_log: log, captures: trail.captures };
  }
  const commits: TapLog[] = [];
  for (const key of plan.commitKeys) {
    const was = await rig.tail(pane, 40);
    // `.last()`: the unread-dialog card carries an Esc of its own above the Keys board.
    const t = await tap(recorder, page.getByRole("button", { name: key, exact: true }).last(), `Keys: ${key} (commit)`);
    log.push(t);
    commits.push(t);
    const moved = (await rig.until(() => rig.tail(pane, 40), (text) => text !== was, 4000)) !== null;
    if (!t.worked || !moved) notes.push(`${key}: ${t.worked ? "accepted" : "refused"}, screen ${moved ? "moved" : "did not move"}`);
  }
  const closed = (await rig.until(() => rig.tail(pane, 40), (text) => !plan.selectorOpen.test(text), 5000)) !== null;
  const footer = plan.footer.test(await rig.tail(pane, 6));
  trail.captures.push(await capture(page, `${harness}-1-picker`), await captureScreen(rig, pane, `${harness}-1-picker`));
  notes.push(closed ? "the selector closed on the commit" : "the selector stayed open", footer ? "the footer names the model" : "the footer does not name the model");
  const verdict = openTaps === 1 && closed && footer && commits.every((t) => t.worked) && log.every((l) => l.worked) ? ("pass" as const) : ("fail" as const);
  return { verdict, taps: log.length, minTaps: 3 + plan.commitKeys.length, note: notes.join("; "), taps_log: log, captures: trail.captures };
}

/**
 * Seed history without the model: shell lines (`!echo history-NN`) through the bridge's send API. pi
 * and omp run each one themselves and record it as a note of its own. Returns how many went in.
 */
async function seedShellLines(rig: Rig, pane: string, count: number): Promise<number> {
  let sent = 0;
  for (let i = 1; i <= count; i++) {
    const { json } = await rig.post("/api/send", { id: randomUUID(), pane, text: `!echo history-${String(i).padStart(2, "0")}`, mode: "command" });
    const outcome = asJsonString(asJsonObject(asJsonObject(json)?.receipt)?.outcome);
    if (outcome === "sent" || outcome === "effective") sent++;
    await waitIdle(rig, pane, 10_000);
    await sleep(250);
  }
  return sent;
}
