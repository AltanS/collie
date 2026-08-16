import type { ReactNode } from "react";
import { Settings } from "lucide-react";
import { useNavigate } from "react-router";

import { settingsPath } from "@/lib/nav";
import { CollieHome } from "@/components/collie-home";

interface AppHeaderProps {
  /** Generic route loading only. It animates the mark without making a freshness claim. */
  loading?: boolean;
  /** Static treatment when this route's root snapshot cannot support current-state claims. */
  degraded?: boolean;

  /** Tapping the Collie mark returns to the dashboard. A callback, not a `<Link to="/">`: the
   * dashboard and the drilled-in space view share the "/" route, so a same-route link would no-op. */
  onHome?: () => void;
  /** Show the "Collie" wordmark beside the mark (dashboard + space). Omit inside a pane — the
   * breadcrumb in `children` carries the context there, and the mark stands alone to save width. */
  wordmark?: boolean;

  /** Route-specific center content — the pane's `space › tab` breadcrumb. Rendered in a `flex-1
   * min-w-0` region so a long breadcrumb truncates instead of pushing the right cluster off the row. */
  children?: ReactNode;
  /** Right-cluster lead items (the dashboard's SessionSwitcher; the pane's StatusBadge). */
  rightLead?: ReactNode;
  /** Right-cluster trailing items (the Settings gear). */
  rightTrail?: ReactNode;

  /** Full-width takeover of the header row (the pane's find bar). */
  override?: ReactNode;
}

// The shared header shell. Loading animation and degraded treatment are explicit independent inputs:
// neither invents a connection state, and only route loader outcomes decide whether data is degraded.
export function AppHeader({
  loading = false,
  degraded = false,
  onHome,
  wordmark,
  children,
  rightLead,
  rightTrail,
  override,
}: AppHeaderProps) {
  return (
    <header className="sticky top-0 z-20 flex items-center gap-2 border-b border-border/60 bg-muted pl-4 pr-2 py-2 [padding-top:calc(env(safe-area-inset-top)_+_0.5rem)]">
      {override ?? (
        <>
          <CollieHome onHome={onHome} loading={loading} degraded={degraded} wordmark={wordmark} />
          <div className="flex min-w-0 flex-1 items-center">{children}</div>
          <div className="flex items-center gap-1">
            {rightLead}
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
      className="grid size-11 place-items-center text-muted-foreground transition-colors hover:text-foreground"
    >
      <Settings className="size-5" />
    </button>
  );
}
