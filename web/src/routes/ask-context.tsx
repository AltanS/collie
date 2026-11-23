import { useCallback } from "react";
import { useParams } from "react-router";

import { AskClosed } from "@/components/ask-closed";
import { AskContext } from "@/components/ask-context";
import { useCrew } from "@/components/crew-provider";
import { useAsksDeck } from "@/hooks/use-asks-deck";
import { useLocale } from "@/hooks/use-locale";
import { useNav } from "@/hooks/use-nav";
import { askFileRequest, mayOpenFile, sessionFacts } from "@/lib/hill/asks";
import { askedWords } from "@/lib/hill/asks-board";
import { useHillClosed, useHillOpen } from "@/lib/hill/store";
import type { HillAskFile } from "@/lib/hill/wire";
import { useMuxCapability } from "@/lib/mux-capability";
import { askPath, filesPath, hillPath, type FilesAt } from "@/lib/nav";
import { useScope } from "@/lib/session";
import { closedAskWhy } from "@/lib/hill/asks";

// THE CONTEXT PAGE'S ROUTE (Asks build 2, 2026-11-23), `/hill/ask/:id/context`: a child of the ask. Back goes up to the ask
// (the entry behind it, or a replace onto it when the page was opened by a link). A linked file opens the Files preview
// one level further down (`nav.down`), under the pane the ask named, with the crew member's scope when the session lives
// on another machine. An ask that closed while the page was open shows the closed screen: there is nothing to answer.

export function AskContextRoute() {
  useLocale();
  const { id = "" } = useParams();
  const nav = useNav();
  const scope = useScope();
  const { lead } = useCrew();
  const { sessions, live, now } = useAsksDeck();
  const closed = useHillClosed();
  const open = useHillOpen();
  const screenless = !useMuxCapability("paneGrid", scope).capable;
  const back = useCallback(() => nav.up(askPath(id, scope)), [nav, scope, id]);

  const session = sessions.find((candidate) => candidate.asks.some((ask) => ask.id === id));
  const ask = session?.asks.find((candidate) => candidate.id === id);
  if (session === undefined || ask === undefined) {
    const decision = [...closed, ...open].find((candidate) => candidate.id === id);
    const why = decision === undefined ? null : closedAskWhy(decision);
    return <AskClosed name={decision?.from.label ?? ""} line={decision === undefined ? " " : askedWords(decision.at, now)} title={decision?.title ?? null} why={why} newer={false} onBack={() => nav.up(hillPath(scope))} onNewer={back} />;
  }
  const facts = sessionFacts(session, live);
  const openFile = (file: HillAskFile): (() => void) | null => {
    if (!mayOpenFile(ask.ask, facts, screenless)) return null;
    const request = askFileRequest(ask, file, lead);
    if (request === null) return null;
    const at: FilesAt = { path: request.path };
    if (request.line !== undefined) at.line = request.line;
    return () => nav.down(filesPath(request.paneId, request.scope, at));
  };
  return <AskContext ask={ask} name={facts.name} openFile={openFile} onBack={back} />;
}
