import { t } from "./i18n";
import { timeAgoShort } from "./format";
import { DONE_WINDOW_MS, RUN_IN_FLIGHT } from "./update-ribbon";
import type { UpdateCrewMember, UpdatePeerLeg, UpdatePeerLegState, UpdateRun } from "./types";

// ── THE UPDATE SCREEN, AS ONE PURE READING ──────────────────────────────────────────────────────
//
// A running update owns the phone: one sheet, a row per machine, a row for this device's own
// download, the app behind it inert on the device that started it, a badge on every other device,
// and a way out of every state that can stall. WHICH of those the operator sees is decided here and
// nowhere else, so the precedence is pinned by a table rather than by pulling a DOM apart.
//
// ── DISMISSIBILITY IS DECIDED HERE, AND BY ONE SENTENCE ──────────────────────
// `dismissible` is false while a run THIS DEVICE STARTED is IN FLIGHT, and true otherwise. That is
// the whole rule. It is written as one expression below rather than as a branch inside each mode,
// because three truths — the run, the worker and the device that tapped — used to be reconciled on
// three surfaces, and a sheet that reconciled them differently from the thing that blocks the app is
// a sheet that sticks open. A settled run is therefore NEVER undismissible: `done`, `rolled-back`,
// `stuck` and `interrupted` are all closable, including the one combination that looks like an
// exception (`done` plus a worker still installing — see below).
//
// ── THE RUN AND THE WORKER ARE TWO INDEPENDENT TRUTHS ────────────────────────
// `done` while the service worker is still `installing` is a legitimate combination and not a
// conflict: the machines finished, and this phone is still downloading the bundle they now serve. So
// the sheet renders both rows and waits for the controller swap, which is the only thing allowed to
// reload the page (`lib/pwa.ts`'s header). The swap is what ends the device's own leg here, which is
// why `controllerChangedAt` is an input.
//
// ── THE BARE BUNDLE DOWNLOAD IS STILL THE BAND'S ─────────────────────────────
// With no run to be about, a worker installing is the PWA row and nothing more — the band's
// `bundle-installing`, decided on 2026-09-12. This sheet only shows the device's download as part of
// a run, so the two surfaces never say the same thing at once.
//
// ── EVERY THRESHOLD IS A CONSTANT IN THIS FILE, WITH ITS REASON AT THE LINE ──
// Three of them, and each one's escape is "keep the app you have", never a forced reload.

/**
 * How long a peer may say nothing before the sheet says something about it.
 *
 * One sweep plus slack. Past this a quiet peer is worth a sentence rather than a spinner: the row
 * dates itself from the leg's own `updatedAt` and offers "keep waiting" beside "see Updates", so the
 * operator is choosing rather than guessing.
 */
export const PEER_UNREACHABLE_MS = 30_000;

/**
 * How long the device's own download may make no progress before the sheet stops blocking for it.
 *
 * Longer than any precache of this bundle on a slow phone, which is the measurement that matters:
 * the 2026-09-12 incident's install was 125 seconds of an 869 kB chunk and was perfectly healthy.
 * Past this the row says "still downloading, keep using the app", the sheet collapses to the badge
 * and becomes dismissible, and ONE `checkForUpdate()` re-check is fired so a badge lying about a
 * worker that already died corrects itself. The install continues; the controller swap still lands.
 */
export const DOWNLOAD_HUNG_MS = 120_000;

/**
 * How long the lead may hold one run state before the sheet stops promising it is nearly over.
 *
 * Longer than a normal build plus restart plus verify. Past this the sheet says "still working, keep
 * waiting", offers "see Updates", and becomes dismissible — the operator is not trapped behind a
 * machine that may be wedged, and nothing about the run is cancelled by letting go of the screen.
 */
export const LEAD_STALLED_MS = 180_000;

/** How much of the screen the sheet takes. `hidden` renders nothing at all. */
export type UpdateScreenMode = "hidden" | "collapsed" | "expanded";

