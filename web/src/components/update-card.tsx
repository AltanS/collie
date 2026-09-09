import { useCallback, useEffect, useState } from "react";
import { ArrowUpCircle, CheckCircle2, Loader2, RotateCcw } from "lucide-react";
import { useRevalidator } from "react-router";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Collapse } from "@/components/ui/collapse";
import { SectionHeader } from "@/components/section-header";
import { useLocale } from "@/hooks/use-locale";
import { t, tn } from "@/lib/i18n";
import { fetchStandbyRun, fetchUpdateState, snoozeUpdate, startUpdate } from "@/lib/api";
import { describeThrownError } from "@/lib/api-error-message";
import { timeAgoShort } from "@/lib/format";
import { useOptionalRootData } from "@/lib/route-data";
import { noteUpdateRun } from "@/lib/self-update";
import {
  crewAction,
  crewActionLabel,
  peerRows,
  peersBehind,
  peersRolledBack,
  type PeerRow,
} from "@/lib/update-crew";
import {
  clearUpdateStarted,
  linkChangeNote,
  minutesWord,
  noteUpdateStarted,
  crewMoving,
  readRun,
  runInFlight,
} from "@/lib/update-ribbon";
import { cn } from "@/lib/utils";
import type {
  PreflightCheck,
  PreflightReport,
  UpdateCheckResponse,
  UpdatePeerLeg,
  UpdateRun,
  UpdateRunState,
} from "@/lib/types";

// ── UPDATE COLLIE, from the phone ───────────────────────────────────────────────────────────────
//
// One tap plus one confirm: the card on `/settings/updates` that names the version you are on, the
// version you would move to, what the preflight says about this machine, what it says about every
// peer, and the button that starts it. The route behind it is `POST /api/update`
// (bridge/update-action.ts), gated exactly like a send.
//
// ── ONE CONFIRM COVERS THE CREW, AND PEERS ARE LINES IN THIS CARD ────────────
// The peer lines sit inside the card rather than in a table beside it, because the card is what the
// confirm button belongs to and the thing that blocks the confirm has to be readable without moving
// your eyes to a second surface. No peer line carries a button of any kind: the operator's decision
// is "level this crew", made once, and a per-peer button would be a second one.
//
// ── THIS IS NOT THE OTHER UPDATE ─────────────────────────────────────────────
// The top band's bundle states say "New version — tap to update" and reload the BUNDLE. This card
// updates COLLIE — the program, on the host, with a service restart in the middle of it. Two things
// called "update" in one UI is the confusion this card exists to avoid, so it never borrows those
// words: it is titled "Update Collie", it names versions, and it takes a confirm. The two are
// coordinated in `lib/self-update.ts`, which holds the bundle reload for the length of a run and
// lets it fire once the run is `done`. What this card owes the band is one stamp: `noteUpdateStarted()`
// on a successful POST, which is the band's "Starting update…" and nothing else.
//
// ── THE RESTART GAP IS NOT AN OUTAGE ─────────────────────────────────────────
// The bridge goes away during `restarting`. A poll that fails in that window is the update working,
// and this card must never render it the way it would render a genuine outage — so a failed poll
// there falls through to the standby door (`GET /standby/update`, CREW_PROTOCOL.md §18.15) and, if
// that is unreachable too, changes nothing on screen and tries again.


/**
 * How often the card asks the STANDBY DOOR while a run is in flight (M20/08).
 *
 * This used to be a front-door poll as well, `fetchUpdateState` every two seconds beside the
 * snapshot poll and the card's own mount read: three loops over one route. The snapshot poll now
 * runs at `HOT_MS` while a run is in flight (`hooks/use-polling.ts`) and carries the same run
 * record, so the front-door half is gone and this timer answers only the question nothing else can.
 *
 * That question is the restart gap. `GET /standby/update` (CREW_PROTOCOL.md §18.15) is the one
 * reader that works while the bridge this page is served from is down, which is exactly the minute
 * the operator called the most confusing. Nothing else on this screen can reach it.
 */
const STANDBY_POLL_MS = 2000;

/**
 * The four in-flight states, in the order a run passes through them (M20/08).
 *
 * Rendered as a row of four marks with the current one filled, which is the cheapest thing on this
 * card that says "of four things, this is the second". Four sentences over several minutes told the
 * operator what was happening and never where in the run they were.
 */
const RUN_PHASES: readonly UpdateRunState[] = ["preflight", "staging", "restarting", "verifying"];

/**
 * How long the restart may take before the card stops calling it normal (M20/08).
 *
 * The bridge is genuinely gone in this window and the phone cannot tell an update from an outage, so
 * "Restarting. This is not an outage." is the right sentence — for a while. Past this it has become
 * one, or near enough that saying otherwise is the screen lying to somebody who can see it is wrong.
 *
 * A DISPLAY threshold and nothing else, exactly as {@link STARTED_SLOW_MS} is. It unlocks no control
 * and shortens no timeout. Ninety seconds is comfortably longer than every restart the drill has
 * produced and short enough that a genuine failure is named while the operator is still watching.
 */
const RESTART_BOUND_MS = 90_000;

/**
 * A counter that runs on THE PHONE'S OWN CLOCK, never off a poll result (M20/08).
 *
 * This is the whole point. During `restarting` the bridge is down, every poll fails, and a number
 * derived from the last successful read would freeze at exactly the moment the operator most needs
 * proof that something is alive. A `setInterval` on the phone cannot be stopped by a dead server.
 */
function useTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/**
 * How long the card waits, after its own tap, before it says the start is TAKING A WHILE.
 *
 * A DISPLAY threshold and nothing else. It was a control-unlock once — the button came back after
 * 30s — and that was a guess about how long an update takes dressed up as a safety valve: an
 * in-place checkout writes its run record only AFTER it has built (`recordInPlaceRun` in
 * cli/update.ts), and a build on a slow host outlives any number this file could pick. Unlocking
 * there would re-open the double-tap window this state exists to close, on exactly the machines
 * least able to afford it.
 *
 * What actually guards a second tap is the bridge: `POST /api/update` holds a lock and answers
 * `update.in_progress`. The disabled button is a courtesy, so it may stay disabled for as long as
 * the run takes; what it may NOT do is stay disabled and say nothing, which is what the second
 * sentence below is for.
 */
const STARTED_SLOW_MS = 60_000;

/** The freshest of the records this card can hold. `updatedAt` decides — the standby door and the
 *  front door are two readers of ONE file, so the newer reading is simply the newer reading. */
function freshest(...runs: (UpdateRun | undefined)[]): UpdateRun | undefined {
  let best: UpdateRun | undefined;
  for (const run of runs) {
    if (run === undefined) continue;
    // `>` and not `>=` (M20/14). Copies of one run tie on `updatedAt` — a peer leg moving does not
    // touch it — and `>=` handed every tie to the LAST argument, which is this card's own
    // `GET /api/update/check` copy, fetched when the card mounted and not since. `>` hands a tie to
    // the FIRST, and the arguments are ordered by how live each source is: the standby door during a
    // restart, then the snapshot poll, then the card's own copy. This decides the run's STATE only;
    // where its LEGS are read from is `peerLegsOf`, which no longer consults this record at all while
    // the status carries legs of its own.
    if (best === undefined || run.updatedAt > best.updatedAt) best = run;
  }
  return best;
}

/** The colour a verdict is drawn in. Existing status tokens only — no new colour enters the app. */
const VERDICT_COLOUR = {
  green: "bg-status-done",
  amber: "bg-status-working",
  red: "bg-status-blocked",
} satisfies Record<PreflightCheck["verdict"], string>;

/**
 * What the open confirm is asking for. `kind` decides the words and nothing else — every one of
 * them sends the same `POST /api/update`, and `peersOnly` is the only field that changes what the
 * bridge does with it.
 */
interface Confirm {
  kind: "single" | "crew" | "retry" | "major";
  version: string;
  major: boolean;
  peersOnly: boolean;
}

