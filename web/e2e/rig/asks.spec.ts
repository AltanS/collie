// The reminder of open asks in the browser leg (.adr/0178), case 38, with real Claude Code and the real hook.
//
// Claude Code's `UserPromptSubmit` and `SessionStart` hooks run `collie beacon asks`, which asks the bridge for
// the session's open asks and prints them as context next to the prompt; the agent then closes an ask the
// prompt settled. Unit tests and a rig run with a stand-in process prove the parts. This case runs them end to
// end: a Claude session of its own (harnesses.ts `asks`, the hooks an install writes, the rig's `collie`
// shim, Sonnet), on Herdr and on the core. The Asks switch is on for this case only, through the route the
// phone calls, and off again at its end; no other case sees Asks or the hooks.
//
//   Part 1, the plain loop. The agent posts an ask with `collie walky ask` (turn 1); the bridge lists it open,
//   `fresh`, and the phone's Asks page shows it. A prompt that settles nothing (turn 2) gets the reminder: the
//   request held the full form naming it, the bridge handed the ask out to that prompt, so the stop of the
//   turn makes it `carried` with `confirmedAt`, and it stays open. A prompt in plain words that settles it
//   (turn 3) gets the short form, and the agent closes it with `collie walky cancel <id> --answered`, so it
//   ends `withdrawn` "answered in the session", and the Asks page no longer shows it.
//   Part 3, the foreign session (no turn). While a second ask is open, the hook gets a real-shaped
//   `UserPromptSubmit` payload with the pane's markers and ANOTHER `session_id`: it prints nothing and the ask
//   stays open. The same payload with the pane's own session id prints the reminder with the ask's id (the
//   control that the call reaches the bridge).
//   Part 2, the resume. The second ask (turn 4) is open. Claude exits in the same pane, and
//   `claude --resume <id>` starts there at once, well inside the bridge's 15 s sweep (a pane that reads as a
//   shell at two sweeps in a row ends its asks). The pane's address is the same, the ask is still open, the
//   hook answers the resumed session (the control again), and a prompt that settles it (turn 5) gets it closed
//   `withdrawn` "answered in the session".
//
// Five Claude turns. The session id for `--resume` is the NAME of the new `<uuid>.jsonl` in the rig's scratch
// Claude folder (the journal root the rig's bridge reads); the case never opens that file.
//
// THE REMINDER IN THE REQUEST. Claude Code 2.1.331 sends a hook's context as a `role: system` item after the
// prompt ("UserPromptSubmit hook additional context: Collie: ..."). The request summary leaves `role: system`
// items out, so no recording matches on the reminder: a change to its words is no mismatch, and a replay alone
// would not notice it missing. So the stub notes it from every Claude request (stub.ts `reminders`,
// cassette.ts `promptReminders`), and the case asserts the text from there, on a live run and on a replay.
import { spawn } from "node:child_process";
import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import type { BrowserContext, Page } from "@playwright/test";

import { asJsonObject, asJsonString, parseJson, type JsonObject } from "../../src/lib/json";
import { readHillList } from "../../src/lib/hill/reader";
import { HILL_ASK_ANSWERED_HERE, type HillDecision } from "../../src/lib/hill/wire";
import { ASKS_FOLDER, SETUPS, harnessDirs, prepareHarness } from "./harnesses";
import { NotReached, askOn, capture, captureScreen, freeSurface, jsonRows, phoneOn, runScenario, sendFromComposer, spendTurn, tapWords, test, waitIdle, type Rig, type ScenarioResult, type Session, type Trail } from "./leg";
import { RIG_SPACE, memGuard, paneClose, paneMarkers, paneRun, readRun, sleep, startInPane } from "./rig-lib";
import { PHONE, REPLY_MS, addressOf, answerLine } from "./walky-lib";

const H = "claude" as const;
const session: Session = { paneId: null, startNote: "" };

/** The bridge's slow timer (bridge/hill/service.ts `sweep`, every 15 s): a pane absent at two in a row ends its asks. */
const SWEEP_MS = 15_000;

