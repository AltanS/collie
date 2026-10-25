// The browser leg's cases, and which harness and which leg each one runs on. No imports: the table in
// global-teardown.ts reads this, and `scripts/browser-leg-scenarios.test.ts` checks it without a rig,
// a browser or Playwright.

/** The three harnesses the leg runs (harnesses.ts sets them up). */
export type HarnessId = "claude" | "pi" | "omp";
export const HARNESS_IDS: readonly HarnessId[] = ["claude", "pi", "omp"];

export const SCENARIOS = [
  { id: "picker", title: "1 model picker" },
  { id: "permission", title: "2 permission card" },
  { id: "pick-many", title: "3 pick-many question" },
  { id: "stream-send", title: "4 send while streaming" },
  { id: "load-older", title: "5 load older, empty cache" },
  // The walky talky path is the same bridge code for every harness, so Claude proves the phone's
  // message and the cases below that need no second harness. pi and omp each prove that the
  // operator's header and body reach a harness whose screen is not Claude's (7), and one pair of
  // harnesses proves an agent's message through the skill (8).
  { id: "walky", title: "6 walky talky message", only: ["claude"] },
  { id: "walky-operator", title: "7 walky talky: operator message", only: ["pi", "omp"] },
  { id: "walky-agents", title: "8 walky talky: agent to agent and back", only: ["pi"] },
  { id: "walky-inbox", title: "9 walky talky: kept, not typed over a dialog or draft", only: ["claude"] },
  { id: "walky-broadcast", title: "10 walky talky: broadcast, shell skipped", only: ["claude"] },
  { id: "walky-forged", title: "11 walky talky: a forged header", only: ["claude"] },
  // The cases that put a message in the way of something: a running turn (16, every harness), an open
  // question card (17) and a pane that closed and was replaced (18).
  { id: "walky-busy", title: "16 walky talky: a message during a running turn" },
  { id: "walky-question", title: "17 walky talky: a message over a question card", only: ["claude"] },
  { id: "walky-replaced", title: "18 walky talky: an address of a pane that closed", only: ["claude"] },
  // A slash command onto a draft (the 2026-10-22 field case): the belt's Model, Replace, the picker.
  { id: "belt-model-draft", title: "22 Model from the belt over a draft", only: ["claude"] },
  // A held message's two ways out (M62 spec 03): the sender's Cancel (23) and the owner's Drop (24).
  { id: "walky-cancel", title: "23 walky talky: a held message cancelled by its sender", only: ["claude"] },
  { id: "walky-drop", title: "24 walky talky: a held message dropped from the held mark", only: ["claude"] },
  // A Stop on a running turn (M68, ADR 0116), case 25.
  { id: "stop-pi", title: "25 Stop a running pi turn", only: ["pi"] },
  // A steer from the Send button's long press while the agent works (M69). Case 27 is the
  // same on Codex and waits for a Codex harness in this rig (README, "The cases").
  { id: "steer", title: "26 steer while working (pi)", only: ["pi"] },
  // A Clear from the Keys board over a draft typed outside the phone (ADR 0116), case 28. No model turn.
  { id: "clear-pi", title: "28 Clear a pi draft from the Keys board", only: ["pi"] },
  // A send queued behind a running omp turn (ADR 0122), case 29: the receipt card, Stop, Send, Discard.
  { id: "queued-omp", title: "29 a queued send on omp: card, Stop, Send or Discard", only: ["omp"] },
  // The crew leg (crew.config.ts, walky-crew.spec.ts): a lead and a member. Each case is one row,
  // under the harness that starts it (Claude on the lead); pi on the member is its other end.
  { id: "walky-crew-broadcast", title: "12 crew: 'Message all agents' on the Crew page", only: ["claude"], leg: "crew" },
  { id: "walky-crew-agents", title: "13 crew: lead agent to member agent and back", only: ["claude"], leg: "crew" },
  { id: "walky-crew-unreachable", title: "14 crew: an unreachable machine is left out", only: ["claude"], leg: "crew" },
  { id: "crew-release-line", title: "15 crew: the lead's release line is the crew's", only: ["claude"], leg: "crew" },
  { id: "walky-crew-member-to-lead", title: "19 crew: member agent to lead agent and back", only: ["claude"], leg: "crew" },
  { id: "walky-crew-off", title: "20 crew: walky talky off on the member", only: ["claude"], leg: "crew" },
  { id: "walky-crew-pair-limit", title: "21 crew: the seventh message between two panes is refused", only: ["claude"], leg: "crew" },
] as const;
export type ScenarioId = (typeof SCENARIOS)[number]["id"];

/** The two legs: the solo rig (playwright.config.ts) and the crew rig (crew.config.ts). */
export type Leg = "solo" | "crew";

/** The leg a scenario runs on: the solo leg, unless it says otherwise. */
export function legOf(scenario: (typeof SCENARIOS)[number]): Leg {
  return "leg" in scenario ? scenario.leg : "solo";
}

/**
 * Whether a scenario runs on a harness in a leg: every solo scenario runs on every harness of the solo
 * leg unless it names the ones it runs on, and a crew scenario only on the crew leg. So each leg's
 * table has a row for its own cases only, and never a "not reached" for a case of the other leg.
 */
export function scenarioApplies(scenario: (typeof SCENARIOS)[number], harness: HarnessId, leg: Leg = "solo"): boolean {
  if (legOf(scenario) !== leg) return false;
  return !("only" in scenario) || scenario.only.some((id) => id === harness);
}

