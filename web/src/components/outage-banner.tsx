import { useCallback, useEffect, useState } from "react";
import { useRevalidator } from "react-router";
import { Loader2, RefreshCw, RotateCw, TriangleAlert, WifiOff } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useConnectionLost } from "@/hooks/use-connection-lost";
import { useLoadingStalled } from "@/hooks/use-loading-stalled";
import { useOnline } from "@/hooks/use-online";
import { isConnecting } from "@/lib/connection";
import * as api from "@/lib/api";
import type { BridgeStatus } from "@/lib/types";

interface OutageBannerProps {
  /** Herdr link from the last snapshot (undefined before the first successful poll). */
  bridge: BridgeStatus | undefined;
  /** The last snapshot fetch failed (stale data on screen). */
  error: boolean;
}

// The result of the /api/config probe (which never touches Herdr): "unknown" until it resolves,
// "reachable" = the bridge answered (so the herd link is what's down), "unreachable" = the bridge
// itself couldn't be reached.
type Probe = "unknown" | "reachable" | "unreachable";

// One crisp, single-row outage banner — the sole escalation above the quiet header pill, replacing the
// two independently-styled rows (OfflineBanner + ConnectionLostPrompt) that showed at visibly
// different heights. It surfaces ONLY once useConnectionLost fires (the app has been not-live for
// CONNECTION_LOST_MS straight); below that threshold the header pill ("reconnecting…") is the only
// signal. `connecting` is the poll-truth isConnecting — NO navigator.onLine gate anywhere, so a lying
// onLine flag can never raise (or, having recovered, keep) this banner while polls succeed.
//
// It's an in-flow row (a sibling of UpdateAvailableBanner in RootLayout's flex column), so it reserves
// real layout space above each route's sticky header instead of overlaying it, and owns the safe-area
// inset. Every cause renders the SAME fixed-height, non-wrapping row — only the icon, copy, and tint
// vary — so the top of the app never jumps between causes.
export function OutageBanner({ bridge, error }: OutageBannerProps) {
  const stalled = useLoadingStalled();
  const connecting = isConnecting({ bridge, error, stalled });
  const show = useConnectionLost(connecting);

  // onLine is COPY-only here — it picks between "truly offline" and "can't reach Collie" when the
  // probe fails; it never gates whether the banner shows.
  const online = useOnline();
  const revalidator = useRevalidator();
  const [probe, setProbe] = useState<Probe>("unknown");
  const [retrying, setRetrying] = useState(false);

  // Probe /api/config (read-only, never touches Herdr) to tell "bridge unreachable" from "bridge up,
  // Herdr down": if the bridge answers, the outage is the herd link, not the bridge itself.
  const runProbe = useCallback(async () => {
    try {
      await api.fetchConfig();
      setProbe("reachable");
    } catch {
      setProbe("unreachable");
    }
  }, []);

  // Probe once when the banner appears; reset when it dismisses so a later outage re-probes fresh.
  useEffect(() => {
    if (!show) {
      setProbe("unknown");
      return;
    }
    void runProbe();
  }, [show, runProbe]);

  if (!show) return null;

  // Recovery (a successful poll) flips `connecting` false → `show` false → this unmounts on its own,
  // no reload. Retry just nudges that along: revalidate the snapshot and re-run the probe.
  async function onRetry() {
    setRetrying(true); // immediate feedback — the button spins while we re-check
    revalidator.revalidate();
    await runProbe();
    setRetrying(false);
  }

  // Copy + tint per cause. The bridge answering means Herdr is the outage; otherwise onLine decides
  // whether to call it a true offline drop or just an unreachable Collie. Same row either way.
  const cause =
    probe === "reachable"
      ? { copy: "Herdr is down on the host", tint: "working" as const, Icon: TriangleAlert }
      : probe === "unreachable" && !online
        ? { copy: "Offline — can't reach Collie", tint: "blocked" as const, Icon: WifiOff }
        : { copy: "Can't reach Collie", tint: "working" as const, Icon: TriangleAlert };

  const tint = TINT[cause.tint];

  return (
    <div
      role="alert"
      className={cn(
        "flex shrink-0 items-center gap-2 border-b px-4 py-1.5 text-xs [padding-top:calc(env(safe-area-inset-top)_+_0.375rem)]",
        tint.row,
      )}
    >
      <cause.Icon className={cn("size-3.5 shrink-0", tint.icon)} />
      {/* One truncating, flex-1 span — the row can never wrap to a second line, whatever the copy. */}
      <span className="min-w-0 flex-1 truncate font-medium text-foreground">{cause.copy}</span>
      <Button
        size="sm"
        className="h-7 gap-1 px-2.5 text-xs"
        onClick={onRetry}
        disabled={retrying}
      >
        {retrying ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCw className="size-3.5" />}
        Retry
      </Button>
      {/* Reload is the full escape hatch — icon-only ghost so the row stays compact. */}
      <Button
        size="icon"
        variant="ghost"
        aria-label="Reload"
        className="size-7 text-muted-foreground"
        onClick={() => window.location.reload()}
      >
        <RefreshCw className="size-3.5" />
      </Button>
    </div>
  );
}

const TINT = {
  working: { row: "border-status-working/40 bg-status-working/15", icon: "text-status-working" },
  blocked: { row: "border-status-blocked/40 bg-status-blocked/15", icon: "text-status-blocked" },
} as const;
