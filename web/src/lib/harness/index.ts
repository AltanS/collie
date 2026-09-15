// The block-building DISPATCHER — the public entry the renderer (ansi-output) calls. It lives HERE
// rather than in blocks.ts to keep the dependency edge one-way: harness/ imports blocks.ts (for the
// Block AST + pure helpers), never the reverse, so pulling an adapter's pipeline in can't form an
// import cycle. Routing is trivial: the agent's adapter builds the blocks, or — for any unknown/
// absent agent — the universal single raw block. This is the seam where the Claude-Code TUI grammars
// (and any future agent's) run; every non-adapter agent keeps the pure raw mirror.

import type { Block, StyledLine } from "../blocks";
import { adapterFor, hasBlockGrammar } from "./registry";
import { decorateMuseDisplay, rendersNativeMirror } from "./muse/display";

/**
 * Group lines into semantic blocks by routing through the agent's adapter. With no `ctx` (or an agent
 * that has no adapter) this is the trivial single-raw-block wrap it always was — conservative gating
 * lives entirely in the registry, so a non-adapter pane is never mis-parsed.
 *
 * Muse's display pass runs here, gated by the shared native-mirror predicate rather than the
 * registry: it is presentation-only (bright-foreground marks for the native light mirror,
 * .adr/0047), and registering an adapter would also flip the reply path off one-shot sends — a
 * behavioural change a display fix must not smuggle in. Dialog blocks are never decorated: only
 * raw blocks reach the mirror.
 */
export function buildBlocks(lines: StyledLine[], ctx?: { agent?: string }): Block[] {
  const blocks = adapterFor(ctx?.agent)?.buildBlocks(lines) ?? [{ kind: "raw", lines }];
  if (!rendersNativeMirror(ctx?.agent)) return blocks;
  let changed = false;
  const decorated = blocks.map((block) => {
    if (block.kind !== "raw") return block;
    const next = decorateMuseDisplay(block.lines);
    if (next === block.lines) return block;
    changed = true;
    return { ...block, lines: next };
  });
  return changed ? decorated : blocks;
}

export { adapterFor, hasBlockGrammar };
export { rendersNativeMirror } from "./muse/display";
export type { HarnessAdapter } from "./types";
