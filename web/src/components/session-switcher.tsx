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
}

// Compact session switcher for the header's right cluster. Backward compatible by construction: the
// trigger renders ONLY when there's a real choice — more than one reachable session, or you're
// already on a non-primary one (so you can always get back). A single-session install shows nothing.
// The sheet lists every session; unreachable ones (crashed / stale socket) are greyed out and
// non-clickable. Selecting one navigates home in that session (primary → no `?s=`).
export function SessionSwitcher({ sessions, scope }: SessionSwitcherProps) {
  useLocale();
  const current = scope.session;
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();

  const reachableCount = sessions.filter((s) => s.reachable).length;
  const onNonPrimary = current !== undefined;
  if (reachableCount <= 1 && !onNonPrimary) return null;

  // The name to show on the trigger: the current session, or the primary's registry name when on it.
  const currentName = current ?? sessions.find((s) => s.isPrimary)?.name ?? "default";
  const isActive = (s: SessionSummary): boolean =>
    current === undefined ? s.isPrimary : s.name === current;

  function select(s: SessionSummary): void {
    setOpen(false);
    if (!s.reachable) return; // unreachable rows are non-clickable (disabled), guard anyway
    const target = s.isPrimary ? undefined : s.name; // primary carries no `?s=`
    if (target === current) return; // already here
    navigate(homePath({ host: scope.host, session: target }));
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={t("connection.session.aria", { name: currentName })}
        className="flex shrink-0 items-center gap-1 rounded-full bg-muted px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/70 active:scale-95"
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
                      active
                        ? "bg-accent text-accent-foreground"
                        : "hover:bg-muted/60 active:bg-muted",
                      !s.reachable && "cursor-not-allowed opacity-50 hover:bg-transparent",
                    )}
                  >
                    <Layers className="size-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="truncate text-sm font-medium">{s.name}</span>
                        {s.isPrimary && (
                          <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
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
                            <span className="rounded-full border border-status-blocked/30 bg-status-blocked/15 px-1.5 py-0.5 text-[10px] font-medium text-status-blocked">
                              {tn("status.count.needsYou", s.blocked)}
                            </span>
                          )}
                          {s.working > 0 && (
                            <span className="rounded-full border border-status-working/30 bg-status-working/15 px-1.5 py-0.5 text-[10px] font-medium text-status-working">
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
