import { navigate, on, type Handle } from "remix/component";
import { Check, Layers } from "lucide";

import { sessionsOnHost } from "@web/lib/hosts";
import { t, tn } from "@web/lib/i18n";
import { homePath } from "@web/lib/nav";
import type { SessionSummary } from "@web/lib/types";
import { cn } from "@web/lib/utils";

import { address, snapshot } from "../../lib/data";
import { useLocale } from "../../lib/i18n-store";
import { useStore } from "../../lib/store";
import { href } from "../../routes";
import { Icon } from "../../ui/icon";
import { BottomSheet } from "../../ui/sheet";

// Port of web/src/components/session-switcher.tsx: the compact session switcher in the header's
// right cluster. It gets no props and reads `snapshot` and `address` itself (the header draws it
// through a render function made once). The sessions are the addressed host's own (`sessionsOnHost`),
// and `viewAll` is the address's `?all=1`.
//
// Backward compatible by construction: the trigger renders ONLY when there is a real choice (more
// than one reachable session), or you are already on a non-primary one or on the widened view, so you
// can always get back. A single-session install shows nothing. The sheet lists every session;
// unreachable ones are greyed out and non-clickable. Selecting one navigates home in that session
// (primary: no `?s=`), sideways, a replace (ADR 0067). The host is carried through untouched, so a
// session switch can never also switch machines.
const NO_SESSIONS: readonly SessionSummary[] = [];

export function SessionSwitcher(handle: Handle) {
  useLocale(handle);
  const snap = useStore(handle, snapshot);
  const where = useStore(handle, address);
  let open = false;

  const close = (): void => {
    open = false;
    void handle.update();
  };

  return () => {
    const body = snap().data;
    const { scope, all: viewAll } = where();
    const sessions = body?.sessions === undefined ? NO_SESSIONS : sessionsOnHost(body.sessions, scope, body.servers);
    const current = scope.session;
    const reachableCount = sessions.filter((s) => s.reachable).length;
    if (reachableCount <= 1 && current === undefined && !viewAll) return null;

    // The trigger shows "All sessions" when widened, else the current session, or the primary's
    // registry name when on it.
    const currentName = viewAll
      ? t("connection.session.all")
      : (current ?? sessions.find((s) => s.isPrimary)?.name ?? "default");
    const isActive = (s: SessionSummary): boolean => (viewAll ? false : current === undefined ? s.isPrimary : s.name === current);

    const select = (s: SessionSummary): void => {
      close();
      if (!s.reachable) return;
      const target = s.isPrimary ? undefined : s.name; // primary carries no `?s=`
      if (target === current && !viewAll) return; // already here
      void navigate(href(homePath({ host: scope.host, session: target })), { history: "replace" });
    };

    // WIDEN. The one row that does not pick a session: it asks for all of them at once. It navigates
    // home carrying the ambient host and NO session, because widened, `?s=` would name a session the
    // list no longer restricts itself to, and the two would contradict each other in one url.
    const widen = (): void => {
      close();
      void navigate(href(homePath({ host: scope.host }, { all: true })), { history: "replace" });
    };

    return (
      <>
        <button
          type="button"
          data-testid="session-switcher"
          aria-label={viewAll ? t("connection.session.allAria") : t("connection.session.aria", { name: currentName })}
          // Bordered, not filled, and deliberately the same shape as the server pill beside it.
          class="flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent active:scale-95"
          mix={on("click", () => {
            open = true;
            void handle.update();
          })}
        >
          <Icon icon={Layers} class="size-3.5" />
          <span class="max-w-[7rem] truncate">{currentName}</span>
        </button>

        <BottomSheet open={open} onClose={close} title={t("connection.session.title")}>
          {open ? (
            <ul class="flex flex-col gap-1" data-testid="session-switcher-list">
              {/* FIRST, above the sessions rather than among them. A session name answers "which
                  one"; this answers "do I have to choose at all". The Check and the inset rail are
                  the same marks the rows below use. */}
              <li key={"\u0000all"}>
                <button
                  type="button"
                  aria-current={viewAll ? "true" : undefined}
                  class={cn(
                    "flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left transition-colors",
                    viewAll ? "shadow-[inset_2px_0_0_0_var(--primary)]" : "hover:bg-accent active:bg-accent",
                  )}
                  mix={on("click", widen)}
                >
                  <Icon icon={Layers} class="size-4 shrink-0 text-muted-foreground" />
                  <div class="min-w-0 flex-1">
                    <span class="block truncate text-sm font-medium">{t("connection.session.all")}</span>
                    <span class="mt-1 block truncate text-[11px] text-muted-foreground">{t("connection.session.allDescription")}</span>
                  </div>
                  {viewAll && <Icon icon={Check} class="size-4 shrink-0 text-primary" />}
                </button>
              </li>
              {sessions.map((s) => {
                const active = isActive(s);
                return (
                  <li key={s.name}>
                    <button
                      type="button"
                      disabled={!s.reachable}
                      aria-current={active ? "true" : undefined}
                      class={cn(
                        "flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left transition-colors",
                        // "Current" is a 2px inset cut in --primary, not a fill: 16:1 against the
                        // sheet, and no layout cost, so the row does not move between states.
                        active ? "shadow-[inset_2px_0_0_0_var(--primary)]" : "hover:bg-accent active:bg-accent",
                        !s.reachable && "cursor-not-allowed opacity-50 hover:bg-transparent",
                      )}
                      mix={on("click", () => select(s))}
                    >
                      <Icon icon={Layers} class="size-4 shrink-0 text-muted-foreground" />
                      <div class="min-w-0 flex-1">
                        <div class="flex flex-wrap items-center gap-1.5">
                          <span class="truncate text-sm font-medium">{s.name}</span>
                          {s.isPrimary && (
                            <span class="rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                              {t("connection.session.primary")}
                            </span>
                          )}
                          {!s.reachable && <span class="text-[11px] text-muted-foreground">{t("connection.session.unreachable")}</span>}
                        </div>
                        {s.reachable && (s.blocked > 0 || s.working > 0) && (
                          <div class="mt-1 flex items-center gap-1.5">
                            {s.blocked > 0 && (
                              <span class="rounded-md border border-status-blocked/30 bg-status-blocked/15 px-1.5 py-0.5 text-[10px] font-medium text-status-blocked">
                                {tn("status.count.needsYou", s.blocked)}
                              </span>
                            )}
                            {s.working > 0 && (
                              <span class="rounded-md border border-status-working/30 bg-status-working/15 px-1.5 py-0.5 text-[10px] font-medium text-status-working">
                                {tn("status.count.working", s.working)}
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                      {active && <Icon icon={Check} class="size-4 shrink-0 text-primary" />}
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </BottomSheet>
      </>
    );
  };
}