export function UpdateCard() {
  useLocale();
  const data = useOptionalRootData();
  const revalidator = useRevalidator();

  // The card's own read: the update status PLUS the preflight, which the snapshot deliberately does
  // not carry (it shells out to git and to `doctor`; paying that on every snapshot poll for a card
  // nobody has opened is the wrong trade).
  const [check, setCheck] = useState<UpdateCheckResponse | undefined>();
  const [checked, setChecked] = useState(false);
  // The record read off the STANDBY door while the front door is restarting.
  const [standbyRun, setStandbyRun] = useState<UpdateRun | undefined>();
  const [confirming, setConfirming] = useState<Confirm | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * THE GAP THE SECOND TAP FITTED IN. `POST /api/update` answers before the detached updater has
   * written anything, so for a beat there is no record at all: `running` was false, the button was
   * live, and the band overhead already said "Starting update…". This is the card's own half of the
   * band's (s), held HERE rather than read off `lib/update-ribbon`'s store — the card must go inert
   * on its own tap, not because some other component happens to be mounted and to clear a flag.
   */
  const [started, setStarted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  const snapshot = data?.update;
  const current = snapshot?.current ?? check?.current ?? "";
  const latest = snapshot?.latest ?? check?.latest ?? null;
  const releaseAvailable = snapshot?.releaseAvailable ?? check?.releaseAvailable ?? false;
  const majorAvailable = snapshot?.majorAvailable ?? check?.majorAvailable ?? null;
  const newerVersions = snapshot?.newerVersions ?? check?.newerVersions ?? [];
  // The one sentence about the crew wire (M27/06), or null. Off the SNAPSHOT first and the card's
  // own check second, the way every other field on this card is read — never re-derived here.
  const linkChange = linkChangeNote(snapshot?.linkChange ?? check?.linkChange ?? null);
  const preflight = check?.preflight ?? null;
  const run = freshest(standbyRun, snapshot?.run, check?.run);
  const runState = run?.state;
  const running = runInFlight(run);
  // Nothing on this card may be tapped while an update is being asked for, started, or driven.
  // ONE reading, used by every control below, so a control cannot be forgotten in one of the three.
  // `started` is the middle of those three and the one that was missing — see it below.
  const moving = busy || started || running;

  // Whether this machine leads anybody. The roster answers it on every snapshot; the check's own
  // `crew` array answers it better, when the bridge is new enough to send one. Either is enough to
  // make the button say "crew" — a lead with peers it could not reach still leads them.
  const servers = data?.servers ?? [];
  const crewLead = servers.length > 1 && servers.some((s) => s.isLead);
  const census = check?.crew ?? [];
  // Read through the SHARED reader, never off `run.peers` directly (M20/09). A peers-only run has no
  // record on this machine at all, so its legs ride the status rather than the run, and a component
  // that reached for one field would be blind to exactly the run it was opened to watch.
  // ONE READING, and the same one the band takes (M20/04). The card used to ask "does the record
  // still list a moving peer?" while the band asked "did the run finish under ten minutes ago?", so
  // on 2026-09-07 the band went quiet while this card kept the same peer moving for five more
  // minutes. Neither surface interprets a record any more.
  const reading = readRun({ update: snapshot ?? check, run, now: Date.now() });
  const legs = [...reading.legs];
  const rows = peerRows(census, legs);
  const hasPeers = rows.length > 0 || crewLead;
  const behind = peersBehind(census, current);
  const rolledBack = peersRolledBack(legs);
  // A packaged install never takes an update from here (ADR 0035): the root is not writable, the CLI
  // refuses, and `POST /api/update` would do nothing but relay that refusal. Read HERE, above the
  // action, because it is one of the facts that decides which action there is — not merely whether
  // the button is greyed out.
  const packageManaged = (snapshot?.installKind ?? check?.installKind) === "packaged";
  // The command the HOST resolved for this machine's prefix. TWO levels, not three: the snapshot
  // field since M17/02, then the preflight's own `package` check for a bridge older than that field.
  // `check.packageCommand` is deliberately not a third — the snapshot and the check are the same
  // `UpdateMonitor.status()` call, so a chain that read both would suggest they could disagree.
  // The PHONE never derives the command: the prefix is on the host, and a second derivation here
  // would be a second thing to drift.
  const packageCommand = packageManaged
    ? (snapshot?.packageCommand ?? check?.preflight?.checks.find((c) => c.id === PACKAGE_CHECK_ID)?.remedy ?? null)
    : null;
  // `leadCanTake: false` is what keeps the peers reachable from the phone. Without it the release
  // short-circuit answered `update-crew`, the card disabled it, and a packaged lead with a peer a
  // version behind was left with a disabled button and an explanation about its own install.
  const action = crewAction({ releaseAvailable, hasPeers, behind, rolledBack, leadCanTake: !packageManaged });

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      setCheck(await fetchUpdateState(signal));
    } catch {
      // A failed read is not an error to render: the versions come from the snapshot anyway, and the
      // preflight simply stays unknown, which disables nothing and claims nothing.
    } finally {
      setChecked(true);
    }
  }, []);

  // Read once on mount, and again whenever a run reaches a terminal state — the preflight's answer
  // is a different answer after an update than it was before one.
  //
  // "A RUN" IS THE CREW'S RUN AND NOT ONLY THIS MACHINE'S (M20/09). `running` reads the local record,
  // and a peers-only run never writes one, so this flag never toggled and the effect never re-fired:
  // `fetchUpdateState` was called once at mount and the census on screen then aged without bound.
  // That is the reported symptom, a peer's version that only a pull-to-refresh could correct.
  //
  // `crewMoving` is the same function the band reads, so the card cannot keep asking after the band
  // has gone quiet, or stop asking before it does.
  const settled = !running && !crewMoving(snapshot ?? check, run);
  useEffect(() => {
    const ac = new AbortController();
    void load(ac.signal);
    return () => ac.abort();
  }, [load, settled]);

  // The bundle self-updater must not reload the page mid-run. Stamped from here as well as from the
  // snapshot loader, because the window that matters most is the one where the snapshot is not
  // answering at all and this card is reading the standby door instead.
  useEffect(() => {
    noteUpdateRun(runState);
  }, [runState]);

  // (s) ends ONE way: the record speaks, and `running` takes the card from there. A POST that was
  // accepted and then produced no record at all leaves the card inert — and that is the honest
  // answer, because this card cannot tell that case apart from an update that is simply still
  // building. The operator is not trapped: leaving `/settings/updates` unmounts this card, so
  // coming back is the reset, and the bridge refuses a genuine second start on its own lock anyway.
  useEffect(() => {
    if (!started) return;
    if (runState !== undefined && runState !== "idle") setStarted(false);
  }, [started, runState]);

  // The second sentence, on a timer that changes only WORDS. See {@link STARTED_SLOW_MS}.
  const [startSlow, setStartSlow] = useState(false);
  useEffect(() => {
    if (!started) {
      setStartSlow(false);
      return;
    }
    const timer = setTimeout(() => setStartSlow(true), STARTED_SLOW_MS);
    return () => clearTimeout(timer);
  }, [started]);

  // THE DOOR THAT STAYS OPEN. Only while a run is in flight, and a failure here is EXPECTED twice
  // over: there may be no deputy at all, and the bridge is restarting because that is what was
  // asked for. Either way it changes nothing on screen and looks again in a moment.
  useEffect(() => {
    if (!running) return;
    let alive = true;
    const timer = setInterval(() => {
      void (async () => {
        try {
          const fromStandby = await fetchStandbyRun();
          if (alive) setStandbyRun(fromStandby);
        } catch {
          /* expected — never an error on screen */
        }
      })();
    }, STANDBY_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [running]);

  async function begin(ask: Confirm) {
    setBusy(true);
    setError(null);
    try {
      const answer = await startUpdate({ target: ask.version, major: ask.major, peersOnly: ask.peersOnly });
      // The band's (s) state, and the only thing that produces it: `POST /api/update` returns
      // immediately and hands off to a detached process, so the run record says nothing for a beat.
      // A silent band in that beat reads as "nothing happened" about the thing just consented to.
      noteUpdateStarted();
      setStarted(true);
      setConfirming(null);
      if (answer.run !== null) setStandbyRun(answer.run);
      // Pull the snapshot now rather than waiting out the poll gap: the operator has just tapped,
      // and the run record is what they are waiting to see.
      revalidator.revalidate();
    } catch (thrown) {
      // Every refusal the bridge can make is a code with a sentence (bridge/error-codes.ts) — a
      // double tap lands here as `update.in_progress`, which is the idempotence being reported
      // rather than a second update being started.
      clearUpdateStarted(); // nothing was started, so the band must not say one was
      setStarted(false);
      setError(describeThrownError(thrown));
      setConfirming(null);
    } finally {
      setBusy(false);
    }
  }

  async function dismiss() {
    setDismissed(true);
    try {
      await snoozeUpdate();
    } catch {
      /* the dismiss is a courtesy; a failed one is not worth a line on screen */
    }
  }

  const redCheck = preflight?.checks.find((c) => c.verdict === "red");
  // The buttons that move THIS machine are disabled for the same reason a red preflight disables
  // them — the tap cannot succeed — but a packaged install is its own condition rather than a
  // manufactured red, because NOTHING IS WRONG with it. Its preflight is green on purpose, and
  // painting the card red would report a fault that does not exist.
  // THE PREFLIGHT HAS NOT ANSWERED YET, so nothing about this machine is known (M20/07). Measured on
  // 2026-09-08: the button reported `disabled: false` for the whole ~1.16 s the read was out,
  // because `blocked` reads `checked` and `checked` is false until it returns. A live button in that
  // window is a button that can start an update no check has cleared. This is a THIRD state and not
  // a fourth reason to be blocked: nothing is wrong here, the answer is simply still out, and the
  // label says so rather than leaving a grey control with no account of itself.
  const pending = !checked;
  const summary = actionSummary(preflight, rows.length);
  const blocked = packageManaged || (checked && (preflight === null || redCheck !== undefined));
  // A REAL red check wins over the package-managed sentence, not the other way round. A packaged
  // install's own preflight is short and green BY DESIGN — but `doctor` and `service` still run on it
  // (`cli/update-check.ts`'s packaged branch keeps both), and either can genuinely be red on a
  // machine that also happens to be packaged. Checking packageManaged first would bury that fault
  // under a sentence about a boundary that is working exactly as designed, on every visit, until the
  // real problem is found some other way.
  const blockedReason =
    redCheck !== undefined
      ? redCheck.reason
      : packageManaged
        ? t("settings.updateCard.packageManaged")
        : t("settings.updateCard.preflightUnavailable");

  // Nothing to take: the running version already IS the newest, no major is waiting, and no run is
  // mid-flight. This is the state the operator sees on almost every visit, so it gets the loudest
  // line on the card rather than being read off a Preflight list nobody asked to open.
  // `behind === 0` is part of it now: a lead whose own version is newest but whose peer is a
  // release back has something to do, and "Up to date. Nothing to do." three inches above a
  // "Retry crew update" button would be the card contradicting itself.
  const upToDate =
    !releaseAvailable && majorAvailable === null && latest !== null && run === undefined && behind === 0;
  const updateAvailable = releaseAvailable || majorAvailable !== null;

  return (
    <Card className="gap-0 py-0">
      <div className="flex items-start gap-3 p-4">
        {upToDate ? (
          <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-status-done" />
        ) : (
          <ArrowUpCircle className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
        )}
        <div className="min-w-0 flex-1">
          <div className="font-medium">{t("settings.updateCard.title")}</div>
          {upToDate ? (
            <>
              <p className="text-sm text-muted-foreground">{t("settings.updateCard.upToDate")}</p>
              <p className="text-sm text-muted-foreground">
                {t("settings.updateCard.running", { current: current || t("settings.updateCard.versionUnknown") })}
                {latest !== null && ` · ${t("settings.updateCard.newest", { version: latest })}`}
              </p>
            </>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                {t("settings.updateCard.running", { current: current || t("settings.updateCard.versionUnknown") })}
                {latest !== null && ` · ${t("settings.updateCard.newest", { version: latest })}`}
              </p>
              {latest === null && (
                <p className="text-sm text-muted-foreground">{t("settings.updateCard.unknownLatest")}</p>
              )}
            </>
          )}
          {newerVersions.length > 1 && (
            <p className="mt-1 text-xs text-muted-foreground">
              {t("settings.updateCard.includes", { versions: newerVersions.join(", ") })}
            </p>
          )}
        </div>
      </div>

      {/* THE ACTION ROW SITS ABOVE EVERY ARRIVAL, AND THAT IS THE WHOLE POINT (M20/07).
          Measured on 2026-09-08 at 390 x 844: with the row last, the peer census (57 px) and the
          auto-opened Details (311 px) landed together at about 1.16 s and pushed the button 368 px
          down the screen, straight out from under a thumb already on its way. With the confirm
          open, its own Cancel rendered at y = 854 against an 844 px viewport.

          Above the row is the version header, which has no async content at all, so the row's
          position is a function of nothing that can arrive late. Below it is everything that can.

          The sections stay INSIDE this card, so the fact that blocks a confirm is still readable
          without moving to a second surface, which is the principle the old ordering comment argued
          for. What that principle needs is the same card, not a place above the button, and the
          one-line summary beside the button carries the deciding fact into the row itself. */}
      {confirming !== null ? (
        <div className="border-t border-border p-4">
          <div className="text-sm font-medium">{confirmTitle(confirming)}</div>
          <p className="mt-1 text-sm text-muted-foreground">{confirmBody(confirming, packageManaged)}</p>
          {/* ABOVE THE CONFIRM, never beside it (M27/06). The button's wording does not change: what
              the tap does is the same act, and the sentence is the fact the operator needs in order
              to decide the ORDER they do it in. A label that carried it would be a label nobody
              reads twice. */}
          {linkChange !== null && <p className="mt-2 text-sm text-muted-foreground">{linkChange}</p>}
          <div className="mt-3 flex items-center gap-2">
            <Button size="sm" disabled={moving} onClick={() => void begin(confirming)}>
              {busy && <Loader2 className="size-4 animate-spin" />}
              {confirmAction(confirming)}
            </Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirming(null)}>
              {t("settings.updateCard.cancel")}
            </Button>
          </div>
        </div>
      ) : (
        (action !== "none" || majorAvailable !== null) && (
          <div className="flex flex-col gap-2 border-t border-border p-3">
            {/* The same sentence, in the state before the confirm is open — so it is on screen when
                the operator decides to tap at all, not only once they are being asked. */}
            {linkChange !== null && <p className="text-sm text-muted-foreground">{linkChange}</p>}
            <div className="flex flex-wrap items-center gap-2">
              {/* THE action button. One of the three labels, never two of them, and the label
                  states what the tap will actually do: level this machine, level the crew, or
                  run the peers again once this machine is already current. */}
              {/* On a packaged install the command REPLACES the button rather than greying it
                  out: a disabled control is a thing to try again, and there is nothing here to
                  try. "Retry crew update" survives, because levelling the peers is a different
                  act that works fine from a lead that cannot move itself. */}
              {packageCommand !== null && (
                <code className="select-all rounded bg-muted px-2 py-1 font-mono text-xs">{packageCommand}</code>
              )}
              {action !== "none" && !(packageManaged && action !== "retry-crew") && (
                <Button
                  size="sm"
                  disabled={moving || pending || (blocked && action !== "retry-crew")}
                  onClick={() =>
                    setConfirming(
                      action === "retry-crew"
                        ? { kind: "retry", version: current, major: false, peersOnly: true }
                        : {
                            kind: action === "update-crew" ? "crew" : "single",
                            version: latest ?? current,
                            major: false,
                            peersOnly: false,
                          },
                    )
                  }
                >
                  {pending && <Loader2 aria-hidden="true" className="size-4 shrink-0 animate-spin" />}
                  {pending ? t("settings.updateCard.checking") : crewActionLabel(action, latest ?? current)}
                </Button>
              )}
              {/* NOT a second update action: crossing a major is its own consent (ADR 0020),
                  the one thing the button above will never take. It appears only when a major
                  is actually waiting, which is rare, and it says "Cross", not "Update". */}
              {majorAvailable !== null && !packageManaged && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={moving || pending || blocked}
                  onClick={() =>
                    setConfirming({
                      kind: "major",
                      version: majorAvailable,
                      major: true,
                      peersOnly: false,
                    })
                  }
                >
                  {t("settings.updateCard.majorAction", { version: majorAvailable })}
                </Button>
              )}
              {/* The dismiss is not an action on the update, it is a courtesy about the digest
                  push — and there is nothing to snooze once this machine is already current, so
                  a retry-only state grows no ghost row. */}
              {!dismissed && updateAvailable && (
                <Button variant="ghost" size="sm" disabled={moving} onClick={() => void dismiss()}>
                  {t("settings.updateCard.dismiss")}
                </Button>
              )}
              {/* The deciding fact, in the row that carries the tap. `ml-auto` so it settles to the
                  trailing edge and the buttons keep the leading one, and it wraps under them rather
                  than squeezing a button on a narrow phone. */}
              {summary !== null && (
                <span className="ml-auto text-xs text-muted-foreground">{summary}</span>
              )}
            </div>
            {/* The red's OWN reason, in place of a generic "unavailable" — a red preflight has to
                be legible without leaving the phone.

                Printed even under a peers-only button, which is not disabled: the sentence says
                why THIS machine is not moving, and that is exactly the question a "Retry crew
                update" offered to a lead with a release waiting raises. Suppressing it there was
                how a packaged lead ended up with a button and no account of itself. */}
            {/* NOT while the card is inert. The sentence explains why a tap would not
                succeed, and there is no tap to explain while one is already running — and
                during the restart gap the preflight read fails BECAUSE the bridge is down, so
                printing "the preflight couldn't be run" there draws the outage this card exists
                not to draw. */}
            {blocked && !moving && <p className="text-xs text-status-blocked">{blockedReason}</p>}
            {/* A DISABLED BUTTON MUST NOT BE SILENT. `running` has the run section above to
                narrate it; the gap before the first record had nothing, so the button simply
                went grey and stayed grey with no account of itself. */}
            {started && (
              <p className="flex items-center gap-1.5 text-xs text-status-working">
                <Loader2 aria-hidden="true" className="size-3 shrink-0 animate-spin" />
                {startSlow
                  ? t("settings.updateCard.startingSlow")
                  : t("settings.updateCard.starting")}
              </p>
            )}
            {dismissed && <p className="text-xs text-muted-foreground">{t("settings.updateCard.dismissed")}</p>}
            {majorAvailable !== null && (
              <p className="text-xs text-muted-foreground">
                {t("settings.updateCard.majorNote", { version: majorAvailable })}
              </p>
            )}
          </div>
        )
      )}

      {/* EVERY ARRIVAL ON THIS CARD IS A `Collapse` (DESIGN.md §7, hard rule 1). The three sections
          below are all async: the run record lands on a poll, and the peer lines and the preflight
          land together when `GET /api/update/check` answers — which is a `doctor` and a `git`
          away, so it is a second or two AFTER the card first paints.

          They now sit BELOW the action row, so their growth pushes the bottom of the card rather
          than the only control on it. Each still wears the `Collapse`: the row above is fixed
          either way, and a section that snapped open would still jump the page under a reader who
          is looking at the section. */}
      <Collapse open={run !== undefined && run.state !== "idle"}>
        {run !== undefined && run.state !== "idle" ? (
          <RunSection
            run={run}
            // Retry re-opens the SAME confirm the first attempt went through. A dead end with no next
            // action is what sends the operator to a terminal they may not have.
            onRetry={() =>
              setConfirming({
                kind: "single",
                version: run.to ?? latest ?? current,
                major: false,
                peersOnly: false,
              })
            }
          />
        ) : null}
      </Collapse>

      {/* The crew, as lines in this card. Drawn whether or not a run is in flight — a peer going
          quiet is exactly what the operator opened this page to see. On a solo install there is
          nothing here and the card grows no height at all. */}
      <Collapse open={rows.length > 0}>
        {rows.length > 0 ? (
          <PeerSection
            rows={rows}
            now={Date.now()}
            failed={reading.failed}
            // Past the patience window the page says the thing the band has no room for. The band
            // names the elapsed time in forty characters; the sentence that makes the wait bearable
            // belongs where a tap on that band lands (M20/04).
            slow={reading.slow}
            // RETRY NOW IS NOT A SECOND DIALLER (M20/04). It opens the same peers-only confirm the
            // crew-wide retry opens, which begins a run and re-sweeps. Spec 01's urgency rule then
            // dials every member with an open leg on every sweep, whatever backoff it was on, so the
            // member is due without this browser clearing anything. Spec 02's reset is reserved for
            // the crew link's own two-factor admission, and a browser is not that.
            onRetry={() => setConfirming({ kind: "retry", version: current, major: false, peersOnly: true })}
          />
        ) : null}
      </Collapse>

      {/* The preflight in full, under the row its one-line summary already reports into. */}
      <Collapse open={preflight !== null && preflight.checks.length > 0}>
        {preflight !== null && preflight.checks.length > 0 ? (
          <PreflightSection preflight={preflight} updateAvailable={updateAvailable} />
        ) : null}
      </Collapse>


      {error !== null && <p className="border-t border-border px-4 py-2.5 text-xs text-status-blocked">{error}</p>}
    </Card>
  );
}

