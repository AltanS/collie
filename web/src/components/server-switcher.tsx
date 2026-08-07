import { useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router";
import { Check, Crown, Server } from "lucide-react";

import { cn } from "@/lib/utils";
import { BottomSheet } from "@/components/ui/sheet";
import { homePath } from "@/lib/nav";
import { hostHealth } from "@/lib/host-health";
import { usePack } from "@/components/pack-provider";
import { countsFor, hostCounts } from "@/lib/hosts";
import type { Scope } from "@/lib/scope";
import type { AgentView, ServerSummary } from "@/lib/types";

interface ServerSwitcherProps {
  /** The snapshot's pack roster, lead first. Empty/one-entry on a solo install — the trigger hides. */
  servers: ServerSummary[];
  /** The scope currently being viewed. Only its host changes here; the session rides through. */
  scope: Scope;
  /**
   * The merged agent list, for per-host counts. A `ServerSummary` carries none (unlike a
   * `SessionSummary`), so they are derived from the rows actually on screen — which also means an
   * unreachable member's last-good panes still count instead of reading as an empty machine.
   */
  agents?: AgentView[];
}

// The machine switcher. Structurally the SessionSwitcher's twin — same hidden-when-single predicate,
// same portalled sheet, same disabled-and-guarded unreachable rows — and deliberately not its visual
// twin: two lookalike pills, one changing machines and one changing sessions on a machine, is a
// mis-tap into the wrong terminal (milestone constraint). This one is bordered and leads with a
// server glyph; the session pill is a filled muted capsule with layers.
//
// ── WHAT SELECTING A HOST DOES, AND WHAT IT DOESN'T ──────────────────────────
// It navigates HOME in that host (`?h=`), exactly as the session switcher does. It never tries to
// map the pane you are looking at onto the other machine: `w1:p1` there is a different terminal, and
// carrying the id across would be the single mistake this whole milestone exists to prevent.
//
// ── AND WHAT IT IS NOT ───────────────────────────────────────────────────────
// Not pack administration. It lists members and lets you go to one; join / leave / promote / rotate
// are CLI verbs, and an unreachable row gets no "reconnect" button — the lead is already retrying on
// its own poll, and a button that only looks like it helps is worse than none.
export function ServerSwitcher({ servers, scope, agents = [] }: ServerSwitcherProps) {
  const current = scope.host;
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  // TIER-2 health, already derived once at the data root against the LEAD's clock (the only clock
  // `lastSeenAt` is comparable to — lib/host-health.ts). Mounted outside a provider (this component's
  // own unit tests), the fallback re-derives with no clock at all, which skips §10.2's tolerance and
  // presents the lead's plain boolean — the same answer this sheet gave before the threshold existed.
  const { health } = usePack();

  const reachableCount = servers.filter((s) => s.reachable).length;
  const onPeer = current !== undefined;
  // Same two clauses as SessionSwitcher: nothing to choose between, AND you are not parked somewhere
  // you would otherwise have no way back from.
  if (reachableCount <= 1 && !onPeer) return null;

  const lead = servers.find((s) => s.isLead);
  const isActive = (s: ServerSummary): boolean => (current === undefined ? s.isLead : s.id === current);
  const currentName = servers.find(isActive)?.name ?? current ?? lead?.name ?? "lead";
  const counts = hostCounts(agents);

  function select(s: ServerSummary): void {
    setOpen(false);
    if (!s.reachable) return; // unreachable rows are disabled; guard the handler anyway
    // The lead carries no `?h=` — absent means the lead, so selecting it restores today's bare URL.
    const target = s.isLead ? undefined : s.id;
    if (target === current) return;
    navigate(homePath({ host: target, session: scope.session }));
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`Host: ${currentName}. Switch host`}
        className="flex shrink-0 items-center gap-1 rounded-full border border-border px-2 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted/60 active:scale-95"
      >
        <Server className="size-3.5" />
        <span className="max-w-[6rem] truncate">{currentName}</span>
      </button>

      {/* Portalled for the same reason as the session sheet: a backdrop-filter on the header would
          become the containing block and clip a `fixed inset-0` sheet to the header band. */}
      {createPortal(
        <BottomSheet open={open} onClose={() => setOpen(false)} title="Machines">
          <ul className="flex flex-col gap-1">
            {servers.map((s) => {
              const active = isActive(s);
              const c = countsFor(counts, s.id);
              const h = health.get(s.id) ?? hostHealth(s, { at: 0, pollMs: 0 });
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    disabled={!h.writable}
                    onClick={() => select(s)}
                    aria-current={active ? "true" : undefined}
                    className={cn(
                      "flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left transition-colors",
                      active
                        ? "bg-accent text-accent-foreground"
                        : "hover:bg-muted/60 active:bg-muted",
                      !h.writable && "cursor-not-allowed opacity-60 hover:bg-transparent",
                    )}
                  >
                    <Server className="size-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="truncate text-sm font-medium">{s.name || s.id}</span>
                        {s.isLead && (
                          <span className="flex items-center gap-1 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                            <Crown className="size-2.5" aria-hidden />
                            lead
                          </span>
                        )}
                        {/* Listed, never hidden (PACK_PROTOCOL.md §10.2): a member that is down or
                            speaking another protocol keeps its row, its counts and an honest reason.
                            A vanished machine reads as "I have no agents there", which is a lie. */}
                        {h.incompatible ? (
                          <span className="text-[11px] font-medium text-status-blocked">
                            incompatible
                          </span>
                        ) : (
                          h.state !== "live" && (
                            <span className="text-[11px] text-muted-foreground">
                              {/* Presented-stale, not merely "the last poll missed" (§10.2): below the
                                  tolerance a dropped sweep is invisible here, so a healthy member
                                  can't flash "unreachable" between two good polls. The age is the
                                  LEAD's receipt time measured on the LEAD's clock, and 0 means it has
                                  never answered at all — which "0s ago" would misreport as just-now. */}
                              {`unreachable · ${h.lastSeenLabel}`}
                            </span>
                          )
                        )}
                      </div>
                      {/* The peer's refusal reason, verbatim — never paraphrased, because the
                          operator's next move is to read it and go fix a version somewhere. */}
                      {h.incompatible && h.protocolDetail && (
                        <p className="mt-0.5 break-words font-mono text-[10px] leading-tight text-muted-foreground">
                          {s.protocolDetail}
                        </p>
                      )}
                      {(c.blocked > 0 || c.working > 0) && (
                        <div className="mt-1 flex items-center gap-1.5">
                          {c.blocked > 0 && (
                            <span className="rounded-full border border-status-blocked/30 bg-status-blocked/15 px-1.5 py-0.5 text-[10px] font-medium text-status-blocked">
                              {c.blocked} needs you
                            </span>
                          )}
                          {c.working > 0 && (
                            <span className="rounded-full border border-status-working/30 bg-status-working/15 px-1.5 py-0.5 text-[10px] font-medium text-status-working">
                              {c.working} working
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
