// The update ribbon: web/src/components/update-ribbon.tsx on the Remix 3 shell.
//
// It registers a slot in the top band (`shell/strip-model.ts`, priority UPDATE, the quietest of the
// four) and draws NOTHING in place. `shell.tsx` mounts it ONCE for every route (web's RootLayout does
// the same), so no route mounts it; it subscribes to the stores it reads and the Shell to none: `UpdateRibbon` renders null and drives the slot. What the strip
// says and which of its five states it is in is `ribbonView` from web/'s `lib/update-ribbon.ts`, used
// as it stands; `stripOf` below only maps that reading to what the strip draws, so a test can pin it.
//
// How web's bundle facts map to this shell's stores (update/):
//   - `bundleStale`      -> `staleBuild !== null` (update/self-update.ts). This shell never auto-reloads
//                           and shows a blocking sheet for a stale build, so "the bundle on screen is
//                           behind" is exactly "the stale build was confirmed". The band row sits
//                           beneath the sheet; it is what stays after the sheet is not on screen.
//   - `bundleInstalling` -> `updateStage === "installing"` (update/pwa.ts).
//   - the bundle tap     -> `reloadOntoServerBuild()`, the same call as the sheet's Reload button.
//   - the crew census    -> `updateCheck.data.crew` (routes/settings/update-check.ts), which is only
//                           loaded while /settings/updates is open. Without it every failed leg counts,
//                           as in web/ before the census arrives. Derived here, not edited there.
//
// What it does not do: it starts nothing on the host (a tap goes to /settings/updates, where the
// confirm lives), and the download row's close is for this document only, never posted.
import { navigate, type Handle, type RemixNode } from "remix/component";
import { ArrowUpCircle, Loader2, RefreshCw, TriangleAlert } from "lucide";
import type { IconNode } from "lucide";

import { dismissUpdate } from "@web/lib/api";
import { t } from "@web/lib/i18n";
import { updatesPath } from "@web/lib/nav";
import type { DismissScope, UpdateInfo } from "@web/lib/types";
import {
  type Dismissal,
  dismissesLocally,
  dismissTarget,
  ribbonText,
  ribbonView,
  type RibbonView,
} from "@web/lib/update-ribbon";

import { address, snapshot } from "../lib/data";
import { useLocale } from "../lib/i18n-store";
import { useStore } from "../lib/store";
import { href } from "../routes";
import { UPDATE } from "../shell/strip-model";
import { stripsOf } from "../shell/context";
import { Icon } from "../ui/icon";
import { Notice, type NoticeTone } from "../ui/notice";
import { updateCheck } from "../routes/settings/update-check";
import { updateStage } from "../update/pwa";
import { reloadOntoServerBuild, staleBuild } from "../update/self-update";
import { bridgeWrite, writeRefusal } from "./writes";

/** What a tap on the row does: reload onto the bundle that exists, go to the Updates page, or nothing. */
export type RibbonTap = "reload" | "updates" | null;

/** What a close on the row does: post to the bridge (kept beside the digest's record) or hide for
 *  this document only. */
export type RibbonDismiss =
  | { kind: "bridge"; target: Dismissal; label: string }
  | { kind: "local"; label: string };

/** Everything the strip draws, as data. */
export interface RibbonStrip {
  kind: Exclude<RibbonView["kind"], "silent">;
  tone: NoticeTone;
  icon: IconNode;
  spin: boolean;
  text: string;
  tap: RibbonTap;
  dismiss: RibbonDismiss | null;
}

/** Icon and tone per state, as web's `skinOf`. A failed peer is the only red the band can show. */
function skinOf(kind: RibbonStrip["kind"]): Pick<RibbonStrip, "tone" | "icon" | "spin"> {
  if (kind === "peer-failed") return { tone: "danger", icon: TriangleAlert, spin: false };
  // A download is a thing in flight, so it wears the spinner. The other two are standing offers.
  if (kind === "bundle-installing") return { tone: "caution", icon: Loader2, spin: true };
  // A reload is not an offer (M20/05): it must not wear the "new version" mark.
  if (kind === "bundle") return { tone: "caution", icon: RefreshCw, spin: false };
  return { tone: "caution", icon: ArrowUpCircle, spin: false };
}

/**
 * The reading mapped to the strip, or null when the band is silent (or the download row was put
 * down for this document: the row stays gone rather than falling back to the offer it outranks).
 */
