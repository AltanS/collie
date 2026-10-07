// THE LIVE ISLAND (S3): what keeps an islands page current, one per page, first in the app column.
//
//   - The beat: the snapshot through the page's snapshot frames (islands/snapshot-frames.ts), which
//     also reloads `home-list` or `pane-head` when their HTML moved, and the config until its one read
//     lands. The pane's own read is the screen island's.
//   - The band above the header: the strips, the connection strip, "Translation is on", the update
//     offer (the static shell's Shell draws the same four, shell.tsx). `html.band-open` tells the server
//     header that the band holds the notch inset (`[html.band-open_&]` in ssr/islands-layout.tsx).
//   - The fixed layers: the busy bar, the navigation bar, the status toast, the update sheet and the
//     idle cover. While the cover is up the page under it is `inert` (`[data-slot=app-body]`, which
//     every document keeps through a soft navigation with `data-rmx-preserve-attrs="inert"`).
//   - The header's Collie mark: drawn by the server, driven from here (shell/collie-mark.tsx
//     `driveHeaderMark`), its button's name following the connection.
//   - The cache chips' countdown (islands/cache-ticker.ts).
//
// It renders the same tree on the server (the band closed, nothing busy), so the first paint holds its
// place and its hydration moves nothing.
import { clientEntry, type Handle } from "remix/component";

import { t } from "@web/lib/i18n";

import { UpdateRibbon } from "../chips/update-ribbon";
import { startBusyTracking } from "../lib/busy";
import { loadConfig } from "../lib/data";
import { idle } from "../lib/idle";
import { useLocale } from "../lib/i18n-store";
import { want } from "../lib/polling";
import { dashPrefs } from "../lib/prefs";
import { onServer } from "../lib/server-render";
import { useStore } from "../lib/store";
import { staleBuild } from "../update/self-update";
import { BusyBar, NavPending } from "../shell/busy-bar";
import { driveHeaderMark, type MarkReading } from "../shell/collie-mark";
import { ConnectionBanner } from "../shell/connection-banner";
import { ShellProvider } from "../shell/context";
import { StripHost } from "../shell/strip-host";
import { TranslationNotice } from "../shell/translation-notice";
import { StatusToast, ToastViewport } from "../ui/toast-viewport";
import { startCacheTicker, tickCacheChips } from "./cache-ticker";
import { ISLAND } from "./ids";
import { bindSnapshotFrames, pollSnapshotFrames } from "./snapshot-frames";
import { encodeRanks, HOME_LIST_FRAME, PANE_HEAD_FRAME, type SnapshotFrameName } from "./snapshot-wire";
import { shellModels } from "./shell-models";

export interface LiveProps {
  page: "home" | "pane";
}

type UpdateSheetModule = typeof import("../update/update-sheet");
let updateSheet: UpdateSheetModule | null = null;
let updateSheetLoading: Promise<UpdateSheetModule> | null = null;

/** The update sheet's module, loaded the first time this tab's build goes stale (update/self-update.ts). */
function loadUpdateSheet(): Promise<UpdateSheetModule> {
  updateSheetLoading ??= import("../update/update-sheet").then((mod) => (updateSheet = mod));
  return updateSheetLoading;
}

type IdleCoverModule = typeof import("../shell/idle-cover");
let idleCover: IdleCoverModule | null = null;
let idleCoverLoading: Promise<IdleCoverModule> | null = null;

/** The idle cover's module, loaded the first time the lock closes (it carries a painted mark). */
function loadIdleCover(): Promise<IdleCoverModule> {
  idleCoverLoading ??= import("../shell/idle-cover").then((mod) => (idleCover = mod));
  return idleCoverLoading;
}

const SNAPSHOT_SOURCE = { key: "snapshot", poll: pollSnapshotFrames };
const CONFIG_SOURCE = { key: "config", poll: loadConfig };

/** The row order the dashboard shows, for `X-Collie-Ranks` (islands/snapshot-wire.ts). */
function shownRanks(): string | null {
  const order = dashPrefs.get().paneOrder;
  if (order === "place") return null;
  const keys: string[] = [];
  // A row's `data-rmx-key` is its row key, URI-encoded (routes/home/agent-row.tsx).
  for (const row of document.querySelectorAll<HTMLElement>("[data-testid=home] a[data-testid=pane-row][data-rmx-key]")) {
    try {
      keys.push(decodeURIComponent(row.dataset.rmxKey ?? ""));
    } catch {
      // a key the server wrote is always encoded; skip one that is not
    }
  }
  return encodeRanks(order, keys);
}

/** The header mark's button name for a reading (shell/collie-mark.tsx `CollieHome`). */
function markLabel(reading: MarkReading, fallback: string): string {
  if (!reading.trouble) return fallback;
  return reading.lost ? t("nav.home.aria.lost") : t("nav.home.aria.reconnecting");
}

export const Live = clientEntry(ISLAND.live, function Live(handle: Handle<LiveProps>) {
  useLocale(handle);
  const readIdle = useStore(handle, idle);
  const readStale = useStore(handle, staleBuild);

  if (!onServer()) {
    want(SNAPSHOT_SOURCE, handle.signal);
    want(CONFIG_SOURCE, handle.signal);
    startBusyTracking();
    bindSnapshotFrames(
      {
        frame: (name) => handle.frames.get(name),
        names: (): readonly SnapshotFrameName[] => (handle.props.page === "home" ? [HOME_LIST_FRAME] : [PANE_HEAD_FRAME]),
        src: () => `${window.location.pathname}${window.location.search}`,
        ranks: () => (handle.props.page === "home" ? shownRanks() : null),
      },
      handle.signal,
    );
    startCacheTicker(handle.signal);
    const root = document.documentElement;
    shellModels.strips.addEventListener("change", () => root.classList.toggle("band-open", shellModels.strips.open), { signal: handle.signal });
    idle.subscribe(() => {
      const { locked, catchingUp } = idle.get();
      document.querySelector("[data-slot=app-body]")?.toggleAttribute("inert", locked || catchingUp);
    }, handle.signal);
    handle.queueTask(() => {
      tickCacheChips();
      const host = document.querySelector<HTMLElement>("[data-slot=collie-mark]");
      const button = host?.closest<HTMLElement>("[data-testid=header-home]");
      if (host == null) return;
      const fallback = button?.getAttribute("aria-label") ?? t("nav.home.aria.default");
      driveHeaderMark(host, handle.signal, (reading) => button?.setAttribute("aria-label", markLabel(reading, fallback)));
    });
  }

  return () => {
    const { locked, catchingUp } = readIdle();
    const covered = locked || catchingUp;
    if (covered && idleCover === null) void loadIdleCover().then(() => handle.update());
    if (readStale() !== null && updateSheet === null) void loadUpdateSheet().then(() => handle.update());
    const UpdateSheet = updateSheet?.UpdateSheet;
    const IdleCover = idleCover?.IdleCover;
    return (
      <ShellProvider models={onServer() ? undefined : shellModels}>
        <StripHost />
        <ConnectionBanner />
        <TranslationNotice />
        <UpdateRibbon />
        <ToastViewport>
          <StatusToast />
        </ToastViewport>
        <BusyBar />
        <NavPending />
        {covered && IdleCover !== undefined ? <IdleCover catchingUp={catchingUp} /> : null}
        {UpdateSheet === undefined ? null : <UpdateSheet />}
      </ShellProvider>
    );
  };
});
