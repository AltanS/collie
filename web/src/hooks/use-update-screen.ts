import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { useLocale } from "@/hooks/use-locale";
import { useTick } from "@/hooks/use-tick";
import { BUILD, isStaleBuild } from "@/lib/build";
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
import { UPDATE_MODE_HOLD, useHoldReload } from "@/lib/reload-guard";
import { getServerBuild, subscribeServerBuild } from "@/lib/server-build";
import { closeUpdateAsk, getUpdateAsk, openUpdateMode, subscribeUpdateAsk, type UpdateAsk } from "@/lib/update-ask";
import { useUpdateRun } from "@/lib/update-run-store";
import {
  clearUpdateStarted,
  getUpdateClaim,
  noteClaimPhase,
  noteMemberSkipped,
  subscribeUpdateStarted,
} from "@/lib/update-ribbon";
import { updateScreenView, type UpdateScreenMode, type UpdateScreenView } from "@/lib/update-screen";

// ── UPDATE MODE'S ONE READING, PLUS WHAT ONLY THIS DOCUMENT CAN HOLD ────────────────────────────
//
// `lib/update-screen.ts` decides everything that can be decided from facts. This hook supplies the
// facts (the shared run store, the worker's stage and progress, the controller swap, the bundle this
// document runs, the ask and this device's claim) and holds the few things that are about this
// document rather than about the run: "Use the app anyway", a strip opened by hand, "Keep trying"
// per member, and which failed end the operator has closed.
//
// It is a hook rather than part of the component because `App.tsx` needs the same reading: the
// wrapper holding `BusyBar` and the router goes `inert` whenever the panel is up, and a second
// derivation of that would be a second opinion about the thing that locks the app (ADR 0044).
//
// THREE SIDE EFFECTS LIVE HERE, each guarded so it happens once:
//   * the reload hold while machines move (`view.holdsReload`), which is what keeps this phone's own
//     reload for step 6 (ADR 0064, and `lib/pwa.ts`);
//   * the ask for the new app when step 6 starts (`view.kickPhone`);
//   * one re-check when the download looks hung (`view.recheckDownload`).

/**
 * How long a claim with nothing to show may stand before it is spent.
 *
 * A claim outlives a reload on purpose. It must not outlive the run: a start the bridge accepted and
 * then never reported, or a crew-only start whose legs never came, leaves a claim that reopens
 * nothing. Twenty seconds is two poll gaps and the begun beat (`CREW_BEGUN_MS`) with room to spare.
 */
const CLAIM_GRACE_MS = 20_000;

/** Where a closed failure is remembered: per device, so a reload does not show it again. */
const CLOSED_KEY = "collie:update-mode:closed:v1";

function readClosed(): string | null {
  try {
    return localStorage.getItem(CLOSED_KEY);
  } catch {
    return null;
  }
}

function writeClosed(key: string): void {
  try {
    localStorage.setItem(CLOSED_KEY, key);
  } catch {
    /* no storage: the close holds for this document */
  }
}

export interface UpdateScreen {
  readonly view: UpdateScreenView;
  /** The mode after this document's own choices, which the reducer cannot know about. */
  readonly mode: UpdateScreenMode;
  /** True whenever the panel is up: the app behind it takes no tap and no keystroke. */
  readonly blocking: boolean;
  /** What "Ready to start" is about, or null. */
  readonly ask: UpdateAsk | null;
  /** Open the strip into the panel, or fold a read-only panel back to the strip. */
  readonly setExpanded: (open: boolean) => void;
  /** "Use the app anyway": the way out of a stall. Cancels nothing. */
  readonly release: () => void;
  /** "Skip <name>": stop waiting for that member. */
  readonly skip: (name: string) => void;
  /** "Keep trying": put the question about that member away for a while. */
  readonly keepTrying: (name: string) => void;
  /** "Back to the app" on an end, or on a read-only panel. */
  readonly back: () => void;
  /** "Not now" on "Ready to start". */
  readonly notNow: () => void;
  /** "Try <name> again" after Done: a run for the members the last one left behind. */
  readonly retryMembers: () => void;
  /** "Try again" after a rolled-back or stopped run: back to "Ready to start" for the same version. */
  readonly tryAgain: () => void;
}

