// Which agents get the Claude-tuned block grammars? Exactly one today: Claude Code.
//
// The matchers in this directory (prompt-select detection, chrome stripping, the statusline
// re-surfacing) are shaped by the VERIFIED Claude Code TUI — its input box, its menu footers, its
// stepper header — via the fixture corpus in web/src/fixtures/panes/*.txt. Every OTHER agent (codex,
// opencode, pi, a bare shell, or an unknown/absent agent) has an unverified TUI shape, so running
// Claude's matchers on it could mis-lift a menu into the wrong buttons, strip real output as
// "chrome", or paint a bogus status strip. We therefore run the grammars ONLY where we know the
// shape; everyone else keeps the plain raw terminal mirror (the universal T1 fallback).
//
// This is the SINGLE decision site: both gates — `buildBlocks` (the render pipeline) and
// agent-chat's status-strip `useMemo` — call it, so the "Claude-only" policy can't drift between
// them, and adding a future verified agent is a one-line change here.
export function hasBlockGrammar(agent: string | undefined): boolean {
  return agent === "claude";
}
