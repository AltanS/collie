import { useMemo } from "react";

import type { BeltMark } from "@/components/actions-row";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
import { useBridgeNow } from "@/lib/tricks/clock";
import { isPastWindow } from "@/lib/tricks/frame";
import { TrickMark } from "@/lib/tricks/mark";
import { parseTrickSessionId, partKey, type WireTrickPart } from "@/lib/tricks/schema";
import { useTrickPart, type TricksStore, tricksStore, type TapHandlers, trickTapper } from "@/lib/tricks/store";
import type { AgentView } from "@/lib/types";
import { cn } from "@/lib/utils";

// THE BELT'S END-BLOCK MARKS (M94 slice 03): one per `belt` part of a trick that is on, between the pins
// mark and Changes, in manifest order (lib/tricks/store.ts `useTrickParts`). Each is a `TrickMark` in its own
// frame, never a pill and never a status mark.
//
// A TAP: a mark with an intent goes to the trick's provider (`trickTapper`), and shows Collie's spinner
// in its icon's box while the tap is in flight. A mark without an intent opens the trick's own session
// when it has one, one level down; without a session it is not a control at all.

/** The 44px reach a mark's 28px frame takes, the same as lib/tricks/mark.tsx gives a tappable mark. */
const REACH = "relative before:absolute before:-inset-x-1 before:-inset-y-2 before:content-['']";

/** The session a mark without an intent opens: the trick's first session part. */
export function sessionOfMark(part: Pick<WireTrickPart, "host" | "trick">, sessions: readonly AgentView[]): AgentView | undefined {
  return sessions.find((pane) => {
    const address = parseTrickSessionId(pane.paneId);
    return address?.host === part.host && address.trick === part.trick;
  });
}

function BeltTrickMark({
  partKey: key,
  handlers,
  session,
  onOpenSession,
  store,
}: {
  partKey: string;
  handlers: TapHandlers;
  session: AgentView | undefined;
  onOpenSession: (pane: AgentView) => void;
  store: TricksStore;
}) {
  useLocale();
  const { part, trick, tap } = useTrickPart(key, store);
  const now = useBridgeNow();
  const onTap = useMemo(() => trickTapper(handlers, store), [handlers, store]);
  const value = part?.value;
  if (part === undefined || value?.at !== "belt") return null;
  const mark = value.mark;
  const trickName = trick?.name ?? part.trick;
  const stale = part.stale === true || isPastWindow(part, now);
  const busy = tap?.phase === "busy";
  const unknown = tap?.phase === "unknown";
  if (mark.intent !== undefined) {
    const intent = mark.intent;
    return <TrickMark mark={mark} trickName={trickName} stale={stale} busy={busy} unknown={unknown} onTap={() => onTap(key, intent, undefined, "mark")} />;
  }
  if (session === undefined) return <TrickMark mark={mark} trickName={trickName} stale={stale} />;
  return (
    <button
      type="button"
      data-slot="belt-trick-open"
      aria-label={t("tricks.mark.open", { trick: trickName })}
      onClick={() => onOpenSession(session)}
      className={cn(
        "inline-flex rounded-sm transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.98]",
        REACH,
      )}
    >
      <TrickMark mark={mark} trickName={trickName} stale={stale} />
    </button>
  );
}

/** The belt's marks, ready for `ActionsRow` `marks`. */
export function beltMarksOf(opts: {
  parts: readonly WireTrickPart[];
  /** The tap handlers for a part, by the host its trick runs on. */
  handlersFor: (host: string) => TapHandlers;
  sessions: readonly AgentView[];
  onOpenSession: (pane: AgentView) => void;
  store?: TricksStore;
}): BeltMark[] {
  const store = opts.store ?? tricksStore;
  return opts.parts.map((part) => {
    const key = partKey(part);
    return {
      id: key,
      trick: part.trick,
      face: <BeltTrickMark partKey={key} handlers={opts.handlersFor(part.host)} session={sessionOfMark(part, opts.sessions)} onOpenSession={opts.onOpenSession} store={store} />,
    };
  });
}
