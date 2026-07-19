import { Plug, WifiOff } from "lucide-react";

import { cn } from "@/lib/utils";
import { isConnecting } from "@/lib/connection";
import { useConnectionLost } from "@/hooks/use-connection-lost";
import type { BridgeStatus } from "@/lib/types";

interface ConnectionPillProps {
  online: boolean;
  bridge: BridgeStatus | undefined;
  error: boolean;
  /** A load (revalidation or navigation) has stalled mid-flight — see useLoadingStalled. Optional
   *  (defaults false) so this reads as a plain "reconnecting…" cause without a dedicated label. */
  stalled?: boolean;
}

// Quiet by default: the connection pill renders NOTHING while the data on screen is live. A healthy
// header is calm — just the mark, title, switcher/badges, and gear — with no status text at all. The
// pill appears ONLY when the connection is not live, so its mere presence means "something's off".
// The SAME pill renders in every header (dashboard, space, pane) via AppHeader, so a not-live state can
// never be shown on one screen and missing on another. Deliberately does NOT reflect the per-poll fetch
// state — it stays absent while we revalidate in the background, so it doesn't flicker on every tick.
//
// Escalation (only relevant once shown) is strictly time-driven and agrees with the galloping Collie
// mark by construction:
//   - live         (poll-truth healthy)                       → nothing (no pill)
//   - reconnecting (not live, pre-threshold)                  → Plug, warn (amber — the dog gallops)
//   - lost         (not live, past CONNECTION_LOST_MS)        → red      (the dog rests)
// `navigator.onLine` is consulted ONLY at `lost`, and ONLY to pick the copy/icon ("offline" + WifiOff
// vs "not connected" + Plug) — never to change WHEN we escalate. So a lying onLine can neither
// manufacture a not-live state nor flip the pill red before the dog stops running. This ordering is
// the fix for the old bug where !onLine short-circuited straight to red while the mark still galloped.
function resolve(online: boolean, lost: boolean) {
  if (!lost) return { label: "reconnecting…", tone: "warn", Icon: Plug } as const;
  return online
    ? ({ label: "not connected", tone: "bad", Icon: Plug } as const)
    : ({ label: "offline", tone: "bad", Icon: WifiOff } as const);
}

const TONE: Record<"warn" | "bad", string> = {
  warn: "text-status-working",
  bad: "text-status-blocked",
};

// The shared connection pill. Computes `connecting`/`lost` from the SAME poll-truth predicate and the
// SAME module-scoped connection-health store the Collie mark uses, so the pill and the mark cannot
// disagree even though they're independent renderers — that agreement is the whole point of
// lib/connection-health. Returns null while live (the quiet default); when shown it's an accessible
// live-region so a screen reader hears the outage state as it changes.
export function ConnectionPill({ online, bridge, error, stalled }: ConnectionPillProps) {
  const connecting = isConnecting({ bridge, error, stalled });
  // Same 15s wall-clock as the prominent outage banner, derived from the shared store (not a
  // per-instance timer), so the pill and the banner escalate as one across remounts and route changes.
  // Called unconditionally (before the early return) so hook order is stable and the shared latch is
  // still driven from here even on the frames where the pill itself renders nothing.
  const lost = useConnectionLost(connecting);
  // Live → the header stays calm: render no pill at all.
  if (!connecting) return null;
  const { label, tone, Icon } = resolve(online, lost);
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn("flex items-center gap-1.5 text-xs font-medium", TONE[tone])}
    >
      <Icon className="size-3.5" />
      <span>{label}</span>
    </div>
  );
}
