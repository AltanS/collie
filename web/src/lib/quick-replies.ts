// The one-tap replies behind the composer's Quick dock, per pane kind.
//
// Modelled on agent-commands.ts (a plain static catalog keyed by the Herdr snapshot `agent` string,
// read through a tolerant lookup) and deliberately NOT on the harness adapter registry: an adapter
// is DETECTION only — grammars for lifting dialogs out of a terminal buffer — and a list of English
// phrases is content policy, not detection. Bolting these onto HarnessAdapter would also strand
// pi/opencode, which have no adapter at all (they run the raw-mirror fallback) yet still want
// quick replies. Keeping them here means a per-agent divergence later is a data edit, not a refactor.
//
// The split that actually matters TODAY is agent vs shell, not agent vs agent: "yes"/"continue" mean
// the same thing to every LLM harness, but "commit and push" typed at a bare bash prompt is nonsense
// and "skip" is meaningless there. Hence one shared agent set plus a distinct shell set. The catalog
// is keyed per agent anyway so a real divergence (a harness that wants "approve" over "yes") is a
// one-line addition rather than a restructuring.

import { rowsFor } from "@/lib/operator-scope";
import type { OperatorQuickReplyRow } from "@/lib/types";

export interface QuickReplyGroup {
  /** Lowercase section label shown above the grid. */
  title: string;
  /** The literal strings sent — each is typed into the pane and submitted verbatim. */
  items: readonly string[];
}

// Shared by every LLM harness. Deduped to distinct intents: no yes/ok/approve/go-ahead pile-up, and
// no "stop" that just duplicates Esc in the Keys pad.
const AGENT: readonly QuickReplyGroup[] = [
  { title: "confirm", items: ["yes", "no"] },
  { title: "common", items: ["continue", "commit and push", "retry", "skip"] },
];

// A bare shell has no notion of continuing or skipping a turn — the only near-universal one-tap
// replies are the classic Unix y/n confirmations, so that's all it gets. An almost-empty dock is the
// honest answer here; padding it with agent phrases would just be four buttons that do nothing
// useful when tapped.
const SHELL: readonly QuickReplyGroup[] = [{ title: "confirm", items: ["y", "n"] }];

// Per-agent overrides. Empty today by design — every known harness takes the shared AGENT set, and
// this map exists so the FIRST real divergence is a data edit here rather than a refactor of the
// call site. Keys are Herdr snapshot `agent` strings ("claude", "codex", "pi", "opencode").
const CATALOG: Record<string, readonly QuickReplyGroup[]> = {};

/**
 * The quick replies for a pane. `isShell` wins over `agent` — a shell pane reports agent "shell",
 * but the caller already knows its kind and shouldn't depend on that string staying stable.
 *
 * `Object.hasOwn`, not a truthy index, so an inherited Object.prototype key ("toString",
 * "constructor", "__proto__", …) arriving as an agent name can't resolve to a non-array and crash
 * the dock — the same hardening adapterFor() applies.
 */
export function quickRepliesFor(
  agent: string | undefined | null,
  isShell: boolean,
  mine: readonly OperatorQuickReplyRow[] = [],
): readonly QuickReplyGroup[] {
  // The operator's own groups REPLACE the shipped ones on a pane they address, never merge into
  // them (ADR 0018) — the same rule `commands.toml` and `keys.toml` follow. A pane none of their
  // rows reach is untouched, and an operator who declared nothing gets every pane exactly as
  // shipped.
  //
  // A shell is scoped like any other pane: `scope = "shell"` addresses it, an unscoped row reaches
  // it too. That is deliberate — an operator who replaces the dock in another language means the
  // y/n pair as much as the rest of it, and a shell that silently kept English would be the one
  // pane their file could not reach.
  const aimed = rowsFor(mine, isShell ? "shell" : agent, (row) => row.title);
  if (aimed.length > 0) return aimed.map((row) => ({ title: row.title, items: row.items }));
  if (isShell) return SHELL;
  if (agent != null && Object.hasOwn(CATALOG, agent)) return CATALOG[agent];
  return AGENT;
}
