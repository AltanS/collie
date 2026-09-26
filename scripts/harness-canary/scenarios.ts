// The five scenarios, driven against one agent in panes the canary created.
//
// Two kinds of evidence, kept apart on purpose. WHETHER a screen was reached is judged without
// Collie: Herdr's own agent state and the screen's plain text (did the typed words appear at all).
// WHAT the phone makes of that screen is judged with Collie's readers only. So a reader that has
// gone blind reads as `fail`, and a screen that never came reads as `not-reached`, never the other
// way round. Nothing here compares bytes: every check is a reader's answer or a phrase on screen.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NARROW_COLS, type CanaryOptions } from "./args";
import type { AgentProfile } from "./agents/profile";
import type { CanarySession } from "./herdr";
import { MESSAGES, NARROW_DRAFT_IDS, SEND_IDS, messageById, type CanaryMessage } from "./messages";
import type { Adapter, Block, Line, Readers } from "./readers";
import type { Transport } from "./transport";
import { failCase, notReachedCase, passCase, scenarioResult, type CaseResult, type ScenarioId, type ScenarioResult } from "./verdict";

const POLL_MS = 150;
const START_TIMEOUT_MS = 45_000;
const DRAFT_TIMEOUT_MS = 4_000;
const CLEAR_TIMEOUT_MS = 4_000;
const TURN_TIMEOUT_MS = 120_000;
const SEND_TIMEOUT_MS = 60_000;
const EXIT_TIMEOUT_MS = 12_000;
/** How long the exit window keeps sampling once the shell is back. */
const EXIT_TAIL_MS = 1_500;
/** Herdr sends at most this many keys per call, so a long Backspace sweep goes out in batches. */
const KEY_BATCH = 100;
/** The rows at the foot of the screen where an agent's input box lives. */
const COMPOSER_ROWS = 30;

/** One read of the pane, and everything the canary asks of it. */
export interface Screen {
  readonly text: string;
  readonly lines: Line[];
  /** Plain text per row. */
  readonly texts: string[];
  readonly blocks: Block[];
  /** The adapter's answer, or null when the agent has no adapter or the adapter no composer gate. */
  readonly composer: boolean | null;
  /** The adapter's draft, or null when there is none or no adapter. */
  readonly draft: string | null;
  readonly unread: boolean;
  readonly rawOnly: boolean;
}

export interface AgentContext {
  readonly profile: AgentProfile;
  readonly version: string;
  readonly session: CanarySession;
  readonly transport: Transport;
  readonly readers: Readers;
  readonly options: CanaryOptions;
  /** The fresh git project every pane starts in. */
  readonly project: string;
  /** Where this agent's captures go: `<out>/<run-id>/<agent>-<version>/`. */
  readonly dir: string;
  readonly log: (line: string) => void;
}

