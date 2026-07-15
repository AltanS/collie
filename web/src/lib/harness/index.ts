// The block-building DISPATCHER — the public entry the renderer (ansi-output) calls. It lives HERE
// rather than in blocks.ts to keep the dependency edge one-way: harness/ imports blocks.ts (for the
// Block AST + pure helpers), never the reverse, so pulling an adapter's pipeline in can't form an
// import cycle. Routing is trivial: the agent's adapter builds the blocks, or — for any unknown/
// absent agent — the universal single raw block. This is the seam where the Claude-Code TUI grammars
// (and any future agent's) run; every non-adapter agent keeps the pure raw mirror.

import type { Block, StyledLine } from "../blocks";
import { adapterFor, hasBlockGrammar } from "./registry";

/**
 * Group lines into semantic blocks by routing through the agent's adapter. With no `ctx` (or an agent
 * that has no adapter) this is the trivial single-raw-block wrap it always was — conservative gating
 * lives entirely in the registry, so a non-adapter pane is never mis-parsed.
 */
export function buildBlocks(lines: StyledLine[], ctx?: { agent?: string }): Block[] {
  return adapterFor(ctx?.agent)?.buildBlocks(lines) ?? [{ kind: "raw", lines }];
}

export { adapterFor, hasBlockGrammar };
export type { HarnessAdapter } from "./types";
