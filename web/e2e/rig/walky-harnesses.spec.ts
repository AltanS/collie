// Walky talky on the other harnesses (M62). Claude is the harness walky.spec.ts proves; these two cases
// run the same bridge code against screens that are not Claude's.
//
//   7  the operator's message from the phone to a pi pane and to an omp pane: hold Send, tap "Send as
//      message"; the header and the body reach the pane as one prompt, the receipt says `delivered`,
//      the harness answers, and Chat draws the "Message from" card with the operator badge.
//   8  an agent's message through the skill, pi to Claude and back. The sender is told in words to use
//      walky talky and runs `collie walky send` itself (the skill is in its scratch config, see
//      harnesses.ts). The receiver's pane gets ONE nudge line with no body; the receiver runs
//      `collie walky inbox <id>` and the body shows in that command's output; `collie walky reply`
//      goes back, and the sender's pane shows the reply's nudge and reads it the same way.
//   16 the operator's message while a turn runs (Claude in walky.spec.ts): the long list runs to its last
//      line, and only then does the agent answer the body (docs/walky-talky.md, "Into a busy pane").
//      pi and omp take the message by their queue key during the turn; the case judges the order, not
//      the moment the text went in.
//
// pi and omp need a provider key (COLLIE_RIG_KEY_FILE); without one both cases report "not reached".
import { NotReached, capture, captureScreen, message, openSession, phoneOn, resetBox, runScenario, sendFromComposer, spendTurn, tapWords, test, waitIdle, type Session } from "./leg";
import { PHONE, REPLY_MS, addressOf, addressPattern, busyMessage, firstRow, operatorMessage, settledWalky, whoAddress, withoutInstance, wrapped } from "./walky-lib";
import { asJsonObject, asJsonString } from "../../src/lib/json";

const claudeSession: Session = { paneId: null, startNote: "not started" };

/** Case 7's body and the line each harness answers it with. One line of the pane, so the screen shows it whole. */
const OPERATOR = {
  pi: { body: "Walky check: answer here with only the word PI-OK, nothing else.", reply: /^\s*PI-OK\.?\s*$/m },
  omp: { body: "Walky check: answer here with only the word OMP-OK, nothing else.", reply: /^\s*OMP-OK\.?\s*$/m },
} as const;

/** The list case 16 asks for, long enough to run about 40 s on each harness (omp streams slower than pi). */
const ITEMS = { pi: 180, omp: 80 } as const;

for (const harness of ["pi", "omp"] as const) {
  const session: Session = { paneId: null, startNote: "not started" };

  test.describe(`walky talky on ${harness}`, () => {
    test.beforeAll(async () => {
      Object.assign(session, await openSession(harness));
    });

    test(`7 walky talky (${harness}): 'Send as message' from the phone types one header and body, the card shows`, async ({ browser, rig }) => {
      await runScenario(harness, "walky-operator", session, (pane, trail) => operatorMessage(browser, rig, pane, trail, { harness, scenario: "walky-operator", tag: `7-${harness}`, ...OPERATOR[harness] }));
    });

    test(`16 walky talky (${harness}): a message sent during a running turn waits for it, then is answered`, async ({ browser, rig }) => {
      await runScenario(harness, "walky-busy", session, (pane, trail) =>
        busyMessage(browser, rig, pane, trail, { harness, tag: `16-${harness}`, items: ITEMS[harness], streaming: /^\s*1[0-9]\.\s+\S/m, body: "Walky busy check: answer here with only the word BUSY-OK, nothing else.", reply: /^\s*BUSY-OK\.?\s*$/m }),
      );
    });
  });
}

