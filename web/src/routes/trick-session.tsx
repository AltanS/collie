import { useMemo } from "react";
import { useParams } from "react-router";

import { RouteHeader } from "@/components/app-header";
import { Icon as KeyIcon } from "@/components/icons/icon";
import { TrickSessionIcon, trickSessionLine } from "@/components/trick-session";
import { PaneBadge } from "@/components/pane-badge";
import { Button } from "@/components/ui/button";
import { BandMain } from "@/components/ui/strip-host";
import { useLocale } from "@/hooks/use-locale";
import { useTrickHandlers } from "@/hooks/use-trick-handlers";
import { useNav } from "@/hooks/use-nav";
import { t } from "@/lib/i18n";
import { trickIconOf } from "@/lib/tricks/icons";
import { TrickView } from "@/lib/tricks/part-frame";
import { findTrickSession } from "@/lib/tricks/places";
import { ACTIONS_MAX, parseTrickSessionId, type TrickAction } from "@/lib/tricks/schema";
import type { LinkTarget } from "@/lib/tricks/render";
import { tricksStore, trickTapper, useTrickPart, type TricksStore } from "@/lib/tricks/store";
import { homePath } from "@/lib/nav";
import { paneName } from "@/lib/pane-name";
import { useRootData } from "@/lib/route-data";
import type { AgentView } from "@/lib/types";
import { cn } from "@/lib/utils";

// A TRICK'S OWN SESSION (M94 slice 03): one level below the Dashboard, `/trick/<id>`.
//
// What it shows: the real Header (the back arrow, the trick's icon in its frame, the session's name, its
// badge, and the step, percent or subtitle under the name), the part's view in its frame (lib/tricks/
// part-frame.tsx), scrollable and laid out for 390px first, and up to four of the part's actions as
// buttons at the foot.
//
// What it does NOT show: a Composer. A trick session has no terminal and no reply box, so there is no
// Send, no Stop, no Dock and no belt. A tap in the view or on an action goes to the trick's provider and
// writes into no reply box anywhere; a row's `href` or a link opens a page or a Session
// (hooks/use-trick-handlers.ts).
//
// The id names the host (`trick:<host>:<trick>:<part>`), and `trick:<host>:<trick>` opens that trick's
// first session part.

/** The control name of an action at the foot, for its busy state. Outside the view tree's paths. */
function actionControl(id: string): string {
  return `actions/${id}`;
}

/** The Header's row: back, the trick's icon in its frame, the name with its badge, and line 2. */
export function TrickSessionHeaderRow({ pane, onBack }: { pane: AgentView | undefined; onBack: () => void }) {
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
    </>
  );
}

/** The part's actions at the foot, at most four, each a 44px button. A tap goes to the provider. */
function Actions({ partKey, onTap, store }: { partKey: string; onTap: (key: string, intent: string, value: TrickAction["value"], control: string) => void; store: TricksStore }) {
  const { part, tap } = useTrickPart(partKey, store);
  const value = part?.value;
  const actions = value?.at === "session" ? (value.actions ?? []).slice(0, ACTIONS_MAX) : [];
  if (actions.length === 0) return null;
  const busyControl = tap?.phase === "busy" ? tap.control : undefined;
  return (
    <div data-slot="trick-session-actions" className="grid shrink-0 grid-cols-2 gap-2 border-t border-border px-4 pt-3 pb-[calc(0.75rem_+_env(safe-area-inset-bottom))]">
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
            onClick={() => onTap(partKey, action.intent, action.value, actionControl(action.id))}
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

/** The screen below the Header: the view, scrollable, and the actions at the foot. No Composer. */
export function TrickSessionBody({
  pane,
  onLink,
  store = tricksStore,
  now,
}: {
  pane: AgentView | undefined;
  onLink: (target: LinkTarget) => void;
  store?: TricksStore;
  /** Pin the clock, for a playground card. */
  now?: number;
}) {
  useLocale();
  const onTap = useMemo(() => trickTapper({}, store), [store]);
  return (
    <>
      <BandMain base={16} className="relative flex min-h-0 flex-1 flex-col overflow-y-auto p-4">
        {pane?.view === undefined ? (
          <p className="py-16 text-center text-sm text-muted-foreground">{t("tricks.session.gone")}</p>
        ) : (
          <TrickView partKey={pane.view} onLink={onLink} store={store} now={now} />
        )}
      </BandMain>
      {pane?.view !== undefined && <Actions partKey={pane.view} onTap={onTap} store={store} />}
    </>
  );
}

export function TrickSessionRoute() {
  const { paneId = "" } = useParams<{ paneId: string }>();
  const data = useRootData();
  const nav = useNav();
  const pane = findTrickSession(paneId, data.trickSessions ?? []);
  const host = parseTrickSessionId(paneId)?.host ?? "";
  const { linkFor } = useTrickHandlers();
  const onLink = useMemo(() => linkFor(host), [linkFor, host]);
  const back = () => nav.up(homePath(data.scope));
  return (
    <div data-slot="trick-session-screen" className="mx-auto flex min-h-0 w-full max-w-screen-sm flex-1 flex-col">
      <RouteHeader width="column" override={<TrickSessionHeaderRow pane={pane} onBack={back} />} />
      <TrickSessionBody pane={pane} onLink={onLink} />
    </div>
  );
}