/** The leg states that are over. `package-managed` is terminal for the same reason `done` is: a
 *  package manager owns that machine (ADR 0035), so the run is not waiting on it and never will be. */
const LEG_TERMINAL: ReadonlySet<UpdatePeerLegState> = new Set<UpdatePeerLegState>([
  "done",
  "package-managed",
  "rolled-back",
  "stuck",
  "interrupted",
]);

/** One machine's row. The lead is first, then every peer, in the order the lead reported them. */
export interface UpdateScreenRow {
  /** The machine's name. The lead's is whatever the caller named it. */
  readonly name: string;
  readonly lead: boolean;
  /** The version it runs now, when anything knows it. */
  readonly version: string | null;
  /** The state's own word, already translated. */
  readonly word: string;
  /** The sentence under the row, or null. A failure's reason, or the package-manager boundary. */
  readonly detail: string | null;
  /** True while this row is moving — the row draws a spinner rather than a dot. */
  readonly moving: boolean;
  /** True once this row has gone terminal, whether it arrived or fell back. */
  readonly settled: boolean;
  /** True on a row that has said nothing for {@link PEER_UNREACHABLE_MS}. */
  readonly quiet: boolean;
  /** A package manager owns this machine (ADR 0035). A state, never a failure. */
  readonly packageManaged: boolean;
  /** "last seen 4 min ago", on a quiet row that carries a stamp. Null everywhere else. */
  readonly lastSeen: string | null;
}

/** This device's own download, or null when it is not downloading as part of this run. */
export interface UpdateScreenDevice {
  /** `downloading` counts files; `switching` is the worker waiting or activating. */
  readonly phase: "downloading" | "switching";
  readonly done: number;
  readonly total: number;
  /** How long the download has been going, or null before anything stamped it. */
  readonly elapsedMs: number | null;
  /** Nothing new for {@link DOWNLOAD_HUNG_MS}. The row says so and the sheet lets go. */
  readonly hung: boolean;
}

/** How the run ended, and what the sheet says about it on the way out. */
export type UpdateScreenEnd =
  | { readonly kind: "none" }
  /** Every machine arrived. The toast names the crew and the version. */
  | { readonly kind: "crew"; readonly version: string }
  /** A solo install: the toast names the MACHINE, never a crew that does not exist. */
  | { readonly kind: "solo"; readonly machine: string; readonly version: string }
  /** The run is over and it did not arrive. The sheet stays up, with the reason and a way out. */
  | { readonly kind: "failed"; readonly sentence: string };

export interface UpdateScreenView {
  readonly mode: UpdateScreenMode;
  /** THE one decision, taken here and never re-derived. See this file's header. */
  readonly dismissible: boolean;
  readonly rows: readonly UpdateScreenRow[];
  readonly device: UpdateScreenDevice | null;
  readonly end: UpdateScreenEnd;
  /** The lead has held one state past {@link LEAD_STALLED_MS}. */
  readonly leadStalled: boolean;
  /** A re-check is owed, exactly once, because the download looks hung. */
  readonly recheckDownload: boolean;
}

export interface UpdateScreenInput {
  /** The freshest run record the store holds (the standby door, the snapshot, the card's check). */
  readonly run: UpdateRun | undefined;
  /** The crew census, for the names and versions a run record does not carry. */
  readonly crew: readonly UpdateCrewMember[];
  /** What this machine is called on its own row. */
  readonly leadName: string;
  /** The service worker's stage (`lib/pwa.ts`). */
  readonly stage: "idle" | "installing";
  /** Files precached so far, off the worker's own per-file message, or null before the first one. */
  readonly progress: { readonly done: number; readonly total: number; readonly at: number } | null;
  /** When the stage became `installing`, so a download with no progress yet still has an age. */
  readonly installingSince: number | null;
  /** Did THIS document tap the confirm? The only thing that blocks the app behind the sheet. */
  readonly startedHere: boolean;
  /** When the controller swapped, or null. The device's own leg is done from that moment. */
  readonly controllerChangedAt: number | null;
  /** The operator took the hung-download way out. */
  readonly downloadReleased: boolean;
  /** The operator took the stalled-lead way out. */
  readonly leadReleased: boolean;
  readonly now: number;
}

