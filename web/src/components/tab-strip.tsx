import { useState } from "react";
import { Plus } from "lucide-react";

import { Chip } from "@/components/ui/chip";
import { SectionLabel } from "@/components/ui/section-label";
import { TabActionsSheet } from "@/components/tab-actions-sheet";
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
  /** Session scope for the long-press tab rename (undefined = primary). */
  session?: string;
  /** Drop the long-press write action when the device isn't authorised (the sheet shows a note). */
  readOnly?: boolean;
  /** Revalidate after a rename. Long-press tab rename turns on only when this is wired. */
  onRenamed?: () => void;
}

// The selected space's tabs as a horizontal strip — the second header row under SpaceStrip, mirroring
// it one level down. "All" shows every tab's panes; tapping a tab filters the space to it; the
// trailing + creates a new tab (and opens its fresh shell). The desktop-focused tab gets a ring; a
// tab holding a blocked agent gets an alert dot. A long-press on a tab chip opens its rename sheet
// when the parent wires onRenamed (the "All" chip and the + never take long-press).
export function TabStrip({
  workspaceId,
  tabs,
  agents,
  selected,
  onSelect,
  onNewTab,
  allowAll = true,
  session,
  readOnly,
  onRenamed,
}: TabStripProps) {
  const [sheetTab, setSheetTab] = useState<TabView | null>(null);

  const wsTabs = tabs
    .filter((t) => t.workspaceId === workspaceId)
    .sort((a, b) => a.number - b.number);
  if (wsTabs.length === 0) return null;

  return (
    <>
      <div className="flex items-center gap-2 overflow-x-auto border-t border-border/40 px-3 py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <SectionLabel>Tabs</SectionLabel>
        {allowAll && <Chip label="All" active={selected === null} onClick={() => onSelect(null)} />}
        {wsTabs.map((t) => (
          <Chip
            key={t.tabId}
            label={t.label}
            active={selected === t.tabId}
            ring={t.focused}
            alert={agents.some((a) => a.tabId === t.tabId && a.status === "blocked")}
            onClick={() => onSelect(t.tabId)}
            // Long-press (and a tap on the already-active tab) opens the rename sheet — only when the
            // parent wired onRenamed; otherwise the chips stay plain tap-to-switch.
            onLongPress={onRenamed ? () => setSheetTab(t) : undefined}
            onTapActive={onRenamed ? () => setSheetTab(t) : undefined}
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

      {onRenamed && (
        <TabActionsSheet
          open={sheetTab !== null}
          onClose={() => setSheetTab(null)}
          tab={sheetTab}
          session={session}
          readOnly={readOnly}
          onRenamed={onRenamed}
        />
      )}
    </>
  );
}
