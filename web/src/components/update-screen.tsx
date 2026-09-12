import { useRef } from "react";
import { ChevronUp, Loader2, Package, TriangleAlert, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useDialogFocus } from "@/components/ui/sheet";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
import { updatesPath } from "@/lib/nav";
import { scopeFromUrl } from "@/lib/scope";
import { cn } from "@/lib/utils";
import { router } from "@/router";
import type { UpdateScreen as UpdateScreenState } from "@/hooks/use-update-screen";
import type { UpdateScreenDevice, UpdateScreenRow } from "@/lib/update-screen";

// ── THE UPDATE IN PROGRESS TAKES THE SCREEN ─────────────────────────────────────────────────────
//
// One sheet owns a running update: a row per machine with its state, a row for this device's own
// download, the app blocked behind it on the device that started it, a badge on every device that did
// not, an end that announces itself, and a way out of every state that can stall.
//
// ── IT IS MOUNTED IN `App.tsx`, BESIDE THE INERT WRAPPER ─────────────────────
// Never inside the router. `App.tsx` wraps `BusyBar` and `RouterProvider` in a `display: contents`
// div carrying `inert`, and this sheet is that div's SIBLING, next to `<IdleLock/>` — because a node
// cannot be both inert and the host of the dialog that made it inert. The cost is real and paid
// deliberately: no route loader data and no `CrewProvider` here, which is why the run, the census and
// this machine's own name all come through `lib/update-run-store.ts`.
//
// ── `inert` AND `useDialogFocus`, BOTH ──────────────────────────────────────
// `inert` takes the app behind out of the focus order and the a11y tree; it does not MOVE focus into
// this panel. So the panel keeps `tabIndex={-1}` and `useDialogFocus` (`ui/sheet.tsx`), exactly as
// `BottomSheet` does, and focus returns to whatever had it when the sheet closes. iOS Safari has
// supported `inert` since 15.5, below any iOS this PWA targets.
//
// ── IT DECIDES NOTHING ──────────────────────────────────────────────────────
// Every state on screen, including whether the operator may close it, is `view` from
// `lib/update-screen.ts`. This file reads `view.dismissible` and never re-derives it. It also never
// reloads the page: the controller swap is the only trigger (`lib/pwa.ts`'s header), and it never
// starts, retries or cancels an update — the Updates page owns every one of those controls, and "see
// Updates" is how the sheet hands over.

/** Where "see Updates" goes. The module-scoped router is reachable from outside the provider, which
 *  is the one thing this component needs from it. */
function goToUpdates(): void {
  void router.navigate(updatesPath(scopeFromUrl(window.location.href)));
}

export function UpdateScreen({
  screen,
  onOpenUpdates = goToUpdates,
}: {
  screen: UpdateScreenState;
  /** Overridden only by the playground, which has no app router to navigate. */
  onOpenUpdates?: () => void;
}) {
  useLocale();
  const panelRef = useRef<HTMLDivElement>(null);
  const { view, mode } = screen;
  useDialogFocus(mode === "expanded", panelRef);

  if (mode === "hidden") return null;

  if (mode === "collapsed") {
    // THE BADGE. One line and a chevron, on a device that did not ask for this. A takeover nobody
    // asked for reads as hijacked, so the other devices get a fact they can open rather than a panel
    // they have to close.
    return (
      <div className="fixed inset-x-0 bottom-0 z-50 flex justify-center px-3 pb-[calc(env(safe-area-inset-bottom)_+_0.75rem)]">
        <button
          type="button"
          onClick={() => screen.setExpanded(true)}
          className="flex w-full max-w-screen-sm items-center gap-2 rounded-md border border-rule bg-card px-3 py-2 text-left text-sm shadow-2xl"
        >
          <Loader2 aria-hidden="true" className="size-4 shrink-0 animate-spin text-status-working" />
          <span className="min-w-0 flex-1 truncate">{badgeLine(view.rows, view.device)}</span>
          <ChevronUp aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        </button>
      </div>
    );
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("updateScreen.dialogAria")}
      className="fixed inset-0 z-50 flex flex-col bg-background/80 backdrop-blur-[3px]"
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className="mx-auto flex h-full w-full max-w-screen-sm flex-col overflow-y-auto overscroll-contain bg-card px-4 pt-[calc(env(safe-area-inset-top)_+_1rem)] pb-[calc(env(safe-area-inset-bottom)_+_1rem)] shadow-2xl"
      >
        <div className="flex items-start gap-2">
          <h2 className="min-w-0 flex-1 text-base font-semibold">{t("updateScreen.title")}</h2>
          {/* A CLOSE EXISTS ONLY WHERE THE READING SAYS IT MAY. While a run this device started is in
              flight there is nothing to close to: the app behind is inert, and a close would be a
              control that hands back a screen the operator cannot use. */}
          {view.dismissible && (
            <Button
              variant="ghost"
              size="icon"
              className="size-8 shrink-0"
              aria-label={t("updateScreen.close")}
              onClick={() => screen.setExpanded(false)}
            >
              <X className="size-4" />
            </Button>
          )}
        </div>

        <ul aria-label={t("updateScreen.rows.label")} className="mt-4 space-y-3">
          {view.rows.map((row) => (
            <MachineRow key={`${row.name}-${row.lead}`} row={row} onOpenUpdates={onOpenUpdates} />
          ))}
        </ul>

        {view.device !== null && (
          <DeviceRow device={view.device} onRelease={screen.releaseDownload} />
        )}

        {/* THE LEAD HAS BEEN AT ONE THING TOO LONG. The sentence says so and the way out is to keep
            waiting with the app back in your hands — never a forced reload, and never a cancel. */}
        {view.leadStalled && (
          <div className="mt-4 rounded-md border border-rule p-3">
            <p className="text-sm">{t("updateScreen.lead.stalled")}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={screen.releaseLead}>
                {t("updateScreen.keepWaiting")}
              </Button>
              <Button variant="ghost" size="sm" onClick={onOpenUpdates}>
                {t("updateScreen.seeUpdates")}
              </Button>
            </div>
          </div>
        )}

        {view.end.kind === "failed" && (
          <div className="mt-4 flex items-start gap-2 rounded-md border border-rule p-3">
            <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-status-blocked" />
            <div className="min-w-0">
              <p className="text-sm text-status-blocked">{view.end.sentence}</p>
              <Button variant="outline" size="sm" className="mt-2" onClick={onOpenUpdates}>
                {t("updateScreen.seeUpdates")}
              </Button>
            </div>
          </div>
        )}

        {/* ONE SENTENCE OF TRUTH, small and last. The run is on the machines; this screen only shows
            it, and closing the phone does not stop it. */}
        <p className="mt-auto pt-6 text-xs text-muted-foreground">{t("updateScreen.truth")}</p>
      </div>
    </div>
  );
}

