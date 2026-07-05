import { Plug, PlugZap, Settings, WifiOff } from "lucide-react";
import { Link } from "react-router";

import { cn } from "@/lib/utils";
import { markNavDirection } from "@/lib/view-transition";
import { isConnecting } from "@/lib/connection";
import { CollieHome } from "@/components/collie-home";
import type { BridgeStatus } from "@/lib/types";

interface ConnectionBarProps {
  online: boolean;
  bridge: BridgeStatus | undefined;
  error: boolean;
  /** Tapping the Collie wordmark returns to the dashboard. A callback, not a `<Link to="/">`: the
   *  dashboard and the drilled-in space view share the "/" route (drill-in is local state), so a
   *  same-route link would no-op while drilled in — the home route owns the reset. */
  onHome?: () => void;
}

// One-line truth about whether the data on screen is live, and why not if it isn't. Deliberately
// does NOT reflect the per-poll fetch state — "live" stays put while we revalidate in the
// background, so the indicator doesn't flicker between states on every tick.
function resolve(props: ConnectionBarProps) {
  const { online, bridge, error } = props;
  // `isConnecting` is the single source of truth for live-vs-not (shared with the in-pane loader);
  // resolve only picks which message/icon to show for the not-live cause.
  if (!isConnecting(props)) return { label: "live", tone: "ok", Icon: PlugZap } as const;
  if (!online) return { label: "offline", tone: "bad", Icon: WifiOff } as const;
  if (error || bridge === undefined) return { label: "reconnecting…", tone: "warn", Icon: Plug } as const;
  return { label: "Herdr offline", tone: "warn", Icon: Plug } as const;
}

const TONE: Record<"ok" | "warn" | "bad", string> = {
  ok: "text-status-done",
  warn: "text-status-working",
  bad: "text-status-blocked",
};

export function ConnectionBar(props: ConnectionBarProps) {
  const { label, tone, Icon } = resolve(props);
  // The Collie mark doubles as the connection loader: it gallops while we're not yet live —
  // connecting, reconnecting, or offline — and rests once the data on screen is live. The same
  // CollieHome renders inside a pane, so the top-left mark means the same thing on every screen.
  return (
    <header className="sticky top-0 z-20 flex items-center justify-between border-b border-border/60 bg-background/80 px-4 py-3 backdrop-blur-md [padding-top:calc(env(safe-area-inset-top)_+_0.75rem)] app-header">
      <CollieHome onHome={props.onHome} connecting={isConnecting(props)} wordmark />
      <div className="flex items-center gap-3">
        <div className={cn("flex items-center gap-1.5 text-xs font-medium", TONE[tone])}>
          <Icon className="size-3.5" />
          <span>{label}</span>
        </div>
        <Link
          to="/settings"
          viewTransition
          onClick={() => markNavDirection("forward")}
          aria-label="Settings"
          className="text-muted-foreground transition-colors hover:text-foreground"
        >
          <Settings className="size-5" />
        </Link>
      </div>
    </header>
  );
}