/** Run every selected scenario for one agent. Always closes the panes it opened. */
export async function runAgent(ctx: AgentContext): Promise<ScenarioResult[]> {
  mkdirSync(ctx.dir, { recursive: true });
  const want = (s: ScenarioId) => ctx.options.scenarios.includes(s);
  const agent = ctx.profile.agent;
  const results: ScenarioResult[] = [];
  const startExit: CaseResult[] = [];

  if (want("idle") || want("drafts") || want("sends") || want("start-exit")) {
    const d = await Driver.open(ctx, `canary-${agent}`, ctx.options.cols, "wide");
    try {
      const ready = await d.launch(startExit);
      if (want("idle")) results.push(scenarioResult(agent, "idle", [ready ? d.judgeIdle(ready, "idle") : notStarted("idle")]));
      let clean = ready !== null;
      if (want("drafts")) {
        const cases: CaseResult[] = [];
        for (const m of MESSAGES) {
          if (!clean) {
            cases.push(notReachedCase(m.id, ready ? "an earlier draft could not be cleared" : "the agent never showed its composer"));
            continue;
          }
          const r = await d.draft(m, `drafts-${m.id}`);
          cases.push(r.result);
          clean = r.cleared;
        }
        results.push(scenarioResult(agent, "drafts", cases));
      }
      if (want("sends")) {
        const cases: CaseResult[] = [];
        let live = clean;
        for (const id of SEND_IDS) {
          if (!live) {
            cases.push(notReachedCase(id, ready ? "the pane was not back at an empty composer" : "the agent never showed its composer"));
            continue;
          }
          const r = await d.send(messageById(id));
          cases.push(r.result);
          live = r.idleAfter;
        }
        results.push(scenarioResult(agent, "sends", cases));
      }
      if (ready) startExit.push(await d.exit());
    } finally {
      d.close();
    }
  }

  if (want("narrow")) {
    const d = await Driver.open(ctx, `canary-${agent}-narrow`, NARROW_COLS, "narrow");
    try {
      const ready = await d.launch(startExit);
      const cases: CaseResult[] = [ready ? d.judgeIdle(ready, "idle-50") : notStarted("idle-50")];
      let clean = ready !== null;
      for (const id of NARROW_DRAFT_IDS) {
        if (!clean) {
          cases.push(notReachedCase(`draft-50-${id}`, "the composer was not reached or not cleared"));
          continue;
        }
        const r = await d.draft(messageById(id), `narrow-${id}`);
        cases.push({ ...r.result, id: `draft-50-${id}` });
        clean = r.cleared;
      }
      results.push(scenarioResult(agent, "narrow", cases));
      if (ready) startExit.push(await d.exit());
    } finally {
      d.close();
    }
  }

  if (want("start-exit")) results.push(scenarioResult(agent, "start-exit", startExit));
  return results;
}

function notStarted(id: string): CaseResult {
  return notReachedCase(id, "the agent never came up idle");
}

/** The first few visible characters of each line of `text`: what "the words are on screen" means. */
function probes(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.replace(/\s+/g, ""))
    .map((l) => [...l].slice(0, 10).join(""))
    // A probe needs a letter or a digit: a `────` rule alone would match the input box's own frame.
    .filter((p) => p.length >= 4 && /[\p{L}\p{N}]/u.test(p));
}

