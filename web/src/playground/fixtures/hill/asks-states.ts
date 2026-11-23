// The states of the Asks pages for the playground (Asks build 2, 2026-11-23): four sessions for the board (warm, working,
// unknown and cold), asks for the ask screen with every optional line and with none, a `--words` ask, one ask for each mark,
// and the closed ones. DEV-ONLY, like the rest of `src/playground/`. Neutral names; no person's name, no private path.

import type { AgentView } from "@/lib/types";
import type { HillAsk, HillAskFile, HillAskMark, HillDecision, HillOption } from "@/lib/hill/wire";
import type { WalkyLivePanes } from "@/lib/walky-names";

export const PLAY_NOW = Date.now();
const MIN = 60_000;

/** A pane for a session: warm with `minutes` left, cold, or with no cache reading (unknown). */
function pane(paneId: string, label: string, status: AgentView["status"], cache: number | "cold" | null): AgentView {
  const view: AgentView = { paneId, instance: "a1b2", workspaceId: "w1", workspaceLabel: "lodge", workspaceNumber: 1, tabId: `w1:t${paneId}`, agent: "claude", status, cwd: `/work/${label}`, focused: false, paneLabel: label };
  if (cache === "cold") view.cache = { state: "cold", ttlSeconds: 300, ruleId: "playground", confidence: "observed" };
  else if (cache !== null) view.cache = { state: "warm", expiresAt: PLAY_NOW + cache * MIN, ttlSeconds: 300, ruleId: "playground", confidence: "observed" };
  return view;
}

export const PLAY_PANES: AgentView[] = [pane("w1:p01", "lead", "idle", 38), pane("w1:p02", "builder", "working", null), pane("w1:p03", "reviewer", "idle", null), pane("w1:p04", "scout", "idle", "cold")];
export const PLAY_LIVE: WalkyLivePanes = { panes: PLAY_PANES, lead: undefined };

interface AskSpec {
  id: string;
  pane: string;
  label: string;
  title: string;
  agoMin: number;
  summary?: string;
  body?: string;
  options?: HillOption[];
  recommend?: { intent: string; why: string };
  words?: boolean;
  files?: HillAskFile[];
  root?: string | null;
  mark?: HillAskMark;
  confirmedAgoMin?: number;
  state?: HillDecision["state"];
  closedReason?: string | null;
  media?: HillDecision["media"];
}

function ask(spec: AskSpec): HillDecision {
  const options = spec.words === true ? [] : (spec.options ?? DEFAULT_OPTIONS);
  const stored: HillAsk = { words: spec.words === true, files: spec.files ?? [], root: spec.root ?? null, mark: spec.mark ?? "fresh" };
  if (spec.confirmedAgoMin !== undefined) stored.confirmedAt = PLAY_NOW - spec.confirmedAgoMin * MIN;
  return {
    v: 1,
    id: spec.id,
    requestId: `7a1c0a7e-3b2f-4e8a-9c41-${spec.id.slice(-12).padStart(12, "0")}`,
    from: { kind: "agent", address: `local/${spec.pane}#a1b2`, trickId: null, trickKey: null, memberId: null, harness: "claude", label: spec.label, host: "lodge", trickHost: null },
    about: null,
    priority: "today",
    priorityAsked: "today",
    title: spec.title,
    summary: spec.summary ?? "",
    body: spec.body ?? "",
    options,
    text: spec.words === true ? "required" : "optional",
    recommends: spec.recommend ?? null,
    media: spec.media ?? [],
    links: [],
    replyTo: null,
    target: { label: spec.label, host: "lodge", unattended: false },
    supersedes: null,
    supersededBy: null,
    expiresAt: null,
    at: PLAY_NOW - spec.agoMin * MIN,
    state: spec.state ?? "open",
    closedAt: spec.state === undefined || spec.state === "open" ? null : PLAY_NOW - MIN,
    closedReason: spec.closedReason ?? null,
    answer: null,
    ask: stored,
  };
}

