import { useMemo } from "react";
import { useLocation, useParams } from "react-router";

import { RouteHeader } from "@/components/app-header";
import { Icon as KeyIcon } from "@/components/icons/icon";
import { TrickSessionIcon, trickSessionLine } from "@/components/trick-session";
import { DashboardRouteBar, footAir } from "@/components/dashboard-route-bar";
import { PaneBadge } from "@/components/pane-badge";
import { Button } from "@/components/ui/button";
import { BandMain } from "@/components/ui/strip-host";
import { useLocale } from "@/hooks/use-locale";
import { useDashboardBar } from "@/hooks/use-dashboard-bar";
import { useTrickHandlers } from "@/hooks/use-trick-handlers";
import { useNav } from "@/hooks/use-nav";
import { fillEmptyDraft } from "@/lib/drafts";
import { findPane } from "@/lib/hosts";
import { t } from "@/lib/i18n";
import type { JsonValue } from "@/lib/json";
import type { HomeData } from "@/lib/loaders";
import { setStatus } from "@/lib/status";
import { trickIconOf } from "@/lib/tricks/icons";
import { TrickView } from "@/lib/tricks/part-frame";
import { findTrickSession } from "@/lib/tricks/places";
import { ACTIONS_MAX, parseTrickSessionId, type TrickAction } from "@/lib/tricks/schema";
import type { LinkTarget } from "@/lib/tricks/render";
import { tricksStore, trickTapper, useTrickPart, type TricksStore } from "@/lib/tricks/store";
import { homePath, pathOnly, readForSession, readFrom, resolveHomeScope, trickDetailKey, trickDetailPath } from "@/lib/nav";
import { scopeFromSearchParams, type Scope } from "@/lib/scope";
import { paneName } from "@/lib/pane-name";
import { useRootData } from "@/lib/route-data";
import type { AgentView } from "@/lib/types";
import { cn } from "@/lib/utils";

// A TRICK'S OWN SESSION (M94 slice 03): one level below the Dashboard, `/trick/<id>`.
//
// What it shows: the real Header (the back arrow, the trick's icon in its frame, the session's name, its
// badge, and the step, percent or subtitle under the name), the part's view in its frame (lib/tricks/
// part-frame.tsx), scrollable and laid out for 390px first, and up to four of the part's actions as
// buttons at the foot. Under them, the Dashboard's bottom bar (amended 2026-11-10).
//
// What it does NOT show: a Composer. A trick session has no terminal and no reply box, so there is no
// Send, no Stop, no Dock and no belt. A tap in the view or on an action goes to the trick's provider and
// writes into no reply box anywhere; a row's `href` or a link opens a page or a Session
// (hooks/use-trick-handlers.ts).
//
// THE ONE EXCEPTION, A DRAFT BUTTON (`does = "draft"`, only for a trick whose manifest says `drafts =
// "session"`). Opened from an agent pane for its session (`forSession`, a belt mark, a status item, the
// switcher), a tap puts the button's text into that pane's reply box and goes back up to the pane, so the
// person sees the box filled. ONLY AN EMPTY BOX is filled (`fillEmptyDraft`): a box with words or chips is
// left exactly as it is, and one line says so. Nothing is ever sent from here: the person reads the text and
// taps Send, and the composer's own Send Protocol, receipt and Put back do the rest. Opened from the
// Dashboard or the bottom bar, the page is for no session, and such a button is drawn disabled.
//
// The id names the host (`trick:<host>:<trick>:<part>`), and `trick:<host>:<trick>` opens that trick's
// first session part.

/** The control name of an action at the foot, for its busy state. Outside the view tree's paths. */
function actionControl(id: string): string {
  return `actions/${id}`;
}

/**
 * The Header's row: back, the trick's icon in its frame, the name with its badge, line 2, and at the end the
 * trick's details button (2026-11-21): the house info glyph in a 44 px button, "Trick details", that opens the
 * trick's details page one level below (routes/settings-trick.tsx); Back there comes up to this page. It stands in
 * the row's trailing place and takes no room from the trick's view. A destructive act is never here: it would be
 * reached through the details page. Absent without `onDetails` (a trick id that does not parse).
 */