/**
 * The `PreflightCheck.id` the CLI puts a packaged install's one line under — and the only place the
 * phone reads a check by id. The KIND decides what the card does; this id only fetches the command
 * that check already resolved, and its absence costs a command and nothing else.
 */
const PACKAGE_CHECK_ID = "package";

/** The confirm's heading. Four asks, four sentences — a crew-wide run must not be consented to
 *  through the words written for one machine. */
function confirmTitle(ask: Confirm): string {
  if (ask.kind === "major") return t("settings.updateCard.majorConfirmTitle", { version: ask.version });
  if (ask.kind === "crew") return t("settings.updateCard.crewConfirmTitle", { version: ask.version });
  if (ask.kind === "retry") return t("settings.updateCard.retryConfirmTitle");
  return t("settings.updateCard.confirmTitle", { version: ask.version });
}

/**
 * The sentence under the title. `packageManaged` changes exactly one of them.
 *
 * The peers-only confirm normally reads "This machine is already current, so only the peers run" —
 * true wherever that button used to appear, and FALSE on a packaged lead with a release waiting,
 * which is the one place it can now appear as well. The reason that lead is sitting the run out is
 * its install kind, not its version, so it says so instead. Neither sentence is new: a third one
 * would be a seventh dictionary to keep in step with the other six for one branch.
 */
