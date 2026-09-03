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
import { useOptionalRootData } from "@/lib/route-data";
import { noteUpdateRun } from "@/lib/self-update";
import { cn } from "@/lib/utils";
import type {
  PreflightCheck,
  PreflightReport,
  UpdateCheckResponse,
  UpdateRun,
  UpdateRunState,
} from "@/lib/types";

// ── UPDATE COLLIE, from the phone ───────────────────────────────────────────────────────────────
//
// One tap plus one confirm: the settings card that names the version you are on, the version you
// would move to, what the preflight says about this machine, and the button that starts it. The
// route behind it is `POST /api/update` (bridge/update-action.ts), gated exactly like a send.
//
// ── THIS IS NOT THE OTHER UPDATE ─────────────────────────────────────────────
// `components/update-available-banner.tsx` says "New version — tap to update" and reloads the
// BUNDLE. This card updates COLLIE — the program, on the host, with a service restart in the middle
// of it. Two things called "update" in one UI is the confusion this card exists to avoid, so it
// never borrows that banner's words: it is titled "Update Collie", it names versions, and it takes
// a confirm. The two are coordinated in `lib/self-update.ts`, which holds the bundle reload for the
// length of a run and lets it fire once the run is `done`.
//
// ── THE RESTART GAP IS NOT AN OUTAGE ─────────────────────────────────────────
// The bridge goes away during `restarting`. A poll that fails in that window is the update working,
// and this card must never render it the way it would render a genuine outage — so a failed poll
// there falls through to the standby door (`GET /standby/update`, PACK_PROTOCOL.md §18.15) and, if
// that is unreachable too, changes nothing on screen and tries again.

/** The run states somebody is still driving. Progress, never failure. */
const IN_FLIGHT: ReadonlySet<UpdateRunState> = new Set<UpdateRunState>([
  "preflight",
  "staging",
  "restarting",
  "verifying",
]);

/** How often the card looks while a run is in flight. Its own beat, and only while one is running —
 *  the snapshot poll (hooks/use-polling.ts) carries the run record the rest of the time, and its
 *  cadence is resolved from what the operator is doing, which is not this. */
const RUN_POLL_MS = 2000;

/** The freshest of the records this card can hold. `updatedAt` decides — the standby door and the
 *  front door are two readers of ONE file, so the newer reading is simply the newer reading. */
function freshest(...runs: (UpdateRun | undefined)[]): UpdateRun | undefined {
  let best: UpdateRun | undefined;
  for (const run of runs) {
    if (run === undefined) continue;
    if (best === undefined || run.updatedAt >= best.updatedAt) best = run;
  }
  return best;
}

