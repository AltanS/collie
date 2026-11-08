import { useMemo } from "react";
import { useParams } from "react-router";
import { ArrowLeft, Loader2 } from "lucide-react";

import { RouteHeader } from "@/components/app-header";
import { ModDraftPicker, ModSessionIcon, modSessionLine } from "@/components/mod-session";
import { PaneBadge } from "@/components/pane-badge";
import { Button } from "@/components/ui/button";
import { BandMain } from "@/components/ui/strip-host";
import { useLocale } from "@/hooks/use-locale";
import { useModHandlers } from "@/hooks/use-mod-handlers";
import { useNav } from "@/hooks/use-nav";
import { t } from "@/lib/i18n";
import { modIconOf } from "@/lib/mods/icons";
import { ModView } from "@/lib/mods/part-frame";
import { findModSession } from "@/lib/mods/places";
import { ACTIONS_MAX, parseModSessionId, type ModAction, type OpenTarget } from "@/lib/mods/schema";
import { modsStore, modTapper, useModPart, type DraftRequest, type ModsStore } from "@/lib/mods/store";
import { homePath } from "@/lib/nav";
import { paneName } from "@/lib/pane-name";
import { useRootData } from "@/lib/route-data";
import type { AgentView } from "@/lib/types";
import { cn } from "@/lib/utils";

// A MOD'S OWN SESSION (M94 slice 03): one level below the Dashboard, `/mod/<id>`.
//
// What it shows: the real Header (the back arrow, the mod's icon in its frame, the session's name, its
// badge, and the step, percent or subtitle under the name), the part's view in its frame (lib/mods/
// part-frame.tsx), scrollable and laid out for 390px first, and up to four of the part's actions as
// buttons at the foot.
//
// What it does NOT show: a Composer. A mod session has no terminal and no reply box, so there is no
// Send, no Stop, no Dock and no belt. A tap in the view or on an action goes to the mod's provider; its
// draft goes to a real session's box (hooks/use-mod-handlers.ts), never here.
//
// The id names the host (`mod:<host>:<mod>:<part>`), and `mod:<host>:<mod>` opens that mod's first
// session part, so a mod's `open` may name the mod alone.

/** The control name of an action at the foot, for its busy state. Outside the view tree's paths. */
function actionControl(id: string): string {
  return `actions/${id}`;
}

/** The Header's row: back, the mod's icon in its frame, the name with its badge, and line 2. */
export function ModSessionHeaderRow({ pane, onBack }: { pane: AgentView | undefined; onBack: () => void }) {
  useLocale();
  const line = pane === undefined ? null : modSessionLine(pane);
  return (
    <>
      <Button variant="ghost" size="icon" className="size-11" onClick={onBack} aria-label={t("mods.session.back")}>
        <ArrowLeft className="size-5" />
      </Button>
      {pane !== undefined && <ModSessionIcon pane={pane} />}
      <div className="min-w-0 flex-1">
        <div className="flex h-6 min-w-0 items-center gap-1.5">
          <h1 data-slot="mod-session-title" className="min-w-0 truncate text-lg font-semibold tracking-tight">
            {pane === undefined ? t("mods.space.title") : paneName(pane)}
          </h1>
          {pane !== undefined && <PaneBadge pane={pane} className="shrink-0" />}
        </div>
        <p data-slot="mod-session-line" className="h-4 min-w-0 truncate text-xs leading-4 text-muted-foreground">
          {line ?? ""}
        </p>
      </div>
    </>
  );
}

/** The part's actions at the foot, at most four, each a 44px button. A tap goes to the provider. */
function Actions({ partKey, onTap, store }: { partKey: string; onTap: (key: string, intent: string, args: ModAction["args"], control: string) => void; store: ModsStore }) {
  const { part, tap } = useModPart(partKey, store);
  const value = part?.value;
  const actions = value?.at === "session" ? (value.actions ?? []).slice(0, ACTIONS_MAX) : [];
  if (actions.length === 0) return null;
  const busyControl = tap?.phase === "busy" ? tap.control : undefined;
  return (
    <div data-slot="mod-session-actions" className="grid shrink-0 grid-cols-2 gap-2 border-t border-border px-4 pt-3 pb-[calc(0.75rem_+_env(safe-area-inset-bottom))]">
      {actions.map((action) => {
        const busy = busyControl === actionControl(action.id);
        const Icon = action.icon === undefined ? null : modIconOf(action.icon);
        return (
          <Button
            key={action.id}
            type="button"
            variant="outline"
            data-slot="mod-session-action"
            disabled={action.disabled === true || busyControl !== undefined}
            aria-busy={busy}
            onClick={() => onTap(partKey, action.intent, action.args, actionControl(action.id))}
            className={cn("h-11 min-w-0 rounded-sm", actions.length === 1 && "col-span-2")}
          >
            {/* The glyph's box turns into the spinner; the label stays, so the button never changes width. */}
            {busy ? <Loader2 aria-hidden className="animate-spin" /> : Icon !== null && <Icon aria-hidden />}
            <span className="truncate">{action.label}</span>
          </Button>
        );
      })}
    </div>
  );
}

/** The screen below the Header: the view, scrollable, and the actions at the foot. No Composer. */
export function ModSessionBody({
  pane,
  onDraft,
  onOpen,
  store = modsStore,
  now,
}: {
  pane: AgentView | undefined;
  onDraft: (draft: DraftRequest) => void;
  onOpen: (target: OpenTarget) => void;
  store?: ModsStore;
  /** Pin the clock, for a playground card. */
  now?: number;
}) {
  useLocale();
  const onTap = useMemo(() => modTapper({ onDraft, onOpen }, store), [onDraft, onOpen, store]);
  return (
    <>
      <BandMain base={16} className="relative flex min-h-0 flex-1 flex-col overflow-y-auto p-4">
        {pane?.view === undefined ? (
          <p className="py-16 text-center text-sm text-muted-foreground">{t("mods.session.gone")}</p>
        ) : (
          <ModView partKey={pane.view} onDraft={onDraft} onOpen={onOpen} store={store} now={now} />
        )}
      </BandMain>
      {pane?.view !== undefined && <Actions partKey={pane.view} onTap={onTap} store={store} />}
    </>
  );
}

export function ModSessionRoute() {
  const { paneId = "" } = useParams<{ paneId: string }>();
  const data = useRootData();
  const nav = useNav();
  const pane = findModSession(paneId, data.modSessions ?? []);
  const host = parseModSessionId(paneId)?.host ?? "";
  const mods = useModHandlers();
  const { handlersFor } = mods;
  const handlers = useMemo(() => handlersFor(host), [handlersFor, host]);
  const back = () => nav.up(homePath(data.scope));
  return (
    <div data-slot="mod-session-screen" className="mx-auto flex min-h-0 w-full max-w-screen-sm flex-1 flex-col">
      <RouteHeader width="column" override={<ModSessionHeaderRow pane={pane} onBack={back} />} />
      <ModSessionBody pane={pane} onDraft={handlers.onDraft} onOpen={handlers.onOpen} />
      <ModDraftPicker open={mods.pending !== undefined} choices={mods.choices} onChoose={mods.choose} onClose={mods.cancel} />
    </div>
  );
}
