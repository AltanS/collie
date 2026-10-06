// The pane screen's reads and the one write gate.
//
// THE MIRROR READ GOES THROUGH web/src/lib/api.ts's `fetchPane`, not this shell's own. Two reasons,
// both about the dialog answers that reuse web's action modules unchanged:
//   - the race guard and `settleAfterSend` (web/src/lib/harness/guard.ts) read the pane through that
//     module and compare against the text it last saw (`textBeforeLastSend`). Polling through the
//     same module is what gives them that baseline;
//   - it asks for `?lines=N` (the 600-row tail web's loader asks for), and the guard re-reads with
//     the same N, so the screen a tap is verified against is the screen the card was drawn from.
// It writes the shell's own `paneStore`, so every other reader of a pane sees the same data.
//
// Nothing is sent for a revision: neither shell sends one. `revision` comes back on every read and
// rides into the guard as `detectedRevision`.
import { fetchPane, isApiErrorStatus } from "@web/lib/api";
import { parseAnsi } from "@web/lib/ansi";
import { splitLines, type Block } from "@web/lib/blocks";
import { buildBlocks } from "@web/lib/harness";
import { muxCapability } from "@web/lib/mux-capability";
import type { Scope } from "@web/lib/scope";
import { isReadOnly, type AgentView, type BridgeConfig, type SnapshotResponse } from "@web/lib/types";
import { t } from "@web/lib/i18n";

import { paneStore } from "../../lib/data";
import { markPollResult } from "../../lib/polling";

/** The tail web's pane loader asks for (web/src/lib/loaders.ts), and what the guard re-reads. */
export const PANE_LINES = 600;
/** Load older grows the window by this much, up to the cap (web/src/lib/loaders.ts). */
export const PANE_LINES_STEP = 600;
export const PANE_LINES_MAX = 1000;

/** The statuses the screen branches on. Anything else is "the bridge did not answer". */
const KNOWN_STATUSES = [401, 403, 404, 409, 502, 503] as const;

/** The HTTP status a failed read carried, when it was one of the known ones. */
export function statusOf(error: Error): number | undefined {
  return KNOWN_STATUSES.find((status) => isApiErrorStatus(error, status));
}

/**
 * One poll of a pane's mirror into `paneStore(key)`. Resolves true when the text changed.
 *
 * It is the cadence's one "is the screen still moving" signal (`markPollResult`, web's paneLoader):
 * a 304 hands back the held body, so the text compare is false then, and also on a bridge with no
 * ETag. A failed read reports nothing, as web's loader does.
 */
export async function pollPane(key: string, paneId: string, scope: Scope, signal: AbortSignal, lines = PANE_LINES): Promise<boolean> {
  const store = paneStore(key);
  try {
    const body = await fetchPane(paneId, lines, scope, signal);
    const changed = body.text !== store.get().data?.text;
    store.set({ data: body, error: undefined, status: undefined, at: Date.now() });
    markPollResult(changed);
    return changed;
  } catch (error) {
    if (!(error instanceof Error) || error.name === "AbortError") return false;
    store.update((prev) => ({ ...prev, error: error.message, status: statusOf(error) }));
    return false;
  }
}

/** The pane in the snapshot, agents first, then bare shells. */
export function findPane(data: SnapshotResponse | undefined, paneId: string): AgentView | undefined {
  return (
    data?.agents.find((p) => p.paneId === paneId) ?? data?.shellPanes?.find((p) => p.paneId === paneId)
  );
}

/**
 * Blocks for one screen, built once per (text, agent) and reused while neither moves. The agent
 * string goes to web's adapter registry as it came in the payload: an agent with no adapter gets the
 * plain mirror and no card, by the registry's own rule.
 */
export function blockBuilder(): (text: string, agent: string | undefined) => Block[] {
  let lastText: string | undefined;
  let lastAgent: string | undefined;
  let last: Block[] = [];
  return (text, agent) => {
    if (text === lastText && agent === lastAgent) return last;
    lastText = text;
    lastAgent = agent;
    last = buildBlocks(splitLines(parseAnsi(text)), { agent });
    return last;
  };
}

/** What the write gate reads. */
export interface WriteGateInput {
  gone: boolean;
  shell: boolean;
  snapshot: SnapshotResponse | undefined;
  config: BridgeConfig | undefined;
  notPaired: boolean;
}

export interface WriteGate {
  /** The placeholder the composer shows (also the refusal a dialog tap reports). */
  placeholder: string;
  /** True when nothing may be written. */
  locked: boolean;
  /** The device is not paired or not authorised: the notice links to the pairing settings. */
  unpaired: boolean;
}

/** The composer's lock and placeholder (web/src/components/composer.tsx, priority order). */
export function writeGate(input: WriteGateInput): WriteGate {
  const unpaired = input.notPaired || isReadOnly(input.snapshot?.device);
  const mux = input.config?.mux ?? null;
  const typeText = muxCapability(mux, "typeText");
  const sendKeys = muxCapability(mux, "sendKeys");
  const missing = !typeText.capable ? typeText : !sendKeys.capable ? sendKeys : null;
  if (input.gone) return { placeholder: t("composer.placeholder.gone"), locked: true, unpaired };
  if (unpaired) return { placeholder: t("composer.placeholder.readOnly"), locked: true, unpaired };
  if (missing !== null) {
    return { placeholder: missing.note || t("composer.placeholder.noMuxSend"), locked: true, unpaired };
  }
  return {
    placeholder: input.shell ? t("composer.placeholder.shell") : t("composer.placeholder.reply"),
    locked: false,
    unpaired,
  };
}
