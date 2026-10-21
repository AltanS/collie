// Walky talky across a crew (M62), on the crew leg: a lead and a member (crew.config.ts, rig.ts
// `up --crew`). Claude runs on the lead and pi on the member. Each case is judged by the bridges'
// receipts AND by what the panes and the phone show, every tap on the first try:
//
//   12 "Message all agents" from the Crew page: the sheet counts 2 agents on 2 machines, the operator
//      confirms, both panes get the header and the body, both receipts reach `delivered` on the lead
//      (the member's through its sweep report), the member's pane opened on the phone through the
//      lead (`?h=`) shows the message card (head "Message from <device>", the body, "signed by rig-lead"),
//      and each agent answers.
//   13 lead agent to member agent through the skill: Claude runs `collie walky who` and sends to pi's
//      address as `who` printed it, with its pane instance token (`#` and four characters); pi's pane
//      gets the one-line nudge, pi's `collie walky inbox <id>` shows the body, pi replies with
//      `collie walky reply`, and Claude's pane shows the reply nudge. The lead's `collie walky status
//      <id>` (its own socket) says `delivered` within 60 s, which proves the member's outcome report
//      reached the lead; the MEMBER's `collie walky status <reply id>` says `delivered` within 60 s,
//      which proves the lead pushed the reply's outcome back to the machine that sent it.
//   14 an unreachable machine is left out: the member's bridge stops (`rig.ts crew stop-member`), the
//      lead's Crew page names it unreachable, the sheet counts 1 agent on 1 machine, the bridge takes
//      the message for one target, the lead's pane, and answers the member with a refused receipt
//      (`rig-member/all`, "host rig-member is unreachable") that the sheet draws as a "not sent" row.
//      Then the member starts again and is reachable before the end.
//   19 member agent to lead agent through the skill: pi on the member runs `collie walky who` (which lists
//      only its own machine), sends to Claude's address on the lead, Claude's pane gets the one-line
//      nudge, Claude reads it with `collie walky inbox <id>` and replies. The MEMBER's `collie walky
//      status <id>` says `delivered` (the lead pushed the outcome back to the machine that sent it),
//      and the LEAD's status of the reply says `delivered` (the member's sweep report).
//   20 walky talky off on the member (`COLLIE_WALKY=off`, the member's bridge restarted with it):
//      Claude on the lead sends to pi and is told `not sent: off`, the lead's status says refused,
//      and the Crew page's message to that machine draws a "not sent: off" row. pi's pane gets
//      nothing. The member is restarted clean afterwards.
//   21 the pair limit across the crew: six messages from one pane to a pane on the member are taken
//      (the member's box holds a draft, so they wait in its inbox and cost no model turn), the
//      seventh is refused `pair limit` on the lead and never dialled.
//   15 the lead's release line is the crew's (M60 spec 01, ADR 0110): on the lead's Updates page the
//      Release line reads Stable, a tap on Edge shows the receipt and the lead's line record says
//      `edge` with no run started, the Crew page says the members follow Edge, and a tap on Stable
//      puts it back. No model turn is spent. The member's own follow needs a published Edge tag
//      behind a release mirror, which the rig does not serve (README.md, case 15).
import "./crew-env";

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type { Browser, Page } from "@playwright/test";

import { asJsonObject, asJsonString, type JsonObject } from "../../src/lib/json";
import {
  NotReached,
  capture,
  captureScreen,
  jsonRows,
  message,
  openSession,
  phoneContext,
  phoneOn,
  resetBox,
  runScenario,
  sendFromComposer,
  spendTurn,
  tap,
  tapWords,
  test,
  waitIdle,
  TapRecorder,
  type Rig,
  type Session,
  type TapLog,
} from "./leg";
import { DEVICE_LABEL, LEAD_ID, MEMBER_ID, askWalky, paneClose, sleep } from "./rig-lib";
import { PHONE, REPLY_MS, cliSend, escape, firstRow, mintId, operatorHeader, refusalCount, settledWalky, startExtraAgent, wrapped } from "./walky-lib";

const RIG_TS = join(import.meta.dirname, "rig.ts");

const lead: Session = { paneId: null, startNote: "not started" };
const member: Session = { paneId: null, startNote: "not started" };

/** A pane's address on the crew: `<member id>/<pane>`. Another branch may add a `#xxxx` instance token, so a pattern allows one. */
const crewAddress = (memberId: string, paneId: string): string => `${memberId}/${paneId}`;
const addressPattern = (memberId: string, paneId: string): string => `${escape(crewAddress(memberId, paneId))}(?:#[A-Za-z0-9]+)?`;
const sameTarget = (address: string, memberId: string, paneId: string): boolean => new RegExp(`^${addressPattern(memberId, paneId)}$`).test(address);

/** The question the sheet's confirm step asks (walky-broadcast-sheet.tsx confirmQuestion), in the app's own words. */
function confirmWords(agents: number, machines: number): string {
  return message("walky.crew.confirm", {
    agents: message(agents === 1 ? "walky.crew.confirm.agents.one" : "walky.crew.confirm.agents.other", { count: agents }),
    machines: message(machines === 1 ? "walky.crew.confirm.machines.one" : "walky.crew.confirm.machines.other", { count: machines }),
  });
}

/** The ids of every agent nudge on a screen. */
const nudgeIds = (text: string): string[] => [...text.matchAll(/\[walky-talky (wt_[a-z0-9]{12})\] from agent /g)].map((m) => m[1]!);

/** A message's receipts as the LEAD holds them: `collie walky status <id>` through the lead's own socket. */
async function leadReceipts(id: string): Promise<JsonObject[]> {
  return jsonRows((await askWalky("lead", { op: "status", id }))?.receipts);
}

/** The lead's receipts for `id` once `ok` holds for them, or the last read after `ms`. */
async function leadReceiptsUntil(rig: Rig, id: string, ok: (rows: JsonObject[]) => boolean, ms: number): Promise<JsonObject[]> {
  return (await rig.until(() => leadReceipts(id), ok, ms, 1000)) ?? (await leadReceipts(id));
}

const receiptWords = (rows: readonly JsonObject[]): string => rows.map((r) => `${asJsonString(r.target) ?? "?"} ${asJsonString(r.state) ?? "?"}`).join(", ") || "none";

/** The lead's word for the member (`GET /api/crew`). */
async function memberHealth(rig: Rig): Promise<string | null> {
  const row = jsonRows(asJsonObject(await rig.get("/api/crew"))?.members).find((m) => m.id === MEMBER_ID);
  return asJsonString(row?.health) ?? null;
}