/** The colour a verdict is drawn in. Existing status tokens only — no new colour enters the app. */
const VERDICT_COLOUR = {
  green: "bg-status-done",
  amber: "bg-status-working",
  red: "bg-status-blocked",
} satisfies Record<PreflightCheck["verdict"], string>;

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
  const [confirming, setConfirming] = useState<{ version: string; major: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  const snapshot = data?.update;
  const current = snapshot?.current ?? check?.current ?? "";
  const latest = snapshot?.latest ?? check?.latest ?? null;
  const releaseAvailable = snapshot?.releaseAvailable ?? check?.releaseAvailable ?? false;
  const majorAvailable = snapshot?.majorAvailable ?? check?.majorAvailable ?? null;
  const newerVersions = snapshot?.newerVersions ?? check?.newerVersions ?? [];
  const preflight = check?.preflight ?? null;
  const run = freshest(standbyRun, snapshot?.run, check?.run);
  const runState = run?.state;
  const running = runState !== undefined && IN_FLIGHT.has(runState);

  // A pack LEAD says so plainly, so nobody hunts for a button that does not exist this milestone:
  // a peer is levelled from the operator's own terminal, over their own SSH (ADR 0016).
  const servers = data?.servers ?? [];
  const packLead = servers.length > 1 && servers.some((s) => s.isLead);

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
  const settled = !running;
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

  // The run poll. Only while a run is in flight, and it treats a failed front-door read as EXPECTED:
  // the bridge is restarting because that is what was asked for.
  useEffect(() => {
    if (!running) return;
    let alive = true;
    const timer = setInterval(() => {
      void (async () => {
        try {
          const fresh = await fetchUpdateState();
          if (alive) setCheck(fresh);
        } catch {
          // The restart gap. Ask the door that stays open, and if that is unreachable too, say
          // nothing and look again in a moment.
          try {
            const fromStandby = await fetchStandbyRun();
            if (alive) setStandbyRun(fromStandby);
          } catch {
            /* expected while the front door is down — never an error on screen */
          }
        }
      })();
    }, RUN_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [running]);

  async function begin(version: string, major: boolean) {
    setBusy(true);
    setError(null);
    try {
      const answer = await startUpdate({ target: version, major });
      setConfirming(null);
      if (answer.run !== null) setStandbyRun(answer.run);
      // Pull the snapshot now rather than waiting out the poll gap: the operator has just tapped,
      // and the run record is what they are waiting to see.
      revalidator.revalidate();
    } catch (thrown) {
      // Every refusal the bridge can make is a code with a sentence (bridge/error-codes.ts) — a
      // double tap lands here as `update.in_progress`, which is the idempotence being reported
      // rather than a second update being started.
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
  const blocked = checked && (preflight === null || redCheck !== undefined);
  const blockedReason =
    redCheck !== undefined ? redCheck.reason : t("settings.updateCard.preflightUnavailable");

  // Nothing to take: the running version already IS the newest, no major is waiting, and no run is
  // mid-flight. This is the state the operator sees on almost every visit, so it gets the loudest
  // line on the card rather than being read off a Preflight list nobody asked to open.
  const upToDate = !releaseAvailable && majorAvailable === null && latest !== null && run === undefined;
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

      {run !== undefined && run.state !== "idle" && (
        <RunSection
          run={run}
          // Retry re-opens the SAME confirm the first attempt went through. A dead end with no next
          // action is what sends the operator to a terminal they may not have.
          onRetry={() => setConfirming({ version: run.to ?? latest ?? current, major: false })}
        />
      )}

      {!running && (
        <>
          {preflight !== null && preflight.checks.length > 0 && (
            <PreflightSection preflight={preflight} updateAvailable={updateAvailable} />
          )}

          {packLead && updateAvailable && (
            <p className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
              {t("settings.updateCard.packLead")}
            </p>
          )}

          {confirming !== null ? (
            <div className="border-t border-border p-4">
              <div className="text-sm font-medium">
                {confirming.major
                  ? t("settings.updateCard.majorConfirmTitle", { version: confirming.version })
                  : t("settings.updateCard.confirmTitle", { version: confirming.version })}
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                {confirming.major
                  ? t("settings.updateCard.majorConfirmBody", { version: confirming.version })
                  : t("settings.updateCard.confirmBody")}
              </p>
              <div className="mt-3 flex items-center gap-2">
                <Button size="sm" disabled={busy} onClick={() => void begin(confirming.version, confirming.major)}>
                  {busy && <Loader2 className="size-4 animate-spin" />}
                  {confirming.major
                    ? t("settings.updateCard.majorConfirmAction", { version: confirming.version })
                    : t("settings.updateCard.confirmAction")}
                </Button>
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirming(null)}>
                  {t("settings.updateCard.cancel")}
                </Button>
              </div>
            </div>
          ) : (
            (releaseAvailable || majorAvailable !== null) && (
              <div className="flex flex-col gap-2 border-t border-border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  {releaseAvailable && latest !== null && (
                    <Button
                      size="sm"
                      disabled={blocked}
                      onClick={() => setConfirming({ version: latest, major: false })}
                    >
                      {t("settings.updateCard.action", { version: latest })}
                    </Button>
                  )}
                  {majorAvailable !== null && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={blocked}
                      onClick={() => setConfirming({ version: majorAvailable, major: true })}
                    >
                      {t("settings.updateCard.majorAction", { version: majorAvailable })}
                    </Button>
                  )}
                  {!dismissed && (
                    <Button variant="ghost" size="sm" onClick={() => void dismiss()}>
                      {t("settings.updateCard.dismiss")}
                    </Button>
                  )}
                </div>
                {/* The red's OWN reason, in place of a generic "unavailable" — a red preflight has to
                    be legible without leaving the phone. */}
                {blocked && <p className="text-xs text-status-blocked">{blockedReason}</p>}
                {dismissed && <p className="text-xs text-muted-foreground">{t("settings.updateCard.dismissed")}</p>}
                {majorAvailable !== null && (
                  <p className="text-xs text-muted-foreground">
                    {t("settings.updateCard.majorNote", { version: majorAvailable })}
                  </p>
                )}
              </div>
            )
          )}
        </>
      )}

      {error !== null && <p className="border-t border-border px-4 py-2.5 text-xs text-status-blocked">{error}</p>}
    </Card>
  );
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
  const inFlight = IN_FLIGHT.has(run.state);
  const version = run.to ?? run.from ?? "";
  const still = run.from ?? "";

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
        <span className="min-w-0">{stateLine(run, version, still)}</span>
      </div>

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

/** The sentence for a run's state. Every state has one — a state with no line reads as a hang. */
function stateLine(run: UpdateRun, version: string, still: string): string {
  switch (run.state) {
    case "preflight":
      return t("settings.updateCard.state.preflight");
    case "staging":
      return t("settings.updateCard.state.staging", { version });
    case "restarting":
      return t("settings.updateCard.state.restarting");
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