export function TrickSessionHeaderRow({ pane, onBack, onDetails }: { pane: AgentView | undefined; onBack: () => void; onDetails?: () => void }) {
  useLocale();
  const line = pane === undefined ? null : trickSessionLine(pane);
  return (
    <>
      <Button variant="ghost" size="icon" className="size-11" onClick={onBack} aria-label={t("tricks.session.back")}>
        <KeyIcon name="back" className="size-5" />
      </Button>
      {pane !== undefined && <TrickSessionIcon pane={pane} />}
      <div className="min-w-0 flex-1">
        <div className="flex h-6 min-w-0 items-center gap-1.5">
          <h1 data-slot="trick-session-title" className="min-w-0 truncate text-lg font-semibold tracking-tight">
            {pane === undefined ? t("tricks.space.title") : paneName(pane)}
          </h1>
          {pane !== undefined && <PaneBadge pane={pane} className="shrink-0" />}
        </div>
        <p data-slot="trick-session-line" className="h-4 min-w-0 truncate text-xs leading-4 text-muted-foreground">
          {line ?? ""}
        </p>
      </div>
      {onDetails !== undefined && (
        <Button variant="ghost" size="icon" data-slot="trick-session-details" className="size-11 shrink-0" onClick={onDetails} aria-label={t("tricks.session.details")}>
          <KeyIcon name="info" className="size-5" />
        </Button>
      )}
    </>
  );
}

/** The part's actions at the foot, at most four, each a 44px button. A tap goes to the provider. */
function Actions({
  partKey,
  onTap,
  barBelow,
  store,
}: {
  partKey: string;
  onTap: (key: string, intent: string, value: TrickAction["value"], control: string, drawnRev?: number) => void;
  barBelow: boolean;
  store: TricksStore;
}) {
  const { part, tap } = useTrickPart(partKey, store);
  const value = part?.value;
  const actions = value?.at === "session" ? (value.actions ?? []).slice(0, ACTIONS_MAX) : [];
  if (actions.length === 0) return null;
  const busyControl = tap?.phase === "busy" ? tap.control : undefined;
  return (
    <div data-slot="trick-session-actions" className={cn("grid shrink-0 grid-cols-2 gap-2 border-t border-border px-4 pt-3", footAir(barBelow, "pb-3"))}>
      {actions.map((action) => {
        const busy = busyControl === actionControl(action.id);
        const Icon = action.icon === undefined ? null : trickIconOf(action.icon);
        return (
          <Button
            key={action.id}
            type="button"
            variant="outline"
            data-slot="trick-session-action"
            disabled={action.disabled === true || busyControl !== undefined}
            aria-busy={busy}
            onClick={() => onTap(partKey, action.intent, action.value, actionControl(action.id), part?.rev)}
            className={cn("h-11 min-w-0 rounded-sm", actions.length === 1 && "col-span-2")}
          >
            {/* The glyph's box turns into the spinner; the label stays, so the button never changes width. */}
            {busy ? <KeyIcon name="busy" aria-hidden className="animate-spin" /> : Icon !== null && <Icon aria-hidden />}
            <span className="truncate">{action.label}</span>
          </Button>
        );
      })}
    </div>
  );
}

/**
 * The screen below the Header: the view, scrollable, and the actions at the foot. No Composer.
 * `barBelow`: the Dashboard's bar is drawn under it, and owns the safe area (amended 2026-11-10).
 */
export function TrickSessionBody({
  pane,
  onLink,
  onDraft,
  barBelow = false,
  store = tricksStore,
  now,
}: {
  pane: AgentView | undefined;
  onLink: (target: LinkTarget) => void;
  /** A draft button was tapped (see the header). Absent: the page is for no session. */
  onDraft?: (value: string) => void;
  barBelow?: boolean;
  store?: TricksStore;
  /** Pin the clock, for a playground card. */
  now?: number;
}) {
  useLocale();
  const onTap = useMemo(() => trickTapper({}, store), [store]);
  const actions = pane?.view !== undefined;
  return (
    <>
      {/* With the actions at the foot, they keep the safe area (or the bar does); the view keeps its own air. */}
      <BandMain base={16} data-slot="trick-session-scroll" className={cn("relative flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pt-4", actions ? "pb-4" : footAir(barBelow, "pb-4"))}>
        {pane?.view === undefined ? (
          <p className="py-16 text-center text-sm text-muted-foreground">{t("tricks.session.gone")}</p>
        ) : (
          <TrickView partKey={pane.view} onLink={onLink} onDraft={onDraft} store={store} now={now} />
        )}
      </BandMain>
      {pane?.view !== undefined && <Actions partKey={pane.view} onTap={onTap} barBelow={barBelow} store={store} />}
    </>
  );
}