/**
 * Stop the member's bridge and start it again (`rig.ts crew stop-member | start-member`), with
 * `COLLIE_WALKY=off` when asked, and wait until the lead calls it reachable. Its Herdr and agents run on.
 */
async function restartMember(rig: Rig, walkyOff: boolean): Promise<string | null> {
  execFileSync("bun", [RIG_TS, "crew", "stop-member"], { stdio: "inherit", timeout: 60_000 });
  execFileSync("bun", [RIG_TS, "crew", "start-member", ...(walkyOff ? ["--env", "COLLIE_WALKY=off"] : [])], { stdio: "inherit", timeout: 90_000 });
  return rig.until(() => memberHealth(rig), (health) => health === "reachable", 90_000, 1000);
}

/** The phone on the lead's Crew page, with its recorder. Close the context when done. */
async function crewPhone(browser: Browser, rig: Rig) {
  const context = await phoneContext(browser, rig, PHONE);
  const page = await context.newPage();
  const recorder = new TapRecorder(page);
  await page.goto("/crew");
  await page.getByRole("button", { name: message("walky.crew.open"), exact: true }).waitFor({ state: "visible", timeout: 20_000 });
  return { context, page, recorder };
}

interface Broadcast {
  readonly taps: TapLog[];
  readonly notes: string[];
  readonly id: string | null;
  /** The receipts the POST answered with. */
  readonly answered: JsonObject[];
  /** The receipt rows the sheet drew. */
  readonly rows: number;
  readonly reachShown: boolean;
  readonly questionShown: boolean;
}

/**
 * "Message all agents" as a person does it on the Crew page: open the sheet, write the text, wait for
 * the count, tap "Send message", read the question, tap Send. Three taps, and only the last one posts.
 */
