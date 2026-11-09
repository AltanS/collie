/**
 * The rules every agent reads before it posts, in `collie hill --help` and `collie hill post --help`, and
 * in the "Decisions (the hill)" part of the installed WalkyTalky skill (`renderWalkySkill` in
 * cli/skill-install.ts fills `{{HILL_RULES}}` from this list). One source: edit the words here only. It
 * imports nothing, so the browser leg's rig (web/e2e/rig/harnesses.ts) can read it without pulling the
 * bridge into the web typecheck.
 */
export const HILL_RULES = [
  "Post a decision only for what needs the person.",
  "Always write the summary in plain words, and recommend one option with a why.",
  "One question per decision. To change one, post again with --supersedes; never repost.",
  "Do not wait in a loop. The answer arrives as a WalkyTalky message and starts your next turn.",
  "If no answer arrived, read it with collie hill status <id>.",
  "An answer typed into your session for a decision you did not post carries only the id and the option word. Read the rest with collie hill status <id>.",
  "A worker with a lead asks its lead first.",
] as const;