/** The agent session a trick's page puts a draft into: the pane, its address, and the path that opens it. */
export interface DraftTarget {
  paneId: string;
  scope: Scope;
  /** The pane's path as the page was opened from it, `?h=` and `?s=` included: Back and the draft go there. */
  path: string;
}

/**
 * The session a trick's page is open for, from its history entry: only a page opened FOR a pane
 * (`forSession`) from `/pane/<id>`, and only while that pane is an agent session the snapshot lists, looked up
 * within its own machine and session (a crew member's pane works, its address carries `?h=`). Anything else,
 * the Dashboard, the bottom bar, a shell, a pane that closed, is no session: undefined.
 */
export function draftTargetOf(state: JsonValue | undefined, root: Pick<HomeData, "agents" | "servers" | "sessions">): DraftTarget | undefined {
  if (!readForSession(state)) return undefined;
  const from = readFrom(state);
  if (from === undefined) return undefined;
  const seg = pathOnly(from).split("/").filter((part) => part !== "");
  if (seg.length !== 2 || seg[0] !== "pane" || seg[1] === undefined) return undefined;
  let paneId: string;
  try {
    paneId = decodeURIComponent(seg[1]);
  } catch {
    return undefined;
  }
  const cut = from.indexOf("?");
  const scope = scopeFromSearchParams(new URLSearchParams(cut === -1 ? "" : (from.slice(cut + 1).split("#")[0] ?? "")));
  const pane = findPane(root.agents, paneId, scope, root.servers, root.sessions);
  if (pane === undefined || (pane.kind !== undefined && pane.kind !== "agent")) return undefined;
  return { paneId, scope, path: from };
}

export function TrickSessionRoute() {
  const { paneId = "" } = useParams<{ paneId: string }>();
  const data = useRootData();
  const nav = useNav();
  // Whatever the navigation attached: `draftTargetOf` reads it through the JSON narrowing helpers alone
  // (`readFrom`, `readForSession`), so any other shape reads as no session.
  const { pathname, search, state } = useLocation();
  const target = useMemo(() => draftTargetOf(state, data), [state, data]);
  // Fill the empty box and go up to the pane, or say why not and change nothing. Never a send.
  const onDraft = useMemo(() => {
    if (target === undefined) return undefined;
    return (value: string) => {
      if (!fillEmptyDraft(target.scope, target.paneId, value)) {
        setStatus(t("tricks.draft.holdsWords"), "warn");
        return;
      }
      nav.up(target.path);
    };
  }, [target, nav]);
  const pane = findTrickSession(paneId, data.trickSessions ?? []);
  const host = parseTrickSessionId(paneId)?.host ?? "";
  const { linkFor } = useTrickHandlers();
  const onLink = useMemo(() => linkFor(host), [linkFor, host]);
  const back = () => nav.up(homePath(resolveHomeScope(pathname, search, state)));
  // The details page of this trick, a level below: Back there steps back up to this page (lib/nav.ts ladder).
  const own = parseTrickSessionId(paneId);
  const details = own === undefined ? undefined : () => nav.down(trickDetailPath(trickDetailKey(own.host, own.trick)));
  // The Dashboard's bar stays under a trick's Session, with this trick's own item as the current one
  // when it has one (amended 2026-11-10, components/dashboard-route-bar.tsx).
  const bar = useDashboardBar();
  const at = useMemo(() => {
    const address = parseTrickSessionId(paneId);
    return { kind: "trick" as const, trick: address === undefined ? undefined : { host: address.host, trick: address.trick } };
  }, [paneId]);
  return (
    <div data-slot="trick-session-screen" className="mx-auto flex min-h-0 w-full max-w-screen-sm flex-1 flex-col">
      <RouteHeader width="column" override={<TrickSessionHeaderRow pane={pane} onBack={back} onDetails={details} />} />
      <TrickSessionBody pane={pane} onLink={onLink} onDraft={onDraft} barBelow={bar.shown} />
      <DashboardRouteBar bar={bar} at={at} />
    </div>
  );
}
