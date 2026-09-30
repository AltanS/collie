// The canary reads its OWN session, per harness, with the bridge's own journal adapter.
//
// The screen half of the canary asks "what would the phone read off this pane". This asks the other
// question Chat depends on: what would the phone read out of the agent's own written record. Two
// gates, and the second is the one that catches a change nobody predicted (spec M41/05):
//
//   THE KINDS. The scenario sent a prompt, asked for one tool call and got a reply, so the adapter
//   must yield a user item, a tool item and a reply. A reader that has gone blind to one of them
//   reads as a fail rather than as a card that looks slightly wrong.
//
//   THE UNKNOWNS. Every reducer counts the row kinds and content kinds it had no branch for
//   (`bridge/journal/reduce.ts` § "what a reducer reports about what it could not read"). Above zero
//   fails the run and NAMES the type. That is a gate against a format change nobody has written a
//   test for, which is how Claude Code 2.1.283 and Codex 0.156.1 both broke reading on the day they
//   shipped while every test stayed green.
//
// NOTHING IS WRITTEN, not even under /tmp. The screen scenarios save an `.ansi` capture per case; a
// session log may not be saved anywhere, because a Claude JSONL carries file contents from every Read
// and environment from every Bash. Only counts and item kinds reach `summary.json` — no path, no
// turn, no tool output. That is the same rule that made recorded sessions as fixtures a non-goal.

import { homedir } from "node:os";
import { join } from "node:path";

import { resolveJournalRoots } from "../../bridge/config";
import { buildJournalRegistry, type JournalRoots } from "../../bridge/journal/registry";
import { describeUnknowns, parseWith, unknownCount, type UnknownTally } from "../../bridge/journal/reduce";
import type { AgentSessionRef, JournalAdapter, TranscriptEntry } from "../../bridge/journal/types";
import { failCase, notReachedCase, passCase, type CaseResult } from "./verdict";

/**
 * Where the canary looks for the logs the agents in its panes wrote.
 *
 * The bridge's own answer, plus one root the bridge leaves to the operator: `CLAUDE_CONFIG_DIR`
 * gives each Claude profile its own `projects` tree (issue #92), and Herdr's panes inherit that
 * variable from this process — `cleanEnv` strips `CLAUDE_CODE_*` and not this one. The bridge expects
 * `COLLIE_TRANSCRIPT_ROOT` to be configured for such a host; the canary can simply derive it, and
 * without this a run under a profile config would read "no log" and say nothing about the reader.
 */
export function canaryJournalRoots(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): JournalRoots {
  const roots = resolveJournalRoots(env, home);
  const profile = env.CLAUDE_CONFIG_DIR;
  if (profile === undefined || profile === "") return roots;
  const extra = join(profile, "projects");
  return roots.claude.includes(extra) ? roots : { ...roots, claude: [extra, ...roots.claude] };
}

/** The registry the journal scenario reads through: one per run, built from this host's own roots. */
export function canaryJournals(): Record<string, JournalAdapter> {
  return buildJournalRegistry(canaryJournalRoots());
}

/** One harness's own session, as its adapter read it. */
export interface JournalReading {
  /** How many turns the adapter yielded. A count, never the turns themselves. */
  readonly total: number;
  readonly entries: readonly TranscriptEntry[];
  /** What the reducer had no branch for, by name. */
  readonly tally: UnknownTally;
}

/**
 * The adapter's grammar over one session's text, plus what it could not read. PURE.
 *
 * `parseWith` is the whole-file reading of the same reducer the live window folds a tail through, so
 * this asks the reducer the canary's question without a second grammar and without a second read.
 */
export function readRows(adapter: JournalAdapter, text: string): JournalReading {
  const reducer = adapter.reducer();
  const entries = parseWith(reducer, text);
  return { total: entries.length, entries, tally: reducer.unknowns() };
}

/**
 * Resolve the session the agent itself reported and read it. Null when there is nothing to read —
 * the ref names no file, the adapter refused its shape, or containment refused the path.
 */
export async function loadOwnSession(adapter: JournalAdapter, ref: AgentSessionRef): Promise<JournalReading | null> {
  const key = await adapter.source.resolve(ref);
  if (key === null) return null;
  const { text } = await adapter.source.load(key);
  return text.trim() === "" ? null : readRows(adapter, text);
}