/** The lead's own word for the state it is in. Every state has one — a state with no word reads as
 *  a hang. */
function leadWord(run: UpdateRun): string {
  switch (run.state) {
    case "preflight":
      return t("updateScreen.state.preflight");
    case "staging":
      return t("updateScreen.state.staging");
    case "restarting":
      return t("updateScreen.state.restarting");
    case "verifying":
      return t("updateScreen.state.verifying");
    case "done":
      return t("updateScreen.state.done");
    case "rolled-back":
      return t("updateScreen.state.rolledBack", { version: run.from ?? t("updateScreen.versionUnknown") });
    case "stuck":
      return t("updateScreen.state.stuck");
    case "interrupted":
      return t("updateScreen.state.interrupted");
    case "idle":
      return t("updateScreen.state.idle");
  }
}

/** A peer leg's own word. The lead cannot tell a peer's four run states apart, so `updating` is its
 *  word for all four (M16/04) and the sheet prints it as the peer reported it. */
function legWord(state: UpdatePeerLegState, version: string | null): string {
  switch (state) {
    case "waiting":
      return t("updateScreen.state.waiting");
    case "updating":
      return t("updateScreen.state.updating");
    case "unreachable":
      return t("updateScreen.state.unreachable");
    case "preflight":
      return t("updateScreen.state.preflight");
    case "staging":
      return t("updateScreen.state.staging");
    case "restarting":
      return t("updateScreen.state.restarting");
    case "verifying":
      return t("updateScreen.state.verifying");
    case "done":
      return t("updateScreen.state.done");
    case "rolled-back":
      return t("updateScreen.state.rolledBack", { version: version ?? t("updateScreen.versionUnknown") });
    case "package-managed":
      return t("updateScreen.state.packageManaged");
    case "stuck":
      return t("updateScreen.state.stuck");
    case "interrupted":
      return t("updateScreen.state.interrupted");
    case "idle":
      return t("updateScreen.state.idle");
  }
}

/** The sentence under a peer row, or null. A failure carries its own reason; a package-managed row
 *  carries the boundary instead, because nothing is wrong with it (ADR 0035). */
function legDetail(leg: UpdatePeerLeg): string | null {
  if (leg.state === "package-managed") return t("updateScreen.peer.packageManagedNote");
  if (!LEG_TERMINAL.has(leg.state) && leg.state !== "unreachable") return null;
  if (leg.state === "done") return null;
  return leg.reason ?? null;
}

/** The peer legs this run reported, preferring the leg over the census row: while a run is moving
 *  the leg is the fresher fact, and the census is what is left when there is no leg. */
