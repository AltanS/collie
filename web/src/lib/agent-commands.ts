// Pre-generated slash-command catalogs, keyed by Herdr's detected agent type (`pane.agent`).
// Sourced from each agent's official docs (Claude Code: code.claude.com/docs; Codex:
// developers.openai.com/codex + openai/codex; pi: pi.dev/docs; opencode: opencode.ai/docs) and
// curated for one-tap use from a phone. A slash command is just text:
// the UI sends `/command` (+ submit key) for no-arg commands, or inserts `/command ` into the
// composer for the user to complete when the command takes an argument.
//
// To regenerate: re-run the per-agent doc-fetch agents (see CHANGELOG) and replace the arrays.

export interface AgentCommand {
  /** Includes the leading slash, e.g. "/compact". */
  command: string;
  /** One-line, action-oriented description. */
  description: string;
  /** True if the command commonly takes an argument — tap inserts it into the composer to edit. */
  takesArg: boolean;
  /** Placeholder shown after insert, e.g. "[instructions]" / "<model>". Empty if no arg. */
  argHint: string;
  /** True for the handful surfaced first on a phone. The rest are reachable via search. */
  common: boolean;
  /** Destructive/disruptive enough to warrant a two-tap confirm (e.g. /clear wipes context). */
  dangerous: boolean;
}

