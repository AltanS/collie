// What each delegated action does (S3; lib/acts.ts says how server HTML names them). The `gestures`
// island calls `runAct` from its one click listener and its one long-press listener.
//
// A pref act writes the pref (the prefs cookie follows at once, lib/prefs.ts `startPrefCookie`) and
// asks the snapshot frames again, so the server draws the list by the new pref within one request. A
// view the islands document does not draw (Crew, Files) loads the page again: the bridge then answers
// with the static shell's document.
import { coerceDashView } from "@web/lib/dash-view";
import { homePath } from "@web/lib/nav";
import { parseScope } from "./scope-args";

import { address, snapshot } from "../lib/data";
import { glideBack } from "../lib/glide";
import { setMachineHidden } from "../lib/hidden-machines";
import { navigate } from "../lib/navigate";
import { ORDERS, type PaneOrder } from "../lib/pane-order";
import { dashPrefs, pinHintRetired, setDashPref } from "../lib/prefs";
import { href } from "../routes";
import { paneController } from "./pane-controller";
import { openSheet } from "./sheet-store";
import { refreshSnapshotFrames } from "./snapshot-frames";

type Args = Record<string, string>;

type PlainSheet = "pane-actions" | "pane-settings" | "cache" | "switcher";
const SHEETS: readonly PlainSheet[] = ["pane-actions", "pane-settings", "cache", "switcher"];

function isPlainSheet(kind: string | undefined): kind is PlainSheet {
  return SHEETS.some((k) => k === kind);
}

function isOrder(value: string | undefined): value is PaneOrder {
  return ORDERS.some((order) => order === value);
}

function scrollToId(id: string | undefined): void {
  if (id === undefined) return;
  document.getElementById(id)?.scrollIntoView({ block: "start", behavior: "smooth" });
}

/** The dashboard prefs a switch may set from server HTML, and how each value reads. */
function setPref(pref: string | undefined, value: string | undefined): boolean {
  if (pref === "needsYouOnly") {
    setDashPref("needsYouOnly", value === "true");
    return true;
  }
  return false;
}

/** Do the action `name` with `args`. Returns false for a name this table does not know. */
export function runAct(name: string, args: Args, el: HTMLElement): boolean {
  switch (name) {
    case "dash-pref":
      if (!setPref(args.pref, args.value)) return false;
      refreshSnapshotFrames();
      return true;
    case "pane-order":
      if (!isOrder(args.order)) return false;
      // The selected segment again re-reads the order; another takes it (lib/frozen-ranks.ts). Either
      // way the next answer is drawn by the server's own reading.
      setDashPref("paneOrder", args.order);
      refreshSnapshotFrames();
      return true;
    case "isolate":
      setDashPref("isolatedSpace", args.key === undefined || args.key === "" ? null : args.key);
      refreshSnapshotFrames();
      return true;
    case "hide-space": {
      const key = args.key;
      if (key === undefined) return false;
      const hidden = dashPrefs.get().hiddenSpaces;
      setDashPref("hiddenSpaces", hidden.includes(key) ? hidden.filter((k) => k !== key) : [...hidden, key]);
      refreshSnapshotFrames();
      return true;
    }
    case "show-machine":
      if (args.host === undefined) return false;
      setMachineHidden(args.host, false, snapshot.get().data?.servers);
      refreshSnapshotFrames();
      return true;
    case "retire-pin-hint":
      pinHintRetired.set(true);
      refreshSnapshotFrames();
      return true;
    case "new-tab": {
      const workspace = args.workspace;
      if (workspace === undefined) return false;
      const at = parseScope(args.host, args.session);
      void import("../chips/space-actions").then(({ newTab }) => newTab(workspace, at).finally(refreshSnapshotFrames));
      refreshSnapshotFrames();
      return true;
    }
    case "scroll-to":
    case "reveal":
      scrollToId(args.id);
      return true;
    case "document":
      if (args.href === undefined) return false;
      window.location.assign(args.href);
      return true;
    case "sheet": {
      const kind = args.sheet;
      if (!isPlainSheet(kind)) return false;
      openSheet({ kind });
      return true;
    }
    case "pane-actions":
      if (args.pane === undefined) return false;
      openSheet({ kind: "row-actions", paneId: args.pane, host: args.host, session: args.session });
      return true;
    case "up": {
      const controller = paneController.get();
      if (controller !== null) {
        controller.acts.goUp();
        return true;
      }
      const key = el.dataset.glideKey ?? "";
      glideBack("pane", key, () => void navigate(href(homePath(address.get().scope))));
      return true;
    }
    case "dash-view": {
      const view = coerceDashView(args.value ?? "");
      setDashPref("dashView", view);
      if (view !== "dashboard") window.location.reload();
      else refreshSnapshotFrames();
      return true;
    }
    default:
      return false;
  }
}
