// WHICH PANE PAGE IS AN ISLANDS PAGE (S3). Read with the request's stores primed (ssr/render.tsx `prime`): the
// islands document draws a pane's Terminal, never its Chat (Chat stays the S2 document and the full client). So
// a pane page is an islands page when the pane frames are on and the pane would not show Chat:
// pane-start.ts `readGate`, Chat is the body only for a chat harness the device chose Chat for.
//
// The dashboard asks the same question per row: a row whose pane is not an islands page is a plain document
// link (`data-rmx-document`), so its tap is a straight document load, with no prefetch the resolver would
// only refuse (islands/resolver.ts, "not-a-document") one hop later.
import { hasJournalAdapter } from "@web/lib/journal-agents";
import { muxCapability } from "@web/lib/mux-capability";
import type { AgentView } from "@web/lib/types";

import { config } from "../lib/data";
import { dashPrefs, paneFrames } from "../lib/prefs";

export function paneDrawsIslands(pane: AgentView | undefined): boolean {
  if (!paneFrames.get()) return false;
  const shell = pane?.kind === "shell";
  const sessionLog = muxCapability(config.get().data?.mux ?? null, "agentSessionRef").capable;
  const chatHarness = pane !== undefined && !shell && sessionLog && (pane.hasSession === true || hasJournalAdapter(pane.agent));
  return !(dashPrefs.get().paneView === "chat" && chatHarness);
}
