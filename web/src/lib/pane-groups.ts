// THE DASHBOARD'S SECOND AXIS: a pane sits under the PLACE it lives in.
//
// `lib/triage.ts` answers "what needs me", and that answer stays on top of the dashboard because it
// is the dashboard's job. Everything it does NOT flag is answered here instead, by grouping: one
// group per `space › tab`, headed by that place and counted, so a row no longer has to repeat an
// address eighteen times down the page. Three rows under one tab heading are panes, because a tab is
// what contains panes — the structure says the KIND, which is the thing no surface used to say.
//
// ── WHAT DECIDES THE ORDER ───────────────────────────────────────────────────
// Groups run by SPACE NUMBER — the multiplexer's own numbering, the same order the space strip and
// the space navigator use — and within a space, by the order the tabs were first met in the list the
// bridge sent. Panes inside a group keep that same order untouched, which is the rule `triage()`
// already keeps for a bucket: the bridge sends one stable arrangement (status, space, tab, position
// in the tab) and it is the arrangement the operator made at the desk. A row therefore only ever
// moves when it changes GROUP, never because a clock ticked.
//
// ── SHELLS SIT WITH THEIR TAB ────────────────────────────────────────────────
// A bare shell is a pane of the tab it is in, so it lands in that tab's group rather than in a
// trailing pen of its own — after the agents, because a group is read for its work first. That is
// the one place the given order is not preserved verbatim, and it is deliberate.
//
// Pure and host-aware, so a crew's two `w1`s are two places (lib/hosts.ts § spaceKey).
import { hostKey } from "./hosts";
import { panePlace } from "./pane-name";
import type { AgentView } from "./types";

/** The same separator `lib/hosts.ts` composes its keys with: a byte no label may contain. */
const KEY_SEP = "\u0000";

/** One `space › tab` and the panes in it. */
export interface PlaceGroup {
  /** `(host, workspaceId, tabId)` — the only triple that names one tab in a merged herd. */
  key: string;
  /** The heading's text: `space › tab`, or the space alone when the tab carries no name. */
  label: string;
  /** Agents in the order they were given, then that tab's bare shells in theirs. */
  panes: AgentView[];
}

interface Bucket {
  key: string;
  label: string;
  /** The multiplexer's own space number — the outer sort key. */
  workspaceNumber: number;
  /** Where this tab was first met in the given lists — the inner sort key, i.e. tab order. */
  seq: number;
  agents: AgentView[];
  shells: AgentView[];
}

/**
 * `(host, session, workspaceId, tabId)`. A workspace id is unique only within one session on one
 * machine, exactly as a pane id is (`paneRowKey`), so a widened body holds several tabs answering to
 * `w1:t1` and only the full address tells them apart. `hostKey` supplies the untagged-is-ambient
 * half of the rule, so a solo un-widened list keys as a pure prefix extension of the bare ids.
 */
export function placeKey(pane: AgentView): string {
  return `${hostKey(pane)}${KEY_SEP}${pane.session ?? ""}${KEY_SEP}${pane.workspaceId}${KEY_SEP}${pane.tabId}`;
}

/**
 * Bucket a herd by place. Every pane appears exactly once, empty groups do not exist, and a caller
 * that hands the same two lists twice gets the same groups in the same order.
 */
export function groupPanesByPlace(
  agents: readonly AgentView[],
  shellPanes: readonly AgentView[] = [],
): PlaceGroup[] {
  const byKey = new Map<string, Bucket>();
  let seq = 0;

  const bucket = (pane: AgentView): Bucket => {
    const key = placeKey(pane);
    const found = byKey.get(key);
    if (found) return found;
    const made: Bucket = {
      key,
      // The joined form, because a heading is one run of text with the whole width of the page —
      // the two-span split `agent-card.tsx` uses exists for a 390px ROW, which has to truncate.
      label: panePlace(pane),
      workspaceNumber: pane.workspaceNumber,
      seq: seq++,
      agents: [],
      shells: [],
    };
    byKey.set(key, made);
    return made;
  };

  for (const a of agents) bucket(a).agents.push(a);
  for (const s of shellPanes) bucket(s).shells.push(s);

  return [...byKey.values()]
    .toSorted((a, b) => a.workspaceNumber - b.workspaceNumber || a.seq - b.seq)
    .map((g) => ({ key: g.key, label: g.label, panes: [...g.agents, ...g.shells] }));
}