function confirmBody(ask: Confirm, packageManaged = false): string {
  if (ask.kind === "major") return t("settings.updateCard.majorConfirmBody", { version: ask.version });
  if (ask.kind === "crew") return t("settings.updateCard.crewConfirmBody");
  if (ask.kind === "retry") {
    return packageManaged ? t("settings.updateCard.packageManaged") : t("settings.updateCard.retryConfirmBody");
  }
  return t("settings.updateCard.confirmBody");
}

function confirmAction(ask: Confirm): string {
  if (ask.kind === "major") return t("settings.updateCard.majorConfirmAction", { version: ask.version });
  if (ask.kind === "crew") return t("settings.updateCard.crewConfirmAction");
  if (ask.kind === "retry") return t("settings.updateCard.retryConfirmAction");
  return t("settings.updateCard.confirmAction");
}

/**
 * The peer lines. Read-only by construction: this function renders no interactive element at all,
 * which is the milestone's rule rather than an omission — the operator's decision is "level this
 * crew", taken once on the button above, and a per-peer button would be a second one.
 *
 * Worst first, so the row that blocks the confirm is the row nearest the button. Each line is
 * `name · version · verdict-or-state`, plus the reason on its own line whenever the row is red,
 * unknown or a leg that failed. Each is dated from the stamp its source carried, so a six-hour-old
 * green and a four-second-old green are told apart.
 */
