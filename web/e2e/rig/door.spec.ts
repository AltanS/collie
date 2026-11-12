// pi's inbox in the browser leg (ADR 0141, case 36): a draft typed at the desk, then a send from the phone.
//
// The case starts a pi pane of its own with this checkout's inbox extension loaded (harnesses.ts
// `inbox`), so every other pi case stays a screen send. A word sits in pi's box, typed outside the phone
// (the keys route, as case 28 types one) and never sent. Then the phone sends a short text from the
// composer, one tap.
//
// On Herdr the bridge's pi door binds the pane (Herdr's `agent_session` is pi's session file) and hands
// the text to pi's own API: the receipt says `sent` through `via: "pi"` with `door: "taken"`, no key
// reaches the pane, so the desk draft is still in pi's box after pi answers, and pi's session log holds
// the phone's text as exactly one user turn and the draft as none. One model turn.
//
// On herdr-core the pane names no pi session file (the core keeps none for pi), so the inbox is heard
// and the door refuses: the receipt says `doorRefused`, the screen path meets the draft and types
// nothing over it, and the log holds no turn with the text. No model turn.
//
// pi needs a provider (a recording, COLLIE_RIG_KEY_FILE, or its own login with COLLIE_RIG_PI_TURNS=1);
// without one the case reports "not reached".
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { asJsonObject, asJsonString, parseJson, type JsonValue } from "../../src/lib/json";
import { harnessDirs } from "./harnesses";
import { NotReached, Rig, capture, captureScreen, phoneOn, runScenario, sendFromComposer, spendTurn, startHarness, tapWords, test, waitIdle, type Session } from "./leg";
import { muxOf, sleep } from "./rig-lib";
import { PHONE, REPLY_MS } from "./walky-lib";

const H = "pi" as const;
const session: Session = { paneId: null, startNote: "not started" };

/** The desk draft: one word of letters, easy to find on the screen and needing no space key. */
const DRAFT = "deskdraftword";
const TEXT = "Inbox check: reply with only the word INBOX-OK, nothing else.";
const REPLY = /^\s*INBOX-OK\.?\s*$/m;

/** The text of one pi log line's user message, or null for any other line. */
function userText(line: string): string | null {
  const entry = asJsonObject(parseJson(line));
  const message = asJsonObject(entry?.message);
  if (asJsonString(entry?.type) !== "message" || asJsonString(message?.role) !== "user") return null;
  const content: JsonValue | undefined = message?.content;
  const plain = asJsonString(content);
  if (plain !== undefined) return plain;
  if (!Array.isArray(content)) return null;
  return content.map((part) => (asJsonString(asJsonObject(part)?.text) ?? "")).join("");
}

/** The user turns in pi's session logs written since `since`, as text. */
function userTurnsSince(since: number): string[] {
  const root = join(harnessDirs(H).agent, "sessions");
  const files: string[] = [];
  for (const dir of readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    for (const name of readdirSync(join(root, dir.name))) {
      const path = join(root, dir.name, name);
      if (name.endsWith(".jsonl") && statSync(path).mtimeMs >= since) files.push(path);
    }
  }
  return files.flatMap((path) => readFileSync(path, "utf8").split("\n").flatMap((line) => (line.trim() === "" ? [] : [userText(line)].filter((text): text is string => text !== null))));
}

/** The receipt in the bridge's answer to the phone's send (the answer's body, as leg.ts reads it), as its fields. */
function receiptOf(raw: string | undefined) {
  const body = asJsonObject(parseJson(raw ?? ""));
  const receipt = asJsonObject(body?.receipt) ?? body;
  return {
    outcome: asJsonString(receipt?.outcome) ?? "none",
    via: asJsonString(receipt?.via) ?? "none",
    door: asJsonString(receipt?.door) ?? "none",
    doorRefused: receipt?.doorRefused === true,
  };
}

test.describe("pi's inbox", () => {
  test.beforeAll(async () => {
    try {
      const started = await startHarness(new Rig(), H, "lead", { inbox: true });
      Object.assign(session, { paneId: started.paneId, startNote: started.notes.join("; ") });
    } catch (err) {
      Object.assign(session, { paneId: null, startNote: err instanceof Error ? err.message : String(err) });
    }
  });

  test("36 a desk draft, then a phone send through pi's inbox: taken, the draft stays, one turn", async ({ browser, rig }) => {
    await runScenario(H, "door-draft", session, async (pane, trail) => {
      const core = muxOf("lead") === "herdr-core";
      const { context, page, recorder } = await phoneOn(browser, rig, pane, PHONE);
      const notes = trail.notes;
      try {
        // The draft is typed outside the phone and never sent: no model turn.
        await rig.keys(pane, [...DRAFT]);
        const drafted = await rig.until(() => rig.pane(pane), (p) => p?.surface?.composer === "draft", 8000);
        if (drafted === null) throw new NotReached("the draft did not show in pi's box");
        notes.push("the Surface reads a draft");

        const since = Date.now() - 2000;
        if (!core) spendTurn(H, "inbox: the answer to the phone's text");
        const t = await sendFromComposer(page, recorder, TEXT, "send through pi's inbox");
        trail.log.push(t);
        const sent = t.answers.find((answer) => answer.path === "/api/send");
        const receipt = receiptOf(sent?.receipt);
        notes.push(`${tapWords(t)}; receipt ${receipt.outcome}, via ${receipt.via}, door ${receipt.door}${receipt.doorRefused ? ", doorRefused" : ""}`);

        const replied = core ? false : (await rig.screenUntil(pane, REPLY, REPLY_MS, 120)) !== null;
        if (!core) await waitIdle(rig, pane, REPLY_MS);
        else await sleep(3000);
        const after = await rig.pane(pane);
        const draftKept = after?.surface?.composer === "draft" && (await rig.screen(pane, 120)).includes(DRAFT);
        const turns = userTurnsSince(since);
        const exact = turns.filter((text) => text === TEXT).length;
        const merged = turns.filter((text) => text !== TEXT && text.includes(TEXT)).length;
        const draftTurns = turns.filter((text) => text.includes(DRAFT)).length;
        notes.push(
          `${core ? "" : replied ? "pi answered; " : "NO answer on screen; "}the draft ${draftKept ? "is still in pi's box" : "IS NOT IN THE BOX"}; the log holds the text ${String(exact)}x exact, ${String(merged)}x merged, the draft ${String(draftTurns)}x`,
        );
        trail.captures.push(await capture(page, "door-36"), await captureScreen(rig, pane, "door-36"));

        const pass = core
          ? receipt.doorRefused && receipt.via === "screen" && draftKept && exact === 0 && merged === 0 && draftTurns === 0
          : t.worked && receipt.outcome === "sent" && receipt.via === "pi" && receipt.door === "taken" && !receipt.doorRefused && replied && draftKept && exact === 1 && merged === 0 && draftTurns === 0;
        if (core) notes.push("herdr-core names no pi session file: the inbox refuses and the screen path keeps the draft (#764 Known gaps)");
        return { verdict: pass ? "pass" : "fail", taps: trail.log.length, minTaps: 1, note: notes.join("; "), taps_log: trail.log, captures: trail.captures };
      } finally {
        await context.close();
        // Leave the box empty, as the next case on any pane expects of a pane it might share.
        await rig.keys(pane, ["ctrl+u"]).catch(() => undefined);
      }
    });
  });
});
