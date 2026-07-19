import { useCallback, useEffect, useRef, useState } from "react";
import { useRevalidator } from "react-router";
import { CheckCircle2, Loader2, Plug, RefreshCw, RotateCw, TriangleAlert, WifiOff } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useConnectionLost, useConnectionTrouble } from "@/hooks/use-connection-lost";
import { useLoadingStalled } from "@/hooks/use-loading-stalled";
import { useOnline } from "@/hooks/use-online";
import { isConnecting } from "@/lib/connection";
import * as api from "@/lib/api";
import type { BridgeStatus } from "@/lib/types";

interface ConnectionBannerProps {
  /** Herdr link from the last snapshot (undefined before the first successful poll). */
  bridge: BridgeStatus | undefined;
  /** The last snapshot fetch failed (stale data on screen). */
  error: boolean;
}

// The result of the /api/config probe (which never touches Herdr): "unknown" until it resolves,
// "reachable" = the bridge answered (so the herd link is what's down), "unreachable" = the bridge
// itself couldn't be reached. Only ever run while RED, to name the cause.
type Probe = "unknown" | "reachable" | "unreachable";

// The three color-coded states, plus null = nothing. green = established, amber = checking, red = failed.
type Tone = "amber" | "red" | "green";

// How long the "Connected" confirmation lingers after a visible bar recovers, then it exits.
export const GREEN_MS = 1_800;
// The collapse/fade before the row unmounts — matches the CSS transition duration below so the DOM
// node lives exactly as long as the exit animation (standard delayed-unmount).
export const EXIT_MS = 200;

