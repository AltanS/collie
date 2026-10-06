// The app shell: wraps every route's content (router.tsx installs it through `render()`), keeps the
// snapshot and config on the polling beat for the page's lifetime, and draws what every screen
// shares: the strip band, the ONE header, the screen slide, the toast, the busy bar, the first-connect
// cover and the idle lock.
//
// IT DOES NOT SUBSCRIBE TO DATA (REMIX3.md rule 4). A Shell update re-renders every route, so the
// Shell renders from the URL and the idle lock only. The header, the band and the toast each
// subscribe to their own model or store and re-render alone; the models are provided once, by
// `ShellProvider`, and never followed by an update.
//
// THE COVER SITS OVER A MOUNTED TREE (ADR 0007). The route content stays mounted under the lock, in
// an `inert` wrapper with `display: contents`, so a draft, a scroll position or an open sheet survive
// a pause. Polling is what stops (lib/polling.ts reads the lock), and releasing it refetches and
// holds the cover through that one refetch.
//
// EVERY PENDING THING IS ITS OWN LEAF: `FirstConnect` (the cover until the first snapshot answers),
// `ConnectionBanner` (drives the band's connection slot), `BusyBar` and `NavPending`. Each subscribes
// to what it draws, so none of them wakes the Shell or, through it, every route.
import { on, type Handle, type RemixNode } from "remix/component";

import { t } from "@web/lib/i18n";

import { startBusyTracking } from "./lib/busy";
import { loadConfig, loadSnapshot } from "./lib/data";
import { bindGlideFrame } from "./lib/glide";
import { idle, unlock } from "./lib/idle";
import { want } from "./lib/polling";
import { scheduleUpdate, useStore } from "./lib/store";
import { Button } from "./ui/button";
import { useLocale } from "./lib/i18n-store";
import { StatusToast, ToastViewport } from "./ui/toast-viewport";
import { TourHost } from "./tour/tour-host";
import { UpdateSheet } from "./update/update-sheet";
import { BootSplash, FirstConnect } from "./shell/boot-splash";
import { BusyBar, NavPending } from "./shell/busy-bar";
import { CollieMark } from "./shell/collie-mark";
import { ConnectionBanner } from "./shell/connection-banner";
import { headerOf, ShellProvider } from "./shell/context";
import { HeaderHost, headerShowsStatus } from "./shell/header";
import { ScreenTransition } from "./shell/screen-transition";
import { StripHost } from "./shell/strip-host";
import { UpdateRibbon } from "./chips/update-ribbon";

export const SNAPSHOT_SOURCE = { key: "snapshot", poll: loadSnapshot };
export const CONFIG_SOURCE = { key: "config", poll: loadConfig };

export interface ShellProps {
  url: URL;
  children?: RemixNode;
}

export function Shell(handle: Handle<ShellProps>) {
  want(SNAPSHOT_SOURCE, handle.signal);
  want(CONFIG_SOURCE, handle.signal);
  bindGlideFrame(handle.frames.top, handle.signal);
  startBusyTracking();
  const readIdle = useStore(handle, idle);
  useLocale(handle);
  return () => {
    const { locked, catchingUp } = readIdle();
    const covered = locked || catchingUp;
    return (
      <ShellProvider>
        <div style={{ display: "contents" }} inert={covered} data-slot="app">
          <div class="flex h-(--app-h) flex-col overflow-hidden">
            <StripHost />
            {/* The connection strip: amber, red, green and the auth refusal, one slot in the band. */}
            <ConnectionBanner />
            {/* The update offer: one slot in the band for every route, as web's RootLayout. Draws nothing in
                place; it subscribes to its own stores, never the Shell. */}
            <UpdateRibbon />
            <HeaderHost />
            <ScreenTransition pathname={handle.props.url.pathname}>{handle.props.children}</ScreenTransition>
          </div>
          <ShellToast />
        </div>
        <BusyBar />
        <NavPending />
        <FirstConnect />
        {covered && <IdleCover catchingUp={catchingUp} />}
        <UpdateSheet />
        <TourHost />
      </ShellProvider>
    );
  };
}

/** The status as a toast, on the screens whose header has no title slot for it. */
function ShellToast(handle: Handle) {
  const header = headerOf(handle);
  let inHeader = headerShowsStatus(header.current);
  handle.queueTask(() => {
    header.addEventListener(
      "change",
      () => {
        if (headerShowsStatus(header.current) !== inHeader) scheduleUpdate(handle);
      },
      { signal: handle.signal },
    );
  });
  return () => {
    inHeader = headerShowsStatus(header.current);
    return <ToastViewport>{inHeader ? null : <StatusToast />}</ToastViewport>;
  };
}

function IdleCover(handle: Handle<{ catchingUp: boolean }>) {
  return () => {
    const { catchingUp } = handle.props;
    return (
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("idle.dialogAria")}
        data-testid="idle-lock"
        class="fixed inset-0 z-50 flex items-center justify-center bg-background/40 px-6 backdrop-blur-[3px]"
      >
        <div class="flex flex-col items-center gap-6 rounded-lg border border-border/60 bg-card/70 px-8 py-10 text-center shadow-2xl ring-1 ring-white/10 backdrop-blur-2xl">
          <div class="flex flex-col items-center gap-3">
            {/* ONE mark in both states, in one 80 px box, so the panel never shifts as the resume
                fetch starts and finishes. The catch-up is the bloom: the orbit speeds up and the
                accents come to full chroma. `paper` is the glass panel's own token, the closest
                honest answer over a blurred herd. */}
            <span class="grid size-20 shrink-0 place-items-center">
              <CollieMark size={64} loading={catchingUp} paper="var(--card)" />
            </span>
            <span class="text-lg font-semibold tracking-tight">Collie</span>
          </div>
          {catchingUp ? (
            <div class="space-y-1">
              <p class="font-medium">{t("idle.catchingUp.title")}</p>
              <p class="max-w-xs text-sm text-muted-foreground">{t("idle.catchingUp.body")}</p>
            </div>
          ) : (
            <div class="space-y-1">
              <p class="font-medium">{t("idle.paused.title")}</p>
              <p class="max-w-xs text-sm text-muted-foreground">{t("idle.paused.body")}</p>
            </div>
          )}
          {!catchingUp && (
            <Button size="lg" mix={on("click", unlock)}>
              {t("idle.resume")}
            </Button>
          )}
        </div>
      </div>
    );
  };
}

// The first paint while the first route resolves, and the first-connect cover (shell/boot-splash.tsx).
export { BootSplash };

export function NotFound(handle: Handle<{ url: URL }>) {
  return () => <p class="p-4 text-sm text-muted-foreground">{handle.props.url.pathname}</p>;
}
