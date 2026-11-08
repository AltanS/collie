import { useMemo } from "react";

import type { BeltMark } from "@/components/actions-row";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
import { useBridgeNow } from "@/lib/mods/clock";
import { isPastWindow } from "@/lib/mods/frame";
import { ModMark } from "@/lib/mods/mark";
import { parseModSessionId, partKey, type WireModPart } from "@/lib/mods/schema";
import { useModPart, type ModsStore, modsStore, type TapHandlers, modTapper } from "@/lib/mods/store";
import type { AgentView } from "@/lib/types";
import { cn } from "@/lib/utils";

// THE BELT'S END-BLOCK MARKS (M94 slice 03): one per `belt` part of a mod that is on, between the pins
// mark and Changes, in manifest order (lib/mods/store.ts `useModParts`). Each is a `ModMark` in its own
// frame, never a pill and never a status mark.
//
// A TAP: a mark with an intent goes to the mod's provider (`modTapper`), and shows Collie's spinner
// in its icon's box while the tap is in flight. A mark without an intent opens the mod's own session
// when it has one, one level down; without a session it is not a control at all.

/** The 44px reach a mark's 28px frame takes, the same as lib/mods/mark.tsx gives a tappable mark. */
const REACH = "relative before:absolute before:-inset-x-1 before:-inset-y-2 before:content-['']";

/** The session a mark without an intent opens: the mod's first session part. */
export function sessionOfMark(part: Pick<WireModPart, "host" | "mod">, sessions: readonly AgentView[]): AgentView | undefined {
  return sessions.find((pane) => {
    const address = parseModSessionId(pane.paneId);
    return address?.host === part.host && address.mod === part.mod;
  });
}

function BeltModMark({
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
  store: ModsStore;
}) {
  useLocale();
  const { part, mod, tap } = useModPart(key, store);
  const now = useBridgeNow();
  const onTap = useMemo(() => modTapper(handlers, store), [handlers, store]);
  const value = part?.value;
  if (part === undefined || value?.at !== "belt") return null;
  const mark = value.mark;
  const modName = mod?.name ?? part.mod;
  const stale = part.stale === true || isPastWindow(part, now);
  const busy = tap?.phase === "busy";
  const unknown = tap?.phase === "unknown";
  if (mark.intent !== undefined) {
    const intent = mark.intent;
    return <ModMark mark={mark} modName={modName} stale={stale} busy={busy} unknown={unknown} onTap={() => onTap(key, intent, mark.args, "mark")} />;
  }
  if (session === undefined) return <ModMark mark={mark} modName={modName} stale={stale} />;
  return (
    <button
      type="button"
      data-slot="belt-mod-open"
      aria-label={t("mods.mark.open", { mod: modName })}
      onClick={() => onOpenSession(session)}
      className={cn(
        "inline-flex rounded-sm transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.98]",
        REACH,
      )}
    >
      <ModMark mark={mark} modName={modName} stale={stale} />
    </button>
  );
}

/** The belt's marks, ready for `ActionsRow` `marks`. */
export function beltMarksOf(opts: {
  parts: readonly WireModPart[];
  /** The tap handlers for a part, by the host its mod runs on. */
  handlersFor: (host: string) => TapHandlers;
  sessions: readonly AgentView[];
  onOpenSession: (pane: AgentView) => void;
  store?: ModsStore;
}): BeltMark[] {
  const store = opts.store ?? modsStore;
  return opts.parts.map((part) => {
    const key = partKey(part);
    return {
      id: key,
      mod: part.mod,
      face: <BeltModMark partKey={key} handlers={opts.handlersFor(part.host)} session={sessionOfMark(part, opts.sessions)} onOpenSession={opts.onOpenSession} store={store} />,
    };
  });
}
