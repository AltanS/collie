import { Plus } from "lucide-react";

import { cn } from "@/lib/utils";
import type { AgentView, TabView } from "@/lib/types";

interface TabStripProps {
  workspaceId: string;
  tabs: TabView[];
  agents: AgentView[];
  /** Selected tab id, or null for "All" (every tab's panes). */
  selected: string | null;
  onSelect: (tabId: string | null) => void;
  onNewTab: (workspaceId: string) => void;
  /** Show the leading "All" chip (home space view); off for the in-pane tab bar. */
  allowAll?: boolean;
}

// The selected space's tabs as a horizontal strip — the second header row under SpaceStrip, mirroring
// it one level down. "All" shows every tab's panes; tapping a tab filters the space to it; the
// trailing + creates a new tab (and opens its fresh shell). The desktop-focused tab gets a ring; a
// tab holding a blocked agent gets an alert dot.
export function TabStrip({
  workspaceId,
  tabs,
  agents,
  selected,
  onSelect,
  onNewTab,
  allowAll = true,
}: TabStripProps) {
  const wsTabs = tabs
    .filter((t) => t.workspaceId === workspaceId)
    .sort((a, b) => a.number - b.number);
  if (wsTabs.length === 0) return null;

  return (
    <div className="flex items-center gap-2 overflow-x-auto border-t border-border/40 px-3 py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {allowAll && <Chip label="All" active={selected === null} onClick={() => onSelect(null)} />}
      {wsTabs.map((t) => (
        <Chip
          key={t.tabId}
          label={t.label}
          active={selected === t.tabId}
          ring={t.focused}
          alert={agents.some((a) => a.tabId === t.tabId && a.status === "blocked")}
          onClick={() => onSelect(t.tabId)}
        />
      ))}
      <button
        type="button"
        onClick={() => onNewTab(workspaceId)}
        aria-label="New tab"
        className="flex size-8 shrink-0 items-center justify-center rounded-full border border-dashed border-border text-muted-foreground transition-colors hover:bg-accent active:scale-95"
      >
        <Plus className="size-4" />
      </button>
    </div>
  );
}

function Chip({
  label,
  active,
  ring,
  alert,
  onClick,
}: {
  label: string;
  active: boolean;
  ring?: boolean;
  alert?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "true" : undefined}
      className={cn(
        "relative shrink-0 whitespace-nowrap rounded-full px-3 py-1.5 text-sm font-medium transition-colors active:scale-95",
        active
          ? "bg-primary text-primary-foreground"
          : "bg-muted text-muted-foreground hover:bg-muted/70",
        ring && !active && "ring-1 ring-inset ring-primary/40",
      )}
    >
      {label}
      {alert && (
        <span className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full bg-status-blocked ring-2 ring-background" />
      )}
    </button>
  );
}