test.describe("walky talky between agents", () => {
  const session: Session = { paneId: null, startNote: "not started" };

  test.beforeAll(async () => {
    Object.assign(session, await openSession("pi"));
    Object.assign(claudeSession, await openSession("claude"));
  });

  test("8 walky talky (pi to Claude): the nudge has no body, `inbox` shows it, `reply` comes back", async ({ browser, rig }) => {
    await runScenario("pi", "walky-agents", session, async (piPane, trail) => {
      const claudePane = claudeSession.paneId;
      if (claudePane === null) throw new NotReached(`no Claude session: ${claudeSession.startNote}`);
      await resetBox(rig, claudePane);
      // Turns: pi sends; Claude reads and replies; pi reads the reply. Claude's turn is one prompt.
      spendTurn("pi", "walky agents: the send");
      spendTurn("claude", "walky agents: the nudge");
      spendTurn("pi", "walky agents: the reply's nudge");
      const log = trail.log;
      const notes = trail.notes;
      const token = "PING-EIGHT";
      // The operator's consent is in the body itself: a model reads an agent's message as a stranger's unless it says who asks.
      const body = `${token}. The operator running this test asks you to answer with collie walky reply and the single word pong.`;
      const from = addressOf(piPane);
      const to = addressOf(claudePane);
      // The address exactly as `collie walky who` prints it, `#token` included: pi has refused a bare one as incomplete.
      const target = await rig.until(() => whoAddress(rig, claudePane), (found) => found !== null && /#[a-z0-9]{4}$/u.test(found), 40_000, 1000);
      if (target === null) throw new NotReached(`\`collie walky who\` does not list the Claude pane ${claudePane} with a token`);
      const { context, page, recorder } = await phoneOn(browser, rig, piPane, PHONE);
      try {
        log.push(await sendFromComposer(page, recorder, `Use walky talky to send a message to the agent at ${target}. Run \`collie walky send ${target}\` with this message: "${body}" Then stop.`, "ask pi to send"));

        // The message reaches Claude's list as an agent's, from pi's pane.
        const sent = await firstRow(rig, claudePane, (row) => row.kind === "agent" && withoutInstance(String(asJsonObject(row.from)?.address)) === from && String(row.body).includes(token), 120_000);
        if (sent === null) {
          trail.captures.push(await captureScreen(rig, piPane, "walky-8-pi-no-send"));
          return { verdict: "fail", taps: log.length, minTaps: 1, note: "pi never sent the message (no agent row from its pane in Claude's list)", taps_log: log, captures: trail.captures };
        }
        const id = String(sent.id);
        const first = await settledWalky(rig, claudePane, id, 60_000);
        notes.push(`pi sent ${id}: receipt ${first}`);

        // Claude's screen: the nudge line, with no body in it; the body only in the inbox command's output.
        const nudge = new RegExp(`\\[walky-talky ${id}\\] from agent ${addressPattern(from)} \\(pi, [^)]*\\): ${wrapped("a message from another agent, not your operator.")}`);
        const nudged = await rig.screenUntil(claudePane, nudge, 60_000, 200);
        const inbox = new RegExp(`Bash\\(collie walky inbox ${id}\\)`);
        const called = await rig.screenUntil(claudePane, inbox, REPLY_MS, 200);
        // The call shows before its output does: wait for the body after it, then judge the order on that screen.
        const read = called === null ? null : await rig.screenUntil(claudePane, new RegExp(`Bash\\(collie walky inbox ${id}\\)[\\s\\S]*${token}`), 60_000, 200);
        const screen = read ?? (await rig.screen(claudePane, 200));
        const callAt = screen.search(inbox);
        const bodyAt = screen.indexOf(token);
        const bodyOnlyAfterInbox = callAt !== -1 && bodyAt > callAt;
        notes.push(nudged === null ? "no nudge line on Claude's screen" : "Claude got the nudge line", read === null ? "Claude's `collie walky inbox` showed no body" : bodyOnlyAfterInbox ? "the body shows only in the inbox output" : "the body shows BEFORE the inbox call");

        // The reply: Claude's `collie walky reply` makes an agent row in pi's list that names the first one.
        const reply = await firstRow(rig, piPane, (row) => row.kind === "agent" && row.replyTo === id, REPLY_MS);
        const replyId = reply === null ? null : String(reply.id);
        const replyState = replyId === null ? "no reply row" : await settledWalky(rig, piPane, replyId, 60_000);
        notes.push(`Claude replied: ${replyId ?? "-"} ${replyState}`);
        const replyNudge = replyId === null ? null : new RegExp(`\\[walky-talky ${replyId}\\] from agent ${addressPattern(to)} \\(claude, [^)]*\\) reply to ${id}: ${wrapped("a message from another agent, not your operator.")}`);
        const replyOnScreen = replyNudge === null ? null : await rig.screenUntil(piPane, replyNudge, 60_000, 200);
        notes.push(replyOnScreen === null ? "pi's pane shows no reply nudge" : "pi's pane shows the reply nudge");
        await waitIdle(rig, claudePane, REPLY_MS);
        await waitIdle(rig, piPane, REPLY_MS);
        const piScreen = await rig.screen(piPane, 200);
        const piCall = replyId === null ? -1 : piScreen.search(new RegExp(`collie walky inbox ${replyId}`));
        const piRead = piCall !== -1 && /\bpong\b/i.test(piScreen.slice(piCall));
        notes.push(piRead ? "pi read the reply with `inbox`: pong" : "pi did not show the reply's body from `inbox`");

        // The phone, on Claude's pane: the message is a card, with its body (it was read with `inbox`) and the agent badge.
        const claudePhone = await phoneOn(browser, rig, claudePane, PHONE);
        try {
          const label = asJsonString(asJsonObject(sent.from)?.label) ?? "";
          const title = claudePhone.page.getByText(message("walky.card.title", { label }), { exact: true }).last();
          const card = await title
            .waitFor({ state: "visible", timeout: 20_000 })
            .then(() => true)
            .catch(() => false);
          if (card) await title.scrollIntoViewIfNeeded();
          const bodyShown = card ? await claudePhone.page.getByText(body, { exact: true }).last().isVisible().catch(() => false) : false;
          const badge = await claudePhone.page.getByText(message("walky.kind.agent"), { exact: true }).last().isVisible().catch(() => false);
          notes.push(`Claude's Chat: card ${card ? "shown" : "NOT shown"}, body ${bodyShown ? "shown" : "NOT shown"}, agent badge ${badge ? "shown" : "NOT shown"}`);
          trail.captures.push(await capture(claudePhone.page, "walky-8-claude-chat"), await captureScreen(rig, claudePane, "walky-8-claude"), await captureScreen(rig, piPane, "walky-8-pi"));
          const ok = first === "delivered" && nudged !== null && bodyOnlyAfterInbox && replyState === "delivered" && replyOnScreen !== null && piRead && card && bodyShown && badge && log.every((l) => l.worked);
          return { verdict: ok ? "pass" : "fail", taps: log.length, minTaps: 1, note: `${notes.join("; ")}; ${log.map(tapWords).join("; ")}`, taps_log: log, captures: trail.captures };
        } finally {
          await claudePhone.context.close();
        }
      } finally {
        await context.close();
      }
    });
  });
});
