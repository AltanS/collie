import { Plug, PlugZap, WifiOff } from "lucide-react";

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

// One-line truth about whether the data on screen is live. The SAME pill renders in every header
// (dashboard, space, pane) via AppHeader, so the connection status can never be present on one
// screen and missing on another. Deliberately does NOT reflect the per-poll fetch state — "live"
// stays put while we revalidate in the background, so the indicator doesn't flicker on every tick.
//
// Escalation is strictly time-driven and agrees with the galloping Collie mark by construction:
//   - live         (poll-truth healthy)                       → PlugZap, ok
//   - reconnecting (not live, pre-threshold)                  → Plug,    warn (amber — the dog gallops)
//   - lost         (not live, past CONNECTION_LOST_MS)        → red      (the dog rests)
// `navigator.onLine` is consulted ONLY at `lost`, and ONLY to pick the copy/icon ("offline" + WifiOff
// vs "not connected" + Plug) — never to change WHEN we escalate. So a lying onLine can neither
// manufacture a not-live state nor flip the pill red before the dog stops running. This ordering is
// the fix for the old bug where !onLine short-circuited straight to red while the mark still galloped.
function resolve(online: boolean, connecting: boolean, lost: boolean) {
  if (!connecting) return { label: "live", tone: "ok", Icon: PlugZap } as const;
  if (!lost) return { label: "reconnecting…", tone: "warn", Icon: Plug } as const;
  return online
    ? ({ label: "not connected", tone: "bad", Icon: Plug } as const)
    : ({ label: "offline", tone: "bad", Icon: WifiOff } as const);
}

const TONE: Record<"ok" | "warn" | "bad", string> = {
  ok: "text-status-done",
  warn: "text-status-working",
  bad: "text-status-blocked",
};

// The shared connection pill. Computes `connecting`/`lost` from the SAME poll-truth predicate and the
// SAME module-scoped connection-health store the Collie mark uses, so the pill and the mark cannot
// disagree even though they're independent renderers — that agreement is the whole point of
// lib/connection-health.
export function ConnectionPill({ online, bridge, error, stalled }: ConnectionPillProps) {
  const connecting = isConnecting({ bridge, error, stalled });
  // Same 15s wall-clock as the prominent outage banner, derived from the shared store (not a
  // per-instance timer), so the pill and the banner escalate as one across remounts and route changes.
  const lost = useConnectionLost(connecting);
  const { label, tone, Icon } = resolve(online, connecting, lost);
  return (
    <div className={cn("flex items-center gap-1.5 text-xs font-medium", TONE[tone])}>
      <Icon className="size-3.5" />
      <span>{label}</span>
    </div>
  );
}
