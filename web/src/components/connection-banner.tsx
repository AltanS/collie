import { useCallback, useEffect, useRef, useState } from "react";
import { useRevalidator } from "react-router";
import {
  CheckCircle2,
  Loader2,
  LogIn,
  Plug,
  RefreshCw,
  RotateCw,
  TriangleAlert,
  WifiOff,
} from "lucide-react";

import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { PROXY_AUTH_PATH } from "@/lib/sw-routes";
import { useConnectionLost, useConnectionTrouble } from "@/hooks/use-connection-lost";
import { useLoadingStalled } from "@/hooks/use-loading-stalled";
import { useOnline } from "@/hooks/use-online";
import { isConnecting } from "@/lib/connection";
import { clockTime } from "@/lib/format";
import * as api from "@/lib/api";
import type { BridgeStatus } from "@/lib/types";

interface ConnectionBannerProps {
  /** Herdr link from the last snapshot (undefined before the first successful poll). */
  bridge: BridgeStatus | undefined;
  /** The last snapshot fetch failed (stale data on screen). */
  error: boolean;
  /** The failed snapshot request was rejected with HTTP 401 or 403. */
  authError: boolean;
  /**
   * When the data on screen was last actually fetched, if it can be dated (lib/last-seen.ts). Shown in
   * the RED copy only, where it is the fact the operator most needs: a cold boot with no network
   * re-renders the herd from cache, and an undated old screen is indistinguishable from a live one.
   */
  lastSeenAt?: number;
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
export function ConnectionBanner({ bridge, error, authError, lastSeenAt }: ConnectionBannerProps) {
  if (authError) return <AuthErrorBanner />;
  return <ConnectionStateBanner bridge={bridge} error={error} lastSeenAt={lastSeenAt} />;
}

// A refusal is not an outage, so it gets its own surface ahead of the connection state machine: no
// probe, no reconnect spinner, no escalation clock. The copy stays deliberately non-specific about
// the cause. The flag covers 401 and 403 alike, and a 403 can equally mean "this device is not
// allowlisted", "host not allowed" or "cross-origin rejected", so naming any one of them would be
// wrong more often than right. What the operator needs here is the one fact the old behaviour hid:
// this is not the network.
//
// Reload alone is NOT enough to reach a fronting proxy, which is what this banner used to claim. In
// an installed PWA the service worker answers every navigation it owns — a reload included — from
// the precached app shell, so a reload re-renders the same refused UI and never touches the proxy.
// "Sign in" is the escape: a real navigation to the one path the SW always passes to the network
// (lib/sw-routes). An <a>, not a button, so it is an ordinary navigation the SW sees as such — and
// so it still works if React is wedged. Reload stays alongside it, since a merely stale session on
// an already-signed-in device recovers without leaving the app.
function AuthErrorBanner() {
  return (
    <div className="grid shrink-0 grid-rows-[1fr] overflow-hidden opacity-100">
      <div className="min-h-0 overflow-hidden">
        <div
          role="alert"
          aria-live="polite"
          className={cn(
            "flex items-center gap-2 border-b px-4 py-1 text-xs [padding-top:calc(env(safe-area-inset-top)_+_0.25rem)]",
            TINT.blocked.row,
          )}
        >
          <TriangleAlert className={cn("size-3.5 shrink-0", TINT.blocked.icon)} />
          <span className="min-w-0 flex-1 truncate font-medium text-foreground">
            Access refused. This is not a connection problem.
          </span>
          <a
            href={PROXY_AUTH_PATH}
            className={cn(
              buttonVariants({ size: "sm" }),
              "h-6 gap-1 px-2 text-xs no-underline",
            )}
          >
            <LogIn className="size-3.5" />
            Sign in
          </a>
          <Button
            size="icon"
            variant="ghost"
            aria-label="Reload"
            className="size-6 text-muted-foreground"
            onClick={() => window.location.reload()}
          >
            <RefreshCw className="size-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}

function ConnectionStateBanner({
  bridge,
  error,
  lastSeenAt,
}: Omit<ConnectionBannerProps, "authError">) {
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

  const view = resolveView(shownTone, online, probe, lastSeenAt);

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
//
// Red also DATES what's on screen when it can ("… — last seen 14:32"). That matters most in the case
// this whole path exists for: a PWA the browser discarded, reopened with the tunnel still down, has a
// full herd on screen rendered from cache. Without the stamp it looks live. The cause wording is kept
// rather than replaced by a flat "Disconnected", because "Herdr is down on the host" is a different
// (and more actionable) fact than "we can't reach Collie", and both can be undated or dated.
function resolveView(tone: Tone, online: boolean, probe: Probe, lastSeenAt?: number) {
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
  const copy =
    lastSeenAt === undefined ? cause.copy : `${cause.copy} — last seen ${clockTime(lastSeenAt)}`;
  return { copy, Icon: cause.Icon, row: TINT.blocked.row, icon: TINT.blocked.icon } as const;
}

const TINT = {
  done: { row: "border-status-done/40 bg-status-done/15", icon: "text-status-done" },
  working: { row: "border-status-working/40 bg-status-working/15", icon: "text-status-working" },
  blocked: { row: "border-status-blocked/40 bg-status-blocked/15", icon: "text-status-blocked" },
} as const;
