import type { BeltMark } from "@/components/actions-row";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
import { useBridgeNow } from "@/lib/tricks/clock";
import { isPastWindow } from "@/lib/tricks/frame";
import { TrickBoundary } from "@/lib/tricks/boundary";
import { TrickMark } from "@/lib/tricks/mark";
import { parseTrickSessionId, partKey, type WireTrickPart } from "@/lib/tricks/schema";
import { setStatus } from "@/lib/status";
import { tapRefusalLine, useTrickPart, type TricksStore, tricksStore, type TapHandlers } from "@/lib/tricks/store";
import type { AgentView } from "@/lib/types";

// THE BELT'S TRICK MARKS (M94 slice 03): one per `belt` part of a trick that is on, in manifest order
// (lib/tricks/store.ts `useTrickParts`), at the end of the belt's scrolling strip after Collie's own pills
// (actions-row.tsx draws them there; they never take room in the pinned block). Each is a `TrickMark` in its
// own frame, never a pill and never a status mark.
//
// A TAP: a mark with an intent goes to the trick's program (`trickTapper`), and shows Collie's spinner
// in its icon's box while the tap is in flight. A mark without an intent opens the trick's own session
// when it has one, one level down. A mark with neither is the same control, which does nothing and
// says so (lib/tricks/mark.tsx, ONE CONTROL): it never drops to a span that shrinks.
//
// A REFUSED TAP (fault A) has no frame line to say it on: a mark is one control on the belt. Collie's
// line for it goes out as an Event (lib/status.ts), which floats and holds no space, so nothing on the
// belt moves. The mark itself draws the trick's parts the reply brought, as any tap does.

/**
 * What travels beside a belt tap from a pane: the agent session open on the phone, by its scope key. A
 * shell or a trick's own pane is no agent session, so a tap from it names none (fault A: the bridge refuses a session
 * its facts do not list as an agent's).
 */
export function beltTapHandlers(pane: Pick<AgentView, "host" | "paneId" | "kind"> | undefined, host: string): TapHandlers {
  // A pane with no kind comes from a bridge before kinds: it lists agent panes only.
  if (pane === undefined || (pane.kind !== undefined && pane.kind !== "agent")) return {};
  return { from: { session: `${pane.host ?? host}:${pane.paneId}` } };
}

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
  const value = part?.value;
  if (part === undefined || value?.at !== "belt") return null;
  const mark = value.mark;
  // A belt part that arrived with no `mark` (or one that is no object) draws nothing, as a part that is not held does.
  if (mark === undefined || mark === null) return null;
  const trickName = trick?.name ?? part.trick;
  const stale = part.stale === true || isPastWindow(part, now);
  const busy = tap?.phase === "busy";
  const unknown = tap?.phase === "unknown";
  if (mark.intent !== undefined) {
    const intent = mark.intent;
    const onTap = async (): Promise<void> => {
      await store.tap({ host: part.host, trick: part.trick, part: part.part, intent, control: "mark", rev: part.rev }, handlers);
      const last = store.getState().taps.get(key);
      if (last?.phase === "failed" && last.refused !== undefined) setStatus(tapRefusalLine(last.refused), last.refused === "changed" ? "info" : "warn");
    };
    return <TrickMark mark={mark} trickName={trickName} stale={stale} busy={busy} unknown={unknown} onTap={onTap} />;
  }
  if (session === undefined) return <TrickMark mark={mark} trickName={trickName} stale={stale} />;
  return <TrickMark mark={mark} trickName={trickName} stale={stale} actionLabel={t("tricks.mark.open", { trick: trickName })} onTap={() => onOpenSession(session)} />;
}

/** The belt's marks, ready for `ActionsRow` `marks`. */
export function beltMarksOf(opts: {
  parts: readonly WireTrickPart[];
  /** What travels beside a tap on a part (the session open on the phone), by the host its trick runs on. */
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
      // One boundary per mark: a mark that throws leaves the belt's other marks drawn, and draws nothing itself.
      face: (
        <TrickBoundary fallback="none" resetKey={`${key}@${part.rev}`}>
          <BeltTrickMark partKey={key} handlers={opts.handlersFor(part.host)} session={sessionOfMark(part, opts.sessions)} onOpenSession={opts.onOpenSession} store={store} />
        </TrickBoundary>
      ),
    };
  });
}
