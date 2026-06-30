import { Plug, PlugZap, Settings, WifiOff } from "lucide-react";
import { Link } from "react-router";

import { cn } from "@/lib/utils";
import { markNavDirection } from "@/lib/view-transition";
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
function resolve({ online, bridge, error }: ConnectionBarProps) {
  if (!online) return { label: "offline", tone: "bad", Icon: WifiOff } as const;
  if (error || bridge === undefined) return { label: "reconnecting…", tone: "warn", Icon: Plug } as const;
  if (bridge === "disconnected") return { label: "Herdr offline", tone: "warn", Icon: Plug } as const;
  return { label: "live", tone: "ok", Icon: PlugZap } as const;
}

const TONE: Record<"ok" | "warn" | "bad", string> = {
  ok: "text-status-done",
  warn: "text-status-working",
  bad: "text-status-blocked",
};

export function ConnectionBar(props: ConnectionBarProps) {
  const { label, tone, Icon } = resolve(props);
  return (
    <header className="sticky top-0 z-20 flex items-center justify-between border-b border-border/60 bg-background/80 px-4 py-3 backdrop-blur-md [padding-top:calc(env(safe-area-inset-top)_+_0.75rem)] app-header">
      <button
        type="button"
        onClick={props.onHome}
        aria-label="Collie home"
        className="-mx-1 flex items-center gap-2 rounded px-1 transition-opacity active:opacity-70"
      >
        <img src="/favicon.svg" alt="" className="size-6 rounded" />
        <span className="text-lg font-semibold tracking-tight">Collie</span>
      </button>
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
