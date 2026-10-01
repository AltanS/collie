// Spec M37/03: the real dialogs, and a send to a busy agent.
//
// Each dialog is opened the way a person meets it: a fixed, cheap prompt asks the agent to do
// something that needs permission, and Herdr's own agent state says when the dialog is up
// (`blocked`). From there the same split as scenarios.ts holds. WHETHER the dialog came is judged
// without Collie (Herdr's state, a screen that held still); WHAT the phone makes of it is judged with
// Collie's readers only: the card kind, the option labels, the free-text lock. A model that answers
// in words instead of calling the tool reads as `not-reached`, never as a pass or a fail.
//
// Keys are pressed only where the recipe was measured live on 2026-09-26: a permission dialog's "No"
// digit (declines), Escape out of the Tab amend note (declines), an AskUserQuestion option's digit
// (answers), Codex's approval decline, and OpenCode's pointer walk (Right, then Enter) and Escape.
// Every decline is checked in the project folder too: the file the prompt asked for must not exist.
// Plan approval is read, never answered: its keys were not probed on 2.1.283.

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CODEX_ARGS } from "./agents/codex";
import { launchLine } from "./agents/profile";
import { Driver, POLL_MS, answeredBelow, wordsOnScreen, type AgentContext, type Screen } from "./scenarios";
import { failCase, notReachedCase, passCase, type CaseResult } from "./verdict";

const BLOCKED_TIMEOUT_MS = 120_000;
const SETTLE_TIMEOUT_MS = 60_000;
const BUSY_START_TIMEOUT_MS = 20_000;
const BUSY_TURN_TIMEOUT_MS = 180_000;
/** Once Herdr says the turn ended without a dialog, how long to keep waiting for one anyway. */
const NO_DIALOG_GRACE_MS = 5_000;
/** Pointer moves looking for a row, at most. */
const MAX_WALK = 8;

/** The fields of a `prompt-select` block the canary reads. Restated, as in readers.ts. */
interface PromptOptionLike {
  readonly label: string;
  readonly keys: readonly string[];
}
interface PromptLike {
  readonly question: string;
  readonly family: string;
  readonly options: readonly PromptOptionLike[];
  readonly feedback?: { readonly focused: boolean };
}

function promptOf(s: Screen): PromptLike | null {
  const block = s.blocks.find((b) => b.kind === "prompt-select");
  if (block === undefined || !("prompt" in block)) return null;
  // SAFETY: a `prompt-select` block carries its PromptModel in `prompt` (web/src/lib/blocks.ts); the
  // fields restated in PromptLike are a subset of it, and the readers are loaded from that checkout.
  return block.prompt as PromptLike;
}

function lifted(s: Screen): string {
  const kinds = s.blocks.filter((b) => b.kind !== "raw").map((b) => b.kind);
  return kinds.length === 0 ? "raw only" : kinds.join(",");
}

/** What the canary expects the phone to make of a dialog screen. */
interface Expect {
  /** The prompt family, when it matters. */
  readonly family?: string;
  /** Whether the free-text row must be focused (true), present and not focused (false), or either. */
  readonly focused?: boolean;
  /** Labels (case-insensitive substrings) that must be among the options. */
  readonly labels?: readonly string[];
}

/** The reader's verdict on one dialog screen, as a case. */
function judgePrompt(d: Driver, s: Screen, id: string, want: Expect): CaseResult {
  const file = d.save(`dialogs-${id}`, s);
  const p = promptOf(s);
  const problems: string[] = [];
  if (s.unread) problems.push("unread card");
  if (p === null) problems.push(`no choice card (${lifted(s)})`);
  else {
    if (want.family !== undefined && p.family !== want.family) problems.push(`family ${p.family}, not ${want.family}`);
    for (const label of want.labels ?? []) {
      if (!p.options.some((o) => o.label.toLowerCase().includes(label.toLowerCase()))) problems.push(`no "${label}" option`);
    }
    if (want.focused !== undefined) {
      if (p.feedback === undefined) problems.push("no free-text row");
      else if (p.feedback.focused !== want.focused) problems.push(want.focused ? "free-text row not locked" : "buttons still locked");
    }
  }
  if (problems.length > 0) return failCase(id, `${problems.join(", ")} (${file})`);
  const labels = p!.options.map((o) => o.label.split(/\s+/).slice(0, 3).join(" ")).join(" / ");
  return passCase(id, `${p!.family}: ${labels}${p!.feedback?.focused ? ", locked" : ""}`);
}

