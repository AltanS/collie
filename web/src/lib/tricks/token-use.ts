import type { PlaceKind } from "./schema";

// WHETHER A TRICK MAKES AN AGENT READ OR WRITE MORE (2026-11-12, a design round, nothing draws it yet). The
// answer comes from facts the phone already holds, never from a flag a trick or a person sets by hand.
//
// What spends an agent's tokens is text the agent reads or writes. A trick reaches an agent in three ways:
//
//   1. `agent-view`: the session's agent draws the trick's screen (it writes every screen) and every tap on
//      it is typed into that session as a message in the person's name (bridge/agent-view, `POST /api/send`
//      with `view`): one more turn per tap.
//   2. `rules`: the agent reads the trick's instructions (`collie trick view <trick> help`). The schema
//      refuses rules without `agent-view`, so on a bridge that sends both this only names what an older
//      bridge, or the official list (`givesRules`), says alone.
//   3. a Decision with `replyTo`: the person's answer on the Hill is typed into that session as their own
//      WalkyTalky message (bridge/hill/service.ts, "WHERE THE ANSWER GOES"): one more turn per answer. A
//      trick's Decision without `replyTo` types nothing; its answer reaches only the trick's program.
//
// Every other control a trick draws runs the trick's own program on the bridge and types nothing into a
// session (README "Rights": a trick never sends, presses a key or writes a reply box). That is
// {@link PLACE_REACH}: a new place in the schema fails to compile here until someone says which it is.
//
// WHAT THE WIRE DOES NOT CARRY. Whether a program trick's Decisions name `replyTo` is known only once one is
// posted (the phone reads it from the Hill's list). Neither the manifest, `WireTrickInfo` nor the official
// list says it before. A label read from it comes with the first such Decision, not with the switch.
//
// Pure, no DOM and no `@/` alias: the bridge may load it by relative path, as it loads `schema.ts`.

/** Why a trick makes an agent read or write more. */
export type TokenUseReason = "agent-view" | "rules" | "answer";

/** Every reason, in the order the rule tries them. */
export const TOKEN_USE_REASONS: readonly TokenUseReason[] = ["agent-view", "rules", "answer"];

/**
 * Where a tap on a place's controls goes: `program` runs the trick's program on the bridge, `session` types
 * into an agent session, `none` is no control (a tap at most opens the trick's session). One row per place
 * the schema knows, and `agent-view`, which the manifest keeps apart from the drawing places.
 */
export const PLACE_REACH = {
  belt: "program",
  session: "program",
  dashboard: "none",
  status: "none",
  tabbar: "none",
  menu: "program",
  "agent-view": "session",
} as const satisfies Record<PlaceKind | "agent-view", "program" | "session" | "none">;

/**
 * What the rule reads of a trick: an installed one (`WireTrickInfo`) or an entry of the official list that is
 * not added yet (`WireOfficialTrick`). Both fit as they are.
 */
export interface TrickTokenFacts {
  readonly id?: string;
  /** The bridge's member id of an installed trick. */
  readonly host?: string;
  /** The places it draws. A manifest's `agent-view` counts here too. */
  readonly places?: readonly string[] | undefined;
  /** `WireTrickInfo.agentView` and `WireOfficialTrick.agentView`. */
  readonly agentView?: boolean | undefined;
  /** `WireTrickInfo.rules`: present when the trick gives its agents instructions. */
  readonly rules?: object | undefined;
  /** `WireTrickInfo.rulesUnshown`: rules were sent, but none this phone can show. */
  readonly rulesUnshown?: boolean | undefined;
  /** `WireOfficialTrick.givesRules`: the list pins instructions for the entry. */
  readonly givesRules?: boolean | undefined;
}

/** What the rule reads of a Hill Decision (`HillDecision` in lib/hill/wire.ts fits as it is). */
export interface DecisionTokenFacts {
  readonly from: { readonly kind: string; readonly trickId: string | null; readonly trickHost?: string | null };
  readonly replyTo: string | null;
}

/** The places whose controls type into a session. */
const SESSION_PLACES: ReadonlySet<string> = new Set(Object.entries(PLACE_REACH).flatMap(([place, reach]) => (reach === "session" ? [place] : [])));

/** Whether a place's controls type into a session. A word the table does not know types nothing. */
function placeTypesIntoSession(place: string): boolean {
  return SESSION_PLACES.has(place);
}

/** Whether a Decision is this trick's and types the person's answer into a session. */
function answerTypes(trick: TrickTokenFacts, decision: DecisionTokenFacts): boolean {
  if (decision.from.kind !== "trick" || decision.replyTo === null) return false;
  if (trick.id === undefined || decision.from.trickId !== trick.id) return false;
  const host = decision.from.trickHost;
  return trick.host === undefined || host === undefined || host === null || host === trick.host;
}

/**
 * Why `trick` makes an agent read or write more, or null when it does not. `decisions` is the Hill's list as
 * the phone holds it; leave it out where the phone holds none (an official entry that is not added).
 */
export function trickTokenUse(trick: TrickTokenFacts, decisions: readonly DecisionTokenFacts[] = []): TokenUseReason | null {
  const places = Array.isArray(trick.places) ? trick.places : [];
  if (trick.agentView === true || places.some(placeTypesIntoSession)) return "agent-view";
  if (trick.rules !== undefined || trick.rulesUnshown === true || trick.givesRules === true) return "rules";
  if (decisions.some((decision) => answerTypes(trick, decision))) return "answer";
  return null;
}
