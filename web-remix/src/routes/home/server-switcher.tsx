import { navigate, on, type Handle } from "remix/component";
import { Check, Crown, Network, Server } from "lucide";

import { crewPath, homePath } from "@web/lib/nav";
import { linkPresentation, type HostHealth } from "@web/lib/host-health";
import { HOST_TEXT_CLASSES, countsFor, hostCounts, hostSlot } from "@web/lib/hosts";
import { t, tn } from "@web/lib/i18n";
import type { ServerSummary } from "@web/lib/types";
import { cn } from "@web/lib/utils";

import { address, snapshot } from "../../lib/data";
import { useLocale } from "../../lib/i18n-store";
import { hiddenMachines } from "../../lib/prefs";
import { useStore } from "../../lib/store";
import { href } from "../../routes";
import { Icon } from "../../ui/icon";
import { BottomSheet } from "../../ui/sheet";
import { Switch } from "../../ui/switch";
import { crewHealthNow } from "./crew-health";
import { crewHealth, memberHealth, nextHiddenMachines } from "./crew-model";

// Port of web/src/components/server-switcher.tsx: the machine switcher in the header's right
// cluster. It gets no props and reads `snapshot` and `address` itself, because the header draws it
// through a render function made once.
//
// It hides when there is nothing to choose between, and you are not parked on a peer you would
// otherwise have no way back from. It is bordered and leads with a server glyph; the session pill
// beside it is a different shape on purpose, so the two cannot be mistaken for each other.
//
// SELECTING A HOST navigates HOME in that host (`?h=`), sideways (a replace, ADR 0067). It never maps
// the pane you are looking at onto the other machine: `w1:p1` there is a different terminal.
//
// EVERY ROW NAVIGATES, INCLUDING AN UNREACHABLE ONE (CREW_PROTOCOL.md §10.2): a down machine's
// last-good state never vanishes, so the row goes where it says it goes and stays dimmed to say what
// you will find there. Writing is gated where it happens, not here.
//
// A SECOND QUESTION ON ITS OWN TARGET (#288): each row carries a Show switch, beside the row's
// button and never inside it, so a tap on the row still goes to the machine and a tap on the switch
// never navigates. It writes `hiddenMachines` and nothing else. The addressed machine's switch is on
// and disabled, with its reason under the row. Counts stay herd-wide, hidden or not.
//
// Not crew administration: it lists members and lets you go to one.
export function ServerSwitcher(handle: Handle) {
  useLocale(handle);
  const snap = useStore(handle, snapshot);
  const where = useStore(handle, address);
  const hidden = useStore(handle, hiddenMachines);
  let open = false;

  const close = (): void => {
    open = false;
    void handle.update();
  };

  const captionId = `server-caption-${String(handle.id)}`;
  const reasonId = `server-reason-${String(handle.id)}`;

  return () => {
    const body = snap().data;
    const servers = body?.servers ?? [];
    const scope = where().scope;
    const current = scope.host;
    const reachableCount = servers.filter((s) => s.reachable).length;
    // Nothing to choose between, AND you are not parked somewhere you could not get back from.
    if (reachableCount <= 1 && current === undefined) return null;

    const lead = servers.find((s) => s.isLead);
    const isActive = (s: ServerSummary): boolean => (current === undefined ? s.isLead : s.id === current);
    const currentName = servers.find(isActive)?.name ?? current ?? lead?.name ?? t("connection.host.lead");

    const select = (s: ServerSummary): void => {
      close();
      // The lead carries no `?h=`: absent means the lead, so selecting it restores the bare URL.
      const target = s.isLead ? undefined : s.id;
      if (target === current) return;
      // Sideways: another machine's dashboard replaces this one, so Back never walks the machines.
      void navigate(href(homePath({ host: target, session: scope.session })), { history: "replace" });
    };

    // Only while the sheet is open: counts are a pass over every pane and health a pass over every member.
    const counts = hostCounts(open ? (body?.agents ?? []) : []);
    const health = open ? crewHealthNow() : crewHealth(undefined, 0);

    return (
      <>
        <button
          type="button"
          data-testid="server-switcher"
          aria-label={t("connection.server.aria", { name: currentName })}
          class="flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-xs font-medium text-foreground transition-colors hover:bg-accent active:scale-95"
          mix={on("click", () => {
            open = true;
            void handle.update();
          })}
        >
          <Icon icon={Server} class="size-3.5" />
          <span class="max-w-[6rem] truncate">{currentName}</span>
        </button>

        <BottomSheet open={open} onClose={close} title={t("connection.server.title")}>
          {open ? (
            <>
              {/* The switches' column caption, said once for the eye. Each switch is named by this
                  caption plus its row's machine name (`aria-labelledby`). */}
              <p id={captionId} class="pb-1 pr-1.5 text-right text-[11px] text-muted-foreground">
                {t("connection.server.show")}
              </p>
              <ul class="flex flex-col gap-1" data-testid="server-switcher-list">
                {servers.map((s) => {
                  const active = isActive(s);
                  const nameId = `server-name-${String(handle.id)}-${s.id}`;
                  const switchId = `server-switch-${String(handle.id)}-${s.id}`;
                  // The addressed machine always shows, whatever is stored, so its switch reads on
                  // and cannot be turned off.
                  const onDashboard = active || !hidden().includes(s.id);
                  const c = countsFor(counts, s.id);
                  const h = memberHealth(health, s);
                  // This sheet names machines WITHOUT a HostChip, so it carries the identity tint
                  // itself, on the glyph that already stands at the head of the row.
                  const slot = hostSlot(servers, s.id);
                  return (
                    <li key={s.id} data-host={s.id}>
                      <div class="flex items-center gap-1">
                        <button
                          type="button"
                          aria-current={active ? "true" : undefined}
                          class={cn(
                            "flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-3 py-2.5 text-left transition-colors",
                            // A 2px inset cut in --primary, not a fill (see session-switcher.tsx).
                            active ? "shadow-[inset_2px_0_0_0_var(--primary)]" : "hover:bg-accent active:bg-accent",
                            // Dimmed, not disabled: what you find there is last-known and read-only,
                            // and the row says both, but it still goes there.
                            !h.writable && "opacity-60",
                          )}
                          mix={on("click", () => select(s))}
                        >
                          <Icon
                            icon={Server}
                            class={cn("size-4 shrink-0", slot === null ? "text-muted-foreground" : HOST_TEXT_CLASSES[slot])}
                          />
                          <div class="min-w-0 flex-1">
                            <div class="flex flex-wrap items-center gap-1.5">
                              <span id={nameId} class="truncate text-sm font-medium">
                                {s.name || s.id}
                              </span>
                              {s.isLead && (
                                <span class="flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                                  <Icon icon={Crown} class="size-2.5" />
                                  {t("connection.host.lead")}
                                </span>
                              )}
                              {/* Listed, never hidden (CREW_PROTOCOL.md §10.2): a member that is down
                                  or speaking another protocol keeps its row, its counts and an honest
                                  reason. The WORD belongs to `writable`, not `state`: a stale receipt
                                  beside `reachable: true` is an old receipt, not a down machine. */}
                              {h.incompatible ? (
                                <span class="text-[11px] font-medium text-status-blocked">{t("connection.host.incompatible")}</span>
                              ) : (
                                h.state !== "live" && (
                                  <span class="text-[11px] text-muted-foreground">
                                    {h.writable ? h.lastSeenLabel : degradedLabel(h)}
                                  </span>
                                )
                              )}
                            </div>
                            {/* The peer's refusal reason, verbatim, never paraphrased. */}
                            {h.incompatible && h.protocolDetail && (
                              <p class="mt-0.5 break-words font-mono text-[10px] leading-tight text-muted-foreground">
                                {s.protocolDetail}
                              </p>
                            )}
                            {(c.blocked > 0 || c.working > 0) && (
                              <div class="mt-1 flex items-center gap-1.5">
                                {c.blocked > 0 && (
                                  <span class="rounded-md border border-status-blocked/30 bg-status-blocked/15 px-1.5 py-0.5 text-[10px] font-medium text-status-blocked">
                                    {tn("status.count.needsYou", c.blocked)}
                                  </span>
                                )}
                                {c.working > 0 && (
                                  <span class="rounded-md border border-status-working/30 bg-status-working/15 px-1.5 py-0.5 text-[10px] font-medium text-status-working">
                                    {tn("status.count.working", c.working)}
                                  </span>
                                )}
                              </div>
                            )}
                          </div>
                          {active && <Icon icon={Check} class="size-4 shrink-0 text-primary" />}
                        </button>
                        {/* Its own 44px target beside the row. The cell passes a tap on its padding to the
                            switch, so the whole 44px cell answers; the name still comes from `aria-labelledby`. */}
                        <div
                          class="flex h-11 w-14 shrink-0 cursor-pointer items-center justify-center has-[:disabled]:cursor-not-allowed"
                          mix={on("click", (event) => {
                            if (event.target === event.currentTarget) event.currentTarget.querySelector("button")?.click();
                          })}
                        >
                          <Switch
                            id={switchId}
                            checked={onDashboard}
                            disabled={active}
                            onCheckedChange={(shown) => hiddenMachines.set(nextHiddenMachines(hidden(), s.id, !shown, servers))}
                            aria-labelledby={`${captionId} ${nameId}`}
                            aria-describedby={active ? reasonId : undefined}
                          />
                        </div>
                      </div>
                      {/* Why the switch above is off-limits, under the name's own left edge: the
                          row's px-3, the 16px glyph and its gap-2.5 make 38px. */}
                      {active && (
                        <p id={reasonId} class="pb-1 pl-9.5 pr-14 text-[11px] leading-snug text-muted-foreground">
                          {t("connection.server.showLocked")}
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>

              {/* The way OUT of the switcher and into the whole picture: the census page, which
                  reports and nothing more. */}
              <button
                type="button"
                class="mt-1 flex w-full items-center gap-2.5 rounded-lg border-t border-rule px-3 py-2.5 text-left text-sm text-muted-foreground transition-colors hover:bg-accent active:bg-accent"
                mix={on("click", () => {
                  close();
                  void navigate(href(crewPath(scope)));
                })}
              >
                <Icon icon={Network} class="size-4 shrink-0" />
                {t("crew.entry.title")}
              </button>
            </>
          ) : null}
        </BottomSheet>
      </>
    );
  };
}

/**
 * The word beside a member this lead cannot write to, with its receipt age: the three readings the
 * host chip gives (lib/host-health.ts `linkPresentation`). `reconnecting` keeps the row plain on
 * purpose: the lead is retrying inside its budget and there is nothing here to do.
 */
function degradedLabel(h: HostHealth): string {
  const link = linkPresentation(true, h.linkState);
  if (link === "reconnecting") return t("connection.host.reconnectingSuffix", { label: h.lastSeenLabel });
  if (link === "attention") return t("connection.host.attentionSuffix", { label: h.lastSeenLabel });
  return t("connection.host.unreachableSuffix", { label: h.lastSeenLabel });
}