/** Type a prompt and submit it. This is setup, not the path under test: the sends scenario tests that. */
async function prompt(d: Driver, text: string): Promise<void> {
  d.ctx.session.sendText(d.paneId, text);
  await Bun.sleep(300);
  d.ctx.session.sendKeys(d.paneId, ["Enter"]);
}

/** Two reads in a row with the same bytes: the screen stopped moving. */
async function stable(d: Driver): Promise<Screen> {
  let last = await d.screen();
  for (let i = 0; i < 20; i++) {
    await Bun.sleep(POLL_MS * 2);
    const s = await d.screen();
    if (s.text === last.text) return s;
    last = s;
  }
  return last;
}

/**
 * Wait until Herdr says the agent is blocked on a dialog and the screen holds still. Null when the
 * turn ended without one, or nothing came in time.
 */
async function waitBlocked(d: Driver, timeoutMs = BLOCKED_TIMEOUT_MS): Promise<Screen | null> {
  const deadline = Date.now() + timeoutMs;
  let quietSince: number | null = null;
  let sawWork = false;
  while (Date.now() < deadline) {
    await Bun.sleep(POLL_MS * 2);
    const info = d.ctx.session.paneInfo(d.paneId);
    if (info.status === "blocked") return stable(d);
    if (info.status === "working") {
      sawWork = true;
      quietSince = null;
    } else if (sawWork && (info.status === "idle" || info.status === "done")) {
      quietSince ??= Date.now();
      if (Date.now() - quietSince >= NO_DIALOG_GRACE_MS) return null;
    }
  }
  return null;
}

/** Wait until the dialog is gone and the agent is idle again (Herdr's word, held for two polls). */
async function waitSettled(d: Driver, timeoutMs = SETTLE_TIMEOUT_MS): Promise<Screen | null> {
  const deadline = Date.now() + timeoutMs;
  let held = 0;
  while (Date.now() < deadline) {
    await Bun.sleep(POLL_MS * 2);
    held = d.herdrIdle() ? held + 1 : 0;
    if (held >= 2) return stable(d);
  }
  return null;
}

/**
 * The trimmed text after `pointer` on the LAST row that starts with it. Not the first: Claude echoes
 * every earlier prompt in the transcript as `❯ …`, so only the lowest pointer is the dialog's.
 */
export function lastPointedRow(texts: readonly string[], pointer: string): string | null {
  for (let i = texts.length - 1; i >= 0; i--) {
    const trimmed = texts[i]!.trim();
    if (trimmed.startsWith(pointer)) return trimmed.slice(pointer.length).trim();
  }
  return null;
}

/** Press Down (or Up) until the row the pointer is on matches `row`. The screen at that point, or null. */
async function walkTo(d: Driver, pointer: string, row: RegExp, key: "Down" | "Up"): Promise<Screen | null> {
  for (let i = 0; i <= MAX_WALK; i++) {
    const s = await stable(d);
    const pointed = lastPointedRow(s.texts, pointer);
    if (pointed !== null && row.test(pointed)) return s;
    d.keys([key]);
  }
  return null;
}

