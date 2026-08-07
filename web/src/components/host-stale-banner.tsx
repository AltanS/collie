import { ServerOff } from "lucide-react";

import type { HostHealth } from "@/lib/host-health";
import { cn } from "@/lib/utils";

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
export function HostStaleBanner({
  health,
  className,
}: {
  /** The pane's host health. Undefined (solo, or live) renders nothing. */
  health: HostHealth | undefined;
  className?: string;
}) {
  if (!health || health.state === "live") return null;

  const reason = health.incompatible
    ? `${health.name} is running an incompatible Collie`
    : `${health.name} is unreachable · ${health.lastSeenLabel}`;
  // `unknown` means the lead has never had anything from this machine, so there is no last-good
  // mirror under this banner — an empty pane that SAYS it is empty, never a spinner that can't resolve.
  const detail =
    health.state === "unknown"
      ? "Nothing cached for this machine yet."
      : "Showing the last known screen — replies and keys are refused until it answers.";

  return (
    <div
      role="status"
      className={cn(
        "flex items-start gap-2 border-b border-status-info/40 bg-status-info/15 px-4 py-2 text-xs font-medium text-status-info",
        className,
      )}
    >
      <ServerOff className="mt-px size-3.5 shrink-0" />
      <span>
        {/* The host name is operator-supplied (their `join` label) and, like every other such string
            that reaches this UI, is rendered as a text node and never as markup. */}
        {reason}. {detail}
        {health.incompatible && health.protocolDetail ? ` ${health.protocolDetail}` : ""}
      </span>
    </div>
  );
}
