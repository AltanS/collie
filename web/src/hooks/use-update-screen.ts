import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { useLocale } from "@/hooks/use-locale";
import { useTick } from "@/hooks/use-tick";
import { t } from "@/lib/i18n";
import {
  checkForUpdate,
  getControllerChangedAt,
  getInstallingSince,
  getPrecacheProgress,
  getUpdateStage,
  subscribeControllerChanged,
  subscribePrecacheProgress,
  subscribeUpdateStage,
} from "@/lib/pwa";
import { setStatus } from "@/lib/status";
import { useUpdateRun } from "@/lib/update-run-store";
import { clearUpdateStarted, getUpdateStarted, subscribeUpdateStarted } from "@/lib/update-ribbon";
import {
  endSentence,
  updateScreenView,
  type UpdateScreenMode,
  type UpdateScreenView,
} from "@/lib/update-screen";

// ── THE SHEET'S ONE READING, PLUS THE FOUR THINGS ONLY A COMPONENT CAN HOLD ──────────────────────
//
// `lib/update-screen.ts` decides everything that can be decided from facts. This hook supplies the
// facts — the shared run store, the worker's stage, its per-file progress, the controller swap and
// "this document tapped the confirm" — and holds the four pieces of state that are genuinely about
// this document rather than about the run: the two ways out the operator has taken, whether a badge
// was expanded by hand, and whether the end has already been announced.
//
// It is a hook rather than part of the component because `App.tsx` needs the same reading: the
// wrapper holding `BusyBar` and the router goes `inert` on exactly `expanded && !dismissible`, and a
// second derivation of that would be a second opinion about the thing that blocks the app.

/**
 * How long this device's claim on the screen outlives the run that is over.
 *
 * Long enough for the page to notice the new bundle and start fetching it, short enough that a run
 * which produced no new bundle at all lets go while the operator is still looking at the toast. Not in
 * `lib/update-screen.ts` with the three thresholds, because it decides nothing the reducer decides: it
 * is the lifetime of a store this hook happens to own.
 */
const CLAIM_GRACE_MS = 20_000;

/** How long the end's own message stays up. See the call site for why it is not the channel's default. */
const END_TOAST_MS = 6_000;

export interface UpdateScreen {
  readonly view: UpdateScreenView;
  /** The mode after this document's own expand, which the reducer cannot know about. */
  readonly mode: UpdateScreenMode;
  /** True when the app behind the sheet must not take a tap or a keystroke. */
  readonly blocking: boolean;
  /** Expand a badge, or fold an expanded sheet back to one. */
  readonly setExpanded: (open: boolean) => void;
  /** "Keep using the app" — the way out of a download that has stopped saying anything. */
  readonly releaseDownload: () => void;
  /** "Keep waiting" — the way out of a lead that has held one state too long. */
  readonly releaseLead: () => void;
}