/** Whether the typed words, or the paste placeholder an agent swaps them for, are on these rows. */
function wordsOnScreen(texts: readonly string[], text: string): boolean {
  const flat = texts.join("").replace(/\s+/g, "");
  if (/\[Pasted (text|Content)/i.test(texts.join(" "))) return true;
  return probes(text).some((p) => flat.includes(p));
}

/** The reply every canary message asks for: a row that is just "OK", after a bullet or not. */
const OK_ROW = /^\s*(?:[⏺•●▣>*-]\s*)?OK[.。!]?\s*$/u;

/** Whether an "OK" row stands below the last row that carries `text`'s last line. */
function answeredBelow(texts: readonly string[], text: string): boolean {
  const last = probes(text).at(-1);
  if (last === undefined) return false;
  let at = -1;
  texts.forEach((t, i) => {
    if (t.replace(/\s+/g, "").includes(last)) at = i;
  });
  return at >= 0 && texts.slice(at + 1).some((t) => OK_ROW.test(t));
}

class Driver {
  private constructor(
    private readonly ctx: AgentContext,
    private readonly workspaceId: string,
    private readonly paneId: string,
    private readonly cols: number | null,
    private readonly tag: string,
  ) {}

  static async open(ctx: AgentContext, label: string, cols: number | null, tag: string): Promise<Driver> {
    const { workspaceId, paneId } = ctx.session.createWorkspace(ctx.project, label);
    ctx.log(`  ${label}: workspace ${workspaceId}, pane ${paneId}`);
    const d = new Driver(ctx, workspaceId, paneId, cols, tag);
    await d.shellReady();
    return d;
  }

  private get agent(): string {
    return this.ctx.profile.agent;
  }

  private get adapter(): Adapter | undefined {
    return this.ctx.readers.adapterFor(this.agent);
  }

  close(): void {
    try {
      this.ctx.session.closeWorkspace(this.workspaceId);
    } catch (err) {
      this.ctx.log(`  close ${this.workspaceId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async screen(): Promise<Screen> {
    const text = await this.ctx.transport.readScreen(this.paneId);
    const r = this.ctx.readers;
    const lines = r.parse(text);
    const texts = lines.map((l) => r.lineText(l));
    const blocks = r.buildBlocks(lines, this.agent);
    const adapter = this.adapter;
    return {
      text,
      lines,
      texts,
      blocks,
      composer: adapter?.composerReady ? adapter.composerReady(lines) : null,
      draft: adapter ? adapter.extractInputDraft(lines) : null,
      unread: blocks.some((b) => b.kind === "unread-dialog"),
      rawOnly: blocks.every((b) => b.kind === "raw"),
    };
  }

  private save(name: string, s: Screen): string {
    const file = join(this.ctx.dir, `${name}.ansi`);
    writeFileSync(file, s.text);
    return file;
  }

  private keys(keys: readonly string[]): void {
    for (let i = 0; i < keys.length; i += KEY_BATCH) this.ctx.session.sendKeys(this.paneId, keys.slice(i, i + KEY_BATCH));
  }

  /** The fresh shell has painted its prompt: the screen has text and held still across two reads. */
  private async shellReady(): Promise<void> {
    let last = "";
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      await Bun.sleep(300);
      const s = await this.ctx.transport.readScreen(this.paneId);
      if (s.trim() !== "" && s === last) return;
      last = s;
    }
    throw new Error(`pane ${this.paneId}: the shell never settled`);
  }

  /** Herdr sees the agent in the pane and calls it ready for input. */
  private herdrIdle(): boolean {
    const info = this.ctx.session.paneInfo(this.paneId);
    return info.agent === this.agent && (info.status === "idle" || info.status === "done");
  }

  /**
   * Start the agent and sample every ~150 ms until it is idle. Every sample of the start window is
   * judged for an unread card (scenario 5) and pushed to `startExit`. Startup questions the profile
   * knows (folder trust) are answered and end the window: from there on the screen is the agent's.
   * Returns the idle screen, or null when the agent never came up.
   */
  async launch(startExit: CaseResult[]): Promise<Screen | null> {
    const label = `start-${this.tag}`;
    this.ctx.session.sendText(this.paneId, this.ctx.profile.launch(this.cols));
    await Bun.sleep(200);
    this.ctx.session.sendKeys(this.paneId, ["Enter"]);
    let window = true;
    let samples = 0;
    let unreadAt: Screen | null = null;
    let previous = "";
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await Bun.sleep(POLL_MS);
      const s = await this.screen();
      const answer = this.ctx.profile.startupAnswer(s.texts);
      if (window) {
        samples += 1;
        if (s.unread && unreadAt === null) unreadAt = s;
      }
      if (answer !== null) {
        // A startup question is the agent's own screen: the start window ends at its first frame.
        if (window) startExit.push(this.windowCase(label, samples, unreadAt, "while starting"));
        window = false;
        this.ctx.session.sendKeys(this.paneId, answer);
        await Bun.sleep(600);
        previous = "";
        continue;
      }
      // Idle means Herdr says so AND the screen held still for one poll: a first frame can be
      // idle by Herdr's reckoning while the agent is still painting.
      const idle = this.herdrIdle() && s.text === previous;
      previous = s.text;
      if (!idle) continue;
      if (window) startExit.push(this.windowCase(label, samples, unreadAt, "while starting"));
      return s;
    }
    const s = await this.screen();
    this.save(`${label}-timeout`, s);
    startExit.push(
      unreadAt !== null
        ? this.windowCase(label, samples, unreadAt, "while starting")
        : notReachedCase(label, `not idle after ${START_TIMEOUT_MS / 1000} s`),
    );
    this.ctx.log(`  ${this.agent}: not idle after ${START_TIMEOUT_MS / 1000} s`);
    return null;
  }

  private windowCase(id: string, samples: number, unreadAt: Screen | null, when: string): CaseResult {
    if (unreadAt === null) return passCase(id, `${samples} samples, no unread card`);
    const file = this.save(`${id}-unread`, unreadAt);
    return failCase(id, `unread card ${when} (${file})`);
  }

  /** Scenario 1 (and the idle half of 4): what the phone reads on the idle screen. */
  judgeIdle(s: Screen, id: string): CaseResult {
    this.save(id, s);
    const problems: string[] = [];
    if (this.adapter?.composerReady && s.composer !== true) problems.push("composer not found");
    if (s.unread) problems.push("unread card");
    if (!s.rawOnly) problems.push(`lifted ${s.blocks.filter((b) => b.kind !== "raw").map((b) => b.kind).join(",")}`);
    return problems.length === 0 ? passCase(id, this.adapter ? "composer ready, raw only" : "raw only") : failCase(id, problems.join(", "));
  }

  /**
   * Scenario 2 (and the drafts of 4): type `m` unsubmitted, judge the read, clear it. Adapter agents
   * must read the draft back, keep the composer ready and show no card; the others must show the
   * words on the raw mirror with nothing lifted.
   */
  async draft(m: CanaryMessage, name: string): Promise<{ result: CaseResult; cleared: boolean }> {
    this.ctx.session.sendText(this.paneId, m.text);
    const adapter = this.adapter;
    const deadline = Date.now() + DRAFT_TIMEOUT_MS;
    let s = await this.screen();
    let problems: string[] = ["not judged"];
    let landed = false;
    for (;;) {
      landed = wordsOnScreen(s.texts.slice(-COMPOSER_ROWS), m.text);
      problems = this.draftProblems(s, m.text, adapter);
      if ((landed && problems.length === 0) || Date.now() >= deadline) break;
      await Bun.sleep(POLL_MS);
      s = await this.screen();
    }
    this.save(name, s);
    const result = !landed
      ? notReachedCase(m.id, "the typed words never showed on screen")
      : problems.length === 0
        ? passCase(m.id)
        : failCase(m.id, problems.join(", "));
    const cleared = await this.clearDraft(m.text);
    return { result, cleared };
  }

  private draftProblems(s: Screen, sent: string, adapter: Adapter | undefined): string[] {
    const problems: string[] = [];
    if (s.unread) problems.push("unread card");
    if (adapter === undefined) {
      if (!s.rawOnly) problems.push("lifted a block");
      return problems;
    }
    if (adapter.composerReady && s.composer !== true) problems.push("composer not found");
    const carried =
      this.ctx.readers.draftCarriesSend(sent, s.draft) || (s.draft !== null && adapter.draftCarriesSend?.(sent, s.draft) === true);
    if (!carried) problems.push(`draft not read back (read ${JSON.stringify(s.draft?.slice(0, 40) ?? null)})`);
    return problems;
  }

  /** Empty the input box. True once the words are gone and the adapter reads no draft. */
  private async clearDraft(text: string): Promise<boolean> {
    const attempts: (readonly string[])[] = [this.ctx.profile.clearKeys(text), this.ctx.profile.clearKeys(text)];
    if (this.ctx.profile.clearFallback !== null) attempts.push(this.ctx.profile.clearFallback);
    for (const keys of attempts) {
      this.keys(keys);
      const deadline = Date.now() + CLEAR_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await Bun.sleep(POLL_MS * 2);
        const s = await this.screen();
        const gone = !wordsOnScreen(s.texts.slice(-COMPOSER_ROWS), text);
        if (gone && (s.draft === null || s.draft.trim() === "")) {
          // After a Ctrl+C, wait out Claude's "press again to exit" window before the next key.
          if (keys === this.ctx.profile.clearFallback) await Bun.sleep(1500);
          return true;
        }
      }
    }
    this.save(`not-cleared-${[...text].slice(0, 12).join("").replace(/\W+/g, "-")}`, await this.screen());
    this.ctx.log(`  ${this.agent}: a draft could not be cleared; the remaining drafts and sends are skipped`);
    return false;
  }

  /**
   * Scenario 3: one real send through the client's `sendGuardedReply` and the bridge's `replyPane`.
   * `sent` is the client's verdict; the message must then show in the transcript (out of the input
   * box) and the agent must answer. `idleAfter` says whether the next send may go.
   */
  async send(m: CanaryMessage): Promise<{ result: CaseResult; idleAfter: boolean }> {
    const outcome = await Promise.race([
      this.ctx.readers.sendGuardedReply(this.paneId, m.text, this.agent),
      Bun.sleep(SEND_TIMEOUT_MS).then(() => ({ status: "error" as const, error: "sendGuardedReply did not return in 60 s" })),
    ]);
    if (outcome.status !== "sent") {
      const s = await this.screen();
      this.save(`sends-${m.id}`, s);
      const cleared = await this.clearDraft(m.text);
      return { result: failCase(m.id, `outcome ${outcome.status}: ${outcome.error}`), idleAfter: cleared };
    }
    let s = await this.screen();
    let settledPolls = 0;
    const deadline = Date.now() + TURN_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const info = this.ctx.session.paneInfo(this.paneId);
      s = await this.screen();
      const inBox = s.draft !== null && this.ctx.readers.draftCarriesSend(m.text, s.draft);
      const shown = wordsOnScreen(s.texts, m.text) && !inBox;
      // Herdr's idle can flicker between the submit and the turn, so it must hold for two polls,
      // and the answer must sit BELOW the message: an earlier send's OK does not count.
      settledPolls = info.agent === this.agent && (info.status === "idle" || info.status === "done") ? settledPolls + 1 : 0;
      if (shown && answeredBelow(s.texts, m.text) && settledPolls >= 2) {
        await Bun.sleep(800);
        this.save(`sends-${m.id}`, await this.screen());
        return { result: passCase(m.id, "sent, shown, answered"), idleAfter: true };
      }
      await Bun.sleep(POLL_MS * 2);
    }
    this.save(`sends-${m.id}`, s);
    const inBox = s.draft !== null && this.ctx.readers.draftCarriesSend(m.text, s.draft);
    if (inBox) return { result: failCase(m.id, "outcome sent, but the message is still in the input box"), idleAfter: false };
    return { result: notReachedCase(m.id, `outcome sent; the turn did not finish in ${TURN_TIMEOUT_MS / 1000} s`), idleAfter: false };
  }

  /**
   * Leave the agent and sample every ~150 ms until the shell is back, plus a short tail. An unread
   * card on any sample is scenario 5's finding.
   */
  async exit(): Promise<CaseResult> {
    const id = `exit-${this.tag}`;
    this.ctx.session.sendText(this.paneId, this.ctx.profile.exitCommand);
    await Bun.sleep(400);
    this.ctx.session.sendKeys(this.paneId, ["Enter"]);
    let samples = 0;
    let unreadAt: Screen | null = null;
    let shellSince: number | null = null;
    const deadline = Date.now() + EXIT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await Bun.sleep(POLL_MS);
      const s = await this.screen();
      samples += 1;
      if (s.unread && unreadAt === null) unreadAt = s;
      const info = this.ctx.session.paneInfo(this.paneId);
      if (info.agent === null) shellSince ??= Date.now();
      if (shellSince !== null && Date.now() - shellSince >= EXIT_TAIL_MS) {
        this.save(id, s);
        return this.windowCase(id, samples, unreadAt, "after exit");
      }
    }
    this.save(`${id}-timeout`, await this.screen());
    return unreadAt !== null
      ? this.windowCase(id, samples, unreadAt, "while exiting")
      : notReachedCase(id, `the agent did not exit in ${EXIT_TIMEOUT_MS / 1000} s`);
  }
}