// ── Claude Code ──────────────────────────────────────────────────────────────
const CLAUDE: readonly AgentCommand[] = [
  { command: "/compact", description: "Summarize the conversation to free up context; optional focus", takesArg: true, argHint: "[instructions]", common: true, dangerous: false },
  { command: "/clear", description: "Start a fresh conversation with empty context", takesArg: false, argHint: "", common: true, dangerous: true },
  { command: "/model", description: "Switch the model; opens a picker if no name given", takesArg: true, argHint: "[model]", common: true, dangerous: false },
  { command: "/resume", description: "Resume a previous conversation by id, name, or picker", takesArg: true, argHint: "[session]", common: true, dangerous: false },
  { command: "/init", description: "Generate a starter CLAUDE.md for this project", takesArg: false, argHint: "", common: true, dangerous: false },
  { command: "/review", description: "Review a GitHub pull request by number (lists open PRs if none)", takesArg: true, argHint: "[PR]", common: true, dangerous: false },
  { command: "/status", description: "Show version, model, account, and connectivity info", takesArg: false, argHint: "", common: true, dangerous: false },
  { command: "/usage", description: "Show session cost, plan limits, and activity stats", takesArg: false, argHint: "", common: true, dangerous: false },
  { command: "/context", description: "Visualize context-window usage with optimization hints", takesArg: false, argHint: "", common: true, dangerous: false },
  { command: "/memory", description: "Edit CLAUDE.md memory files and auto-memory entries", takesArg: false, argHint: "", common: true, dangerous: false },
  { command: "/help", description: "Show help and list available commands", takesArg: false, argHint: "", common: true, dangerous: false },
  { command: "/add-dir", description: "Add an extra working directory for file access", takesArg: true, argHint: "<path>", common: false, dangerous: false },
  { command: "/agents", description: "Manage subagent configurations and view running agents", takesArg: false, argHint: "", common: false, dangerous: false },
  { command: "/branch", description: "Fork the conversation here to explore a different direction", takesArg: true, argHint: "[name]", common: false, dangerous: false },
  { command: "/btw", description: "Ask a quick side question without adding it to history", takesArg: true, argHint: "<question>", common: false, dangerous: false },
  { command: "/cd", description: "Move the session to a new working directory", takesArg: true, argHint: "<path>", common: false, dangerous: false },
  { command: "/code-review", description: "Review the current diff for bugs and cleanups", takesArg: true, argHint: "[level]", common: false, dangerous: false },
  { command: "/config", description: "Open settings, or set a value with key=value", takesArg: true, argHint: "[key=value]", common: false, dangerous: false },
  { command: "/copy", description: "Copy the last assistant response to the clipboard", takesArg: true, argHint: "[N]", common: false, dangerous: false },
  { command: "/cost", description: "Show token cost and usage for the current session", takesArg: false, argHint: "", common: false, dangerous: false },
  { command: "/deep-research", description: "Fan out web searches and synthesize a cited report", takesArg: true, argHint: "<question>", common: false, dangerous: false },
  { command: "/diff", description: "Open an interactive viewer of uncommitted changes", takesArg: false, argHint: "", common: false, dangerous: false },
  { command: "/doctor", description: "Diagnose and verify your Claude Code installation", takesArg: false, argHint: "", common: false, dangerous: false },
  { command: "/effort", description: "Set the model reasoning effort level", takesArg: true, argHint: "[low|medium|high|max]", common: false, dangerous: false },
  { command: "/export", description: "Export the conversation as plain text", takesArg: true, argHint: "[filename]", common: false, dangerous: false },
  { command: "/fast", description: "Toggle fast mode on or off", takesArg: true, argHint: "[on|off]", common: false, dangerous: false },
  { command: "/feedback", description: "Submit feedback or report a bug to Anthropic", takesArg: true, argHint: "[report]", common: false, dangerous: false },
  { command: "/fork", description: "Spawn a background subagent that inherits this conversation", takesArg: true, argHint: "<directive>", common: false, dangerous: false },
  { command: "/goal", description: "Set a completion condition; keep working until it is met", takesArg: true, argHint: "[condition|clear]", common: false, dangerous: false },
  { command: "/hooks", description: "View hook configurations for tool events", takesArg: false, argHint: "", common: false, dangerous: false },
  { command: "/ide", description: "Manage IDE integrations and show connection status", takesArg: false, argHint: "", common: false, dangerous: false },
  { command: "/login", description: "Sign in to your Anthropic account", takesArg: false, argHint: "", common: false, dangerous: false },
  { command: "/logout", description: "Sign out from your Anthropic account", takesArg: false, argHint: "", common: false, dangerous: true },
  { command: "/loop", description: "Run a prompt repeatedly on an interval (self-paced if none)", takesArg: true, argHint: "[interval] [prompt]", common: false, dangerous: false },
  { command: "/mcp", description: "Manage MCP server connections and auth", takesArg: true, argHint: "[subcommand]", common: false, dangerous: false },
  { command: "/permissions", description: "Manage allow, ask, and deny rules for tools", takesArg: false, argHint: "", common: false, dangerous: false },
  { command: "/plan", description: "Switch into plan mode; optionally seed a description", takesArg: true, argHint: "[description]", common: false, dangerous: false },
  { command: "/plugin", description: "Manage plugins — list, install, enable, or disable", takesArg: true, argHint: "[subcommand]", common: false, dangerous: false },
  { command: "/recap", description: "Generate a one-line summary of the current session", takesArg: false, argHint: "", common: false, dangerous: false },
  { command: "/release-notes", description: "View the changelog in a version picker", takesArg: false, argHint: "", common: false, dangerous: false },
  { command: "/rename", description: "Rename the current session", takesArg: true, argHint: "[name]", common: false, dangerous: false },
  { command: "/rewind", description: "Roll back code and conversation to a checkpoint", takesArg: false, argHint: "", common: false, dangerous: true },
  { command: "/security-review", description: "Analyze pending changes for security vulnerabilities", takesArg: false, argHint: "", common: false, dangerous: false },
  { command: "/simplify", description: "Review changed code for cleanups and apply fixes", takesArg: true, argHint: "[target]", common: false, dangerous: false },
  { command: "/skills", description: "List available skills and toggle their visibility", takesArg: false, argHint: "", common: false, dangerous: false },
  { command: "/statusline", description: "Configure the shell status line display", takesArg: true, argHint: "[description]", common: false, dangerous: false },
  { command: "/tasks", description: "View and manage background tasks for this session", takesArg: false, argHint: "", common: false, dangerous: false },
  { command: "/terminal-setup", description: "Configure terminal keybindings (e.g. Shift+Enter)", takesArg: false, argHint: "", common: false, dangerous: false },
  { command: "/theme", description: "Change the color theme", takesArg: false, argHint: "", common: false, dangerous: false },
  { command: "/vim", description: "Toggle Vim editing mode for the prompt", takesArg: false, argHint: "", common: false, dangerous: false },
  { command: "/exit", description: "Exit the CLI (detaches if attached to a background session)", takesArg: false, argHint: "", common: false, dangerous: true },
];