const FIRST = { question: "Which colour should the new banner use?", options: ['blue="Use blue"', 'green="Use green"'] };
const SECOND = { question: "Should the release ship on Friday?", options: ['friday="Ship it on Friday"', 'monday="Wait for Monday"'] };

/** The prompt that posts an ask: the exact command, so the turn spends one tool call. */
const postPrompt = (ask: typeof FIRST): string => `Run this exact command with the Bash tool, then reply with only the word POSTED: collie walky ask "${ask.question}" ${ask.options.map((o) => `--option ${o}`).join(" ")}`;
/** A prompt that settles nothing: the reminder comes, and the ask must stay open. */
const NEUTRAL = "Reply with only the word NOTED.";
/** The prompts that settle each ask in plain words, with no word about Collie or a command. */
const SETTLE_FIRST = "About the banner colour: I have decided, it will be blue. Nothing else is needed from you.";
const SETTLE_SECOND = "About the release: I have decided, it ships on Friday. Nothing else is needed from you.";

/** Quote a word for /bin/sh. */
const sq = (word: string): string => `'${word.replaceAll("'", `'\\''`)}'`;

/** Every ask the bridge serves now, open and closed (`GET /api/hill`). */
async function asks(rig: Rig): Promise<HillDecision[]> {
  const list = readHillList(await rig.get("/api/hill"));
  if (list === null) throw new Error("GET /api/hill answered no list");
  return [...list.open, ...list.closed].filter((decision) => decision.ask !== undefined);
}

/** The ask `pick` accepts, polled until it is there and `ok` holds for it. */
async function askUntil(rig: Rig, pick: (d: HillDecision) => boolean, ok: (d: HillDecision) => boolean, ms: number): Promise<HillDecision | null> {
  const found = await rig.until(
    async () => (await asks(rig)).find(pick) ?? null,
    (d) => d !== null && ok(d),
    ms,
    500,
  );
  return found ?? null;
}

/** One ask as the note says it: state, mark, reason. */
const askWords = (d: HillDecision | null | undefined): string => (d === null || d === undefined ? "gone" : `${d.state}${d.ask === undefined ? "" : `, ${d.ask.mark}`}${d.closedReason === undefined || d.closedReason === null ? "" : ` (${d.closedReason})`}`);

/**
 * The reminders of this case's Claude requests, as the rig's model stub saw them (stub.ts `reminders`): the
 * hook's text Claude Code sent with each prompt, in a `role: system` item no recording matches on. One list of
 * texts per change.
 */
async function stubReminders(): Promise<string[][]> {
  const port = readRun()?.stub?.port;
  if (port === undefined) return [];
  const text = await fetch(`http://127.0.0.1:${String(port)}/_rig/stats`)
    .then(async (r) => r.text())
    .catch(() => "");
  const stats = asJsonObject(parseJson(text));
  return jsonRows(stats?.reminders).flatMap((row) => {
    const texts = row.texts;
    return row.case === `${H}.ask-remind` && Array.isArray(texts) ? [texts.map((t) => asJsonString(t) ?? "")] : [];
  });
}

/** The reminders sent since `from` rows (from {@link stubReminders}), flattened. */
async function remindersSince(from: number): Promise<string[]> {
  return (await stubReminders()).slice(from).flat();
}

/** The pane's session instance (the `#xxxx` of its walky address) from the snapshot. */
async function instanceOf(rig: Rig, paneId: string): Promise<string | null> {
  const snap = asJsonObject(await rig.get("/api/snapshot"));
  const row = [...jsonRows(snap?.agents), ...jsonRows(snap?.shellPanes)].find((r) => r.paneId === paneId);
  return asJsonString(row?.instance) ?? null;
}

