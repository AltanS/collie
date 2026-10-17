// pi and omp in the browser leg. Scenario 1 needs no model turn and always runs. Scenarios 2 to 5
// spend turns, so they run only when harnesses.ts says the harness has a working provider
// (COLLIE_RIG_PI_TURNS=1 / COLLIE_RIG_OMP_TURNS=1); otherwise they report "not reached" with the reason.
//
// What Collie lifts for these two (web/src/lib/harness/pi/ASK_NOTES.md, omp/ASK_NOTES.md, ADR 0077):
// a pick-one question and a permission select are cards; a pick-many question and the /model
// selector are raw, with the "Collie cannot read this dialog" card and the Keys board. So scenario 1
// drives the selector through the Keys board, and scenario 3 asks a pick-one question.
//
// NOT YET RUN AGAINST A LIVE TURN: on 2026-10-17 neither harness had a working provider here, so the
// bodies of scenarios 2 to 5 below are written from the readers' notes and Claude's run, and their
// card names and confirmations are the first thing to check on the first run with a provider.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { devices, type Page } from "@playwright/test";

import { asJsonObject } from "../../src/lib/json";
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
  type TapRecorder,
  type Trail,
} from "./leg";

const PHONE = devices[PHONE_DEVICE];
const REPLY_MS = 120_000;

interface Plan {
  /** A row the selector prints only while it is open. */
  readonly selectorOpen: RegExp;
  /** The permission request, the folder or file it touches, and how the screen shows the answer. */
  readonly permission: { readonly prompt: string; readonly option: RegExp; readonly prepare: (project: string) => void; readonly took: (project: string, screen: string) => boolean };
  /** The pick-one question and the option the phone taps. */
  readonly question: { readonly prompt: string; readonly option: string };
}

const PLANS = {
  pi: {
    selectorOpen: /Enter to select · Ctrl\+S to set as default/,
    // permission-gate.ts asks before `rm -rf`. The phone answers No, so the folder stays.
    permission: {
      prompt: "Run this exact bash command and nothing else: rm -rf gate-probe",
      option: /^No$/,
      prepare: (project) => mkdirSync(join(project, "gate-probe"), { recursive: true }),
      took: (project, screen) => existsSync(join(project, "gate-probe")) && /Blocked by user/.test(screen),
    },
    question: { prompt: 'Use the question tool exactly once: ask "Which fruit do you like?" with the options Apple, Banana, Cherry. Do nothing else.', option: "Cherry" },
  },
  omp: {
    selectorOpen: /⏎\/→ models · ↑\/↓ providers/,
    // omp's tool approval (approval.ts), when its config asks. The phone allows a harmless touch.
    permission: {
      prompt: "Run this exact bash command and nothing else: touch phone-said-yes.txt",
      option: /^(Allow|Approve|Yes)\b/,
      prepare: () => undefined,
      took: (project) => existsSync(join(project, "phone-said-yes.txt")),
    },
    question: { prompt: 'Use the ask tool exactly once: ask "Which fruit do you like?" with the options Apple, Banana, Cherry. Do nothing else.', option: "Cherry" },
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
          const shown = await option
            .first()
            .waitFor({ state: "visible", timeout: 60_000 })
            .then(() => true)
            .catch(() => false);
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
          const option = page.getByRole("button", { name: plan.question.option, exact: true });
          await expect(option, "no question card on the phone").toBeVisible({ timeout: 60_000 });
          const t = await tap(recorder, option, plan.question.option);
          trail.log.push(t);
          await waitIdle(rig, pane, REPLY_MS);
          const answered = new RegExp(plan.question.option).test((await rig.screen(pane, 60)).split("Which fruit do you like?").at(-1) ?? "");
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
        spendTurn(harness, "stream: 120 fruits");
        const { context, page, recorder } = await phoneOn(browser, rig, pane, PHONE);
        try {
          trail.log.push(await sendFromComposer(page, recorder, "List 120 different fruits, one per line, numbered 1 to 120. No other text.", "send the long prompt"));
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
      await runScenario(harness, "load-older", session, async (pane, trail) => {
        if (!SETUPS[harness].turns) throw new NotReached(SETUPS[harness].noTurnsReason);
        const project = harnessDirs(harness).project;
        for (let i = 1; i <= 48; i++) writeFileSync(join(project, `note-${String(i).padStart(2, "0")}.txt`), `note ${String(i)}\n`);
        spendTurn(harness, "load-older: 48 reads");
        const seed = await phoneOn(browser, rig, pane, PHONE);
        try {
          trail.log.push(await sendFromComposer(seed.page, seed.recorder, "Use the read tool on each of the 48 files note-01.txt to note-48.txt, one read call per file. Then reply with only the word DONE.", "send the history prompt"));
        } finally {
          await seed.context.close();
        }
        await rig.screenUntil(pane, /^\s*DONE\s*$/m, 240_000, 200);
        await waitIdle(rig, pane, REPLY_MS);
        const cold = asJsonObject(await rig.get(`/api/pane/${encodeURIComponent(pane)}/chat`));
        if (!coldPageHasOlder(cold)) throw new NotReached("the session holds no more than one page");
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
          const before = await page.locator("[data-block]").count();
          await loadOlder.tap({ timeout: 5000 });
          const grew = await expect
            .poll(async () => page.locator("[data-block]").count(), { timeout: 15_000 })
            .toBeGreaterThan(before)
            .then(() => true)
            .catch(() => false);
          trail.captures.push(await capture(page, `${harness}-5-load-older`));
          trail.notes.push(`pin ${pinBox === null ? "not shown" : covered ? "OVER the row" : "clear of the row"}`, grew ? "an older page loaded" : "no older page loaded");
          return { verdict: !covered && grew ? "pass" : "fail", taps: 1, minTaps: 1, note: trail.notes.join("; "), captures: trail.captures };
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
    return { verdict: openTaps === 1 && log.every((l) => l.worked) ? ("not reached" as const) : ("fail" as const), taps: log.length, minTaps: 4, note: notes.join("; "), taps_log: log, captures: trail.captures };
  }
  const commit = await tap(recorder, page.getByRole("button", { name: "Enter", exact: true }), "Keys: Enter (commit)");
  log.push(commit);
  const closed = (await rig.until(() => rig.tail(pane, 40), (text) => !plan.selectorOpen.test(text), 5000)) !== null;
  const footer = (await rig.tail(pane, 6)).includes(SETUPS[harness].model.split("/").slice(1).join("/"));
  trail.captures.push(await capture(page, `${harness}-1-picker`), await captureScreen(rig, pane, `${harness}-1-picker`));
  notes.push(closed ? "the selector closed on the commit" : "the selector stayed open", footer ? "the footer names the model" : "the footer does not name the model");
  const verdict = openTaps === 1 && closed && commit.worked && log.every((l) => l.worked) ? ("pass" as const) : ("fail" as const);
  return { verdict, taps: log.length, minTaps: 4, note: notes.join("; "), taps_log: log, captures: trail.captures };
}