/** The collapsed badge's one line: whoever is still moving, or this device's own download. */
function badgeLine(rows: readonly UpdateScreenRow[], device: UpdateScreenDevice | null): string {
  const moving = rows.find((row) => row.moving);
  if (moving !== undefined) return t("updateScreen.badge.moving", { name: moving.name, word: moving.word });
  if (device !== null) return t("updateScreen.badge.downloading");
  return t("updateScreen.badge.generic");
}

/** One machine. Name, version, the state's own word, and — on a row that has gone quiet — when it was
 *  last heard from, with the two things the operator can actually do about it. */
function MachineRow({ row, onOpenUpdates }: { row: UpdateScreenRow; onOpenUpdates: () => void }) {
  return (
    <li className="flex items-start gap-2 text-sm">
      {row.moving ? (
        <Loader2 aria-hidden="true" className="mt-0.5 size-4 shrink-0 animate-spin text-status-working" />
      ) : row.packageManaged ? (
        <Package aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      ) : (
        <span
          aria-hidden="true"
          className={cn(
            "mt-1.5 size-1.5 shrink-0 rounded-full",
            row.quiet ? "bg-status-working" : row.settled ? "bg-status-done" : "bg-status-idle",
          )}
        />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-1.5">
          <span className="font-medium">{row.name}</span>
          {row.version !== null && (
            <span className="font-mono text-xs text-muted-foreground">{row.version}</span>
          )}
          <span className="text-xs text-muted-foreground">{row.word}</span>
        </div>
        {row.detail !== null && <p className="text-xs text-muted-foreground">{row.detail}</p>}
        {row.quiet && row.lastSeen !== null && (
          <p className="text-xs text-muted-foreground">{row.lastSeen}</p>
        )}
        {row.quiet && (
          <Button variant="ghost" size="sm" className="mt-1 -ml-2" onClick={onOpenUpdates}>
            {t("updateScreen.seeUpdates")}
          </Button>
        )}
      </div>
    </li>
  );
}

/** THIS DEVICE, VISUALLY APART. It is not a machine in the crew: it is the phone in your hand,
 *  fetching the bundle the machines now serve. Counted in FILES — see `lib/update-screen.ts`. */
function DeviceRow({ device, onRelease }: { device: UpdateScreenDevice; onRelease: () => void }) {
  const pct = device.total > 0 ? Math.min(100, Math.round((device.done / device.total) * 100)) : 0;
  return (
    <div className="mt-5 border-t border-rule pt-4">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">
        {t("updateScreen.device.title")}
      </p>
      <p className="mt-1 text-sm">
        {device.phase === "switching"
          ? t("updateScreen.device.switching")
          : device.total > 0
            ? t("updateScreen.device.downloading", {
                done: String(device.done),
                total: String(device.total),
              })
            : t("updateScreen.device.downloadingUnknown")}
        {device.elapsedMs !== null && (
          <span className="ml-1.5 tabular-nums text-xs text-muted-foreground">
            {clockOf(device.elapsedMs)}
          </span>
        )}
      </p>
      {/* A bar weighted by FILES, and labelled as one. No `<progress>`: the row already says the
          numbers, and the bar is the glance. */}
      <div
        role="progressbar"
        aria-label={t("updateScreen.device.progressAria")}
        aria-valuemin={0}
        aria-valuemax={device.total}
        aria-valuenow={device.done}
        className="mt-2 h-1 w-full overflow-hidden rounded-md bg-muted"
      >
        <div className="h-full bg-status-working" style={{ width: `${pct}%` }} />
      </div>
      {device.hung && (
        <div className="mt-2">
          <p className="text-sm">{t("updateScreen.device.hung")}</p>
          <Button variant="outline" size="sm" className="mt-2" onClick={onRelease}>
            {t("updateScreen.device.keepUsing")}
          </Button>
        </div>
      )}
    </div>
  );
}

/** `m:ss`, ticking. Monospaced digits at the call site, so the row does not jitter every second. */
function clockOf(ms: number): string {
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
