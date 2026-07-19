import { Plug, PlugZap, Settings, WifiOff } from "lucide-react";
import { useNavigate } from "react-router";

import { cn } from "@/lib/utils";
import { isConnecting } from "@/lib/connection";
import { useConnectionLost } from "@/hooks/use-connection-lost";
import { settingsPath } from "@/lib/nav";
import { CollieHome } from "@/components/collie-home";
import { SessionSwitcher } from "@/components/session-switcher";
import type { BridgeStatus, SessionSummary } from "@/lib/types";

interface ConnectionBarProps {
  online: boolean;
  bridge: BridgeStatus | undefined;
  error: boolean;
  /** A load (revalidation or navigation) has stalled mid-flight — see useLoadingStalled. Optional
   *  (defaults false) so this reads as a plain "reconnecting…" cause without a dedicated label. */
  stalled?: boolean;
  /** Tapping the Collie wordmark returns to the dashboard. A callback, not a `<Link to="/">`: the
   *  dashboard and the drilled-in space view share the "/" route (drill-in is local state), so a
   *  same-route link would no-op while drilled in — the home route owns the reset. */
  onHome?: () => void;
  /** The bridge's session registry — drives the switcher trigger (which self-hides on one session). */
  sessions?: SessionSummary[];
  /** The current session name (undefined = primary). */
  session?: string;
  /** Show the session switcher. Dashboard-only — hidden when drilled into a space so the in-space
   *  header stays uncluttered (you switch sessions from home). Defaults to shown. */
  showSessionSwitcher?: boolean;
}

// One-line truth about whether the data on screen is live, and why not if it isn't. Deliberately
// does NOT reflect the per-poll fetch state — "live" stays put while we revalidate in the
// background, so the indicator doesn't flicker between states on every tick. `lost` = the reconnect
// has run past CONNECTION_LOST_MS (the same threshold that raises the prominent prompt), which
// escalates the transient "reconnecting…" to an honest "not connected".
function resolve(props: ConnectionBarProps, lost: boolean) {
  const { online, bridge, error, stalled } = props;
  // `isConnecting` is the single source of truth for live-vs-not (shared with the in-pane loader);
  // resolve only picks which message/icon to show for the not-live cause.
  if (!isConnecting(props)) return { label: "live", tone: "ok", Icon: PlugZap } as const;
  if (!online) return { label: "offline", tone: "bad", Icon: WifiOff } as const;
  // A stall reads as "reconnecting…" too — same warn label, no new state: a fetch that hasn't
  // settled is, from the user's seat, indistinguishable from a reconnect in progress. Once it has
  // dragged on past the threshold, though, stop implying it's still trying — call it what it is.
  if (error || bridge === undefined || stalled) {
    return lost
      ? ({ label: "not connected", tone: "bad", Icon: Plug } as const)
      : ({ label: "reconnecting…", tone: "warn", Icon: Plug } as const);
  }
  return { label: "Herdr offline", tone: "warn", Icon: Plug } as const;
}

const TONE: Record<"ok" | "warn" | "bad", string> = {
  ok: "text-status-done",
  warn: "text-status-working",
  bad: "text-status-blocked",
};

export function ConnectionBar(props: ConnectionBarProps) {
  const connecting = isConnecting(props);
  // Same 15s wall-clock as the prominent prompt, so the pill and the prompt agree on when a blip has
  // become a real outage. Self-contained here (the pill renders inside each route header, not under
  // RootLayout) — worst case a route change during an outage restarts its clock; the prompt, which
  // lives in the persistent RootLayout, is the stable escalation.
  const lost = useConnectionLost(connecting);
  const { label, tone, Icon } = resolve(props, lost);
  const navigate = useNavigate();
  // The Collie mark doubles as the connection loader: it gallops while we're not yet live —
  // connecting, reconnecting, or offline — and rests once the data on screen is live. The same
  // CollieHome renders inside a pane, so the top-left mark means the same thing on every screen.
  return (
    <header className="sticky top-0 z-20 flex items-center justify-between border-b border-border/60 bg-zinc-800 px-4 py-2 [padding-top:calc(env(safe-area-inset-top)_+_0.5rem)]">
      <CollieHome onHome={props.onHome} connecting={connecting} lost={lost} wordmark />
      <div className="flex items-center gap-3">
        {/* Session switcher — dashboard-only (hidden when drilled into a space). Also self-hides
            unless there's more than one reachable session (or you're on a non-primary one), so a
            single-session install sees no change here. */}
        {props.showSessionSwitcher !== false && (
          <SessionSwitcher sessions={props.sessions ?? []} current={props.session} />
        )}
        <div className={cn("flex items-center gap-1.5 text-xs font-medium", TONE[tone])}>
          <Icon className="size-3.5" />
          <span>{label}</span>
        </div>
        {/* Settings gear. */}
        <button
          type="button"
          onClick={() => navigate(settingsPath(props.session))}
          aria-label="Settings"
          className="text-muted-foreground transition-colors hover:text-foreground"
        >
          <Settings className="size-5" />
        </button>
      </div>
    </header>
  );
}
