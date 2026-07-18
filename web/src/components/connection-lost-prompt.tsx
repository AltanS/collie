import { useCallback, useEffect, useState } from "react";
import { useRevalidator } from "react-router";
import { Loader2, RotateCw, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useConnectionLost } from "@/hooks/use-connection-lost";
import { useLoadingStalled } from "@/hooks/use-loading-stalled";
import { useOnline } from "@/hooks/use-online";
import { isConnecting } from "@/lib/connection";
import * as api from "@/lib/api";
import type { BridgeStatus } from "@/lib/types";

interface ConnectionLostPromptProps {
  /** Herdr link from the last snapshot (undefined before the first successful poll). */
  bridge: BridgeStatus | undefined;
  /** The last snapshot fetch failed (stale data on screen). */
  error: boolean;
}

// What kind of outage we're looking at — decides the copy. "unknown" until the /api/config probe
// (which never touches Herdr) resolves; "bridge" = the bridge itself is unreachable; "herdr" = the
// bridge answered but the Herdr link is down.
type Mode = "unknown" | "bridge" | "herdr";

const COPY: Record<Mode, string> = {
  unknown: "Can't reach Collie — check your connection.",
  bridge: "Can't reach the Collie bridge.",
  herdr: "Herdr appears to be down on the host.",
};

// Escalation past the quiet header pill: when the app has been unreachable for CONNECTION_LOST_MS
// straight, this surfaces a prominent (but non-blocking) prompt so a phone left on a stale screen
// isn't silently showing dead data. It's an in-flow row — a sibling of OfflineBanner in RootLayout's
// flex column — so the stale herd stays visible and interactable underneath. Gated on being ONLINE:
// a real offline drop is OfflineBanner's job, and the two must never show together.
export function ConnectionLostPrompt({ bridge, error }: ConnectionLostPromptProps) {
  const online = useOnline();
  const stalled = useLoadingStalled();
  const connecting = isConnecting({ online, bridge, error, stalled });
  const lost = useConnectionLost(connecting);
  const show = online && lost;

  const revalidator = useRevalidator();
  const [mode, setMode] = useState<Mode>("unknown");
  const [retrying, setRetrying] = useState(false);

  // Probe /api/config (read-only, never touches Herdr) to tell "bridge unreachable" from "bridge up,
  // Herdr down": if the bridge answers, the outage is the herd link, not the bridge itself.
  const probe = useCallback(async () => {
    try {
      await api.fetchConfig();
      setMode("herdr");
    } catch {
      setMode("bridge");
    }
  }, []);

  // Probe once when the prompt appears; reset when it dismisses so a later outage re-probes fresh.
  useEffect(() => {
    if (!show) {
      setMode("unknown");
      return;
    }
    void probe();
  }, [show, probe]);

  if (!show) return null;

  async function onRetry() {
    setRetrying(true); // immediate feedback — the button spins while we re-check
    revalidator.revalidate();
    await probe();
    setRetrying(false);
    // A successful revalidation flips `connecting` false → `lost` false → this unmounts on its own.
  }

  return (
    <div
      role="alert"
      className="flex shrink-0 flex-wrap items-center justify-center gap-x-3 gap-y-2 border-b border-status-working/40 bg-status-working/15 px-4 py-2.5 text-sm [padding-top:calc(env(safe-area-inset-top)_+_0.625rem)]"
    >
      <div className="flex min-w-0 items-center gap-2">
        <TriangleAlert className="size-4 shrink-0 text-status-working" />
        <span className="font-medium text-foreground">{COPY[mode]}</span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button size="sm" className="h-8 gap-1.5" onClick={onRetry} disabled={retrying}>
          {retrying ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCw className="size-3.5" />}
          Retry
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-8 text-muted-foreground"
          onClick={() => window.location.reload()}
        >
          Reload
        </Button>
      </div>
    </div>
  );
}
