// The block-building DISPATCHER — the public entry the renderer (ansi-output) calls. It lives HERE
// rather than in blocks.ts to keep the dependency edge one-way: harness/ imports blocks.ts (for the
// Block AST + pure helpers), never the reverse, so pulling an adapter's pipeline in can't form an
// import cycle. Routing is trivial: the agent's adapter builds the blocks, or — for any unknown/
// absent agent — the universal single raw block. This is the seam where the Claude-Code TUI grammars
// (and any future agent's) run; every non-adapter agent keeps the pure raw mirror.

import { lineText, type Block, type StyledLine } from "../blocks";
import { adapterFor, hasBlockGrammar } from "./registry";
import { unreadDialogSignature } from "./unread-dialog-model";
import type { HarnessAdapter } from "./types";
import {
  decorateMuseDisplay,
  rendersNativeMirror,
  trimMuseRowChrome,
  trimsRowChrome,
} from "./muse/display";

/**
 * Group lines into semantic blocks by routing through the agent's adapter. With no `ctx` (or an agent
 * that has no adapter) this is the trivial single-raw-block wrap it always was — conservative gating
 * lives entirely in the registry, so a non-adapter pane is never mis-parsed.
 *
 * Native display passes run here, gated by the shared native-mirror predicate rather than
 * the registry: they are presentation-only (bright-foreground marks for the native light
 * mirror, .adr/0047), and registering an adapter would also flip the reply path off
 * one-shot sends — a behavioural change a display fix must not smuggle in. The row-chrome
 * trim is the exception: it removes visible bytes by design, so it stays gated on Muse,
 * whose gutter shape it was measured against. Dialog blocks are never touched: only raw
 * blocks reach the mirror.
 */
export function buildBlocks(
  lines: StyledLine[],
  ctx?: { agent?: string; grammars?: boolean; nativeMirror?: boolean },
): Block[] {
  // `grammars: false` is the raw-terminal pref: no adapter runs, so no chrome is stripped and no
  // dialog is lifted, but a native-mirror agent still keeps its display passes below.
  const adapter = ctx?.grammars === false ? undefined : adapterFor(ctx?.agent);
  const blocks = adapter?.buildBlocks(lines) ?? [{ kind: "raw", lines }];
  // The unread-dialog post-pass runs LAST, over the DECORATED blocks. The display passes only ever
  // touch raw blocks, so running the card first would leave every Muse card showing an un-trimmed,
  // un-marked mirror — the card renders the region itself, and a native-mirror agent's region has to
  // arrive the way the mirror would have drawn it. With `grammars: false` there is no adapter, so the
  // raw-terminal pref still switches the card off for free.
  return withUnreadDialog(adapter, lines, decorateNativeMirror(blocks, ctx));
}

/** The native display passes (.adr/0047), unchanged: bright-foreground marks for the light native
 *  mirror, plus Muse's row-chrome trim. Raw blocks only — a lifted dialog never reaches the mirror.
 *  Split out of `buildBlocks` so the unread-dialog pass can be composed after it rather than before. */
function decorateNativeMirror(
  blocks: Block[],
  ctx?: { agent?: string; nativeMirror?: boolean },
): Block[] {
  if (!rendersNativeMirror(ctx?.agent, ctx?.nativeMirror)) return blocks;
  const trim = trimsRowChrome(ctx?.agent);
  let changed = false;
  const decorated = blocks.map((block) => {
    if (block.kind !== "raw") return block;
    const trimmed = trim ? trimMuseRowChrome(block.lines) : block.lines;
    const next = decorateMuseDisplay(trimmed);
    if (next === block.lines) return block;
    changed = true;
    return { ...block, lines: next };
  });
  return changed ? decorated : blocks;
}


/**
 * The UNREAD-DIALOG post-pass (.adr/0053). Offer the adapter's DECLARED cancel key over a screen
 * every one of its grammars honestly declined, when the adapter can still tell the composer is not
 * on it.
 *
 * Four conditions, all of them, or the blocks come back untouched and identity-equal:
 *  1. there is an adapter, and it DECLARED a `cancelKey` (no declaration → no card, per adapter);
 *  2. nothing lifted — every block is `raw` (a grammar that read the screen owns it);
 *  3. `composerReady` answered a definite `false` (a throw or `undefined` is not a false);
 *  4. the screen is not blank (a cleared buffer is not a dialog).
 *
 * It lives OUTSIDE every adapter on purpose, so no adapter's `buildBlocks` can emit this kind and
 * the cross-adapter fail-closed cohorts stay exactly as strict as they were. It reads no footer and
 * infers no key: this is not a grammar and it does not meet .adr/0009's confidence bar. It is one
 * declared escape hatch over an unmodelled screen.
 *
 * The race guard's reach is the signature's window: it spans the last 12 non-blank lines, so a
 * spinner repainting INSIDE that window aborts the tap — the safe side, since a screen we could not
 * read a moment ago and cannot read now is not one to fire a key at — while a spinner above the
 * window does not, and the tap goes out against a screen whose tail is genuinely unchanged.
 *
 * Exported because the wrapper below is NOT the only consumer: `agent-chat.tsx`'s `dialogPresent`
 * and `lib/dialog-guard.ts`'s `dialogDetector` both call `adapter.buildBlocks` directly, and both
 * must see the card or the composer stays open onto the modal it was written for. The conformance
 * suite (harness/conformance.ts) calls the adapter directly too, and is correctly left out.
 */
export function withUnreadDialog(
  adapter: HarnessAdapter | undefined,
  lines: StyledLine[],
  blocks: Block[],
): Block[] {
  const key = adapter?.cancelKey;
  if (adapter === undefined || key === undefined) return blocks;
  if (!blocks.every((b) => b.kind === "raw")) return blocks;
  // A THROW is not a `false`. The pre-flight (lib/reply-action.ts) only refuses on a definite false
  // and this card is the same claim with a button on it, so a probe that blew up is treated exactly
  // like an adapter that declined to answer.
  let ready: boolean | undefined;
  try {
    ready = adapter.composerReady?.(lines);
  } catch {
    ready = undefined;
  }
  if (ready !== false) return blocks;
  const texts = lines.map(lineText);
  if (!texts.some((t) => t.trim() !== "")) return blocks;
  return [
    {
      kind: "unread-dialog",
      cancel: { key, agent: adapter.agent, signature: unreadDialogSignature(texts) },
      // The lines the pass was HANDED, not the ones it probed: every block here is raw, and on a
      // native-mirror agent they have already been through the display passes. The card renders this
      // region itself, so it must be what the mirror would have drawn. The probes above stay on the
      // original `lines`, because `composerReady`, blankness and the signature are claims about the
      // real screen, and the row-chrome trim removes visible bytes by design.
      lines: blocks.flatMap((b) => b.lines),
    },
  ];
}

export { adapterFor, hasBlockGrammar };
export { rendersNativeMirror } from "./muse/display";
export type { HarnessAdapter } from "./types";