const DEFAULT_OPTIONS: HillOption[] = [
  { intent: "keep", label: "Keep both routes", detail: "Older phones keep working. The bridge carries two code paths until the next minor.", cost: "One more test file." },
  { intent: "drop", label: "Drop the old route", detail: "One code path. A phone that did not reload must reload." },
  { intent: "later", label: "Decide next week" },
];

/** An ask with every optional line: situation, background, files, a recommendation with its reason, Then and Cost on options. */
export const askFull = ask({
  id: "ak_play000000001",
  pane: "w1:p01",
  label: "lead",
  title: "Keep the old answer route beside the new Send?",
  agoMin: 14 * 60,
  summary: "The phone can send all answers of a session at once now. The old route still answers one card at a time.",
  body: ["## What I found", "", "The single answer route is used by **every phone bundle** since the first release.", "", "- A phone that has not reloaded still calls it.", "- Both routes share one claim lane.", "", "If we drop it, an old bundle gets a 404 and the person taps again after a reload."].join("\n"),
  recommend: { intent: "keep", why: "A phone that did not reload would lose an answer the person already gave." },
  files: [{ path: "bridge/hill/answers.ts", line: 120 }, { path: "docs/asks.md", heading: "Send" }],
  root: "w1:p01",
  mark: "carried",
  confirmedAgoMin: 40,
  media: [{ id: "im_playasks00000001", kind: "image", mime: "image/png", bytes: 1800, width: 600, height: 360, caption: "The send line after the change" }],
});

/** An ask with none of them: a question and two plain options. */
export const askPlain = ask({ id: "ak_play000000002", pane: "w1:p01", label: "lead", title: "Ship the fix in the next patch?", agoMin: 20, options: [{ intent: "yes", label: "Yes" }, { intent: "no", label: "Not yet" }] });

/** A `--words` ask: no options, the answer is the person's own words. */
export const askWords = ask({ id: "ak_play000000003", pane: "w1:p01", label: "lead", title: "What should the empty board say?", agoMin: 55, words: true, summary: "The empty list shows a blank screen now.", mark: "fresh" });

/** The three marks. */
export const askFresh = ask({ id: "ak_play000000004", pane: "w1:p02", label: "builder", title: "Rename the setting to Asks?", agoMin: 5, mark: "fresh" });
export const askCarried = ask({ id: "ak_play000000005", pane: "w1:p02", label: "builder", title: "Move the key hints into the sheet?", agoMin: 90, mark: "carried", confirmedAgoMin: 12 });
export const askUnchecked = ask({ id: "ak_play000000006", pane: "w1:p02", label: "builder", title: "Is the old stamp line still needed?", agoMin: 130, mark: "unchecked" });

/** One ask each for the other sessions of the board. */
export const askReviewer = ask({ id: "ak_play000000007", pane: "w1:p03", label: "reviewer", title: "Merge the narrow-width fix first?", agoMin: 33 });
export const askScout = ask({ id: "ak_play000000008", pane: "w1:p04", label: "scout", title: "Which of the three logs holds the failure?", agoMin: 400 });

/** The open asks of the board: the lead has three (one unchecked sinks), the others one or two. */
export const boardAsks: readonly HillDecision[] = [askFull, askPlain, askWords, askFresh, askCarried, askUnchecked, askReviewer, askScout];

/** Closed asks: one the person answered in the session, one the agent lost when the conversation was cleared. */
export const closedAnsweredHere = ask({ id: "ak_play000000009", pane: "w1:p01", label: "lead", title: "Use the shared spinner?", agoMin: 300, state: "withdrawn", closedReason: "answered in the session" });
export const closedCleared = ask({ id: "ak_play000000010", pane: "w1:p02", label: "builder", title: "Split the release notes?", agoMin: 240, state: "withdrawn", closedReason: "conversation cleared" });