// ── Codex ────────────────────────────────────────────────────────────────────
const CODEX: readonly AgentCommand[] = [
  { command: "/compact", description: "Summarize history to free up context-window tokens", takesArg: false, argHint: "", common: true, dangerous: false },
  { command: "/clear", description: "Reset output and start a new chat in this session", takesArg: false, argHint: "", common: true, dangerous: true },
  { command: "/diff", description: "Show the git diff of the working tree (incl. untracked)", takesArg: false, argHint: "", common: true, dangerous: false },
  { command: "/model", description: "Switch the active model and reasoning effort", takesArg: true, argHint: "<model>", common: true, dangerous: false },
  { command: "/new", description: "Start a fresh conversation without leaving the CLI", takesArg: false, argHint: "", common: true, dangerous: true },
  { command: "/status", description: "Show model, approval policy, writable roots, token usage", takesArg: false, argHint: "", common: true, dangerous: false },
  { command: "/review", description: "Request a code review of the current working tree", takesArg: false, argHint: "", common: true, dangerous: false },
  { command: "/mention", description: "Attach specific files or folders to the context", takesArg: true, argHint: "<file>", common: true, dangerous: false },
  { command: "/permissions", description: "Adjust which actions Codex can take without asking", takesArg: false, argHint: "", common: true, dangerous: false },
  { command: "/resume", description: "Reload a previously saved conversation", takesArg: false, argHint: "", common: true, dangerous: false },
  { command: "/init", description: "Generate an AGENTS.md scaffold in this project", takesArg: false, argHint: "", common: false, dangerous: false },
  { command: "/plan", description: "Enter plan mode to propose a strategy before running", takesArg: true, argHint: "[prompt]", common: false, dangerous: false },
  { command: "/goal", description: "Set, pause, resume, or clear a long-running objective", takesArg: true, argHint: "[objective]", common: false, dangerous: false },
  { command: "/approve", description: "Retry an action denied by the approval reviewer", takesArg: false, argHint: "", common: false, dangerous: false },
  { command: "/fork", description: "Clone the conversation into a new independent thread", takesArg: false, argHint: "", common: false, dangerous: false },
  { command: "/side", description: "Open an ephemeral side conversation (alias: /btw)", takesArg: true, argHint: "[question]", common: false, dangerous: false },
  { command: "/agent", description: "Switch between active subagent threads", takesArg: false, argHint: "", common: false, dangerous: false },
  { command: "/copy", description: "Copy the latest completed response to the clipboard", takesArg: false, argHint: "", common: false, dangerous: false },
  { command: "/mcp", description: "List configured MCP tools (verbose for diagnostics)", takesArg: true, argHint: "[verbose]", common: false, dangerous: false },
  { command: "/ide", description: "Include currently open editor files in the context", takesArg: false, argHint: "", common: false, dangerous: false },
  { command: "/skills", description: "Browse and apply task-specific skills", takesArg: false, argHint: "", common: false, dangerous: false },
  { command: "/personality", description: "Choose Codex communication style", takesArg: true, argHint: "<style>", common: false, dangerous: false },
  { command: "/fast", description: "Toggle the fast service tier for the model", takesArg: false, argHint: "", common: false, dangerous: false },
  { command: "/vim", description: "Toggle Vim keybindings for the composer", takesArg: false, argHint: "", common: false, dangerous: false },
  { command: "/theme", description: "Preview and save a syntax-highlighting theme", takesArg: false, argHint: "", common: false, dangerous: false },
  { command: "/usage", description: "View account token activity and usage stats", takesArg: false, argHint: "", common: false, dangerous: false },
  { command: "/ps", description: "Show running background terminals and their output", takesArg: false, argHint: "", common: false, dangerous: false },
  { command: "/stop", description: "Cancel all running background terminals", takesArg: false, argHint: "", common: false, dangerous: false },
  { command: "/logout", description: "Sign out and clear stored credentials", takesArg: false, argHint: "", common: false, dangerous: true },
  { command: "/archive", description: "Archive the current session and exit Codex", takesArg: false, argHint: "", common: false, dangerous: true },
  { command: "/delete", description: "Permanently delete the current session", takesArg: false, argHint: "", common: false, dangerous: true },
  { command: "/quit", description: "Exit the Codex CLI immediately (alias: /exit)", takesArg: false, argHint: "", common: false, dangerous: true },
];