function peerRowsOf(input: UpdateScreenInput, legs: readonly UpdatePeerLeg[]): UpdateScreenRow[] {
  const byName = new Map(input.crew.map((member) => [member.name, member]));
  const rows: UpdateScreenRow[] = legs.map((leg) => {
    const version = leg.version ?? byName.get(leg.name)?.version ?? null;
    const settled = LEG_TERMINAL.has(leg.state);
    const stamp = leg.updatedAt ?? byName.get(leg.name)?.asOf ?? null;
    const age = stamp === null ? null : Math.max(0, input.now - stamp);
    const quiet = !settled && age !== null && age >= PEER_UNREACHABLE_MS;
    return {
      name: leg.name,
      lead: false,
      version,
      word: legWord(leg.state, version),
      detail: legDetail(leg),
      moving: !settled && leg.state !== "unreachable",
      settled,
      packageManaged: leg.state === "package-managed",
      quiet: quiet || leg.state === "unreachable",
      lastSeen: stamp === null ? null : t("updateScreen.peer.lastSeen", { ago: timeAgoShort(stamp, input.now) }),
    };
  });
  // A census row for a machine no leg named: the run is not about it yet, and leaving it off the
  // sheet would be the sheet claiming a crew smaller than the one on screen everywhere else.
  for (const member of input.crew) {
    if (legs.some((leg) => leg.name === member.name)) continue;
    if (member.name === input.leadName) continue;
    rows.push({
      name: member.name,
      lead: false,
      version: member.version,
      word: t("updateScreen.state.waiting"),
      detail: null,
      moving: false,
      settled: false,
      quiet: false,
      packageManaged: false,
      lastSeen:
        member.asOf === null ? null : t("updateScreen.peer.lastSeen", { ago: timeAgoShort(member.asOf, input.now) }),
    });
  }
  return rows;
}

/** The sentence a run that did not arrive leaves on screen. */
function failedSentence(run: UpdateRun): string {
  const reason = run.reason ?? t("updateScreen.reasonUnknown");
  if (run.state === "rolled-back") {
    return t("updateScreen.failed.rolledBack", {
      version: run.from ?? t("updateScreen.versionUnknown"),
      reason,
    });
  }
  if (run.state === "stuck") return t("updateScreen.failed.stuck", { reason });
  return t("updateScreen.failed.interrupted", { reason });
}

/** The run states that are over and did NOT arrive. The sheet stays up for each of them. */
const RUN_FAILED = new Set<UpdateRun["state"]>(["rolled-back", "stuck", "interrupted"]);

/**
 * THE WHOLE SCREEN, DECIDED ONCE.
 *
 * Pure: no React, no `Date.now()`, no store read. Every fact it needs is an input, which is what
 * makes the 72-row cross-product in `update-screen.test.ts` possible at all.
 */
export function updateScreenView(input: UpdateScreenInput): UpdateScreenView {
  const run = input.run;
  const state = run?.state ?? "idle";
  const runActive = run !== undefined && RUN_IN_FLIGHT.has(state);
  const runFailed = run !== undefined && RUN_FAILED.has(state);
  const runDone = run !== undefined && state === "done";

  // The controller swap ENDS this device's own leg: the page is running the bundle the worker just
  // installed. Until then an `installing` stage is a leg still open.
  const deviceBusy = input.stage === "installing" && input.controllerChangedAt === null;

  const legs = run?.peers ?? [];
  const rows: UpdateScreenRow[] = [];
  if (run !== undefined && state !== "idle") {
    rows.push({
      name: input.leadName,
      lead: true,
      version: run.to ?? run.from,
      word: leadWord(run),
      detail: runFailed ? failedSentence(run) : null,
      moving: runActive,
      settled: !runActive,
      quiet: false,
      packageManaged: false,
      lastSeen: null,
    });
  }
  rows.push(...peerRowsOf(input, legs));

  // The device's own row. Only ever part of a RUN — a bare bundle download is the band's row and
  // saying it twice would be two surfaces about one fact (see this file's header).
  const downloadingHere = run !== undefined && state !== "idle" && deviceBusy;
  const progressAt = input.progress?.at ?? input.installingSince;
  const deviceAge =
    progressAt === null || progressAt === undefined ? null : Math.max(0, input.now - progressAt);
  // Hung is about a download that IS happening. With no device row there is nothing to be hung, and
  // a stale stamp from a worker that finished hours ago must never arm a way out of a fresh run.
  const hung = downloadingHere && deviceAge !== null && deviceAge >= DOWNLOAD_HUNG_MS;
  const device: UpdateScreenDevice | null =
    downloadingHere
      ? {
          phase: input.progress !== null && input.progress.done < input.progress.total ? "downloading" : "switching",
          done: input.progress?.done ?? 0,
          total: input.progress?.total ?? 0,
          elapsedMs:
            input.installingSince === null ? null : Math.max(0, input.now - input.installingSince),
          hung,
        }
      : null;

  const leadStalled =
    runActive && run.updatedAt > 0 && input.now - run.updatedAt >= LEAD_STALLED_MS;

  // The two ways out, each spent only once the operator has taken it. A way out collapses the sheet
  // and hands the app back; it never cancels the run and never reloads the page.
  const escaped = (hung && input.downloadReleased) || (leadStalled && input.leadReleased);

  // ONE SENTENCE, and the invariant the whole file rests on: a settled run is always dismissible,
  // because `runActive` is false for every terminal state.
  const dismissible = !(runActive && input.startedHere && !escaped);

  const mode = modeOf({ runActive, runFailed, runDone, deviceBusy, escaped, startedHere: input.startedHere });

  // THE END HAS A WINDOW, and it is the one the band already uses for a finished run.
  //
  // The run record persists on the snapshot long after the run, so without a window every document
  // loaded for the next week would announce "Crew updated to 1.9.0" again on its way in — and the
  // announcement fires per document, because a page that reloads onto the new bundle is a new
  // document. Ten minutes is longer than any restart and far shorter than "still news tomorrow".
  const fresh = run !== undefined && input.now - run.updatedAt < DONE_WINDOW_MS;
  const end: UpdateScreenEnd = runFailed
    ? { kind: "failed", sentence: failedSentence(run) }
    : runDone && !deviceBusy && fresh
      ? endOfDone(run, legs, input.leadName)
      : { kind: "none" };

  return { mode, dismissible, rows, device, end, leadStalled, recheckDownload: hung };
}

