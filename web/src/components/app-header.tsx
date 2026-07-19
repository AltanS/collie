import type { ReactNode } from "react";
import { Settings } from "lucide-react";
import { useNavigate } from "react-router";

import { isConnecting } from "@/lib/connection";
import { useConnectionLost } from "@/hooks/use-connection-lost";
import { settingsPath } from "@/lib/nav";
import { CollieHome } from "@/components/collie-home";
import { ConnectionPill } from "@/components/connection-pill";
import type { BridgeStatus } from "@/lib/types";

interface AppHeaderProps {
  // Connection state — the ONE input that drives BOTH the CollieHome gallop and the quiet-by-default
  // ConnectionPill. Every header (dashboard, space, pane) renders THIS component, so the mark and the
  // pill are the same pieces fed from the same state everywhere; a header can no longer diverge by
  // hand-rolling its own bar or omitting the pill. The pill self-hides while live, so a healthy header
  // is calm and the pill's mere presence signals an outage — identically on every screen.
  online: boolean;
  bridge: BridgeStatus | undefined;
  error: boolean;
  stalled?: boolean;

  /** Tapping the Collie mark returns to the dashboard. A callback, not a `<Link to="/">`: the
   *  dashboard and the drilled-in space view share the "/" route, so a same-route link would no-op. */
  onHome?: () => void;
  /** Show the "Collie" wordmark beside the mark (dashboard + space). Omit inside a pane — the
   *  breadcrumb in `children` carries the context there, and the mark stands alone to save width. */
  wordmark?: boolean;

  /** Route-specific center content — the pane's `space › tab` breadcrumb. Rendered in a `flex-1
   *  min-w-0` region so a long breadcrumb truncates instead of pushing the pill off the row. Empty on
   *  the dashboard/space, where the region is just the spacer that pushes the right cluster over. */
  children?: ReactNode;
  /** Right-cluster items BEFORE the pill (the dashboard's SessionSwitcher; the pane's StatusBadge). */
  rightLead?: ReactNode;
  /** Right-cluster items AFTER the pill (the Settings gear). */
  rightTrail?: ReactNode;

  /** Full-width takeover of the header row (the pane's find bar). When set it replaces the normal
   *  content while it's up — the find bar owns the row one-handed, exactly as before — but it still
   *  lives inside this one shell so the sticky/safe-area/zinc bar is never copy-pasted. */
  override?: ReactNode;
}

// The single header shell every screen mounts: the sticky, safe-area-aware zinc bar with the Collie
// mark on the left, an optional route breadcrumb in the middle, and a right cluster that holds the
// connection pill. The pill is baked in here (not a slot), so no caller can forget it — which is
// exactly the divergence the pane header used to have — but it renders nothing while live, so the
// resting header shows only the caller's own items (switcher/badge + gear). When an outage brings the
// pill in it shifts its neighbours over (acceptable — the gear stays pinned to the edge as rightTrail).
export function AppHeader({
  online,
  bridge,
  error,
  stalled,
  onHome,
  wordmark,
  children,
  rightLead,
  rightTrail,
  override,
}: AppHeaderProps) {
  // Independent of the pill's own computation, but derived from the SAME predicate + shared store, so
  // the mark's gallop and the pill's tone always agree (see lib/connection-health).
  const connecting = isConnecting({ bridge, error, stalled });
  const lost = useConnectionLost(connecting);
  return (
    <header className="sticky top-0 z-20 flex items-center gap-2 border-b border-border/60 bg-zinc-800 pl-4 pr-2 py-2 [padding-top:calc(env(safe-area-inset-top)_+_0.5rem)]">
      {override ?? (
        <>
          <CollieHome onHome={onHome} connecting={connecting} lost={lost} wordmark={wordmark} />
          {/* Center region: the breadcrumb (or, on the dashboard/space, an empty flex-1 spacer that
              pushes the right cluster to the edge). min-w-0 so the breadcrumb truncates when tight. */}
          <div className="flex min-w-0 flex-1 items-center">{children}</div>
          <div className="flex items-center gap-3">
            {rightLead}
            <ConnectionPill online={online} bridge={bridge} error={error} stalled={stalled} />
            {rightTrail}
          </div>
        </>
      )}
    </header>
  );
}

// The Settings gear, shared so the dashboard and space headers don't each hand-roll it. Session-scoped
// so the navigation stays on the session you're viewing.
export function SettingsGear({ session }: { session?: string }) {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      onClick={() => navigate(settingsPath(session))}
      aria-label="Settings"
      className="text-muted-foreground transition-colors hover:text-foreground"
    >
      <Settings className="size-5" />
    </button>
  );
}
