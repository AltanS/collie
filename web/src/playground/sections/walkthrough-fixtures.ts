// The data the app-walkthrough card feeds the real route table, and the ONLY fixtures that live
// outside `../fixtures.ts`. They sit here because they belong to one card: the transcript below is
// the minimum `/pane/:paneId/history` needs to render its list, not a state anyone reaches on
// purpose, and the snapshot below is a composition of fixtures that already exist rather than a new
// one. DEV-ONLY, like the rest of `src/playground/`.

import { leadHost, primarySession, sessionsOnHost } from "@/lib/hosts";
import type { HistoryData, HomeData } from "@/lib/loaders";

import {
  herd,
  homeSolo,
  onHost,
  paneBlocked,
  paneShell,
  paneWorking,
  rosterTrio,
  sessionsCrew,
  shells,
  updateRelease,
} from "../fixtures";

/** The machine every pane in this snapshot runs on. It is the crew's lead. */
export const WALKTHROUGH_HOST = leadHost(rosterTrio) ?? "lodge";

/**
 * The snapshot the walkthrough runs on, and the one property that makes the walk work: IT IS
 * SELF-CONSISTENT. Every pane names a tab that exists, every tab names a space that exists, and
 * every pane runs on the LEAD.
 *
 * The last one is not decoration. The space navigator is lead-local by design (`routes/space.tsx`,
 * `leadHost`), so a pane parked on a peer is invisible in the space and tab strips, and half the
 * tab chips would open an empty section. `homeCrew` spreads the herd over five machines to make the
 * server switcher's per-host counts mean something, which is right for the cards that show the
 * switcher and wrong for a card about walking around. So the herd is tagged `lodge` throughout: the
 * rows still carry a host chip, the roster still holds three machines, and the peers hold no panes.
 *
 * The rest is composition: the plain four spaces (whose labels match the tabs and the panes' working
 * directories), the crew's session registry, and a release on offer so the band above the header has
 * a strip in it.
 */
export const walkthroughHome: HomeData = {
  ...homeSolo,
  agents: herd.map((pane) => onHost(pane, WALKTHROUGH_HOST)),
  shellPanes: shells.map((pane) => onHost(pane, WALKTHROUGH_HOST)),
  sessions: sessionsCrew,
  servers: rosterTrio,
  update: updateRelease,
};

/** The session an address with no `?s=` resolves to on this snapshot. */
export const WALKTHROUGH_SESSION =
  primarySession(
    sessionsOnHost(walkthroughHome.sessions, { host: WALKTHROUGH_HOST }, walkthroughHome.servers),
  ) ?? "default";

/** The space the walkthrough drills into, and the pane it opens. */
export const WALKTHROUGH_SPACE_ID = walkthroughHome.workspaces[0]!.workspaceId;
export const WALKTHROUGH_PANE_ID = paneWorking.pane.paneId;

/** One pane's mirror: the text and the revision the pane loader answers with. */
export interface WalkthroughScreen {
  text: string;
  revision: number;
}

// The captured screens, by the pane they belong to. Three panes have their own: the permission
// prompt, the mid-tool-run, and a bare shell. Every other pane in the snapshot answers with the
// mid-tool-run screen or, for the second shell, the shell screen — a stand-in, so that opening ANY
// row in the herd lands on a pane view with real bytes in it instead of an empty mirror.
const SCREENS = new Map<string, WalkthroughScreen>([
  [paneBlocked.pane.paneId, { text: paneBlocked.text, revision: paneBlocked.revision }],
  [paneWorking.pane.paneId, { text: paneWorking.text, revision: paneWorking.revision }],
  [paneShell.pane.paneId, { text: paneShell.text, revision: paneShell.revision }],
]);

const SHELL_PANE_IDS: ReadonlySet<string> = new Set(walkthroughHome.shellPanes.map((p) => p.paneId));

/** The mirror for any pane in this snapshot, and for a pane id it does not know. */
export function walkthroughScreen(paneId: string): WalkthroughScreen {
  const own = SCREENS.get(paneId);
  if (own) return own;
  if (SHELL_PANE_IDS.has(paneId)) return { text: paneShell.text, revision: paneShell.revision };
  return { text: paneWorking.text, revision: paneWorking.revision };
}

const HISTORY_TS = "2026-09-10T09:14:00.000Z";

/**
 * A four-turn transcript — speech, a tool call and its result, and a compaction summary. Enough for
 * `TranscriptView` to render every part kind it has a renderer for, and short enough that the
 * history screen's own paging never comes into it (`hasMore: false`).
 */
export const walkthroughHistory: HistoryData = {
  paneId: WALKTHROUGH_PANE_ID,
  scope: {},
  entries: [
    {
      uuid: "wt-1",
      ts: HISTORY_TS,
      role: "user",
      parts: [{ kind: "text", text: "Run the web tests and tell me what fails." }],
    },
    {
      uuid: "wt-2",
      ts: HISTORY_TS,
      role: "assistant",
      parts: [
        { kind: "text", text: "Running the suite now." },
        {
          kind: "tool",
          name: "Bash",
          summary: "bun run test",
          result: { text: "Tests  1 failed | 55 passed (56)" },
        },
      ],
    },
    {
      uuid: "wt-3",
      ts: HISTORY_TS,
      role: "assistant",
      parts: [
        {
          kind: "text",
          text: "One case fails: the pane header's stale stamp reads the herd's clock, not the mirror's.",
        },
      ],
    },
    {
      uuid: "wt-4",
      ts: HISTORY_TS,
      role: "summary",
      parts: [{ kind: "text", text: "Earlier turns compacted: setup, the first two test runs." }],
    },
  ],
  hasMore: false,
  total: 4,
  fileTruncated: false,
};