export function useUpdateScreen(): UpdateScreen {
  useLocale();
  const { run, crew, leadName } = useUpdateRun();
  const stage = useSyncExternalStore(subscribeUpdateStage, getUpdateStage, getUpdateStage);
  const progress = useSyncExternalStore(
    subscribePrecacheProgress,
    getPrecacheProgress,
    getPrecacheProgress,
  );
  const controllerChangedAt = useSyncExternalStore(
    subscribeControllerChanged,
    getControllerChangedAt,
    getControllerChangedAt,
  );
  const startedAt = useSyncExternalStore(subscribeUpdateStarted, getUpdateStarted, getUpdateStarted);

  const [downloadReleased, setDownloadReleased] = useState(false);
  const [leadReleased, setLeadReleased] = useState(false);
  const [expandedHere, setExpandedHere] = useState(false);

  const runState = run?.state;
  const live = (runState !== undefined && runState !== "idle") || stage === "installing";
  // The phone's own clock, so the elapsed numbers keep moving while the bridge is deliberately away.
  // Only while there is something to count — a second tick for the app's whole life would be a timer
  // nobody is reading.
  const now = useTick(live);

  // BACKGROUNDED AND BACK. Coming to the foreground re-reads nothing of its own: every source here is
  // a store the page kept subscribed to, so the only thing that can be stale is the clock. One extra
  // tick on the way back in is the whole of it, and the sheet stays exactly where it was.
  const [wokeAt, setWokeAt] = useState(0);
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") setWokeAt(Date.now());
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  const view = updateScreenView({
    run,
    crew,
    leadName: leadName ?? t("updateScreen.thisMachine"),
    stage,
    progress,
    installingSince: getInstallingSince(),
    startedHere: startedAt !== null,
    controllerChangedAt,
    downloadReleased,
    leadReleased,
    now: Math.max(now, wokeAt),
  });

  // A NEW RUN GETS A NEW DECISION. Both ways out are about one run's one stall, so they are spent when
  // the state they were taken against is gone — otherwise a release taken at 14:02 would hand the next
  // run straight back before the operator had seen it.
  useEffect(() => {
    if (runState === undefined || runState === "idle") {
      setDownloadReleased(false);
      setLeadReleased(false);
      setExpandedHere(false);
    }
  }, [runState]);

  // (s) IS OVER WHEN THE SHEET IS, not when the run first speaks and not the instant the run ends.
  //
  // The store is what blocks this device, so it has to outlive the first status the detached updater
  // writes — the band used to clear it there, which is the one thing it must not do now. It also has
  // to outlive the RUN itself, and that is the part a grace window buys: the machines report `done`
  // and the new bundle turns up a BEAT LATER, because discovering it takes a poll that reads the new
  // build id and a worker that starts installing. Spending the claim in that gap demoted the device
  // that asked for the update to a badge half way through its own download. Measured in
  // `e2e/update-screen.spec.ts`, which is the only place the two events are a real sequence.
  //
  // The timer re-arms on every stage change and refuses to fire while a download is in progress, so a
  // slow precache holds the claim for as long as it takes rather than for a number chosen here.
  const spoke = runState !== undefined && runState !== "idle";
  const over = spoke && view.mode === "hidden";
  useEffect(() => {
    if (!over) return;
    const timer = setTimeout(() => {
      if (getUpdateStage() === "idle") clearUpdateStarted();
    }, CLAIM_GRACE_MS);
    return () => clearTimeout(timer);
  }, [over, stage]);

  // THE RE-CHECK, ONCE. A badge can be lying about a worker that already died, and one
  // `checkForUpdate()` is what corrects it. It is fired from here rather than from the reducer because
  // it is a side effect, and guarded by a ref because a hung download stays hung for minutes.
  const rechecked = useRef(false);
  useEffect(() => {
    if (!view.recheckDownload) {
      rechecked.current = false;
      return;
    }
    if (rechecked.current) return;
    rechecked.current = true;
    void checkForUpdate();
  }, [view.recheckDownload]);

  // THE END ANNOUNCES ITSELF ONCE, through the status channel every other confirmation uses. Keyed by
  // the version, so a second run to a second version is a second toast and a re-render is not.
  const announced = useRef<string | null>(null);
  const end = view.end;
  useEffect(() => {
    if (end.kind !== "crew" && end.kind !== "solo") return;
    if (announced.current === end.version) return;
    announced.current = end.version;
    const sentence = endSentence(end);
    // A LONGER TTL THAN A SEND CONFIRMATION, and for a plain reason: this one arrives on a page that
    // has just reloaded itself onto a new bundle, so the operator may be looking at the boot rather
    // than at the pill. `lib/status.ts`'s own default is 2.5 s, which is right for a send.
    if (sentence !== null) setStatus(sentence, "success", END_TOAST_MS);
  }, [end]);

  const mode: UpdateScreenMode =
    view.mode === "collapsed" && expandedHere ? "expanded" : view.mode;

  // A WAY OUT FOLDS THE SHEET. The reducer answers `collapsed` once a release is taken, and this
  // document's own expand would otherwise hold the panel open over the decision to let go of it.
  const releaseDownload = useCallback(() => {
    setDownloadReleased(true);
    setExpandedHere(false);
  }, []);
  const releaseLead = useCallback(() => {
    setLeadReleased(true);
    setExpandedHere(false);
  }, []);
  const setExpanded = useCallback((open: boolean) => setExpandedHere(open), []);

  return {
    view,
    mode,
    // The reducer's own answer, never a second reading of it: the app goes inert exactly while the
    // sheet is expanded because a run this device started is in flight.
    blocking: view.mode === "expanded" && !view.dismissible,
    setExpanded,
    releaseDownload,
    releaseLead,
  };
}
