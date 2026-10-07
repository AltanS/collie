// The app shell: wraps every route's content (router.tsx installs it through `render()`), keeps the
// snapshot on the polling beat for the page's lifetime and the config there until its one read
// lands (lib/data.ts `loadConfig`, lib/CADENCE.md), and draws what every screen
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
import type { Handle, RemixNode } from "remix/component";


import { startBusyTracking } from "./lib/busy";
import { loadConfig, loadSnapshot } from "./lib/data";
import { bindGlideFrame } from "./lib/glide";
import { idle } from "./lib/idle";
import { want } from "./lib/polling";
import { onServer } from "./lib/server-render";
import { scheduleUpdate, useStore } from "./lib/store";
import { useLocale } from "./lib/i18n-store";
import { StatusToast, ToastViewport } from "./ui/toast-viewport";
import { TourHost } from "./tour/tour-host";
import { UpdateSheet } from "./update/update-sheet";
import { BootSplash, FirstConnect } from "./shell/boot-splash";
import { BusyBar, NavPending } from "./shell/busy-bar";
import { IdleCover } from "./shell/idle-cover";
import { ConnectionBanner } from "./shell/connection-banner";
import { TranslationNotice } from "./shell/translation-notice";
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
  // Not in a server render: the glide frame would outlive the request, and the busy tracker wraps
  // the process's own `fetch`, which on the bridge is the bridge's.
  if (!onServer()) {
    bindGlideFrame(handle.frames.top, handle.signal);
    startBusyTracking();
  }
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
            {/* "Translation is on": one lowest-priority slot, shown while the browser's translator holds the page. */}
            <TranslationNotice />
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

// The first paint while the first route resolves, and the first-connect cover (shell/boot-splash.tsx).
export { BootSplash };

export function NotFound(handle: Handle<{ url: URL }>) {
  return () => <p class="p-4 text-sm text-muted-foreground">{handle.props.url.pathname}</p>;
}