// The ONE connection surface: a single, thin, animated bar mounted once in RootLayout (in-flow above
// the route, a sibling of UpdateAvailableBanner) that is the app's entire connection UI — the header
// pill is gone. It fades in only on SUSTAINED trouble, escalates from amber → red on a real outage,
// flashes green on recovery, and otherwise renders nothing. It reads the SAME two shared-clock signals
// the header dog does (useConnectionTrouble at 4s, useConnectionLost at 15s), so bar and dog can never
// disagree; `connecting` is poll-truth (isConnecting) — navigator.onLine is COPY-only (it picks the
// red cause), never a gate. Threshold lockstep with the shared clock is proven in use-connection-lost;
// here we own the amber→red→green state machine and the smooth mount/unmount.
export function ConnectionBanner({ bridge, error }: ConnectionBannerProps) {
  const stalled = useLoadingStalled();
  const connecting = isConnecting({ bridge, error, stalled });
  const trouble = useConnectionTrouble(connecting);
  const lost = useConnectionLost(connecting);

  // What the live signals want on screen right now — red wins over amber; null = healthy (or a blip
  // that never reached trouble). Green is NOT derived here: it's a timed confirmation the state machine
  // adds only when a VISIBLE bar recovers, so it can't come from the instantaneous signals.
  const activeTone: Exclude<Tone, "green"> | null = lost ? "red" : trouble ? "amber" : null;

  // The rendered tone. Adds the recovery "connected" flash on top of the live signals.
  const [tone, setTone] = useState<Tone | null>(null);
  // Has an amber/red bar actually been shown since the last time we went hidden? Gates the green flash
  // so a sub-trouble blip (which never showed a bar) recovers silently.
  const shownBar = useRef(false);

  useEffect(() => {
    if (activeTone) {
      shownBar.current = true;
      setTone(activeTone);
      return;
    }
    // activeTone === null → recovered, or never troubled.
    if (!shownBar.current) {
      setTone(null); // a blip that never showed a bar → show nothing.
      return;
    }
    // Recovery FROM a visible bar → a brief green "connected", then hide.
    shownBar.current = false;
    setTone("green");
    const id = window.setTimeout(() => setTone(null), GREEN_MS);
    return () => clearTimeout(id);
  }, [activeTone]);

  // Delayed-unmount + enter/exit animation. `present` = there's a tone to show; we keep the row
  // rendered through the collapse so it animates OUT, then unmount. `open` drives the expanded class,
  // flipped one tick AFTER mount so the browser transitions from the collapsed initial state in.
  const present = tone !== null;
  const [rendered, setRendered] = useState(present);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (present) {
      setRendered(true);
      const id = window.setTimeout(() => setOpen(true), 0);
      return () => clearTimeout(id);
    }
    setOpen(false);
    const id = window.setTimeout(() => setRendered(false), EXIT_MS);
    return () => clearTimeout(id);
  }, [present]);

  // The last real tone, held so the row keeps its copy/tint while collapsing after `tone` → null.
  const shownToneRef = useRef<Tone>("amber");
  if (tone) shownToneRef.current = tone;
  const shownTone = shownToneRef.current;

  // Probe /api/config only while RED, to tell "bridge unreachable" from "bridge up, Herdr down". Amber
  // (ambient) and green (a success flash) never probe. Reset when we leave red so a later outage re-probes.
  const online = useOnline();
  const revalidator = useRevalidator();
  const [probe, setProbe] = useState<Probe>("unknown");
  const [retrying, setRetrying] = useState(false);

  const runProbe = useCallback(async () => {
    try {
      await api.fetchConfig();
      setProbe("reachable");
    } catch {
      setProbe("unreachable");
    }
  }, []);

  useEffect(() => {
    if (!lost) {
      setProbe("unknown");
      return;
    }
    void runProbe();
  }, [lost, runProbe]);

  if (!rendered) return null;

  // Recovery (a successful poll) flips the signals → tone → hidden on its own, no reload. Retry just
  // nudges that along: revalidate the snapshot and re-run the probe.
  async function onRetry() {
    setRetrying(true);
    revalidator.revalidate();
    await runProbe();
    setRetrying(false);
  }

  const view = resolveView(shownTone, online, probe);

  return (
    // Outer grid collapses 0fr → 1fr (an in-flow height animation the layout below rides), fading with
    // opacity; the inner wrapper clips the content while it's collapsed. Snaps under reduced motion.
    <div
      className={cn(
        "grid shrink-0 overflow-hidden transition-all duration-200 ease-out motion-reduce:transition-none",
        open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
      )}
    >
      <div className="min-h-0 overflow-hidden">
        <div
          // Red is an actionable error (assertive alert); amber/green are ambient status.
          role={shownTone === "red" ? "alert" : "status"}
          aria-live="polite"
          className={cn(
            // Thin single row: text-xs, tight padding, safe-area top inset, never wraps.
            "flex items-center gap-2 border-b px-4 py-1 text-xs [padding-top:calc(env(safe-area-inset-top)_+_0.25rem)]",
            view.row,
          )}
        >
          <view.Icon className={cn("size-3.5 shrink-0", view.icon)} />
          {/* One truncating, flex-1 span — the row can never wrap to a second line, whatever the copy. */}
          <span className="min-w-0 flex-1 truncate font-medium text-foreground">{view.copy}</span>
          {/* Actions only in red — amber is ambient (no buttons), green is a passing confirmation. */}
          {shownTone === "red" && (
            <>
              <Button
                size="sm"
                className="h-6 gap-1 px-2 text-xs"
                onClick={onRetry}
                disabled={retrying}
              >
                {retrying ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <RotateCw className="size-3.5" />
                )}
                Retry
              </Button>
              <Button
                size="icon"
                variant="ghost"
                aria-label="Reload"
                className="size-6 text-muted-foreground"
                onClick={() => window.location.reload()}
              >
                <RefreshCw className="size-3.5" />
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// Copy + tint + icon per tone. Green/amber are fixed; red names the cause — the bridge answering means
// Herdr is the outage, otherwise onLine decides between a true offline drop and an unreachable Collie.
function resolveView(tone: Tone, online: boolean, probe: Probe) {
  if (tone === "green") {
    return { copy: "Connected", Icon: CheckCircle2, row: TINT.done.row, icon: TINT.done.icon } as const;
  }
  if (tone === "amber") {
    // Static Plug (no spinner) — the galloping dog carries the motion, and a spinner would fight
    // prefers-reduced-motion. Ambient by design.
    return { copy: "Reconnecting…", Icon: Plug, row: TINT.working.row, icon: TINT.working.icon } as const;
  }
  const cause =
    probe === "reachable"
      ? { copy: "Herdr is down on the host", Icon: TriangleAlert }
      : probe === "unreachable" && !online
        ? { copy: "Offline — can't reach Collie", Icon: WifiOff }
        : { copy: "Can't reach Collie", Icon: TriangleAlert };
  return { copy: cause.copy, Icon: cause.Icon, row: TINT.blocked.row, icon: TINT.blocked.icon } as const;
}

const TINT = {
  done: { row: "border-status-done/40 bg-status-done/15", icon: "text-status-done" },
  working: { row: "border-status-working/40 bg-status-working/15", icon: "text-status-working" },
  blocked: { row: "border-status-blocked/40 bg-status-blocked/15", icon: "text-status-blocked" },
} as const;
