// COLLIE'S OWN FEATURES THAT MAKE AN AGENT READ OR WRITE MORE (2026-11-12). Only the ones a person switches
// on or off in Settings or in a session's sheet: each switch draws "Uses agent tokens" from this list
// (components/token-use-label.tsx `FeatureTokenChip`), and a feature left out draws none. Each entry says
// why, from the code. A trick's label is not here: lib/tricks/token-use.ts reads it from the trick's facts.
//
// Left out on purpose, with the reason:
//   - the WalkyTalky skill (cli/skill-install.ts): agents read it, but no Settings or sheet switch turns it
//     off, only `collie skill uninstall` and `COLLIE_SKILL_SYNC`. Its Hill section is there only while the
//     Hill is on (M96 spec 12), which the "hill" entry below already marks;
//   - "Tell all sessions now" (components/hill-crew-state.tsx): a button, one send per tap, not a switch;
//   - the harness shortcuts, the quick actions and the palette's commands: the person taps each send;
//   - `COLLIE_WALKY=off`: a config key, no control on the phone.

/** Why a feature makes an agent read or write more. */
export type FeatureTokenReason =
  /** Other agents' messages are typed into the session: one more turn for each. */
  | "agent-messages"
  /** The person's answer to a Decision is typed into a session, and agents spend turns posting them. */
  | "decision-answers"
  /** The agent draws a screen, and each tap on it is typed into the session: one more turn for each. */
  | "view-taps";

/** Where the feature's switch is. */
export type FeatureSwitchPlace = "settings" | "session-sheet";

export interface TokenUseFeature {
  readonly id: string;
  readonly reason: FeatureTokenReason;
  readonly place: FeatureSwitchPlace;
  /** The component that draws the switch. */
  readonly component: string;
}

export const TOKEN_USE_FEATURES: readonly TokenUseFeature[] = [
  // bridge/walky/deliver.ts: one typed line per message to this session. Off: other agents cannot reach it.
  { id: "walky-talky", reason: "agent-messages", place: "session-sheet", component: "components/walky-sheet.tsx WalkyOffSwitch" },
  // bridge/hill/service.ts: an answer is typed to `replyTo` or the poster. Off: posts and answers are refused.
  { id: "hill", reason: "decision-answers", place: "settings", component: "components/hill-switch-card.tsx" },
  // bridge/agent-view/service.ts: a tap types `[view:<trick> <address>] from operator: tapped "<label>"`.
  // Not drawn on that switch yet: at 360 px the chip does not fit the hint's second line (2026-11-12). The
  // trick's own row in Settings, Tricks carries it, and the playground's "Uses agent tokens" section shows it.
  { id: "agent-view", reason: "view-taps", place: "session-sheet", component: "components/trick-menu-group.tsx SwitchRow" },
];

/** The entry of `id`, or undefined. */
export function tokenUseFeature(id: string): TokenUseFeature | undefined {
  return TOKEN_USE_FEATURES.find((feature) => feature.id === id);
}