/** The Claude journals of the case's scratch folder, by name: `<uuid>.jsonl` under `projects/<folder>/`. Names only, never a read. */
function journalNames(): Map<string, number> {
  const root = join(harnessDirs(H, "lead", ASKS_FOLDER).config, "projects");
  const out = new Map<string, number>();
  let folders: string[] = [];
  try {
    folders = readdirSync(root);
  } catch {
    return out;
  }
  for (const folder of folders) {
    let names: string[] = [];
    try {
      names = readdirSync(join(root, folder));
    } catch {
      continue;
    }
    for (const name of names) {
      const m = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/u.exec(name);
      if (m?.[1] !== undefined) out.set(m[1], statSync(join(root, folder, name)).mtimeMs);
    }
  }
  return out;
}

/**
 * `collie beacon asks` as Claude Code runs it from the hook: the case's own shim (the command the hook entry
 * names), the pane's mux markers, one hook payload on stdin. Its stdout, trimmed.
 */
async function hookAsks(paneId: string, payload: JsonObject): Promise<string> {
  const socket = readRun()?.socket;
  if (socket === undefined || socket === "") throw new Error("the rig has no socket");
  const shim = join(harnessDirs(H, "lead", ASKS_FOLDER).root, "bin", "collie");
  const env = { PATH: process.env.PATH ?? "", COLLIE_TELEMETRY: "0", ...paneMarkers(paneId, socket) };
  return new Promise<string>((done) => {
    const child = spawn(shim, ["beacon", "asks"], { env, timeout: 30_000, stdio: ["pipe", "pipe", "ignore"] });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      out += chunk;
    });
    child.on("error", () => done(out.trim()));
    child.on("close", () => done(out.trim()));
    child.stdin.end(JSON.stringify(payload));
  });
}

/** A real-shaped `UserPromptSubmit` payload (the fields Claude Code sends, .adr/0178). */
function promptPayload(sessionId: string, prompt: string): JsonObject {
  const project = harnessDirs(H, "lead", ASKS_FOLDER).project;
  return { session_id: sessionId, transcript_path: join(project, `${sessionId}.jsonl`), cwd: project, permission_mode: "default", hook_event_name: "UserPromptSubmit", prompt };
}

/** The Asks page on its own page of the phone's context: whether `question` shows on the board within `ms`. */
async function boardShows(context: BrowserContext, rig: Rig, question: string, ms: number): Promise<{ shown: boolean; page: Page }> {
  const page = await context.newPage();
  await page.goto(`${rig.base}/asks`);
  const shown = await page
    .locator("[data-slot='asks-board']")
    .getByText(question, { exact: true })
    .first()
    .waitFor({ state: "visible", timeout: ms })
    .then(() => true)
    .catch(() => false);
  return { shown, page };
}

/** Whether `question` has left the Asks board within `ms` (the page polls; a reload reads it fresh). */
async function boardDropped(page: Page, question: string, ms: number): Promise<boolean> {
  await page.reload();
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if ((await page.locator("[data-slot='asks-board']").getByText(question, { exact: true }).count()) === 0) return true;
    await sleep(500);
  }
  return false;
}

/** The words of Claude Code's permission card for a command (its Bash dialog), as the screen shows them. */
const DIALOG_WORDS = /Do you want to proceed\?|This command requires approval/u;

/**
 * A dialog in the pane, as the bridge reads it (the surface's modal names an ask) or as the screen shows Claude's
 * permission card: a few words of it for the note, or null. The case's prompts call for no dialog, and nobody here
 * answers one, so a dialog means the case cannot go on.
 */
