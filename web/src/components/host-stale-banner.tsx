import { ServerOff } from "lucide-react";

import type { HostHealth } from "@/lib/host-health";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";
import { useLocale } from "@/hooks/use-locale";

// TIER 2's pane-level surface: the lead is fine, this pane's MACHINE is not.
//
// ── WHY THIS IS NOT THE CONNECTION BANNER ────────────────────────────────────
// The ConnectionBanner is tier 1 and it speaks for the whole app: it fades in amber, escalates to
// red, latches, and offers Retry/Reload — all of it measured on the one shared clock. A peer being
// down is a different fact with a different blast radius, and routing it through that banner would
// mean a phone with a perfectly live link telling the user they are offline. So this is scoped to the
// pane it belongs to, sits inside the pane frame next to the ReadOnlyBanner (the other "you can look
// but not touch" notice), and is informational rather than alarming — sky, not red: the content below
// it is real, it is just not current.
//
// ── AND WHY IT NAMES THE REFUSAL, NOT JUST THE STALENESS ─────────────────────
// "Showing last known" alone would leave the operator to discover the write ban by tapping Send. The
// composer is disabled and every handler refuses (PACK_PROTOCOL.md §10.3 — a write to a member the
// lead believes unreachable is refused BEFORE it is attempted, never queued, never retried), so the
// banner says so up front. That is ADR 0010's posture carried across a lossier link: an unsent
// message you know about beats a send whose outcome you have to guess at.
//
// ── THE ONE THING IT MUST NEVER SAY: A REFUSAL THAT WILL NOT HAPPEN ──────────
// `state === "stale"` and "this host is unreachable" are DIFFERENT FACTS (see lib/host-health.ts's
// note on the state). The first is about the age of the lead's receipt; the second is the lead's
// plain boolean, and it is the only one that refuses a write — `writeRefusal` gates on `writable`
// and nothing else. This banner used to render on `state !== "live"` alone and print
// "X is unreachable · last seen now. …replies and keys are refused until it answers." over a peer
// that was answering every request, with a composer that was accepting them: three claims, all
// false, one of them self-contradicting.
//
// So the table is now — `state` first, because the §10.2 tolerance still owns whether this surface
// speaks at all (a single missed sweep must not flash a banner), and `writable` owns WHAT it says:
//
//   state "live",    any writable   → NOTHING. Unchanged, deliberately: inside the tolerance this
//                                     surface is silent even when the lead's boolean says
//                                     unreachable — the refusal still bites, and `writeRefusal` is
//                                     what tells the operator so, at the moment they try.
//   incompatible                    → named, refusal claimed (writable is false by construction)
//   state "unknown",  writable      → one waiting sentence, no refusal claim: the lead believes this
//                                     machine is up, it just has not answered yet.
//   state "unknown", !writable      → "unreachable · never seen" + "nothing cached" — the refusal is
//                                     real, but there is no last-known screen to promise.
//   state "stale",  !writable       → "unreachable · <last seen>" + refusal — the one true case
//   state "stale",   writable       → NOTHING. The lead believes this machine is up, writes are
//                                     accepted, and the screen below arrived through that very link
//                                     (every landed forward now refreshes the receipt on the lead —
//                                     `PackRegistry.recordExchange`). A banner here would be
//                                     describing the sweep's cadence, not this pane's freshness.
export function HostStaleBanner({
  health,
  className,
}: {
  /** The pane's host health. Undefined (solo), live, or stale-but-writable renders nothing. */
  health: HostHealth | undefined;
  className?: string;
}) {
  useLocale();
  if (!health || health.state === "live") return null;
  const nothingCached = health.state === "unknown";
  // A merely-old receipt on a machine the lead still believes up is not news: writes are accepted,
  // and the screen below arrived through that same link. Say nothing rather than say something false.
  if (!health.incompatible && health.writable && !nothingCached) return null;

  const reason = health.incompatible
    ? t("connection.stale.incompatible", { name: health.name })
    : t("connection.stale.unreachable", { name: health.name, label: health.lastSeenLabel });
  // `unknown` means the lead has never had anything from this machine, so there is no last-good
  // mirror under this banner — an empty pane that SAYS it is empty, never a spinner that can't resolve.
  // The refusal sentence is spoken only when a write really would be refused (`!writable`), which is
  // exactly `writeRefusal`'s own condition — one fact, one gate, in both places.
  const detail = nothingCached
    ? t("connection.stale.nothingCached")
    : t("connection.stale.showingLastKnown");
  // The one case with nothing to refuse and nothing to show: the lead believes this machine is up
  // and simply has not heard from it yet. One sentence, in the present tense, naming neither a
  // refusal nor a machine that is down — and deliberately not "…yet. Nothing … yet.", which said the
  // same thing twice and read like two faults.
  const message =
    nothingCached && health.writable
      ? t("connection.stale.waitingFirst", { name: health.name })
      : t("connection.stale.messageTemplate", { reason, detail });

  return (
    <output
      className={cn(
        // A content notice, not viewport chrome: an inset box on the page column (the caller
        // supplies the gutter), not a full-bleed `border-b` strip. See read-only-banner.tsx.
        "flex items-start gap-2 rounded-sm border border-status-info/40 bg-status-info/15 px-4 py-2 text-xs font-medium text-status-info",
        className,
      )}
    >
      <ServerOff className="mt-px size-3.5 shrink-0" />
      <span>
        {/* The host name is operator-supplied (their `join` label) and, like every other such string
            that reaches this UI, is rendered as a text node and never as markup. */}
        {message}
        {health.incompatible && health.protocolDetail ? ` ${health.protocolDetail}` : ""}
      </span>
    </output>
  );
}
