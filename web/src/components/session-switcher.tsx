import { useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router";
import { Check, Layers } from "lucide-react";

import { cn } from "@/lib/utils";
import { BottomSheet } from "@/components/ui/sheet";
import { homePath } from "@/lib/nav";
import type { Scope } from "@/lib/scope";
import type { SessionSummary } from "@/lib/types";
import { t, tn } from "@/lib/i18n";
import { useLocale } from "@/hooks/use-locale";

interface SessionSwitcherProps {
  /** The bridge's session registry (primary-first). */
  sessions: SessionSummary[];
  /** The scope currently being viewed. Only its session changes here — the host is carried through
   *  untouched, so switching sessions can never also switch machines. */
  scope: Scope;
  /** True when the home view is WIDENED — every session's panes in one list (`?all=1`). */
  viewAll: boolean;
}

// Compact session switcher for the header's right cluster. Backward compatible by construction: the
// trigger renders ONLY when there's a real choice — more than one reachable session, or you're
// already on a non-primary one (so you can always get back). A single-session install shows nothing.
// The sheet lists every session; unreachable ones (crashed / stale socket) are greyed out and
// non-clickable. Selecting one navigates home in that session (primary → no `?s=`).
export function SessionSwitcher({ sessions, scope, viewAll }: SessionSwitcherProps) {
  useLocale();
  const current = scope.session;
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();

  const reachableCount = sessions.filter((s) => s.reachable).length;
  const onNonPrimary = current !== undefined;
  if (reachableCount <= 1 && !onNonPrimary && !viewAll) return null;

  // The name to show on the trigger: "All sessions" when widened, else the current session — or the
  // primary's registry name when on it.
  const currentName = viewAll
    ? t("connection.session.all")
    : (current ?? sessions.find((s) => s.isPrimary)?.name ?? "default");
  const isActive = (s: SessionSummary): boolean =>
    viewAll ? false : current === undefined ? s.isPrimary : s.name === current;

  function select(s: SessionSummary): void {
    setOpen(false);
    if (!s.reachable) return; // unreachable rows are non-clickable (disabled), guard anyway
    const target = s.isPrimary ? undefined : s.name; // primary carries no `?s=`
    if (target === current && !viewAll) return; // already here
    navigate(homePath({ host: scope.host, session: target }));
  }

  /**
   * WIDEN. The one row here that does not pick a session: it asks for all of them at once, which is
   * a different QUESTION from the rows below it rather than a different answer to theirs.
   *
   * It navigates home carrying the ambient host and NO session. That is deliberate and it is the
   * whole reason the flag is not part of the scope: widened, `?s=` would name a session the list no
   * longer restricts itself to, so the two would contradict each other in the same url. The address
   * stays "this machine, its primary session" — which is what `bridge`, the spaces list and every
   * write with no row of its own go on using — and `?all=1` says how much of that machine to show.
   */
  function widen(): void {
    setOpen(false);
    navigate(homePath({ host: scope.host }, { all: true }));
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={
          viewAll
            ? t("connection.session.allAria")
            : t("connection.session.aria", { name: currentName })
        }
        // Bordered, not filled, and deliberately identical to the server pill beside it. The
        // bg-muted this used to carry was invisible by accident: the header was bg-muted too, so the
        // fill painted nothing. The header is bg-background now, which made a 1.09:1 (light) /
        // 1.31:1 (dark) smudge suddenly visible — a fill too weak to be a surface and too present to
        // be nothing. A component's edge is --border (1.16:1 light / 1.33:1 dark), which is the
        // treatment the sibling trigger already used.
        className="flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent active:scale-95"
      >
        <Layers className="size-3.5" />
        <span className="max-w-[7rem] truncate">{currentName}</span>
      </button>

      {/* Portal to document.body so the sheet's `fixed inset-0` always resolves against the viewport,
          not an ancestor: any transform / filter / backdrop-filter on the app header (it has carried a
          backdrop-blur before) would make it the containing block and clip the sheet to the header band. */}
      {createPortal(
        <BottomSheet open={open} onClose={() => setOpen(false)} title={t("connection.session.title")}>
          <ul className="flex flex-col gap-1">
            {/* FIRST, above the sessions rather than among them. A session name answers "which one";
                this answers "do I have to choose at all", and putting it in the list would make
                "All sessions" look like a session called that. The Check and the inset rail are the
                same marks the rows below use, so "where am I" reads identically either way. */}
            <li>
              <button
                type="button"
                onClick={widen}
                aria-current={viewAll ? "true" : undefined}
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left transition-colors",
                  viewAll
                    ? "shadow-[inset_2px_0_0_0_var(--primary)]"
                    : "hover:bg-accent active:bg-accent",
                )}
              >
                <Layers className="size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">
                    {t("connection.session.all")}
                  </span>
                  <span className="mt-1 block truncate text-[11px] text-muted-foreground">
                    {t("connection.session.allDescription")}
                  </span>
                </div>
                {viewAll && <Check className="size-4 shrink-0 text-primary" />}
              </button>
            </li>
            {sessions.map((s) => {
              const active = isActive(s);
              return (
                <li key={s.name}>
                  <button
                    type="button"
                    disabled={!s.reachable}
                    onClick={() => select(s)}
                    aria-current={active ? "true" : undefined}
                    className={cn(
                      "flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left transition-colors",
                      // "Current" is a 2px inset cut in --primary, not a fill. The fill it replaces
                      // was bg-accent inside a bg-background sheet: 1.17:1 light, 1.31:1 dark, i.e.
                      // barely a surface — while putting the status count pills on rgb(228)/rgb(38),
                      // where blocked measures 4.55 light and 4.13 dark. The rail is 16.44:1 light /
                      // 15.72:1 dark against the same ground and costs no layout, so the row does not
                      // move between states. Same treatment as the alert rows in space-overview and
                      // agent-card.
                      active
                        ? "shadow-[inset_2px_0_0_0_var(--primary)]"
                        : "hover:bg-accent active:bg-accent",
                      !s.reachable && "cursor-not-allowed opacity-50 hover:bg-transparent",
                    )}
                  >
                    <Layers className="size-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="truncate text-sm font-medium">{s.name}</span>
                        {s.isPrimary && (
                          <span className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                            {t("connection.session.primary")}
                          </span>
                        )}
                        {!s.reachable && (
                          <span className="text-[11px] text-muted-foreground">
                            {t("connection.session.unreachable")}
                          </span>
                        )}
                      </div>
                      {s.reachable && (s.blocked > 0 || s.working > 0) && (
                        <div className="mt-1 flex items-center gap-1.5">
                          {s.blocked > 0 && (
                            <span className="rounded-md border border-status-blocked/30 bg-status-blocked/15 px-1.5 py-0.5 text-[10px] font-medium text-status-blocked">
                              {tn("status.count.needsYou", s.blocked)}
                            </span>
                          )}
                          {s.working > 0 && (
                            <span className="rounded-md border border-status-working/30 bg-status-working/15 px-1.5 py-0.5 text-[10px] font-medium text-status-working">
                              {tn("status.count.working", s.working)}
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                    {active && <Check className="size-4 shrink-0 text-primary" />}
                  </button>
                </li>
              );
            })}
          </ul>
        </BottomSheet>,
        document.body,
      )}
    </>
  );
}