function PeerSection({
  rows,
  now,
  failed,
  slow,
  onRetry,
}: {
  rows: PeerRow[];
  now: number;
  /** The leg that went wrong, or null. The card names it in the same words the band does. */
  failed: UpdatePeerLeg | null;
  /** The run has passed the patience window, so the page says waiting is the whole job. */
  slow: boolean;
  onRetry: () => void;
}) {
  return (
    <div className="border-t border-border px-4 py-3">
      <ul aria-label={t("settings.updateCard.peers.label")} className="space-y-1.5">
        {rows.map((row) => (
          <li key={row.name} className="flex items-start gap-2 text-xs">
            {row.inFlight ? (
              <Loader2 aria-hidden="true" className="mt-0.5 size-3 shrink-0 animate-spin text-status-working" />
            ) : (
              <span
                aria-hidden="true"
                className={cn("mt-1 size-1.5 shrink-0 rounded-full", peerDot(row))}
              />
            )}
            <span className="min-w-0">
              <span className="font-medium">{row.name}</span>
              <span className="text-muted-foreground">
                {" · "}
                {row.version ?? t("settings.updateCard.peer.versionUnknown")}
                {" · "}
                {row.word}
                {/* A MOVING ROW COUNTS, IT DOES NOT REPORT A CHECK (M20/04). Both readings come off
                    the same stamp, the leg's own `updatedAt` as that machine reported it, but "for
                    3 min" is the sentence an operator watching a run needs and "checked 3 min ago"
                    is the one they need about a machine that is standing still. */}
                {row.asOf !== null &&
                  (row.inFlight
                    ? ` · ${t("settings.updateCard.peer.movingFor", { elapsed: minutesWord(now - row.asOf) })}`
                    : ` · ${t("settings.updateCard.peer.asOf", { ago: timeAgoShort(row.asOf) })}`)}
              </span>
              {row.reason !== null && <span className="block text-status-blocked">{row.reason}</span>}
            </span>
          </li>
        ))}
      </ul>
      {slow && failed === null && (
        <p className="mt-2 text-xs text-muted-foreground">{t("settings.updateCard.crewPatience")}</p>
      )}
      {/* THE SAME SENTENCE THE BAND SHOWS, in the same words (M20/04). The row above already carries
          the state and the reason, but an operator who arrived from the band must find what the band
          said, and a page that rephrases it reads as a second, different fact. */}
      {failed !== null && (
        <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-border pt-2">
          <p className="min-w-0 flex-1 text-xs text-status-blocked">
            {t("updateRibbon.peerFailed", {
              name: failed.name,
              reason: failed.reason ?? t("settings.updateCard.peer.unknownReason"),
            })}
          </p>
          <Button variant="outline" size="sm" onClick={onRetry}>
            <RotateCcw className="size-4" />
            {t("settings.updateCard.retryNow")}
          </Button>
        </div>
      )}
    </div>
  );
}

