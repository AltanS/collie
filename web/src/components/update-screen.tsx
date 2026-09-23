import { useId, useRef, useState, type ReactNode } from "react";
import { Check, Loader2, Lock, Minus, TriangleAlert, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { useDialogFocus } from "@/components/ui/sheet";
import { useLocale } from "@/hooks/use-locale";
import { describeThrownError } from "@/lib/api-error-message";
import { t, tn } from "@/lib/i18n";
import { updatesPath } from "@/lib/nav";
import { scopeFromUrl } from "@/lib/scope";
import { beginAskedUpdate } from "@/lib/update-ask";
import { STEP_COUNT, formatClock, phaseFailed, phaseInFlight, type UpdateScreenRow } from "@/lib/update-screen";
import { cn } from "@/lib/utils";
import { router } from "@/router";
import type { UpdateScreen as UpdateScreenState } from "@/hooks/use-update-screen";

// ── UPDATE MODE: THE LOCKED APP AND THE DOCKED PANEL (ADR 0064) ─────────────────────────────────
//
// The app stays in view behind a veil and takes no tap. A band across the top says where the update
// is, "Update mode · step N of 7", with a clock, and its bottom edge is the progress bar. A panel
// docked at the bottom walks the seven steps: a heading, a two-line subtitle, one row per machine
// and one for this phone, a note with the one question the operator may be asked, and the footer.
// Chosen by Altan from four drawn options on 2026-09-23 (option 4, "Locked app, docked panel").
//
// ── NOTHING IN THE PANEL MOVES BETWEEN TWO STATES ───────────────────────────
// DESIGN.md §2, applied to a screen whose every state is a timer's. Every box below has a height of
// its own, stated, never measured from what it holds:
//
//   heading    one line, `h-7`, truncated
//   subtitle   `h-10`, which is two 20px lines, clamped to two; a one-line subtitle keeps both
//   rows       `h-13` each (52px): a first line, and a 16px slot under it that holds a reason, a
//              progress bar or nothing. The list is `rows × 52px`, scrolled inside past six.
//   note       `h-[84px]`: two 16px lines, then one 44px row for the member question's two buttons,
//              the stuck command, or nothing
//   footer     two 44px rows: the lock line or a primary action, then a second action or nothing
//
// So the panel's height is a function of the machine count and of nothing else, and a state change
// repaints it. `e2e/update-screen.spec.ts` walks every state at 375x812 in Chromium and WebKit and
// asserts the heading, the subtitle box, each row and the footer stay put to half a pixel. That
// measurement is the rule; this comment is its reason. The layout shift Altan saw in the drawn
// options, between "Members, one unreachable" and "Phone downloading", was a subtitle changing its
// line count and a row trading a second text line for a bar.
//
// ── IT IS MOUNTED IN `App.tsx`, BESIDE THE INERT WRAPPER ─────────────────────
// Never inside the router, because a node cannot be both inert and the host of the dialog that made
// it inert (ADR 0044). The run, the census and this machine's name come through
// `lib/update-run-store.ts`; the ask comes through `lib/update-ask.ts`.
//
// ── IT DECIDES NOTHING ──────────────────────────────────────────────────────
// Every word, row and control is `screen.view` from `lib/update-screen.ts`. This file never reloads
// the page (the controller swap does, `lib/pwa.ts`), and the only update it starts is the one "Start
// update" confirms.

/** One row's height, in px. Tailwind's `h-13`. The list's height is this times the rows shown. */
const ROW_PX = 52;
/** Past this many rows the list scrolls inside its own box rather than growing the panel. */
const MAX_ROWS = 6;

/** After "Start update" is accepted: pull the snapshot now rather than after the poll gap. */
function revalidateNow(): void {
  void router.revalidate();
}

/** Where "Show log" goes. The module-scoped router is reachable from outside the provider. */
function goToUpdates(): void {
  void router.navigate(updatesPath(scopeFromUrl(window.location.href)));
}

export function UpdateScreen({
  screen,
  onOpenUpdates = goToUpdates,
  onStarted = revalidateNow,
}: {
  screen: UpdateScreenState;
  /** Overridden by the playground, which has no app router to navigate. */
  onOpenUpdates?: () => void;
  /** After "Start update" is accepted: pull the snapshot now rather than after the poll gap. */
  onStarted?: () => void;
}) {
  useLocale();
  const panelRef = useRef<HTMLDivElement>(null);
  const headingId = useId();
  const { view, mode } = screen;
  useDialogFocus(mode === "expanded", panelRef);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // `hidden` and `collapsed` draw nothing here. The strip is `components/update-run-strip.tsx`, in the
  // band above the header.
  if (mode !== "expanded") return null;

  const ready = view.phase === "ready";
  const visibleRows = Math.min(Math.max(view.rows.length, 1), MAX_ROWS);

  async function start(): Promise<void> {
    const ask = screen.ask;
    if (ask === null) return;
    setBusy(true);
    setError(null);
    try {
      await beginAskedUpdate(ask);
      onStarted();
    } catch (thrown) {
      // Every refusal the bridge can make is a code with a sentence (bridge/error-codes.ts).
      setError(describeThrownError(thrown));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div role="dialog" aria-modal="true" aria-labelledby={headingId} className="fixed inset-0 z-50">
      {/* THE VEIL. The app stays in view, dimmed and softened, so the operator can see what is locked
          and that it is still there. It takes no pointer: `App.tsx` makes the app behind it inert. */}
      <div aria-hidden="true" className="absolute inset-0 bg-background/70 backdrop-blur-[2px]" />
      {!ready && <Band screen={screen} />}
      <div
        ref={panelRef}
        tabIndex={-1}
        data-slot="update-panel"
        className="absolute inset-x-0 bottom-0 mx-auto flex w-full max-w-screen-sm flex-col rounded-t-md border border-rule bg-card px-4 pt-2 pb-[calc(env(safe-area-inset-bottom)_+_1rem)] shadow-2xl"
      >
        <div aria-hidden="true" className="flex h-4 shrink-0 justify-center">
          <span className="h-1 w-9 rounded-md bg-muted-foreground/40" />
        </div>
        <h2
          id={headingId}
          data-slot="update-heading"
          aria-live="polite"
          className={cn(
            "h-7 shrink-0 truncate text-lg leading-7",
            phaseFailed(view.phase) && "text-status-blocked",
          )}
        >
          {view.heading}
        </h2>
        <div data-slot="update-subtitle" className="mt-1 h-10 shrink-0 text-[13px] leading-5 text-muted-foreground">
          <p className="line-clamp-2">{view.subtitle}</p>
        </div>
        <ul
          data-slot="update-rows"
          aria-label={t("updateScreen.rows.label")}
          className="mt-3 shrink-0 overflow-y-auto overscroll-contain"
          style={{ height: visibleRows * ROW_PX }}
        >
          {view.rows.map((row) => (
            <Row key={row.key} row={row} />
          ))}
        </ul>
        <Note screen={screen} error={ready ? error : null} />
        <Footer screen={screen} busy={busy} onStart={() => void start()} onOpenUpdates={onOpenUpdates} />
      </div>
    </div>
  );
}

/** The band across the top: the step, the clock, and the progress bar along its bottom edge. */
function Band({ screen }: { screen: UpdateScreenState }) {
  const { view } = screen;
  const inFlight = phaseInFlight(view.phase);
  const failed = phaseFailed(view.phase);
  const clock = view.elapsedMs === null ? null : formatClock(view.elapsedMs);
  const text = inFlight
    ? t("updateScreen.band.step", { step: String(view.step), total: String(STEP_COUNT) })
    : failed
      ? t("updateScreen.band.stopped")
      : t("updateScreen.band.done");
  // Half a step while one is under way: the bar says "in step N", not "N finished".
  const fraction = view.phase === "done" ? 1 : inFlight ? (view.step - 0.5) / STEP_COUNT : view.step / STEP_COUNT;
  const tone = failed ? "blocked" : view.phase === "done" ? "done" : "working";
  // THE BAND IS A STRIP NOTICE (DESIGN.md §1 and §11): the tint recipe lives in `ui/notice.tsx` and
  // nowhere else. The icon slot is filled in every state, so the words never move sideways.
  return (
    <div data-slot="update-band" className="absolute inset-x-0 top-0 bg-background pt-[env(safe-area-inset-top)]">
      <Notice
        tone={tone === "blocked" ? "danger" : tone === "done" ? "success" : "caution"}
        variant="strip"
        icon={tone === "blocked" ? <TriangleAlert /> : tone === "done" ? <Check /> : <Lock />}
        action={clock !== null ? <span className="text-xs tabular-nums">{clock}</span> : undefined}
      >
        {text}
      </Notice>
      <div
        role="progressbar"
        aria-label={text}
        aria-valuemin={0}
        aria-valuemax={STEP_COUNT}
        aria-valuenow={view.step}
        className="h-1 w-full bg-muted"
      >
        <div
          className={cn(
            "h-full motion-safe:transition-[width] motion-safe:duration-500",
            tone === "working" && "bg-status-working",
            tone === "done" && "bg-status-done",
            tone === "blocked" && "bg-status-blocked",
          )}
          style={{ width: `${Math.round(fraction * 100)}%` }}
        />
      </div>
    </div>
  );
}

/** One machine, or this phone. The box is the same in every state; see the file header. */
function Row({ row }: { row: UpdateScreenRow }) {
  return (
    <li data-slot="update-row" className={cn("flex h-13 items-start gap-2.5 py-1.5", row.dim && "opacity-50")}>
      <span aria-hidden="true" className="grid size-5 shrink-0 place-items-center">
        <RowIcon status={row.status} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex h-5 items-baseline gap-2 text-sm leading-5">
          <span className="min-w-0 flex-1 truncate">
            <span className="font-medium">{row.name}</span>
            <span className="text-muted-foreground"> · {row.word}</span>
          </span>
          {/* A bare semver is chrome, and chrome is sans (DESIGN.md §5). */}
          {row.versions !== null && (
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{row.versions}</span>
          )}
        </div>
        <div className="mt-1 h-4 text-xs leading-4 text-muted-foreground">
          {row.progress !== null ? (
            <div
              role="progressbar"
              aria-label={t("updateScreen.device.progressAria")}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(row.progress * 100)}
              className="mt-1.5 h-1 w-full overflow-hidden rounded-md bg-muted"
            >
              <div
                className="h-full bg-status-working motion-safe:transition-[width]"
                style={{ width: `${Math.round(row.progress * 100)}%` }}
              />
            </div>
          ) : (
            row.detail !== null && <p className="truncate">{row.detail}</p>
          )}
        </div>
      </div>
    </li>
  );
}

/** Only the active row moves; every other status is a still mark. Motion respects the OS setting. */
function RowIcon({ status }: { status: UpdateScreenRow["status"] }) {
  switch (status) {
    case "active":
      return <Loader2 className="size-4 text-status-working motion-safe:animate-spin" />;
    case "offline":
      return <span className="size-3 rounded-full border-2 border-status-info motion-safe:animate-pulse" />;
    case "queued":
      return <span className="size-3 rounded-full border-[1.5px] border-rule" />;
    case "ok":
      return <Check className="size-4 text-status-done" />;
    case "failed":
      return <X className="size-4 text-status-blocked" />;
    case "attention":
      return <TriangleAlert className="size-4 text-status-working" />;
    case "skipped":
      return <Minus className="size-4 text-status-idle" />;
  }
}

/** Two lines of what comes next, then one row for the question or the command. Always 84px. */
function Note({ screen, error }: { screen: UpdateScreenState; error: string | null }) {
  const { view } = screen;
  const [copied, setCopied] = useState(false);
  let actions: ReactNode = null;
  if (view.ask !== null) {
    const name = view.ask.name;
    actions = (
      <>
        <Button variant="outline" size="lg" className="flex-1" onClick={() => screen.skip(name)}>
          {t("updateScreen.action.skip", { name })}
        </Button>
        <Button variant="ghost" size="lg" className="flex-1" onClick={() => screen.keepTrying(name)}>
          {t("updateScreen.action.keepTrying")}
        </Button>
      </>
    );
  } else if (view.recovery !== null) {
    const command = view.recovery;
    actions = (
      <div className="flex h-11 min-w-0 flex-1 items-center gap-2 rounded-md border border-border bg-muted px-3">
        <code className="min-w-0 flex-1 truncate font-mono text-xs select-all">{command}</code>
        <Button
          variant="ghost"
          size="sm"
          className="shrink-0"
          onClick={() => {
            void navigator.clipboard?.writeText(command).then(() => setCopied(true));
          }}
        >
          {copied ? t("updateScreen.action.copied") : t("updateScreen.action.copy")}
        </Button>
      </div>
    );
  }
  return (
    <div data-slot="update-note" className="mt-3 flex h-[84px] shrink-0 flex-col gap-2">
      <p
        className={cn(
          "line-clamp-2 h-8 text-xs leading-4",
          error !== null ? "text-status-blocked" : "text-muted-foreground",
        )}
      >
        {error ?? view.note}
      </p>
      <div className="flex h-11 gap-2">{actions}</div>
    </div>
  );
}

/** Two 44px rows. What sits in them is the phase's; their size is not. */
function Footer({
  screen,
  busy,
  onStart,
  onOpenUpdates,
}: {
  screen: UpdateScreenState;
  busy: boolean;
  onStart: () => void;
  onOpenUpdates: () => void;
}) {
  const { view } = screen;
  let first: ReactNode = null;
  let second: ReactNode = null;
  const showLog = (
    <Button
      variant="outline"
      size="lg"
      className="flex-1"
      onClick={() => {
        screen.back();
        onOpenUpdates();
      }}
    >
      {t("updateScreen.action.showLog")}
    </Button>
  );
  if (view.phase === "ready") {
    first = (
      <Button size="lg" className="flex-1" disabled={busy} onClick={onStart}>
        {busy && <Loader2 aria-hidden="true" className="size-4 motion-safe:animate-spin" />}
        {t("updateScreen.action.start")}
      </Button>
    );
    second = (
      <Button variant="ghost" size="lg" className="flex-1" disabled={busy} onClick={screen.notNow}>
        {t("updateScreen.action.notNow")}
      </Button>
    );
  } else if (phaseInFlight(view.phase)) {
    first = view.locked ? (
      <p className="flex flex-1 items-center gap-2 text-xs leading-4 text-muted-foreground">
        <Lock aria-hidden="true" className="size-4 shrink-0" />
        <span className="line-clamp-2">{t("updateScreen.lock")}</span>
      </p>
    ) : (
      <Button variant="outline" size="lg" className="flex-1" onClick={screen.back}>
        {t("updateScreen.action.back")}
      </Button>
    );
    if (view.canEscape) {
      second = (
        <Button variant="outline" size="lg" className="flex-1" onClick={screen.release}>
          {t("updateScreen.action.escape")}
        </Button>
      );
    }
  } else {
    first = (
      <Button size="lg" className="flex-1" onClick={screen.back}>
        {t("updateScreen.action.back")}
      </Button>
    );
    if (view.phase === "done" && view.retryNames.length > 0) {
      second = (
        <Button variant="ghost" size="lg" className="flex-1" onClick={screen.retryMembers}>
          {view.retryNames.length === 1
            ? t("updateScreen.action.retryOne", { name: view.retryNames[0] ?? "" })
            : tn("updateScreen.action.retryMany", view.retryNames.length)}
        </Button>
      );
    } else if (view.phase === "rolled-back" || view.phase === "stopped") {
      second = (
        <>
          <Button variant="outline" size="lg" className="flex-1" onClick={screen.tryAgain}>
            {t("updateScreen.action.tryAgain")}
          </Button>
          {showLog}
        </>
      );
    } else if (view.phase === "stuck") {
      second = showLog;
    }
  }
  return (
    <div data-slot="update-footer" className="mt-3 flex h-24 shrink-0 flex-col gap-2">
      <div className="flex h-11 gap-2">{first}</div>
      <div className="flex h-11 gap-2">{second}</div>
    </div>
  );
}