export function useUpdateScreen(): UpdateScreen {
  useLocale();
  const { run, crew, leadName, crewRun, answered } = useUpdateRun();
  const stage = useSyncExternalStore(subscribeUpdateStage, getUpdateStage, getUpdateStage);
  const progress = useSyncExternalStore(subscribePrecacheProgress, getPrecacheProgress, getPrecacheProgress);
  const controllerChangedAt = useSyncExternalStore(subscribeControllerChanged, getControllerChangedAt, getControllerChangedAt);
  const claim = useSyncExternalStore(subscribeUpdateStarted, getUpdateClaim, getUpdateClaim);
  const ask = useSyncExternalStore(subscribeUpdateAsk, getUpdateAsk, getUpdateAsk);
  const serverBuild = useSyncExternalStore(subscribeServerBuild, getServerBuild, getServerBuild);

  const [released, setReleased] = useState(false);
  const [expandedHere, setExpandedHere] = useState(false);
  const [keptTrying, setKeptTrying] = useState<ReadonlyMap<string, number>>(() => new Map());
  const [closedEnd, setClosedEnd] = useState<string | null>(readClosed);

  const runState = run?.state;
  const crewLive = crewRun !== null && crewRun.settledAt === null;
  const live = (runState !== undefined && runState !== "idle") || stage === "installing" || crewLive || claim !== null;
  // The phone's own clock, so the band's clock keeps moving while the bridge is deliberately away.
  const now = useTick(live);

  // BACKGROUNDED AND BACK: every source is a store the page kept subscribed to, so the only thing that
  // can be stale is the clock. One extra tick on the way back in.
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
    startedHere: claim !== null,
    controllerChangedAt,
    released,
    crewRun,
    now: Math.max(now, wokeAt),
    ask,
    claim,
    bundle: { id: BUILD.id, version: BUILD.version },
    serverStale: isStaleBuild(BUILD.id, serverBuild),
    keptTrying,
    answered,
  });

  // A NEW RUN GETS NEW DECISIONS. "Use the app anyway", an opened strip and "Keep trying" are all
  // about one run; each edge of `inFlight` spends them.
  const inFlight = view.inFlight;
  useEffect(() => {
    setReleased(false);
    setExpandedHere(false);
    setKeptTrying(new Map());
  }, [inFlight]);

  // THIS PHONE'S RELOAD WAITS FOR STEP 6 (ADR 0064). Held on every device while machines still move,
  // so no page reloads onto a bundle mid-run; released on step 6, when the reload is the point.
  useHoldReload(UPDATE_MODE_HOLD, view.holdsReload);

  // STEP 6 ASKS FOR THE NEW APP, ONCE PER RUN. The self-updater would get there too, but only if its
  // once-per-build guard is unspent; the step must not depend on that.
  const kicked = useRef<number | null>(null);
  const runKey = view.startedAt;
  useEffect(() => {
    if (!view.kickPhone || kicked.current === runKey) return;
    kicked.current = runKey;
    void checkForUpdate();
  }, [view.kickPhone, runKey]);

  // THE RE-CHECK, ONCE, when the download looks hung: a row can be lying about a worker that died.
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

  // THE STEP ON SCREEN RIDES WITH THE CLAIM, so the next document opens on it (ADR 0064).
  const shownPhase = view.mine && view.inFlight !== null ? view.phase : null;
  useEffect(() => {
    if (shownPhase !== null) noteClaimPhase(shownPhase);
  }, [shownPhase]);

  // A CLAIM WITH NOTHING TO SHOW IS SPENT after a grace. See {@link CLAIM_GRACE_MS}. Only once a
  // source has answered: a document booted in the restart gap has heard nothing, which is not "no run".
  const orphan = claim !== null && answered && view.phase === "none";
  useEffect(() => {
    if (!orphan) return;
    const timer = setTimeout(() => {
      if (getUpdateClaim() !== null) clearUpdateStarted();
    }, CLAIM_GRACE_MS);
    return () => clearTimeout(timer);
  }, [orphan]);

  const failedKey = view.end.kind === "failed" ? view.end.key : null;
  const closedHere = failedKey !== null && failedKey === closedEnd;
  const mode: UpdateScreenMode = closedHere
    ? "hidden"
    : view.mode === "collapsed" && expandedHere
      ? "expanded"
      : view.mode;

  const release = useCallback(() => {
    setReleased(true);
    setExpandedHere(false);
  }, []);
  const skip = useCallback((name: string) => noteMemberSkipped(name), []);
  const keepTrying = useCallback((name: string) => {
    setKeptTrying((before) => new Map(before).set(name, Date.now()));
  }, []);
  const phase = view.phase;
  const back = useCallback(() => {
    if (failedKey !== null) {
      writeClosed(failedKey);
      setClosedEnd(failedKey);
    }
    if (phase === "done" || failedKey !== null) {
      clearUpdateStarted();
      return;
    }
    setExpandedHere(false);
  }, [failedKey, phase]);
  const notNow = useCallback(() => closeUpdateAsk(), []);
  const setExpanded = useCallback((open: boolean) => setExpandedHere(open), []);

  const target = view.target;
  const from = view.from;
  const retryNames = view.retryNames;
  const retryMembers = useCallback(() => {
    if (target === null) return;
    clearUpdateStarted();
    openUpdateMode({ kind: "retry", version: target, major: false, peersOnly: true, current: target, names: retryNames });
  }, [target, retryNames]);
  const hasMembers = crew.some((member) => member.name !== leadName);
  const tryAgain = useCallback(() => {
    if (failedKey !== null) {
      writeClosed(failedKey);
      setClosedEnd(failedKey);
    }
    clearUpdateStarted();
    if (target === null) return;
    openUpdateMode({ kind: hasMembers ? "crew" : "single", version: target, major: false, peersOnly: false, current: from ?? "" });
  }, [failedKey, target, from, hasMembers]);

  return {
    view,
    mode,
    blocking: mode === "expanded",
    ask,
    setExpanded,
    release,
    skip,
    keepTrying,
    back,
    notNow,
    retryMembers,
    tryAgain,
  };
}