/** The dot a peer row is drawn with. Ranks map to the same status tokens the preflight rows use;
 *  an unknown never borrows green's. */
function peerDot(row: PeerRow): string {
  if (row.rank <= 1) return "bg-status-blocked";
  if (row.rank <= 3) return "bg-status-working";
  return "bg-status-done";
}

/** The worst verdict actually present among the individual checks — read off the rows themselves,
 *  never off the report's own summary field, so a row that needs a look is never hidden by a
 *  stale or mistaken top-level verdict. */
function worstVerdict(checks: PreflightCheck[]): PreflightCheck["verdict"] {
  if (checks.some((c) => c.verdict === "red")) return "red";
  if (checks.some((c) => c.verdict === "amber")) return "amber";
  return "green";
}

/**
 * The count that still reads true when the list underneath is folded shut: "6 checks" while every
 * one is green, "1 red · 1 amber" the moment one isn't — red named before amber, because that is
 * the order that matters most.
 */
function preflightSummary(checks: PreflightCheck[]): string {
  const red = checks.filter((c) => c.verdict === "red").length;
  const amber = checks.filter((c) => c.verdict === "amber").length;
  if (red === 0 && amber === 0) return tn("settings.updateCard.summary.checks", checks.length);
  const parts: string[] = [];
  if (red > 0) parts.push(tn("settings.updateCard.summary.red", red));
  if (amber > 0) parts.push(tn("settings.updateCard.summary.amber", amber));
  return parts.join(" · ");
}

/**
 * The one line that rides BESIDE the action button: what the preflight found, and how many peers the
 * tap will move (M20/07).
 *
 * The detail moved below the button when the row moved above it. The fact that decides the tap did
 * not: "1 amber · 1 peer" is the whole of what an operator needs before pressing, and it is readable
 * without scrolling past a section that is 311 px tall on a phone.
 *
 * `null` while the preflight is still out, because a summary of nothing is a claim about a machine
 * nobody has checked. The pending label on the button is what speaks in that window.
 */
function actionSummary(preflight: PreflightReport | null, peers: number): string | null {
  if (preflight === null) return null;
  const parts = [preflightSummary(preflight.checks)];
  if (peers > 0) parts.push(tn("settings.updateCard.summary.peers", peers));
  return parts.join(" · ");
}

/**
 * The Preflight list, folded behind a "Details" row.
 *
 * Default open state is decided ONCE, at mount — never re-derived while the card sits open, or a
 * poll landing mid-read would fold a list the operator is looking at. It opens by default when
 * there is something to act on: an update is available (the operator is about to read these before
 * tapping the button), or a check is red (a check that blocks the update must not hide behind a
 * tap). Amber alone stays folded — a chronic amber (a missing integration, an unlinked path) is not
 * something to act on today, and the header's own summary dot already says "1 amber" without the
 * card forcing itself open on every visit. Otherwise — nothing to do, and everything green or amber
 * — it starts folded, and the header's own summary is what still tells the truth at a glance.
 */