/** Press an option's keys, wait for the agent to settle, and check the project for `file`. */
async function decline(d: Driver, id: string, s: Screen, option: RegExp, file: string | null): Promise<CaseResult> {
  const p = promptOf(s);
  const choice = p?.options.find((o) => option.test(o.label));
  if (choice === undefined) return failCase(id, `no option matching ${String(option)} to press`);
  d.keys(choice.keys);
  const after = await waitSettled(d);
  if (after === null) {
    d.save(`dialogs-${id}-stuck`, await d.screen());
    return failCase(id, `pressed ${choice.keys.join(" ")} for "${choice.label}"; the agent did not settle`);
  }
  d.save(`dialogs-${id}`, after);
  if (file !== null && existsSync(join(d.ctx.project, file))) return failCase(id, `pressed "${choice.label}", but ${file} was written`);
  if (promptOf(after) !== null) return failCase(id, `pressed "${choice.label}"; a choice card is still up`);
  return passCase(id, `pressed ${choice.keys.join(" ")}, declined`);
}

function unreached(ids: readonly string[], why: string): CaseResult[] {
  return ids.map((id) => notReachedCase(id, why));
}

const PERMISSION_IDS = ["permission-row1", "permission-row2", "permission-row3", "permission-no"];

/** Claude: permission (pointer on each row, No), Tab amend, WebFetch, AskUserQuestion, plan approval. */
async function claudeDialogs(ctx: AgentContext): Promise<CaseResult[]> {
  const cases: CaseResult[] = [];
  const d = await Driver.open(ctx, "canary-claude-dialogs", ctx.options.cols, "dialogs");
  try {
    if ((await d.launch([])) === null) return unreached(["dialogs"], "Claude never came up idle");

    // A Bash permission dialog, with the pointer on each row. Before 2.1.283's fix the rows below
    // the first lost the "Tab to amend" hint and read as an unread dialog.
    await prompt(d, "Use the Bash tool to run exactly this command and nothing else: touch canary-perm.txt");
    let s = await waitBlocked(d);
    if (s === null) cases.push(...unreached(PERMISSION_IDS, "no permission dialog came"));
    else {
      cases.push(judgePrompt(d, s, "permission-row1", { family: "permission", labels: ["Yes", "No"] }));
      for (const row of [2, 3]) {
        d.keys(["Down"]);
        s = await stable(d);
        cases.push(judgePrompt(d, s, `permission-row${row}`, { family: "permission", labels: ["Yes", "No"] }));
      }
      cases.push(await decline(d, "permission-no", s, /^No\b/i, "canary-perm.txt"));
    }

    // The same dialog after Tab: the amend note is a text field, so the buttons lock.
    await prompt(d, "Use the Bash tool to run exactly this command and nothing else: touch canary-amend.txt");
    s = await waitBlocked(d);
    if (s === null) cases.push(...unreached(["permission-amend", "permission-amend-escape"], "no permission dialog came"));
    else {
      d.keys(["Tab"]);
      s = await stable(d);
      cases.push(judgePrompt(d, s, "permission-amend", { family: "permission", focused: true }));
      d.keys(["Escape"]);
      const after = await waitSettled(d);
      if (after === null) cases.push(failCase("permission-amend-escape", "Escape from the amend note left the agent unsettled"));
      else if (existsSync(join(ctx.project, "canary-amend.txt"))) cases.push(failCase("permission-amend-escape", "canary-amend.txt was written"));
      else cases.push(passCase("permission-amend-escape", "Escape declined"));
    }

    // WebFetch paints no footer at all; the dialog is known by its own words.
    await prompt(d, "Use the WebFetch tool to fetch https://example.com and then reply with only the page title.");
    s = await waitBlocked(d);
    if (s === null) cases.push(...unreached(["webfetch", "webfetch-no"], "no WebFetch permission dialog came"));
    else {
      cases.push(judgePrompt(d, s, "webfetch", { family: "permission", labels: ["Yes", "No"] }));
      cases.push(await decline(d, "webfetch-no", s, /^No\b/i, null));
    }

    // AskUserQuestion, with the pointer on "Type something" (a text field: buttons lock) and off it.
    await prompt(
      d,
      "Use the AskUserQuestion tool to ask me exactly one question, 'Which fruit?', with the two options Apple and Banana. After I answer, reply with only my answer.",
    );
    s = await waitBlocked(d);
    const askIds = ["ask-open", "ask-type-focused", "ask-type-left", "ask-answer"];
    if (s === null) cases.push(...unreached(askIds, "no AskUserQuestion dialog came"));
    else {
      cases.push(judgePrompt(d, s, "ask-open", { labels: ["Apple", "Banana"] }));
      const onField = await walkTo(d, "❯", /Type something/i, "Down");
      if (onField === null) cases.push(...unreached(["ask-type-focused", "ask-type-left"], "the pointer never reached Type something"));
      else {
        cases.push(judgePrompt(d, onField, "ask-type-focused", { focused: true }));
        d.keys(["Up"]);
        cases.push(judgePrompt(d, await stable(d), "ask-type-left", { focused: false, labels: ["Apple"] }));
      }
      const open = await stable(d);
      const apple = promptOf(open)?.options.find((o) => /Apple/i.test(o.label));
      if (apple === undefined) cases.push(failCase("ask-answer", "no Apple option to press"));
      else {
        d.keys(apple.keys);
        const after = await waitSettled(d);
        if (after === null) cases.push(failCase("ask-answer", `pressed ${apple.keys.join(" ")}; the agent did not settle`));
        else {
          d.save("dialogs-ask-answer", after);
          const answered = after.texts.some((t) => /Apple/.test(t)) && promptOf(after) === null;
          cases.push(answered ? passCase("ask-answer", `pressed ${apple.keys.join(" ")}, answered Apple`) : failCase("ask-answer", "no Apple answer on screen"));
        }
      }
    }
  } finally {
    d.close();
  }

  // Plan approval, in a pane started in plan mode. Read only: its keys were not probed on 2.1.283.
  const p = await Driver.open(ctx, "canary-claude-plan", ctx.options.cols, "plan");
  try {
    if ((await p.launch([], launchLine(ctx.options.cols, "claude --model haiku --permission-mode plan"))) === null) {
      cases.push(notReachedCase("plan-approval", "Claude never came up idle in plan mode"));
    } else {
      await prompt(p, "Plan how to add the line 'hello' to README.md. Keep the plan to two short steps, then present it for my approval.");
      const s = await waitBlocked(p, BLOCKED_TIMEOUT_MS * 1.5);
      if (s === null) cases.push(notReachedCase("plan-approval", "no plan approval dialog came"));
      else {
        const file = p.save("dialogs-plan-approval", s);
        const kinds = lifted(s);
        cases.push(
          s.unread || kinds === "raw only"
            ? failCase("plan-approval", `${s.unread ? "unread card" : "raw only"} (${file})`)
            : passCase("plan-approval", kinds),
        );
      }
    }
  } finally {
    p.close();
  }
  return cases;
}