async function dialogIn(rig: Rig, paneId: string): Promise<string | null> {
  const pane = await rig.pane(paneId).catch(() => null);
  const tail = await rig.tail(paneId, 30).catch(() => "");
  if (askOn(pane) === null && !DIALOG_WORDS.test(tail)) return null;
  const lines = tail.split("\n").map((line) => line.replace(/^[\s│]+/u, "").trim());
  // The command line of the card, not one of its numbered choices ("2. Yes, and don't ask again for: ...").
  const command = lines.findLast((line) => /\bwalky\b|^Bash\(/u.test(line) && !/^\d+\.\s/u.test(line)) ?? "";
  const words = lines.find((line) => DIALOG_WORDS.test(line)) ?? "a dialog the bridge reads as an ask";
  return command === "" ? words : `${words} for: ${command.slice(0, 160)}`;
}

/** Start the case's own Claude in a fresh pane that keeps its shell, and wait until its box reads free. */
async function openAsksClaude(rig: Rig): Promise<string> {
  memGuard("case 38's Claude");
  const { notes } = prepareHarness(H, "lead", { asks: true });
  if (notes.length > 0) session.startNote = notes.join("; ");
  const dirs = harnessDirs(H, "lead", ASKS_FOLDER);
  // No `exec`: the pane's shell stays when Claude exits, so `--resume` can start in the same pane.
  const paneId = await startInPane(dirs.project, "leg-claude-asks", sq(dirs.start), "lead", RIG_SPACE, { shell: true });
  session.paneId = paneId;
  const up = await rig.until(() => rig.pane(paneId), (pane) => pane !== null && pane.agent === SETUPS[H].agent && freeSurface(pane), 90_000, 700);
  if (up === null) throw new NotReached("case 38's Claude did not come up idle in 90 s");
  return paneId;
}

test.describe("asks", () => {
  test.afterAll(async () => {
    // The pane, and the login copy the start seeded (a dummy one on replay), go with the case.
    if (session.paneId !== null) paneClose(session.paneId);
    rmSync(join(harnessDirs(H, "lead", ASKS_FOLDER).config, ".credentials.json"), { force: true });
  });

  test("38 Asks: the reminder of open asks reaches Claude, also after a resume", async ({ browser, rig }) => {
    test.setTimeout(15 * 60_000);
    await runScenario(
      H,
      "ask-remind",
      session,
      async (pane, trail) => {
        const switched = await rig.post("/api/hill/switch", { on: true });
        if (switched.status !== 200 || asJsonObject(switched.json)?.on !== true) throw new NotReached(`the Asks switch did not turn on (${String(switched.status)})`);
        const { context, page, recorder } = await phoneOn(browser, rig, pane, PHONE);
        try {
          return await theCase(rig, pane, trail, context, page, recorder);
        } finally {
          await context.close();
          await rig.post("/api/hill/switch", { on: false });
        }
      },
      () => openAsksClaude(rig),
    );
  });
});

async function theCase(rig: Rig, pane: string, trail: Trail, context: BrowserContext, page: Page, recorder: Parameters<typeof sendFromComposer>[1]): Promise<ScenarioResult> {
  const { log, notes, captures } = trail;
  const checks: [string, boolean][] = [];
  const check = (what: string, ok: boolean): boolean => {
    checks.push([what, ok]);
    notes.push(`${what}: ${ok ? "yes" : "NO"}`);
    return ok;
  };
  const result = (): ScenarioResult => ({
    verdict: checks.every(([, ok]) => ok) ? "pass" : "fail",
    taps: log.length,
    minTaps: 5,
    note: notes.join("; "),
    taps_log: log,
    captures,
  });
  const send = async (text: string, label: string): Promise<boolean> => {
    const t = await sendFromComposer(page, recorder, text, label);
    log.push(t);
    notes.push(tapWords(t));
    return t.worked;
  };
  /**
   * `wait`, while the pane is watched for a dialog: one that comes ends the case at once, with a note that names it
   * and a capture of the screen, instead of a wait that runs into the test's timeout (the first live recording of
   * this case waited 15 minutes on a permission card for the reminder's command, 2026-11-24).
   */
  const watch = async <T>(wait: Promise<T>, what: string): Promise<T> => {
    const watching = { done: false };
    const guard = async (): Promise<T> => {
      while (!watching.done) {
        const seen = await dialogIn(rig, pane);
        if (watching.done) break;
        if (seen !== null) {
          captures.push(await captureScreen(rig, pane, "asks-38-dialog"));
          throw new Error(`a dialog came in the pane while the case waited for ${what}, and nobody answers it: ${seen}`);
        }
        await sleep(1000);
      }
      return wait;
    };
    try {
      return await Promise.race([wait, guard()]);
    } finally {
      watching.done = true;
    }
  };
  const mine = (question: string) => (d: HillDecision) => d.title === question && (d.from.address ?? "").startsWith(`${addressOf(pane)}#`);
  const before = journalNames();
  const address0 = await instanceOf(rig, pane);

  // ── Part 1: the plain loop ─────────────────────────────────────────────────────────────────────
  spendTurn(H, "asks: post the first ask");
  if (!check("turn 1 sent", await send(postPrompt(FIRST), "send: post the first ask"))) return result();
  const first = await watch(askUntil(rig, mine(FIRST.question), (d) => d.state === "open", REPLY_MS), "the first ask");
  if (!check(`the first ask is open in the bridge (${first?.id ?? "none"}, ${askWords(first)})`, first !== null && first.ask?.mark === "fresh") || first === null) return result();
  const id1 = first.id;
  await watch(waitIdle(rig, pane, REPLY_MS), "the end of turn 1");
  const board1 = await boardShows(context, rig, FIRST.question, 20_000);
  check("the Asks page shows the open ask", board1.shown);
  captures.push(await capture(board1.page, "asks-38-open"));

  // The session id the hooks carry: the journal this session wrote (its name only).
  const fresh = [...journalNames().entries()].filter(([id]) => !before.has(id)).toSorted((a, b) => b[1] - a[1]);
  const sessionId = fresh[0]?.[0] ?? null;
  if (!check(`the session wrote one new journal (${String(fresh.length)})`, sessionId !== null && fresh.length === 1) || sessionId === null) return result();

  let seen = (await stubReminders()).length;
  spendTurn(H, "asks: a prompt that settles nothing");
  if (!check("turn 2 sent", await send(NEUTRAL, "send: a prompt that settles nothing"))) return result();
  const noted = await watch(rig.screenUntil(pane, answerLine("NOTED"), REPLY_MS), "the answer NOTED");
  await watch(waitIdle(rig, pane, REPLY_MS), "the end of turn 2");
  const carried = await watch(askUntil(rig, (d) => d.id === id1, (d) => d.ask?.mark === "carried", 10_000), "the ask to read carried");
  check(`turn 2 answered NOTED`, noted !== null);
  const sent2 = await remindersSince(seen);
  check(`Claude sent turn 2 to the model with the full reminder naming the ask (${JSON.stringify(sent2.map((t) => t.split("\n")[0]))})`, sent2.some((t) => t.startsWith("UserPromptSubmit: Collie: your open asks.") && t.includes(id1)));
  check(`the reminder handed the ask out to turn 2: after its stop the ask is open and carried (${askWords(carried ?? (await asks(rig)).find((d) => d.id === id1))})`, carried !== null && carried.state === "open" && carried.ask?.confirmedAt !== undefined);

  seen = (await stubReminders()).length;
  spendTurn(H, "asks: the prompt that settles the first ask");
  if (!check("turn 3 sent", await send(SETTLE_FIRST, "send: the prompt that settles the first ask"))) return result();
  const closed1 = await watch(askUntil(rig, (d) => d.id === id1, (d) => d.state !== "open", REPLY_MS), "the agent to close the first ask");
  await watch(waitIdle(rig, pane, REPLY_MS), "the end of turn 3");
  const sent3 = await remindersSince(seen);
  check(`Claude sent turn 3 with the reminder naming the ask (${JSON.stringify(sent3)})`, sent3.some((t) => t.startsWith("UserPromptSubmit: Collie: ") && t.includes(id1)));
  check(`the agent closed the first ask as answered in the session (${askWords(closed1)})`, closed1 !== null && closed1.state === "withdrawn" && closed1.closedReason === HILL_ASK_ANSWERED_HERE);
  check("the Asks page no longer shows it", await boardDropped(board1.page, FIRST.question, 20_000));
  captures.push(await capture(board1.page, "asks-38-closed"), await captureScreen(rig, pane, "asks-38-part1"));
  await board1.page.close();

  // ── the second ask, then Part 3: another session id gets nothing ──────────────────────────────
  spendTurn(H, "asks: post the second ask");
  if (!check("turn 4 sent", await send(postPrompt(SECOND), "send: post the second ask"))) return result();
  const second = await watch(askUntil(rig, mine(SECOND.question), (d) => d.state === "open", REPLY_MS), "the second ask");
  if (!check(`the second ask is open (${second?.id ?? "none"})`, second !== null) || second === null) return result();
  const id2 = second.id;
  await watch(waitIdle(rig, pane, REPLY_MS), "the end of turn 4");

  const other = crypto.randomUUID();
  const foreign = await hookAsks(pane, promptPayload(other, "Anything new?"));
  const stillOpen = (await asks(rig)).find((d) => d.id === id2);
  check(`the hook prints nothing for another session id in the same pane (${JSON.stringify(foreign.slice(0, 80))}), and the ask stays open (${askWords(stillOpen)})`, foreign === "" && stillOpen?.state === "open");
  const own = await hookAsks(pane, promptPayload(sessionId, "Anything new?"));
  check(`the hook lists the ask for the pane's own session id (control)`, own.includes(id2) && own.includes('"hookEventName":"UserPromptSubmit"'));

  // ── Part 2: the resume, in the same pane ──────────────────────────────────────────────────────
  const exitAt = Date.now();
  await rig.keys(pane, [..."/exit", "Enter"]);
  const shell = await rig.until(() => rig.pane(pane), (p) => p !== null && p.agent !== SETUPS[H].agent, 20_000, 250);
  const shellAt = Date.now();
  if (!check(`Claude exited and the pane is a shell (${shell?.agent ?? "?"}) after ${String(shellAt - exitAt)} ms`, shell !== null)) return result();
  paneRun(pane, `${sq(harnessDirs(H, "lead", ASKS_FOLDER).start)} --resume ${sessionId}`);
  const back = await rig.until(() => rig.pane(pane), (p) => p !== null && p.agent === SETUPS[H].agent && freeSurface(p), 60_000, 250);
  const gap = Date.now() - shellAt;
  check(`claude --resume is up in the same pane ${String(gap)} ms after the shell showed (the sweep needs ${String(SWEEP_MS)} ms twice; margin ${String(SWEEP_MS - gap)} ms)`, back !== null && gap < SWEEP_MS - 3000);
  const address1 = await instanceOf(rig, pane);
  check(`the pane's address is the same (#${address0 ?? "?"} then #${address1 ?? "?"})`, address0 !== null && address0 === address1);
  // Two sweeps after the gap: the ask must still be open, not closed as "target session ended".
  await sleep(SWEEP_MS + 2000);
  const afterGap = (await asks(rig)).find((d) => d.id === id2);
  check(`the second ask is still open a sweep after the resume (${askWords(afterGap)})`, afterGap?.state === "open");
  const resumed = await rig.until(() => hookAsks(pane, promptPayload(sessionId, "Anything new?")), (out) => out.includes(id2), 10_000, 1000);
  check("the hook lists the ask for the resumed session (control: the resume edge named the same session id)", resumed !== null);

  seen = (await stubReminders()).length;
  spendTurn(H, "asks: the prompt that settles the second ask, after the resume");
  if (!check("turn 5 sent", await send(SETTLE_SECOND, "send: the prompt that settles the second ask"))) return result();
  const closed2 = await watch(askUntil(rig, (d) => d.id === id2, (d) => d.state !== "open", REPLY_MS), "the resumed agent to close the second ask");
  await watch(waitIdle(rig, pane, REPLY_MS), "the end of turn 5");
  const sent5 = await remindersSince(seen);
  check(`Claude sent turn 5, after the resume, with the reminder naming the second ask (${JSON.stringify(sent5)})`, sent5.some((t) => t.startsWith("UserPromptSubmit: Collie: ") && t.includes(id2)));
  check(`the resumed agent closed the second ask as answered in the session (${askWords(closed2)})`, closed2 !== null && closed2.state === "withdrawn" && closed2.closedReason === HILL_ASK_ANSWERED_HERE);
  captures.push(await captureScreen(rig, pane, "asks-38-part2"));
  return result();
}