function PreflightSection({
  preflight,
  updateAvailable,
}: {
  preflight: PreflightReport;
  updateAvailable: boolean;
}) {
  const verdict = worstVerdict(preflight.checks);
  const [open, setOpen] = useState(() => updateAvailable || verdict === "red");

  return (
    <div className="border-t border-border px-4 py-3">
      <SectionHeader
        label={t("settings.updateCard.details")}
        level={3}
        open={open}
        onToggle={setOpen}
        controls="update-preflight-body"
        trailing={
          <span className="flex items-center gap-1.5 text-xs font-normal normal-case tracking-normal text-muted-foreground">
            <span
              aria-hidden="true"
              className={cn("size-1.5 shrink-0 rounded-full", VERDICT_COLOUR[verdict])}
            />
            {preflightSummary(preflight.checks)}
          </span>
        }
      />
      <Collapse open={open}>
        <ul id="update-preflight-body" className="mt-1.5 space-y-1.5">
          {preflight.checks.map((c) => (
            <li key={c.id} className="flex items-start gap-2 text-xs">
              <span
                aria-hidden="true"
                className={cn("mt-1 size-1.5 shrink-0 rounded-full", VERDICT_COLOUR[c.verdict])}
              />
              <span className="min-w-0">
                <span className="font-mono">{c.id}</span> <span className="text-muted-foreground">{c.reason}</span>
                {c.remedy !== undefined && (
                  <span className="block font-mono text-muted-foreground">
                    {t("settings.updateCard.remedy", { command: c.remedy })}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      </Collapse>
    </div>
  );
}

/**
 * The run, in whatever state it is in — and the states are told apart on purpose.
 *
 * `restarting` and `verifying` render as PROGRESS: a spinner, a working-coloured line, and the
 * sentence that names the symptom before the operator reads it as a crash. `rolled-back` renders as
 * a failure that names the version still installed, shows the log tail and offers a Retry. A
 * progress state that looked like a failure state would be read as one.
 */
function RunSection({ run, onRetry }: { run: UpdateRun; onRetry: () => void }) {
  const inFlight = runInFlight(run);
  const version = run.to ?? run.from ?? "";
  const still = run.from ?? "";
  const now = useTick(inFlight);
  // Off the run's OWN start stamp, which the host wrote, so the number is the run's age and not this
  // tab's age. A phone opened mid-run joins the count where the run actually is.
  const elapsed = run.startedAt > 0 ? Math.max(0, now - run.startedAt) : null;
  // The restart is timed from the transition into it, not from the run's start: a slow build before
  // it must not spend the restart's patience. `updatedAt` is the stamp of the current state.
  const restartOver =
    run.state === "restarting" && run.updatedAt > 0 && now - run.updatedAt >= RESTART_BOUND_MS;

  return (
    <div className="border-t border-border px-4 py-3">
      <div
        className={cn(
          "flex items-start gap-2 text-sm",
          inFlight && "text-status-working",
          run.state === "done" && "text-status-done",
          (run.state === "rolled-back" || run.state === "stuck") && "text-status-blocked",
        )}
        role="status"
      >
        {inFlight && <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin" />}
        <span className="min-w-0">{stateLine(run, version, still, restartOver)}</span>
      </div>

      {/* PROOF OF LIFE, and the cheapest there is (M20/08). Four sentences over several minutes said
          what was happening and never where in the run the operator was, or for how long. The marks
          answer the first, the counter answers the second, and the counter keeps moving through the
          restart, when every poll fails and it is the only thing on screen that can. */}
      {inFlight && (
        <div className="mt-2 flex items-center gap-2">
          <div className="flex items-center gap-1" role="presentation">
            {RUN_PHASES.map((phase, index) => (
              <span
                key={phase}
                aria-hidden="true"
                className={cn(
                  "h-1 w-5 rounded-full",
                  index <= RUN_PHASES.indexOf(run.state) ? "bg-status-working" : "bg-muted",
                )}
              />
            ))}
          </div>
          <span className="text-xs tabular-nums text-muted-foreground">
            {t("settings.updateCard.phaseOf", {
              step: String(RUN_PHASES.indexOf(run.state) + 1),
              total: String(RUN_PHASES.length),
            })}
            {elapsed !== null && ` · ${clockOf(elapsed)}`}
          </span>
        </div>
      )}

      {inFlight && (
        <p className="mt-1 text-xs text-muted-foreground">{t("settings.updateCard.progressNote")}</p>
      )}

      {run.state === "stuck" && run.recovery !== undefined && (
        <pre className="mt-2 overflow-x-auto rounded-md bg-muted p-2 font-mono text-xs">{run.recovery}</pre>
      )}

      {run.logTail !== undefined && run.logTail !== "" && (
        <details className="mt-2">
          <summary className="text-xs text-muted-foreground">{t("settings.updateCard.logTail")}</summary>
          <pre className="mt-1 max-h-48 overflow-auto rounded-md bg-muted p-2 font-mono text-xs">{run.logTail}</pre>
        </details>
      )}

      {(run.state === "rolled-back" || run.state === "interrupted") && (
        <Button variant="outline" size="sm" className="mt-3" onClick={onRetry}>
          <RotateCcw className="size-4" />
          {t("settings.updateCard.retry")}
        </Button>
      )}
    </div>
  );
}

/** `m:ss`, ticking. Monospaced digits at the call site, so the row does not jitter every second. */
function clockOf(ms: number): string {
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** The sentence for a run's state. Every state has one — a state with no line reads as a hang. */
function stateLine(run: UpdateRun, version: string, still: string, restartOver = false): string {
  switch (run.state) {
    case "preflight":
      return t("settings.updateCard.state.preflight");
    case "staging":
      return t("settings.updateCard.state.staging", { version });
    case "restarting":
      // "THIS IS NOT AN OUTAGE" MUST NOT SURVIVE BECOMING ONE (M20/08). Past the bound the screen
      // stops reassuring and starts saying what to check. A sentence the operator can see is wrong
      // costs more than the silence it replaced.
      return restartOver
        ? t("settings.updateCard.state.restartingSlow")
        : t("settings.updateCard.state.restarting");
    case "verifying":
      return t("settings.updateCard.state.verifying");
    case "done":
      return t("settings.updateCard.state.done", { version });
    case "rolled-back":
      return t("settings.updateCard.state.rolledBack", { version: still });
    case "stuck":
      return t("settings.updateCard.state.stuck");
    case "interrupted":
      return t("settings.updateCard.state.interrupted");
    case "idle":
      return "";
  }
}