export function stripOf(view: RibbonView, update: UpdateInfo | undefined, downloadHidden = false): RibbonStrip | null {
  if (view.kind === "silent") return null;
  if (dismissesLocally(view) && downloadHidden) return null;
  const base = { kind: view.kind, ...skinOf(view.kind) };
  const text = ribbonText(view, update?.linkChange ?? null, update?.urgent ?? null);
  // The download row carries a close and no tap: nothing a tap could do while a worker is on its way in.
  if (dismissesLocally(view)) {
    return { ...base, text, tap: null, dismiss: { kind: "local", label: t("updateRibbon.hideNotice") } };
  }
  const tap: RibbonTap = view.kind === "bundle" ? "reload" : "updates";
  const target = dismissTarget(view);
  const dismiss: RibbonDismiss | null =
    target === null
      ? null
      : { kind: "bridge", target, label: t(target.scope === "crew" ? "updateRibbon.hideNotice" : "updateRibbon.dismiss") };
  return { ...base, text, tap, dismiss };
}

/** What the reading should treat as dismissed in one scope: this tab's own tap when it was in that
 *  scope, else what the bridge has recorded. */
export function dismissedIn(
  scope: DismissScope,
  local: Dismissal | null,
  stored: string | null | undefined,
): string | null {
  if (local !== null && local.scope === scope) return local.version;
  return stored ?? null;
}

export function UpdateRibbon(handle: Handle) {
  const readSnapshot = useStore(handle, snapshot);
  const readStage = useStore(handle, updateStage);
  const readStale = useStore(handle, staleBuild);
  const readCheck = useStore(handle, updateCheck);
  useLocale(handle);
  const slot = stripsOf(handle).slot(handle.signal);

  // Optimistic only: the dismissal lives on the bridge and arrives on the snapshot.
  let justDismissed: Dismissal | null = null;
  // The download row, put down for this document only. A later worker raises it again.
  let downloadHidden = false;
  // What the band draws, and the counter that tells the model it changed.
  let drawn: RibbonStrip | null = null;
  let drawnKey = "";
  let rev = 0;

  const onTap = (): void => {
    if (drawn?.tap === "reload") {
      reloadOntoServerBuild();
      return;
    }
    if (drawn?.tap === "updates") void navigate(href(updatesPath(address.get().scope)));
  };

  const onDismiss = (): void => {
    const dismiss = drawn?.dismiss;
    if (!dismiss || handle.signal.aborted) return;
    if (dismiss.kind === "local") {
      downloadHidden = true;
      void handle.update();
      return;
    }
    justDismissed = dismiss.target;
    void handle.update();
    // A device that may not write still puts the row down locally; nothing is sent for it.
    if (writeRefusal() !== undefined) return;
    // A failed call is a courtesy lost, not an error worth a line: the next tap re-sends.
    void bridgeWrite(() => dismissUpdate(dismiss.target.version, dismiss.target.scope)).catch(() => undefined);
  };

  // Made ONCE. The band calls it whenever it draws; it reads what the last `show` committed.
  const render = (): RemixNode => {
    const strip = drawn;
    if (strip === null) return null;
    return (
      <div data-testid="update-ribbon" data-state={strip.kind}>
        <Notice
          tone={strip.tone}
          variant="strip"
          announce="status"
          icon={<Icon icon={strip.icon} class={strip.spin ? "animate-spin" : undefined} />}
          onActivate={strip.tap === null ? undefined : onTap}
          onDismiss={strip.dismiss === null ? undefined : onDismiss}
          dismissLabel={strip.dismiss?.label}
        >
          {strip.text}
        </Notice>
      </div>
    );
  };

  return () => {
    const update = readSnapshot().data?.update;
    const stage = readStage();
    // The stage leaving `installing` ends the worker that was closed over.
    if (stage !== "installing") downloadHidden = false;
    const view = ribbonView({
      update,
      bundleStale: readStale() !== null,
      bundleInstalling: stage === "installing",
      dismissedVersion: dismissedIn("offer", justDismissed, update?.dismissedVersion),
      dismissedCrewVersion: dismissedIn("crew", justDismissed, update?.dismissedCrewVersion),
      crew: readCheck().data?.crew,
      now: Date.now(),
    });
    const strip = stripOf(view, update, downloadHidden);
    const key = strip === null ? "" : JSON.stringify([strip.kind, strip.text, strip.tap, strip.dismiss?.label ?? null]);
    if (key !== drawnKey) {
      drawnKey = key;
      rev++;
    }
    const nowRev = rev;
    // The band's model is written after commit, never during render.
    handle.queueTask(() => {
      drawn = strip;
      if (strip === null) slot.hide();
      else slot.show({ priority: UPDATE, render, rev: nowRev });
    });
    return null;
  };
}