/**
 * THE END, AS ONE SENTENCE, or null when the run has not arrived anywhere.
 *
 * Here rather than at the component that shows the toast, because two surfaces read it: the hook that
 * publishes it through `lib/status.ts`, and the playground card that has to show the very same words.
 * A solo install names the MACHINE — a toast about a "crew" on a one-machine install is the screen
 * inventing company.
 */
export function endSentence(end: UpdateScreenEnd): string | null {
  if (end.kind === "crew") return t("updateScreen.done.crew", { version: end.version });
  if (end.kind === "solo") {
    return t("updateScreen.done.solo", { machine: end.machine, version: end.version });
  }
  return null;
}

/** Which mode the sheet is in. Separate so the table in the test reads as a table. */
function modeOf(a: {
  runActive: boolean;
  runFailed: boolean;
  runDone: boolean;
  deviceBusy: boolean;
  escaped: boolean;
  startedHere: boolean;
}): UpdateScreenMode {
  // A run that ended badly is the one state the sheet shows on EVERY device without being asked: it
  // carries the reason and the way to the Updates page, and it is dismissible, so it is a statement
  // and not a trap.
  if (a.runFailed) return "expanded";
  // A run in flight, or a run whose machines are done while this phone is still fetching the bundle
  // they serve. The device that tapped gets the takeover; every other device gets a badge, because a
  // takeover nobody asked for reads as hijacked.
  if (a.runActive || (a.runDone && a.deviceBusy)) {
    if (a.escaped) return "collapsed";
    return a.startedHere ? "expanded" : "collapsed";
  }
  // Everything else — a finished run with nothing left to wait for, and no run at all — is the sheet
  // being gone. The end is announced by the toast, not by a panel the operator has to close.
  return "hidden";
}

/** The toast a finished run earns. A solo install names the MACHINE; a crew names the crew. */
function endOfDone(
  run: UpdateRun,
  legs: readonly UpdatePeerLeg[],
  leadName: string,
): UpdateScreenEnd {
  const version = run.to ?? run.from ?? "";
  if (legs.length === 0) return { kind: "solo", machine: leadName, version };
  return { kind: "crew", version };
}
