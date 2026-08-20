// HOW A BEACON NAMES ONE OF THIS ADAPTER'S PANES (M11/03) — zellij's half of the join.
//
// It lives beside the adapter because it is knowledge about ZELLIJ's environment, and the decorator
// (bridge/beacon/decorate.ts) only knows how to ask. Two facts, both probed 2026-08-20 inside a real
// zellij pane:
//
//   • `$ZELLIJ_PANE_ID` is `0` — a BARE INTEGER, where the Collie pane id is `terminal_0`. The
//     emitter stores the raw value, because it cannot know which multiplexer this Collie drives and a
//     value rewritten on the way in could never be un-rewritten on the way out. So the prefix is
//     applied HERE, at the join, and {@link TERMINAL_PREFIX} is the adapter's own constant rather
//     than a second copy of the string.
//   • `$ZELLIJ_SESSION_NAME` is the session, which is zellij's whole addressing space.
//
// ── WHY THE PREFIX MATTERS AND IS NOT DECORATION ──────────────────────────────────────────────────
//
// zellij numbers TERMINAL panes and PLUGIN panes in separate namespaces: `plugin_0` and `terminal_0`
// both exist, at the same time, in the same tab (protocol.ts § the pane id). A join that compared the
// bare integer would therefore be comparing a number that names two different panes — and Collie's
// ids carry the namespace precisely so `terminal_1` and a plugin's `1` can never be confused.
//
// ── THE SCOPE CHECK IS LOAD-BEARING, NOT DEFENSIVE ────────────────────────────────────────────────
//
// zellij pane ids are per-SESSION and they restart at 0 in each one, so `terminal_3` in the
// operator's other session is a different pane with the same name. Without the scope check a beacon
// from that session would hand this pane somebody else's agent, session and status.

import type { BeaconMatcher } from "../../beacon/decorate.ts";
import type { MuxPane } from "../types.ts";
import { TERMINAL_PREFIX } from "./protocol.ts";
import type { ZellijSessionBinding } from "./session.ts";

/**
 * zellij's beacon matcher.
 *
 * `namespace` is handed in rather than imported from `adapter.ts`, so this module does not import
 * back into the module that imports it. It IS the adapter's registry key and nothing else — the
 * emitter writes that same key into every marker it records (`cli/beacon.ts` MUX_ENV_MARKERS).
 */
export function zellijBeaconMatcher(namespace: string, session: ZellijSessionBinding): BeaconMatcher {
  return {
    namespace,
    async scope(): Promise<string | null> {
      // The binding's own resolution, not its display label: a collie that named no session
      // discovers the single running one, and the label falls back to a placeholder before that has
      // happened. A placeholder compared against a real `$ZELLIJ_SESSION_NAME` would match nothing —
      // silently — where `null` joins nothing loudly.
      const resolved = await session.name();
      return resolved.ok ? resolved.session : null;
    },
    matches(pane: MuxPane, marker, scope): boolean {
      // The prefix is applied HERE rather than by the emitter, and it is not decoration: zellij's
      // `plugin_0` and `terminal_0` coexist in one tab, so the bare integer names two panes and only
      // the namespaced id names one.
      return marker.scope === scope && `${TERMINAL_PREFIX}${marker.pane}` === pane.paneId;
    },
    notesWithoutHooks: {
      agentDetection:
        "zellij does not know what an agent is, so Collie asks the agent instead: install the beacon hooks with `collie hooks install claude` and a pane running Claude names itself and its status. Until then every pane reads as a shell rather than as a guess that would pick the wrong grammar.",
      agentSessionRef:
        "Reading an agent's own session log needs a reference to one, and zellij supplies none. `collie hooks install claude` lets the agent supply it; until then history is absent here, not empty.",
    },
  };
}