/** Codex, started so that it asks: command approval and patch approval, both declined. */
async function codexDialogs(ctx: AgentContext): Promise<CaseResult[]> {
  const cases: CaseResult[] = [];
  const d = await Driver.open(ctx, "canary-codex-dialogs", ctx.options.cols, "dialogs");
  const command = `codex ${CODEX_ARGS} -c approvals_reviewer=user -a on-request -s read-only`;
  try {
    if ((await d.launch([], launchLine(ctx.options.cols, command))) === null) return unreached(["dialogs"], "Codex never came up idle");
    const declineRow = /^(No\b|Don'?t|Deny|Decline|Cancel|Reject)/i;

    await prompt(d, "Run this shell command and nothing else: touch canary-exec.txt");
    let s = await waitBlocked(d);
    if (s === null) cases.push(...unreached(["exec-approval", "exec-decline"], "no command approval came"));
    else {
      cases.push(judgePrompt(d, s, "exec-approval", {}));
      cases.push(await decline(d, "exec-decline", s, declineRow, "canary-exec.txt"));
    }

    await prompt(d, "Create a file named canary-patch.txt that contains the word hi. Use your file editing tool, not the shell.");
    s = await waitBlocked(d);
    if (s === null) cases.push(...unreached(["patch-approval", "patch-decline"], "no patch approval came"));
    else {
      cases.push(judgePrompt(d, s, "patch-approval", {}));
      cases.push(await decline(d, "patch-decline", s, declineRow, "canary-patch.txt"));
    }
  } finally {
    d.close();
  }
  return cases;
}

/** Poll stable screens until `test` holds, or the time runs out. The last screen either way. */
async function waitScreen(d: Driver, test: (s: Screen) => boolean, timeoutMs = 10_000): Promise<Screen> {
  const deadline = Date.now() + timeoutMs;
  let s = await stable(d);
  while (!test(s) && Date.now() < deadline) {
    await Bun.sleep(POLL_MS * 2);
    s = await stable(d);
  }
  return s;
}

const onScreen = (words: string) => (s: Screen) => s.texts.some((t) => t.includes(words));

/**
 * The scratch config OpenCode is started with for this scenario: ask before bash and before an
 * edit. A file in the run's own capture folder, passed by `OPENCODE_CONFIG` for this one process,
 * which OpenCode merges over its usual config; nothing in `~/.config/opencode` is written.
 */
const OPENCODE_ASK = { $schema: "https://opencode.ai/config.json", permission: { bash: "ask", edit: "ask" } };

/**
 * OpenCode, started so that it asks: the permission dialog, its "Always allow" step, then two
 * declines, Reject by the walk the button sends and Escape, the adapter's declared cancel key.
 * Confirm on the "Always allow" step is never pressed: it would allow the pattern until OpenCode
 * restarts.
 */
async function opencodeDialogs(ctx: AgentContext): Promise<CaseResult[]> {
  const cases: CaseResult[] = [];
  const config = join(ctx.dir, "opencode-ask.json");
  writeFileSync(config, `${JSON.stringify(OPENCODE_ASK, null, 2)}\n`);
  const d = await Driver.open(ctx, "canary-opencode-dialogs", ctx.options.cols, "dialogs");
  const labels = ["Allow once", "Allow always", "Reject"];
  try {
    if ((await d.launch([], launchLine(ctx.options.cols, `OPENCODE_CONFIG=${config} opencode`))) === null) {
      return unreached(["dialogs"], "OpenCode never came up idle");
    }

    // The bash dialog, then "Allow always", which opens a second step with Confirm and Cancel.
    // Cancel goes back to the first step, and Reject declines it.
    await prompt(d, "Use the bash tool to run exactly this command and nothing else: touch canary-perm.txt");
    let s = await waitBlocked(d);
    const ids = ["permission", "permission-always", "permission-always-cancel", "permission-reject"];
    if (s === null) cases.push(...unreached(ids, "no permission dialog came"));
    else {
      cases.push(judgePrompt(d, s, "permission", { family: "permission", labels }));
      const always = promptOf(s)?.options.find((o) => o.label === "Allow always");
      if (always === undefined) cases.push(failCase("permission-always", "no Allow always option to press"));
      else {
        d.keys(always.keys);
        s = await waitScreen(d, onScreen("△ Always allow"));
        cases.push(judgePrompt(d, s, "permission-always", { family: "permission", labels: ["Confirm", "Cancel"] }));
        const cancel = promptOf(s)?.options.find((o) => o.label === "Cancel");
        if (cancel === undefined) cases.push(failCase("permission-always-cancel", "no Cancel option to press"));
        else {
          d.keys(cancel.keys);
          s = await waitScreen(d, onScreen("△ Permission required"));
          cases.push(judgePrompt(d, s, "permission-always-cancel", { family: "permission", labels }));
        }
      }
      cases.push(await decline(d, "permission-reject", s, /^Reject$/, "canary-perm.txt"));
    }

    // An edit, declined with Escape: the one key the unread-dialog card would offer.
    await prompt(d, "Create a file named canary-edit.txt that contains the word hi. Use your file write tool, not the shell.");
    s = await waitBlocked(d);
    if (s === null) cases.push(...unreached(["edit-permission", "edit-escape"], "no edit permission dialog came"));
    else {
      cases.push(judgePrompt(d, s, "edit-permission", { family: "permission", labels }));
      d.keys(["Escape"]);
      const after = await waitSettled(d);
      if (after === null) cases.push(failCase("edit-escape", "Escape left the agent unsettled"));
      else {
        d.save("dialogs-edit-escape", after);
        if (existsSync(join(ctx.project, "canary-edit.txt"))) cases.push(failCase("edit-escape", "canary-edit.txt was written"));
        else if (promptOf(after) !== null) cases.push(failCase("edit-escape", "Escape; a choice card is still up"));
        else cases.push(passCase("edit-escape", "Escape declined"));
      }
    }
  } finally {
    d.close();
  }
  return cases;
}

/** The dialogs scenario for one agent. Claude, Codex and OpenCode have dialog readers to test. */
export async function runDialogs(ctx: AgentContext): Promise<CaseResult[]> {
  if (ctx.profile.agent === "claude") return claudeDialogs(ctx);
  if (ctx.profile.agent === "codex") return codexDialogs(ctx);
  if (ctx.profile.agent === "opencode") return opencodeDialogs(ctx);
  return [notReachedCase("dialogs", "Collie has no dialog reader for this agent")];
}

const BUSY_PROMPT = "Write a 500-word story about a sheepdog. Use no tools.";
const QUEUED = "Queued note: reply with only OK.";

/**
 * The busy scenario: start a long answer, send a message through the real reply path while the
 * agent works, and check that it was taken (queued or steered, the agent's choice) and answered.
 * Every screen sampled while the agent works is also judged for an unread card.
 */
export async function runBusy(ctx: AgentContext): Promise<CaseResult[]> {
  const agent = ctx.profile.agent;
  const d = await Driver.open(ctx, `canary-${agent}-busy`, ctx.options.cols, "busy");
  try {
    if ((await d.launch([])) === null) return [notReachedCase("busy-send", "the agent never came up idle")];
    await prompt(d, BUSY_PROMPT);
    const startDeadline = Date.now() + BUSY_START_TIMEOUT_MS;
    while (Date.now() < startDeadline && ctx.session.paneInfo(d.paneId).status !== "working") await Bun.sleep(POLL_MS);
    await Bun.sleep(1_000);
    if (ctx.session.paneInfo(d.paneId).status !== "working") return [notReachedCase("busy-send", "the agent was not working when the send was due")];

    const busyScreen = await d.screen();
    d.save("busy-before", busyScreen);
    const outcome = await ctx.readers.sendGuardedReply(d.paneId, QUEUED, agent);
    const cases: CaseResult[] = [];
    let cardAt: Screen | null = busyScreen.unread ? busyScreen : null;
    if (outcome.status !== "sent") {
      d.save("busy-send", await d.screen());
      return [failCase("busy-send", `outcome ${outcome.status}: ${outcome.error}`)];
    }
    let s = await d.screen();
    let held = 0;
    const deadline = Date.now() + BUSY_TURN_TIMEOUT_MS;
    let answered = false;
    while (Date.now() < deadline) {
      s = await d.screen();
      if (s.unread && cardAt === null) cardAt = s;
      held = d.herdrIdle() ? held + 1 : 0;
      const inBox = s.draft !== null && ctx.readers.draftCarriesSend(QUEUED, s.draft);
      if (held >= 2 && !inBox && wordsOnScreen(s.texts, QUEUED) && answeredBelow(s.texts, QUEUED)) {
        answered = true;
        break;
      }
      await Bun.sleep(POLL_MS * 2);
    }
    d.save("busy-send", s);
    if (answered) cases.push(passCase("busy-send", "sent while working, then answered"));
    else if (s.draft !== null && ctx.readers.draftCarriesSend(QUEUED, s.draft)) cases.push(failCase("busy-send", "outcome sent, but the message is still in the input box"));
    else cases.push(notReachedCase("busy-send", `outcome sent; no answer below it in ${BUSY_TURN_TIMEOUT_MS / 1000} s`));
    cases.push(cardAt === null ? passCase("busy-no-card", "no unread card while working") : failCase("busy-no-card", `unread card while working (${d.save("busy-unread", cardAt)})`));
    return cases;
  } finally {
    d.close();
  }
}