async function broadcastFromSheet(page: Page, recorder: TapRecorder, body: string, agents: number, machines: number, tag: string, captures: string[], machine?: string): Promise<Broadcast> {
  const taps: TapLog[] = [];
  const notes: string[] = [];
  taps.push(await tap(recorder, page.getByRole("button", { name: message("walky.crew.open"), exact: true }), "Message all agents", { expectAnswer: false }));
  // "Send to": every machine, unless the case names one.
  if (machine !== undefined) await page.getByLabel(message("walky.crew.target")).selectOption(machine);
  await page.getByRole("textbox", { name: message("walky.crew.text") }).fill(body);
  // The count comes from `who` once the sheet is open; it is the sheet's own line for the reach.
  const reachLine = page.locator('[data-slot="walky-reach"]');
  const reachText = message("walky.crew.reach", { count: agents });
  const reachShown = await reachLine
    .filter({ hasText: reachText })
    .waitFor({ state: "visible", timeout: 20_000 })
    .then(() => true)
    .catch(() => false);
  notes.push(`reach line: "${(await reachLine.textContent().catch(() => "")) ?? ""}"`);
  taps.push(await tap(recorder, page.getByRole("button", { name: message("walky.crew.send"), exact: true }), "Send message", { expectAnswer: false }));
  const question = confirmWords(agents, machines);
  const group = page.getByRole("group", { name: question });
  const questionShown = await group
    .waitFor({ state: "visible", timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  const asked = await page.locator('[data-slot="walky-confirm"]').getAttribute("aria-label").catch(() => null);
  notes.push(`question: "${asked ?? "none"}"`);
  captures.push(await capture(page, `walky-${tag}-confirm`));
  if (!questionShown) return { taps, notes, id: null, answered: [], rows: 0, reachShown, questionShown };
  const send = await tap(recorder, group.getByRole("button", { name: message("walky.crew.confirmSend"), exact: true }), "Send");
  taps.push(send);
  notes.push(tapWords(send));
  const answer = send.answers.find((a) => a.path === "/api/walky");
  const answered = answer === undefined ? [] : jsonRows(asJsonObject(JSON.parse(answer.receipt || "{}"))?.receipts);
  const receiptRows = page.locator('[data-slot="walky-receipt"]');
  await receiptRows.first().waitFor({ state: "visible", timeout: 10_000 }).catch(() => undefined);
  const rows = await receiptRows.count();
  captures.push(await capture(page, `walky-${tag}-receipts`));
  return { taps, notes, id: answer?.requestId ?? null, answered, rows, reachShown, questionShown };
}

test.describe("walky talky across a crew", () => {
  test.beforeAll(async () => {
    Object.assign(lead, await openSession("claude", "lead"));
    Object.assign(member, await openSession("pi", "member"));
  });

  test("12 crew: 'Message all agents' on the Crew page reaches both machines and both agents answer", async ({ browser, rig }) => {
    await runScenario("claude", "walky-crew-broadcast", lead, async (claudePane, trail) => {
      const piPane = member.paneId;
      if (piPane === null) throw new NotReached(`no pi on the member: ${member.startNote}`);
      spendTurn("claude", "walky crew: the broadcast");
      spendTurn("pi", "walky crew: the broadcast");
      await resetBox(rig, piPane, MEMBER_ID);
      const notes = trail.notes;
      const body = "Walky crew check: answer here with only the word CREW-OK, nothing else.";
      const { context, page, recorder } = await crewPhone(browser, rig);
      try {
        const sent = await broadcastFromSheet(page, recorder, body, 2, 2, "12", trail.captures);
        trail.log.push(...sent.taps);
        notes.push(...sent.notes);
        if (sent.id === null) return { verdict: "fail", taps: trail.log.length, minTaps: 3, note: notes.join("; "), taps_log: trail.log, captures: trail.captures };
        const id = sent.id;
        const targets = sent.answered.map((r) => asJsonString(r.target) ?? "");
        const oneEach = targets.length === 2 && targets.some((t) => sameTarget(t, LEAD_ID, claudePane)) && targets.some((t) => sameTarget(t, MEMBER_ID, piPane));
        notes.push(`the POST answered ${String(targets.length)} receipts (${receiptWords(sent.answered)}), the sheet drew ${String(sent.rows)} rows`);

        // Both panes: the header and the body as one prompt.
        const typed = new RegExp(`${escape(operatorHeader(id))}\\s*\\n\\s*${escape(body.slice(0, 40))}`);
        const leadTyped = (await rig.screenUntil(claudePane, typed, 30_000, 120)) !== null;
        const memberTyped = (await rig.screenUntil(piPane, typed, 60_000, 120, MEMBER_ID)) !== null;
        notes.push(`header and body on the lead's pane: ${leadTyped ? "yes" : "NO"}, on the member's pane: ${memberTyped ? "yes" : "NO"}`);

        // The lead's receipts: its own pane's at once, the member's through the member's sweep report.
        const receipts = await leadReceiptsUntil(rig, id, (rows) => rows.length === 2 && rows.every((r) => r.state === "delivered"), 60_000);
        const bothDelivered = receipts.length === 2 && receipts.every((r) => r.state === "delivered");
        notes.push(`lead's status: ${receiptWords(receipts)}`);
        const leadRow = await settledWalky(rig, claudePane, id, 30_000);
        notes.push(`the lead pane's walky list says ${leadRow}`);

        // Each agent answers its turn.
        const claudeAnswered = (await rig.screenUntil(claudePane, /^\s*(?:⏺|●)\s*CREW-OK\.?\s*$/m, REPLY_MS, 120)) !== null;
        const piAnswered = (await rig.screenUntil(piPane, /^\s*CREW-OK\.?\s*$/m, REPLY_MS, 120, MEMBER_ID)) !== null;
        notes.push(`Claude ${claudeAnswered ? "answered" : "did NOT answer"}, pi ${piAnswered ? "answered" : "did NOT answer"}`);
        await waitIdle(rig, claudePane, REPLY_MS);
        await waitIdle(rig, piPane, REPLY_MS, MEMBER_ID);
        trail.captures.push(await captureScreen(rig, claudePane, "walky-12-lead-pane"));

        // The member's pane on the phone, opened through the lead with its host address.
        const memberPhone = await phoneOn(browser, rig, piPane, PHONE, MEMBER_ID);
        try {
          // The phone draws the log's row as the 1.23.0 walky card, never the printed envelope: the card is
          // pinned by its message id, its head names the device, its body is the text, its footer names the signer.
          const card = memberPhone.page.locator(`[data-slot="walky-card"][data-id="${id}"]`).last();
          const shown = await card
            .waitFor({ state: "visible", timeout: 20_000 })
            .then(() => true)
            .catch(() => false);
          if (shown) await card.scrollIntoViewIfNeeded();
          const cardText = shown ? ((await card.textContent().catch(() => null)) ?? "") : "";
          const headOk = cardText.includes(message("walky.card.title", { label: DEVICE_LABEL }));
          const bodyOk = shown && (await card.locator('[data-slot="walky-body"]').textContent().catch(() => null)) === body;
          const signedOk = shown && (await card.locator('[data-slot="walky-verified"]').textContent().catch(() => null))?.includes(message("walky.verified.signedBy", { member: LEAD_ID })) === true;
          notes.push(shown ? `the member's pane on the phone (?h=) shows the message card, head ${headOk ? "ok" : "WRONG"}, body ${bodyOk ? "ok" : "WRONG"}, signed by ${LEAD_ID} ${signedOk ? "ok" : "WRONG"}` : "the member's pane on the phone shows NO message card");
          trail.captures.push(await capture(memberPhone.page, "walky-12-member-pane"));
          const verdict = sent.reachShown && sent.questionShown && sent.rows === 2 && oneEach && leadTyped && memberTyped && bothDelivered && leadRow === "delivered" && claudeAnswered && piAnswered && shown && headOk && bodyOk && signedOk && trail.log.every((l) => l.worked) ? "pass" : "fail";
          return { verdict, taps: trail.log.length, minTaps: 3, note: notes.join("; "), taps_log: trail.log, captures: trail.captures };
        } finally {
          await memberPhone.context.close();
        }
      } finally {
        await context.close();
      }
    });
  });

  test("13 crew: Claude on the lead sends to pi on the member through the skill, pi replies, the lead learns the outcome", async ({ browser, rig }) => {
    await runScenario("claude", "walky-crew-agents", lead, async (claudePane, trail) => {
      const piPane = member.paneId;
      if (piPane === null) throw new NotReached(`no pi on the member: ${member.startNote}`);
      // Turns: Claude sends; pi reads the nudge and replies; Claude reads the reply's nudge.
      spendTurn("claude", "walky crew agents: the send");
      spendTurn("pi", "walky crew agents: the nudge");
      spendTurn("claude", "walky crew agents: the reply's nudge");
      await resetBox(rig, piPane, MEMBER_ID);
      const notes = trail.notes;
      const token = "PING-THIRTEEN";
      // The sender asks for the answer by walky talky, as one agent asks another: the nudge then names `collie walky reply`.
      const body = `${token}. Answer me by walky talky reply, with the single word pong.`;
      // The nudges already in pi's scrollback (a rerun on a kept rig): the case takes only a new one.
      const before = new Set(nudgeIds(await rig.screen(piPane, 400, MEMBER_ID)));
      const { context, page, recorder } = await phoneOn(browser, rig, claudePane, PHONE);
      try {
        trail.log.push(
          await sendFromComposer(
            page,
            recorder,
            `Use walky talky. Run \`collie walky who\`, then send the pi agent on the machine ${MEMBER_ID} this message, to its address exactly as \`who\` printed it: "${body}" Then stop.`,
            "ask Claude to send",
          ),
        );
        // pi's screen, read through the lead: the one-line nudge from Claude's pane, with no body.
        const from = addressPattern(LEAD_ID, claudePane);
        const nudge = new RegExp(`\\[walky-talky (wt_[a-z0-9]{12})\\] from agent ${from} \\(claude, [^)]*\\): ${wrapped("a message from another agent, not your operator.")}`, "g");
        const fresh = (text: string): string | null => [...text.matchAll(nudge)].map((m) => m[1]!).find((found) => !before.has(found)) ?? null;
        const nudged = await rig.until(() => rig.screen(piPane, 200, MEMBER_ID), (text) => fresh(text) !== null, REPLY_MS);
        const id = nudged === null ? null : fresh(nudged);
        if (id === null) {
          trail.captures.push(await captureScreen(rig, claudePane, "walky-13-claude-no-send"), await captureScreen(rig, piPane, "walky-13-pi-no-nudge", MEMBER_ID));
          return { verdict: "fail", taps: trail.log.length, minTaps: 1, note: `no nudge from Claude's pane reached pi's screen in ${String(REPLY_MS / 1000)} s; ${trail.log.map(tapWords).join("; ")}`, taps_log: trail.log, captures: trail.captures };
        }
        const claudeScreen = await rig.screen(claudePane, 300);
        const who = claudeScreen.includes("collie walky who");
        notes.push(`Claude ${who ? "ran" : "did NOT show"} \`collie walky who\`; pi got the nudge for ${id}`);
        // The address Claude sent to, off its own Bash call, against the one the lead's `who` prints for pi.
        const listed = asJsonString(jsonRows((await askWalky("lead", { op: "who" }))?.targets).find((t) => (asJsonString(t.address) ?? "").startsWith(crewAddress(MEMBER_ID, piPane)))?.address) ?? null;
        const typedTo = [...claudeScreen.matchAll(/collie walky send\s+["']?([a-z0-9-]+\/[^\s"'()]+)/g)].map((m) => m[1]!).findLast((address) => address.startsWith(`${MEMBER_ID}/`)) ?? null;
        const tokened = typedTo !== null && new RegExp(`^${escape(crewAddress(MEMBER_ID, piPane))}#[a-z0-9]{4}$`).test(typedTo) && typedTo === listed;
        notes.push(`Claude sent to ${typedTo ?? "no address on screen"}, who lists ${listed ?? "nothing"}: ${tokened ? "the address with its token" : "NOT the token address"}`);
        const bodyInNudge = nudged!.split("\n").some((line) => line.includes(`[walky-talky ${id}]`) && line.includes(token));
        notes.push(bodyInNudge ? "the nudge line CARRIES the body" : "the nudge line has no body");

        // The lead learns the member's outcome from the member's sweep report: `collie walky status` on the lead.
        const status = await leadReceiptsUntil(rig, id, (rows) => rows.some((r) => r.state === "delivered"), 60_000);
        const toPi = status.find((r) => sameTarget(asJsonString(r.target) ?? "", MEMBER_ID, piPane));
        const leadDelivered = toPi?.state === "delivered";
        notes.push(`the lead's \`collie walky status ${id}\`: ${receiptWords(status)}`);

        // pi reads the body with `collie walky inbox <id>`.
        const read = await rig.screenUntil(piPane, new RegExp(`collie walky inbox ${id}[\\s\\S]*${token}`), REPLY_MS, 200, MEMBER_ID);
        notes.push(read === null ? "pi's `collie walky inbox` showed no body" : "pi's `collie walky inbox` showed the body");

        // pi's `collie walky reply` lands in Claude's list on the lead as an agent's message that names the first.
        const reply = await firstRow(rig, claudePane, (row) => row.kind === "agent" && row.replyTo === id, REPLY_MS);
        const replyId = reply === null ? null : String(reply.id);
        const replyFrom = asJsonString(asJsonObject(reply?.from)?.address) ?? "";
        const replyState = replyId === null ? "no reply row" : await settledWalky(rig, claudePane, replyId, 60_000);
        notes.push(`pi replied: ${replyId ?? "-"} from ${replyFrom || "?"}, ${replyState}`);
        const replyNudge = replyId === null ? null : new RegExp(`\\[walky-talky ${replyId}\\] from agent ${addressPattern(MEMBER_ID, piPane)} \\(pi, [^)]*\\) reply to ${id}: ${wrapped("a message from another agent, not your operator.")}`);
        const replyOnScreen = replyNudge === null ? null : await rig.screenUntil(claudePane, replyNudge, 60_000, 200);
        notes.push(replyOnScreen === null ? "Claude's pane shows no reply nudge" : "Claude's pane shows the reply nudge");
        // The reply's outcome on the MEMBER, the machine that sent it: the lead pushed it back.
        const memberStatus = replyId === null ? [] : ((await rig.until(async () => jsonRows((await askWalky("member", { op: "status", id: replyId }))?.receipts), (rows) => rows.some((r) => r.state === "delivered"), 60_000, 1000)) ?? jsonRows((await askWalky("member", { op: "status", id: replyId }))?.receipts));
        const memberDelivered = memberStatus.some((r) => sameTarget(asJsonString(r.target) ?? "", LEAD_ID, claudePane) && r.state === "delivered");
        notes.push(`the member's \`collie walky status ${replyId ?? "-"}\`: ${receiptWords(memberStatus)}`);
        await waitIdle(rig, piPane, REPLY_MS, MEMBER_ID);
        await waitIdle(rig, claudePane, REPLY_MS);
        trail.captures.push(await captureScreen(rig, claudePane, "walky-13-claude"), await captureScreen(rig, piPane, "walky-13-pi", MEMBER_ID), await capture(page, "walky-13-claude-phone"));
        const ok =
          tokened && !bodyInNudge && leadDelivered && memberDelivered && read !== null && replyId !== null && sameTarget(replyFrom, MEMBER_ID, piPane) && replyState === "delivered" && replyOnScreen !== null && trail.log.every((l) => l.worked);
        return { verdict: ok ? "pass" : "fail", taps: trail.log.length, minTaps: 1, note: `${notes.join("; ")}; ${trail.log.map(tapWords).join("; ")}`, taps_log: trail.log, captures: trail.captures };
      } finally {
        await context.close();
      }
    });
  });

  test("14 crew: with the member's bridge stopped, the sheet counts the lead's agent only and names the member not sent", async ({ browser, rig }) => {
    await runScenario("claude", "walky-crew-unreachable", lead, async (claudePane, trail) => {
      const piPane = member.paneId;
      if (piPane === null) throw new NotReached(`no pi on the member: ${member.startNote}`);
      spendTurn("claude", "walky crew: the broadcast with the member down");
      const notes = trail.notes;
      const body = "Walky crew check two: answer here with only the word LEAD-ONLY, nothing else.";
      execFileSync("bun", [RIG_TS, "crew", "stop-member"], { stdio: "inherit", timeout: 60_000 });
      let restarted = false;
      const startMember = () => {
        if (restarted) return;
        restarted = true;
        execFileSync("bun", [RIG_TS, "crew", "start-member"], { stdio: "inherit", timeout: 90_000 });
      };
      try {
        // The lead's sweep rides its poll (bridge/crew/lead.ts, CREW_PROTOCOL §10.1): the next tick
        // dials the member, the dial is refused, and the registry folds that one failure into
        // `unreachable` (registry.ts `record`). The poll relaxes to 12 s when idle, so a few ticks fit
        // in the 90 s bound.
        const t0 = Date.now();
        const down = await rig.until(() => memberHealth(rig), (health) => health !== null && health !== "reachable", 90_000, 1000);
        notes.push(`the lead called the member ${down ?? "still reachable"} after ${String(Math.round((Date.now() - t0) / 1000))} s`);
        if (down === null) return { verdict: "fail", taps: 0, minTaps: 3, note: notes.join("; "), taps_log: trail.log, captures: trail.captures };
        const who = await askWalky("lead", { op: "who" });
        const piTarget = jsonRows(who?.targets).find((t) => sameTarget(asJsonString(t.address) ?? "", MEMBER_ID, piPane));
        notes.push(`the lead's who keeps pi as ${asJsonString(piTarget?.state) ?? "nothing"}`);

        const { context, page, recorder } = await crewPhone(browser, rig);
        try {
          // The Crew page: the member's node carries its health word in its label (crew-formation.tsx).
          const words = [message("crew.health.unreachable"), message("connection.host.reconnecting"), message("connection.host.attention")].map(escape).join("|");
          const node = page.getByLabel(new RegExp(`^${escape(MEMBER_ID)}, (?:.*, )?(?:${words})$`));
          const named = await node
            .first()
            .waitFor({ state: "visible", timeout: 30_000 })
            .then(() => true)
            .catch(() => false);
          notes.push(named ? `the Crew page names ${MEMBER_ID} "${(await node.first().getAttribute("aria-label")) ?? ""}"` : "the Crew page does NOT show the member unreachable");
          trail.captures.push(await capture(page, "walky-14-crew"));

          const sent = await broadcastFromSheet(page, recorder, body, 1, 1, "14", trail.captures);
          trail.log.push(...sent.taps);
          notes.push(...sent.notes);
          if (sent.id === null) return { verdict: "fail", taps: trail.log.length, minTaps: 3, note: notes.join("; "), taps_log: trail.log, captures: trail.captures };
          const id = sent.id;
          // One receipt the bridge took, for the lead's pane. The machine it left out comes back as a
          // refused receipt of its own (`rig-member/all`, "host rig-member is unreachable"), and the sheet
          // draws it as a "not sent" row: that row is how the sheet names the machine it left out.
          const taken = sent.answered.filter((r) => ["accepted", "delivered", "inbox-only"].includes(asJsonString(r.state) ?? ""));
          const refused = sent.answered.filter((r) => !taken.includes(r));
          const leadOnly = taken.length === 1 && sameTarget(asJsonString(taken[0]!.target) ?? "", LEAD_ID, claudePane);
          const memberLeftOut =
            refused.length >= 1 && refused.every((r) => (asJsonString(r.target) ?? "").startsWith(`${MEMBER_ID}/`) && r.state === "refused" && /unreachable/.test(asJsonString(r.reason) ?? ""));
          notes.push(`the POST answered ${String(sent.answered.length)} receipt(s) (${receiptWords(sent.answered)}), the sheet drew ${String(sent.rows)} row(s)`);
          const notSent = message("walky.state.refused");
          const leftRow = page.locator('[data-slot="walky-receipt"]').filter({ hasText: `${MEMBER_ID}/` }).filter({ hasText: notSent });
          const leftRowText = (await leftRow.first().textContent().catch(() => null)) ?? null;
          notes.push(leftRowText === null ? `the sheet draws NO "${notSent}" row for ${MEMBER_ID}` : `the sheet's row for the left-out machine: "${leftRowText}"`);
          const typed = new RegExp(`${escape(operatorHeader(id))}\\s*\\n\\s*${escape(body.slice(0, 40))}`);
          const leadTyped = (await rig.screenUntil(claudePane, typed, 30_000, 120)) !== null;
          const leadRow = await settledWalky(rig, claudePane, id, 30_000);
          const answered = (await rig.screenUntil(claudePane, /^\s*(?:⏺|●)\s*LEAD-ONLY\.?\s*$/m, REPLY_MS, 120)) !== null;
          await waitIdle(rig, claudePane, REPLY_MS);
          notes.push(`the lead's pane: header and body ${leadTyped ? "typed" : "NOT typed"}, walky list ${leadRow}, Claude ${answered ? "answered" : "did NOT answer"}`);
          trail.captures.push(await captureScreen(rig, claudePane, "walky-14-lead-pane"));

          // The member comes back, and the message never reached it.
          startMember();
          const back = await rig.until(() => memberHealth(rig), (health) => health === "reachable", 90_000, 1000);
          const piScreen = back === null ? "" : await rig.screen(piPane, 200, MEMBER_ID);
          const piClean = back !== null && !piScreen.includes(`[walky-talky ${id}]`);
          notes.push(back === null ? "the member was NOT reachable again in 90 s" : `the member is reachable again; its pane ${piClean ? "never got the message" : "GOT the message"}`);
          const verdict = down !== null && named && sent.reachShown && sent.questionShown && sent.rows === sent.answered.length && leadOnly && memberLeftOut && leftRowText !== null && leadTyped && leadRow === "delivered" && answered && back !== null && piClean && trail.log.every((l) => l.worked) ? "pass" : "fail";
          return { verdict, taps: trail.log.length, minTaps: 3, note: notes.join("; "), taps_log: trail.log, captures: trail.captures };
        } finally {
          await context.close();
        }
      } finally {
        startMember();
      }
    });
  });
  test("15 crew: the lead's release line is the crew's; the switch installs nothing and the Crew page names it", async ({ browser, rig }) => {
    await runScenario("claude", "crew-release-line", lead, async (_claudePane, trail) => {
      const notes = trail.notes;
      const lineOf = async (): Promise<string | null> => asJsonString(asJsonObject(await rig.get("/api/update/line"))?.line) ?? null;
      const runOf = async (): Promise<string> => JSON.stringify(asJsonObject(await rig.get("/api/update/check"))?.run ?? null);
      const before = await lineOf();
      const runBefore = await runOf();
      notes.push(`the lead's line before: ${before ?? "unreadable"}`);
      const context = await phoneContext(browser, rig, PHONE);
      try {
        const page = await context.newPage();
        const recorder = new TapRecorder(page);
        await page.goto("/settings/updates");
        const group = page.getByRole("radiogroup", { name: message("updates.line.title") });
        await group.waitFor({ state: "visible", timeout: 20_000 });
        const stableChecked = await group.getByRole("radio", { name: message("updates.line.stable"), exact: true }).isChecked();
        notes.push(`the control reads ${stableChecked ? "Stable" : "NOT Stable"}`);

        trail.log.push(await tap(recorder, group.getByRole("radio", { name: message("updates.line.edge"), exact: true }), "Edge"));
        const edgeReceipt = await page
          .getByText(message("updates.line.receipt.edge"), { exact: true })
          .waitFor({ state: "visible", timeout: 10_000 })
          .then(() => true)
          .catch(() => false);
        const edgeSaved = (await lineOf()) === "edge";
        const nothingStarted = (await runOf()) === runBefore;
        notes.push(`Edge: receipt ${edgeReceipt ? "shown" : "NOT shown"}, line record ${edgeSaved ? "edge" : "NOT edge"}, run record ${nothingStarted ? "unchanged" : "MOVED"}`);
        trail.captures.push(await capture(page, "crew-15-edge"));

        await page.goto("/crew");
        const crewSays = await page
          .getByText(message("crew.releaseLine.edge"), { exact: true })
          .waitFor({ state: "visible", timeout: 20_000 })
          .then(() => true)
          .catch(() => false);
        notes.push(`the Crew page ${crewSays ? "says the members follow Edge" : "does NOT name Edge"}`);

        await page.goto("/settings/updates");
        const again = page.getByRole("radiogroup", { name: message("updates.line.title") });
        await again.waitFor({ state: "visible", timeout: 20_000 });
        trail.log.push(await tap(recorder, again.getByRole("radio", { name: message("updates.line.stable"), exact: true }), "Stable"));
        const stableReceipt = await page
          .getByText(message("updates.line.receipt.stable"), { exact: true })
          .waitFor({ state: "visible", timeout: 10_000 })
          .then(() => true)
          .catch(() => false);
        const stableSaved = (await lineOf()) === "stable";
        notes.push(`Stable: receipt ${stableReceipt ? "shown" : "NOT shown"}, line record ${stableSaved ? "stable" : "NOT stable"}`);
        // Each tap's answer is the POST /api/update/line receipt; a tap with none did not work.
        notes.push(`taps: ${trail.log.map((l) => `${l.label} ${l.worked ? "answered" : `NOT answered (${String(l.answers.length)} answer(s))`}`).join(", ")}`);
        const verdict =
          before === "stable" && stableChecked && edgeReceipt && edgeSaved && nothingStarted && crewSays && stableReceipt && stableSaved && trail.log.every((l) => l.worked)
            ? "pass"
            : "fail";
        return { verdict, taps: trail.log.length, minTaps: 2, note: notes.join("; "), taps_log: trail.log, captures: trail.captures };
      } finally {
        await context.close();
        // Never leave the rig's lead on Edge for the next case or the next night.
        if ((await lineOf().catch(() => null)) !== "stable") await rig.post("/api/update/line", { line: "stable", requestId: randomUUID() });
      }
    });
  });

  test("19 crew: pi on the member sends to Claude on the lead through the skill, Claude replies, both machines learn the outcome", async ({ browser, rig }) => {
    await runScenario("claude", "walky-crew-member-to-lead", lead, async (claudePane, trail) => {
      const piPane = member.paneId;
      if (piPane === null) throw new NotReached(`no pi on the member: ${member.startNote}`);
      // Turns: pi sends; Claude reads the nudge and replies; pi reads the reply's nudge.
      spendTurn("pi", "walky member to lead: the send");
      spendTurn("claude", "walky member to lead: the nudge and the reply");
      spendTurn("pi", "walky member to lead: the reply's nudge");
      await resetBox(rig, claudePane);
      const notes = trail.notes;
      const token = "PING-NINETEEN";
      const body = `${token}. Answer me by walky talky reply, with the single word pong.`;
      // `who` on the member lists its own panes only, so the lead pane's address comes from the lead's `who` and goes into the prompt.
      const leadWho = await askWalky("lead", { op: "who" });
      const target = jsonRows(leadWho?.targets).find((t) => sameTarget(asJsonString(t.address) ?? "", LEAD_ID, claudePane));
      const address = asJsonString(target?.address) ?? null;
      if (address === null) return { verdict: "fail", taps: 0, note: `the lead's who does not list Claude's pane ${claudePane}`, taps_log: trail.log, captures: trail.captures };
      notes.push(`the lead's who lists Claude as ${address}`);
      const { context, page, recorder } = await phoneOn(browser, rig, piPane, PHONE, MEMBER_ID);
      try {
        trail.log.push(
          await sendFromComposer(
            page,
            recorder,
            `Use walky talky. Run \`collie walky who\` first: it lists the panes of your own machine only. Then send the agent at ${address} this message, to that address exactly: "${body}" Then stop.`,
            "ask pi to send",
          ),
        );
        // The message reaches Claude's list on the lead as an agent's, from pi's pane on the member.
        const sent = await firstRow(rig, claudePane, (row) => row.kind === "agent" && String(row.body).includes(token), REPLY_MS);
        if (sent === null) {
          trail.captures.push(await captureScreen(rig, piPane, "walky-19-pi-no-send", MEMBER_ID));
          return { verdict: "fail", taps: trail.log.length, minTaps: 1, note: `pi never sent the message (no agent row with ${token} in Claude's list); ${trail.log.map(tapWords).join("; ")}`, taps_log: trail.log, captures: trail.captures };
        }
        const id = String(sent.id);
        const from = asJsonString(asJsonObject(sent.from)?.address) ?? "";
        const first = await settledWalky(rig, claudePane, id, 60_000);
        notes.push(`pi sent ${id} from ${from}: the lead pane's receipt ${first}, verified ${asJsonString(asJsonObject(sent.receipt)?.verified) ?? "?"}`);
        const piScreen = await rig.screen(piPane, 300, MEMBER_ID);
        notes.push(piScreen.includes("other machines") ? "pi's `collie walky who` pointed to the lead" : "pi's screen does not show the `who` line about other machines");

        // Claude's screen: the one-line nudge with no body, then `inbox <id>` and the body in its output.
        const nudge = new RegExp(`\\[walky-talky ${id}\\] from agent ${addressPattern(MEMBER_ID, piPane)} \\(pi, [^)]*\\): ${wrapped("a message from another agent, not your operator.")}`);
        const nudged = await rig.screenUntil(claudePane, nudge, 60_000, 300);
        const read = await rig.screenUntil(claudePane, new RegExp(`Bash\\(collie walky inbox ${id}\\)[\\s\\S]*${token}`), REPLY_MS, 300);
        const claudeScreen = await rig.screen(claudePane, 300);
        const bodyInNudge = claudeScreen.split("\n").some((line) => line.includes(`[walky-talky ${id}]`) && line.includes(token));
        notes.push(nudged === null ? "no nudge line on Claude's screen" : bodyInNudge ? "the nudge line CARRIES the body" : "Claude got the nudge line with no body", read === null ? "Claude's `collie walky inbox` showed no body" : "Claude's `collie walky inbox` showed the body");

        // The sender's machine learns the outcome: the lead pushed it back to the member.
        const memberStatus = (await rig.until(async () => jsonRows((await askWalky("member", { op: "status", id }))?.receipts), (rows) => rows.some((r) => r.state === "delivered"), 60_000, 1000)) ?? jsonRows((await askWalky("member", { op: "status", id }))?.receipts);
        const memberDelivered = memberStatus.some((r) => sameTarget(asJsonString(r.target) ?? "", LEAD_ID, claudePane) && r.state === "delivered");
        notes.push(`the member's \`collie walky status ${id}\`: ${receiptWords(memberStatus)}`);

        // Claude's `collie walky reply` shows on pi's pane as a nudge that names the first message.
        const replyNudge = new RegExp(`\\[walky-talky (wt_[a-z0-9]{12})\\] from agent ${addressPattern(LEAD_ID, claudePane)} \\(claude, [^)]*\\) reply to ${id}: ${wrapped("a message from another agent, not your operator.")}`);
        const piWithReply = await rig.until(() => rig.screen(piPane, 300, MEMBER_ID), (text) => replyNudge.test(text), REPLY_MS);
        const replyId = piWithReply === null ? null : (replyNudge.exec(piWithReply)?.[1] ?? null);
        notes.push(replyId === null ? "pi's pane shows no reply nudge" : `pi's pane shows the reply nudge for ${replyId}`);
        // The lead learns the reply's outcome from the member's sweep report.
        const leadStatus = replyId === null ? [] : await leadReceiptsUntil(rig, replyId, (rows) => rows.some((r) => r.state === "delivered"), 60_000);
        const leadDelivered = leadStatus.some((r) => sameTarget(asJsonString(r.target) ?? "", MEMBER_ID, piPane) && r.state === "delivered");
        notes.push(`the lead's \`collie walky status ${replyId ?? "-"}\`: ${receiptWords(leadStatus)}`);
        await waitIdle(rig, claudePane, REPLY_MS);
        await waitIdle(rig, piPane, REPLY_MS, MEMBER_ID);
        const finalPi = await rig.screen(piPane, 300, MEMBER_ID);
        const piCall = replyId === null ? -1 : finalPi.search(new RegExp(`collie walky inbox ${replyId}`));
        const piRead = piCall !== -1 && /\bpong\b/i.test(finalPi.slice(piCall));
        notes.push(piRead ? "pi read the reply with `inbox`: pong" : "pi did not show the reply's body from `inbox`");
        trail.captures.push(await captureScreen(rig, claudePane, "walky-19-claude"), await captureScreen(rig, piPane, "walky-19-pi", MEMBER_ID), await capture(page, "walky-19-pi-phone"));
        const ok =
          sameTarget(from, MEMBER_ID, piPane) && first === "delivered" && nudged !== null && !bodyInNudge && read !== null && memberDelivered && replyId !== null && leadDelivered && piRead && trail.log.every((l) => l.worked);
        return { verdict: ok ? "pass" : "fail", taps: trail.log.length, minTaps: 1, note: `${notes.join("; ")}; ${trail.log.map(tapWords).join("; ")}`, taps_log: trail.log, captures: trail.captures };
      } finally {
        await context.close();
      }
    });
  });

  test("20 crew: with walky talky off on the member, a send from Claude and the Crew page's message are refused `off`", async ({ browser, rig }) => {
    await runScenario("claude", "walky-crew-off", lead, async (claudePane, trail) => {
      const piPane = member.paneId;
      if (piPane === null) throw new NotReached(`no pi on the member: ${member.startNote}`);
      spendTurn("claude", "walky crew off: the send");
      await resetBox(rig, piPane, MEMBER_ID);
      const notes = trail.notes;
      const body = "Walky off check: answer here with only the word NEVER-OK, nothing else.";
      let restored: string | null | undefined;
      // The member comes back clean once, whichever way the case ends.
      const restore = async (): Promise<string | null> => {
        restored ??= await restartMember(rig, false).catch(() => null);
        return restored;
      };
      try {
        const up = await restartMember(rig, true);
        notes.push(up === null ? "the member was NOT reachable after its restart with COLLIE_WALKY=off" : "the member runs with COLLIE_WALKY=off and is reachable");
        if (up === null) return { verdict: "fail", taps: 0, note: notes.join("; "), taps_log: trail.log, captures: trail.captures };
        const offBefore = refusalCount("member", "off");
        const before = new Set(nudgeIds(await rig.screen(piPane, 400, MEMBER_ID)));

        // A: Claude on the lead sends to pi's address as `who` prints it, and is told so in the Bash output.
        const claudePhone = await phoneOn(browser, rig, claudePane, PHONE);
        let id: string | null = null;
        let leadRefused = false;
        let toldOff = false;
        try {
          trail.log.push(
            await sendFromComposer(
              claudePhone.page,
              claudePhone.recorder,
              `Use walky talky. Run \`collie walky who\`, then send the pi agent on the machine ${MEMBER_ID} this message, to its address exactly as \`who\` printed it: "${body}" Then stop.`,
              "ask Claude to send",
            ),
          );
          toldOff = (await rig.screenUntil(claudePane, /not sent: off/, REPLY_MS, 300)) !== null;
          await waitIdle(rig, claudePane, REPLY_MS);
          const screen = await rig.screen(claudePane, 300);
          id = [...screen.matchAll(/(wt_[a-z0-9]{12})[\s\S]{0,300}?not sent: off/g)].map((m) => m[1]!).at(-1) ?? null;
          const rows = id === null ? [] : await leadReceiptsUntil(rig, id, (found) => found.some((r) => r.state === "refused"), 30_000);
          const row = rows.find((r) => sameTarget(asJsonString(r.target) ?? "", MEMBER_ID, piPane));
          leadRefused = row?.state === "refused" && row.reason === "off";
          notes.push(`Claude's Bash output ${toldOff ? "says" : "does NOT say"} \`not sent: off\``, `the lead's \`collie walky status ${id ?? "-"}\`: ${receiptWords(rows)}${row?.reason === undefined ? "" : ` (${asJsonString(row.reason) ?? ""})`}`);
          trail.captures.push(await captureScreen(rig, claudePane, "walky-20-claude"));
        } finally {
          await claudePhone.context.close();
        }
        await sleep(2000);
        const piScreen = await rig.screen(piPane, 400, MEMBER_ID);
        const piClean = nudgeIds(piScreen).every((found) => before.has(found)) && (id === null || !piScreen.includes(`[walky-talky ${id}]`));
        notes.push(piClean ? "pi's pane got no nudge" : "pi's pane GOT a nudge");

        // B: the Crew page, sent to that one machine. The sheet draws the member's refusal as a row.
        const { context, page, recorder } = await crewPhone(browser, rig);
        try {
          const sent = await broadcastFromSheet(page, recorder, body, 1, 1, "20", trail.captures, MEMBER_ID);
          trail.log.push(...sent.taps);
          notes.push(...sent.notes);
          if (sent.id === null) return { verdict: "fail", taps: trail.log.length, minTaps: 3, note: notes.join("; "), taps_log: trail.log, captures: trail.captures };
          const answeredOff = sent.answered.length >= 1 && sent.answered.every((r) => r.state === "refused" && r.reason === "off" && (asJsonString(r.target) ?? "").startsWith(`${MEMBER_ID}/`));
          const row = page.locator('[data-slot="walky-receipt"]').filter({ hasText: `${MEMBER_ID}/` }).filter({ hasText: message("walky.state.refusedBecause", { reason: "off" }) });
          const rowText = (await row.first().textContent({ timeout: 3000 }).catch(() => null)) ?? null;
          // The count line under the button is the LEAD's own refusals; the member counts its own in its state dir.
          const countLine = (await page.locator('[data-slot="walky-refusals"]').textContent({ timeout: 2000 }).catch(() => null)) ?? null;
          const counted = refusalCount("member", "off") > offBefore;
          notes.push(`the POST answered ${receiptWords(sent.answered)}`, rowText === null ? "the sheet draws NO \"not sent: off\" row for the member" : `the sheet's row: "${rowText}"`, `the "Not sent on this machine" line: ${countLine === null ? "none" : `"${countLine}"`}`, counted ? "the member counted the refusals as off" : "the member's refusals.json did not count off");
          // The member comes back clean, and the Crew page's message never reached pi either.
          const back = await restore();
          const piAfter = (await rig.screen(piPane, 400, MEMBER_ID)).includes(`[walky-talky ${sent.id}]`);
          notes.push(back === null ? "the member did NOT come back clean" : "the member runs clean again and is reachable", piAfter ? "pi's pane GOT the Crew page's message" : "pi's pane never got the Crew page's message");
          // The last tap is the Send the member refuses: the bridge answers 200 with the refusal, which is the result, so that one tap does not "work" in the leg's sense.
          const refusedTap = sent.taps.at(-1);
          const answeredRefusal = refusedTap !== undefined && refusedTap.answers.length > 0 && refusedTap.answers.every((a) => a.status === 200 && a.outcome === "refused");
          const otherTaps = trail.log.filter((l) => l !== refusedTap).every((l) => l.worked);
          const verdict = toldOff && leadRefused && piClean && sent.reachShown && sent.questionShown && answeredOff && answeredRefusal && otherTaps && rowText !== null && counted && back !== null && !piAfter ? "pass" : "fail";
          return { verdict, taps: trail.log.length, minTaps: 4, note: notes.join("; "), taps_log: trail.log, captures: trail.captures };
        } finally {
          await context.close();
        }
      } finally {
        // Never leave the member with walky talky off for the next case or the next night.
        await restore();
      }
    });
  });

  test("21 crew: six messages from one pane to a pane on the member are taken, the seventh is refused `pair limit`", async ({ rig }) => {
    await runScenario("claude", "walky-crew-pair-limit", lead, async (_claudePane, trail) => {
      const piPane = member.paneId;
      if (piPane === null) throw new NotReached(`no pi on the member: ${member.startNote}`);
      await resetBox(rig, piPane, MEMBER_ID);
      const notes = trail.notes;
      let sender: string | null = null;
      try {
        // A throwaway Claude on the lead is the sender: a pair no other case uses, and no model turn (it only sends through the CLI).
        sender = await startExtraAgent(rig, "claude");
        const who = await askWalky("lead", { op: "who" });
        const address = asJsonString(jsonRows(who?.targets).find((t) => sameTarget(asJsonString(t.address) ?? "", MEMBER_ID, piPane))?.address) ?? null;
        if (address === null) return { verdict: "fail", taps: 0, note: `the lead's who does not list pi's pane ${piPane}`, taps_log: trail.log, captures: trail.captures };
        // A draft in pi's box: a message waits in its inbox as `draft present`, so no message costs pi a turn.
        await rig.keys(piPane, ["d", "r", "a", "f", "t"], MEMBER_ID);
        await sleep(1500);
        const mark = mintId().slice(3, 9);
        const limitBefore = refusalCount("lead", "pair limit");
        const sends = [];
        for (let n = 1; n <= 7; n++) sends.push(await cliSend(sender, address, `Walky pair check ${mark} number ${String(n)}.`));
        const words = sends.map((s, i) => `${String(i + 1)}: exit ${String(s.code)} ${s.receipts.map((r) => `${asJsonString(r.state) ?? "?"}${asJsonString(r.reason) === undefined ? "" : ` (${asJsonString(r.reason) ?? ""})`}`).join(", ") || s.out.slice(0, 80)}`);
        notes.push(`${address} from ${sender}: ${words.join("; ")}`);
        const firstSix = sends.slice(0, 6).every((s) => s.code === 0 && s.receipts.length === 1 && ["accepted", "inbox-only"].includes(asJsonString(s.receipts[0]!.state) ?? ""));
        const last = sends[6]!;
        const seventh = last.code === 4 && asJsonString(last.receipts[0]?.state) === "refused" && asJsonString(last.receipts[0]?.reason) === "pair limit";
        await sleep(1500);
        const boxText = await rig.tail(piPane, 6, MEMBER_ID);
        const draftKept = /draft\s*$/m.test(boxText) && !boxText.includes(mark) && !boxText.includes("[walky-talky");
        const counted = refusalCount("lead", "pair limit") > limitBefore;
        notes.push(draftKept ? "pi's draft is untouched, nothing typed" : "pi's BOX CHANGED", counted ? "the lead counted one `pair limit`" : "the lead's refusals did not count `pair limit`");
        trail.captures.push(await captureScreen(rig, piPane, "walky-21-pi", MEMBER_ID));
        return { verdict: firstSix && seventh && draftKept && counted ? "pass" : "fail", taps: 0, note: notes.join("; "), taps_log: trail.log, captures: trail.captures };
      } finally {
        await rig.keys(piPane, ["ctrl+u"], MEMBER_ID);
        if (sender !== null) paneClose(sender);
      }
    });
  });
});