// ── Pi (pi.dev) ──────────────────────────────────────────────────────────────
const PI: readonly AgentCommand[] = [
  { command: "/compact", description: "Manually compact context, optionally with instructions", takesArg: true, argHint: "[instructions]", common: true, dangerous: false },
  { command: "/new", description: "Start a new session, clearing the current context", takesArg: false, argHint: "", common: true, dangerous: true },
  { command: "/model", description: "Switch the active model", takesArg: false, argHint: "", common: true, dangerous: false },
  { command: "/resume", description: "Pick a previous session to resume", takesArg: false, argHint: "", common: true, dangerous: false },
  { command: "/session", description: "Show session file, id, messages, tokens, and cost", takesArg: false, argHint: "", common: true, dangerous: false },
  { command: "/tree", description: "Jump to any earlier point in the session and continue", takesArg: false, argHint: "", common: true, dangerous: false },
  { command: "/fork", description: "Start a new session from an earlier user message", takesArg: false, argHint: "", common: true, dangerous: false },
  { command: "/share", description: "Upload as a private gist with a shareable HTML link", takesArg: false, argHint: "", common: true, dangerous: false },
  { command: "/copy", description: "Copy the last assistant message to the clipboard", takesArg: false, argHint: "", common: true, dangerous: false },
  { command: "/reload", description: "Reload keybindings, extensions, skills, prompts, and context", takesArg: false, argHint: "", common: true, dangerous: false },
  { command: "/hotkeys", description: "Show all keyboard shortcuts", takesArg: false, argHint: "", common: true, dangerous: false },
  { command: "/login", description: "Sign in — manage OAuth or API-key credentials", takesArg: false, argHint: "", common: false, dangerous: false },
  { command: "/logout", description: "Sign out and clear stored credentials", takesArg: false, argHint: "", common: false, dangerous: true },
  { command: "/scoped-models", description: "Enable or disable models for Ctrl+P cycling", takesArg: false, argHint: "", common: false, dangerous: false },
  { command: "/settings", description: "Thinking level, theme, message delivery, transport", takesArg: false, argHint: "", common: false, dangerous: false },
  { command: "/name", description: "Set the session's display name", takesArg: true, argHint: "<name>", common: false, dangerous: false },
  { command: "/trust", description: "Save a project trust decision for future sessions", takesArg: false, argHint: "", common: false, dangerous: false },
  { command: "/clone", description: "Duplicate the current active branch into a new session", takesArg: false, argHint: "", common: false, dangerous: false },
  { command: "/export", description: "Export the session to HTML or JSONL", takesArg: true, argHint: "[format]", common: false, dangerous: false },
  { command: "/import", description: "Import and resume a session from a JSONL file", takesArg: true, argHint: "<file>", common: false, dangerous: false },
  { command: "/changelog", description: "Display version history", takesArg: false, argHint: "", common: false, dangerous: false },
  { command: "/quit", description: "Quit pi", takesArg: false, argHint: "", common: false, dangerous: true },
];

// ── opencode (opencode.ai) ───────────────────────────────────────────────────
const OPENCODE: readonly AgentCommand[] = [
  { command: "/compact", description: "Compact (summarize) the current session", takesArg: false, argHint: "", common: true, dangerous: false },
  { command: "/new", description: "Start a new session (alias /clear)", takesArg: false, argHint: "", common: true, dangerous: true },
  { command: "/models", description: "List and switch between available models", takesArg: false, argHint: "", common: true, dangerous: false },
  { command: "/sessions", description: "List and switch sessions (alias /resume)", takesArg: false, argHint: "", common: true, dangerous: false },
  { command: "/init", description: "Guided setup to create or update AGENTS.md", takesArg: false, argHint: "", common: true, dangerous: false },
  { command: "/share", description: "Share the current session via a link", takesArg: false, argHint: "", common: true, dangerous: false },
  { command: "/undo", description: "Undo the last turn and revert file changes (Git-backed)", takesArg: false, argHint: "", common: true, dangerous: true },
  { command: "/redo", description: "Redo a previously undone turn", takesArg: false, argHint: "", common: true, dangerous: false },
  { command: "/help", description: "Show the help dialog", takesArg: false, argHint: "", common: true, dangerous: false },
  { command: "/export", description: "Export the conversation to Markdown", takesArg: false, argHint: "", common: true, dangerous: false },
  { command: "/unshare", description: "Stop sharing the current session", takesArg: false, argHint: "", common: false, dangerous: false },
  { command: "/editor", description: "Open $EDITOR to compose a message", takesArg: false, argHint: "", common: false, dangerous: false },
  { command: "/details", description: "Toggle visibility of tool-execution details", takesArg: false, argHint: "", common: false, dangerous: false },
  { command: "/thinking", description: "Toggle visibility of model reasoning blocks", takesArg: false, argHint: "", common: false, dangerous: false },
  { command: "/themes", description: "Browse and switch the UI theme", takesArg: false, argHint: "", common: false, dangerous: false },
  { command: "/connect", description: "Add a provider and configure its API key", takesArg: false, argHint: "", common: false, dangerous: false },
  { command: "/exit", description: "Quit opencode (alias /quit, /q)", takesArg: false, argHint: "", common: false, dangerous: true },
];

const CATALOG: Record<string, readonly AgentCommand[]> = {
  claude: CLAUDE,
  codex: CODEX,
  pi: PI,
  opencode: OPENCODE,
};

/**
 * Commands for a Herdr-detected agent (`pane.agent`, e.g. "claude" / "codex"). Returns [] for
 * unknown/absent agents — the UI then hides the command button.
 */
export function commandsFor(agent: string | undefined | null): readonly AgentCommand[] {
  if (!agent) return [];
  const key = agent.toLowerCase().trim();
  if (CATALOG[key]) return CATALOG[key];
  // Tolerate variants like "claude-code" / "opencode-dev".
  if (key.startsWith("claude")) return CLAUDE;
  if (key.startsWith("codex")) return CODEX;
  if (key.startsWith("opencode")) return OPENCODE;
  if (key === "pi" || key.startsWith("pi-") || key.startsWith("pi.")) return PI;
  return [];
}