/** Enough of a prompt to find it again, whitespace removed: a harness may re-wrap what it stored. */
const NEEDLE_CHARS = 40;

function squash(text: string): string {
  return text.replace(/\s+/gu, "");
}

function needle(prompt: string): string {
  return [...squash(prompt)].slice(0, NEEDLE_CHARS).join("");
}

/** The words of one turn: its text and thinking parts. A tool's summary is not speech. */
function spoken(entry: TranscriptEntry): string {
  return entry.parts.map((part) => (part.kind === "text" || part.kind === "thinking" ? part.text : "")).join("\n");
}

function carriesTool(entry: TranscriptEntry): boolean {
  return entry.parts.some((part) => part.kind === "tool");
}

/**
 * What the `journal` scenario asserts. PURE, so a synthetic row stream drives it in a test.
 *
 * `answered` is the SCREEN's verdict on the same turns — whether the sends scenario saw the agent
 * reply. It is what tells a reader that has gone blind from a turn that never finished: with a reply
 * on screen and none in the journal, the reader is wrong and the case fails; with neither, the model
 * simply did not finish and the case is `not-reached`, which never turns a run red. The canary has
 * drawn that line since M37/02 and this keeps to it.
 */
export function judgeJournal(
  reading: JournalReading | null,
  prompts: readonly string[],
  answered: boolean,
): CaseResult[] {
  if (prompts.length === 0) {
    // Either the sends scenario did not run, or not one of its sends reached the agent. The sends
    // scenario has already said which; either way this run left nothing of its own to read.
    return [notReachedCase("session", "no send of this run reached the agent, so it wrote no turn to read")];
  }
  if (reading === null) {
    return [notReachedCase("session", "the pane's session ref resolved to no readable log")];
  }
  if (reading.total === 0) {
    return [notReachedCase("session", "the log resolved and the adapter read no turn from it")];
  }

  // THE GATE. A count alone is useless for diagnosis, so both cases carry the names.
  const unknowns = unknownCount(reading.tally);
  const said = describeUnknowns(reading.tally);
  const cases: CaseResult[] = [passCase("session", `${reading.total} turns, ${unknowns} unrecognised`)];
  cases.push(
    reading.tally.rows.size === 0
      ? passCase("unknown-rows", "every row kind recognised")
      : failCase("unknown-rows", `unrecognised ${said}`),
  );
  cases.push(
    reading.tally.parts.size === 0
      ? passCase("unknown-parts", "every content kind recognised")
      : failCase("unknown-parts", `unrecognised ${said}`),
  );

  // THE KINDS. `user` is the prompt the canary sent, and it is the one case that cannot be excused by
  // a model that answered oddly: the canary typed those words itself and the send was verified.
  const needles = prompts.map((prompt) => needle(prompt));
  const users = reading.entries.filter((entry) => entry.role === "user");
  const found = needles.filter((want) => users.some((entry) => squash(spoken(entry)).includes(want)));
  cases.push(
    found.length > 0
      ? passCase("user-item", `${found.length}/${needles.length} prompts read back`)
      : failCase("user-item", `${reading.total} turns and ${users.length} user items, none carrying a prompt the canary sent`),
  );

  // A tool item: the journal prompt asked for one read. NEVER a fail — a model that answers in words
  // instead has opened no tool call to read, which says nothing about the reader (M37/03's rule).
  const tools = reading.entries.filter((entry) => carriesTool(entry));
  cases.push(
    tools.length > 0
      ? passCase("tool-item", `${tools.length} turns carry a tool call`)
      : notReachedCase("tool-item", "the agent made no tool call in its own log; it answered in words"),
  );

  // A reply AFTER the newest prompt. An earlier turn's answer is not this scenario's evidence.
  let lastUser = -1;
  reading.entries.forEach((entry, at) => {
    if (entry.role === "user" && needles.some((want) => squash(spoken(entry)).includes(want))) lastUser = at;
  });
  const reply = reading.entries
    .slice(lastUser + 1)
    .find((entry) => entry.role === "assistant" && spoken(entry).trim() !== "");
  cases.push(
    reply !== undefined
      ? passCase("reply", "an assistant turn with words stands below the prompt")
      : answered
        ? failCase("reply", "the screen showed the reply and the journal reader finds none below the prompt")
        : notReachedCase("reply", "no reply below the prompt, and none was seen on screen either"),
  );

  return cases;
}
