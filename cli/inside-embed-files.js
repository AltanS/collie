// The Collie mod for Claude Code, embedded as text (M99 spec 02). Bun reads each file as text at build
// time, so the binary carries the mod byte for byte. This file is JavaScript on purpose: TypeScript
// reads `inside-embed-files.d.ts` beside it and never opens the mod's own `.ts` files, which are typed
// against Claude Code's API and not against this repository's. `cli/inside-embed.ts` is the face.
//
// A file added to `inside/claude/` must be added here; `cli/inside-embed.test.ts` fails until it is.

import pluginJson from "../inside/claude/.claude-plugin/plugin.json" with { type: "text" };
import hooksJson from "../inside/claude/hooks/hooks.json" with { type: "text" };
// The three below are read as text, not as modules: the import checker cannot see the attribute.
// oxlint-disable-next-line import/default
import registerTs from "../inside/claude/hooks/register.ts" with { type: "text" };
// oxlint-disable-next-line import/default
import coreTs from "../inside/claude/hooks/core.ts" with { type: "text" };
// oxlint-disable-next-line import/default
import typesDts from "../inside/claude/types/index.d.ts" with { type: "text" };

export const CLAUDE_MOD_FILES = [
  { path: ".claude-plugin/plugin.json", text: pluginJson },
  { path: "hooks/hooks.json", text: hooksJson },
  { path: "hooks/register.ts", text: registerTs },
  { path: "hooks/core.ts", text: coreTs },
  { path: "types/index.d.ts", text: typesDts },
];
