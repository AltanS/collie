import { useState } from "react";
import { Plus } from "lucide-react";

import { Chip } from "@/components/ui/chip";
import { SectionLabel } from "@/components/ui/section-label";
import { TabActionsSheet } from "@/components/tab-actions-sheet";
import { worstTriage } from "@/lib/triage";
import { hostKey } from "@/lib/hosts";
import type { AgentView, TabView } from "@/lib/types";
import { useMuxCapability } from "@/lib/mux-capability";
import type { Scope } from "@/lib/scope";

interface TabStripProps {
  workspaceId: string;
  tabs: TabView[];
  agents: AgentView[];
  /** The machine this space is on — tab ids collide across a pack, so status is counted per host. */
  host?: string;
  /** Selected tab id, or null for "All" (every tab's panes). */
  selected: string | null;
  onSelect: (tabId: string | null) => void;
  onNewTab: (workspaceId: string) => void;
  /** Show the leading "All" chip (home space view); off for the in-pane tab bar. */
  allowAll?: boolean;
  /** Session scope for the long-press tab actions (rename/close); undefined = primary. */
  scope?: Scope;
  /** Drop the long-press write actions when the device isn't authorised (the sheet shows a note). */
  readOnly?: boolean;
  /** Revalidate after a rename. Long-press tab actions turn on only when this AND onClosed are set. */
  onRenamed?: () => void;
  /** Refresh/fall back after a close. Enables long-press together with onRenamed. */
  onClosed?: (tabId: string) => void;
}

// The selected space's tabs as a horizontal strip — the second header row under SpaceStrip, mirroring
// it one level down. "All" shows every tab's panes; tapping a tab filters the space to it; the
// trailing + creates a new tab (and opens its fresh shell). The desktop-focused tab gets a ring;
// each tab carries a status dot for the most urgent thing inside it. A long-press on a chip opens
// its actions sheet
// (rename / close) when the parent wires both onRenamed and onClosed (the "All" chip and the + never
// take long-press).
export function TabStrip({
  workspaceId,
  tabs,
  agents,
  host,
  selected,
  onSelect,
  onNewTab,
  allowAll = true,
  scope,
  readOnly,
  onRenamed,
  onClosed,
}: TabStripProps) {
  const [sheetTab, setSheetTab] = useState<TabView | null>(null);
  const newTab = useMuxCapability("createTab");
  // Actions need both callbacks wired (revalidate on rename, fall back on close); without them the
  // chips stay plain tap-to-switch — long-press is inert.
  const actionsEnabled = !!onRenamed && !!onClosed;

  // Tab status is computed over THIS machine's panes only: tab ids (`w1:t1`) collide across a pack
  // exactly as pane and workspace ids do, so an unfiltered merged list would paint a peer's blocked
  // agent onto the lead's tab chip. Solo panes are untagged and `host` is undefined — same set as before.
  const here = agents.filter((a) => hostKey(a) === (host ?? ""));
  const wsTabs = tabs.filter((t) => t.workspaceId === workspaceId);
  if (wsTabs.length === 0) return null;

  return (
    <>
      {/* shrink-0 for the same reason as SpaceStrip — see the note there. */}
      <div className="flex shrink-0 items-center gap-2 overflow-x-auto border-t border-border/40 px-3 py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <SectionLabel>Tabs</SectionLabel>
        {allowAll && <Chip label="All" active={selected === null} onClick={() => onSelect(null)} />}
        {wsTabs.map((t) => (
          <Chip
            key={t.tabId}
            label={t.label}
            active={selected === t.tabId}
            ring={t.focused}
            // What's actually going on in there — blocked / ready / working / idle — instead of a
            // dot that only ever appeared for blocked and left every other state unreadable.
            status={worstTriage(here.filter((a) => a.tabId === t.tabId))}
            onClick={() => onSelect(t.tabId)}
            // Long-press (and a tap on the already-active tab) opens the actions sheet — only when the
            // parent wired the actions; otherwise the chips stay plain tap-to-switch.
            onLongPress={actionsEnabled ? () => setSheetTab(t) : undefined}
            onTapActive={actionsEnabled ? () => setSheetTab(t) : undefined}
          />
        ))}
        {/* HIDE, don't explain (M10/06). A "+" at the end of the tab row is an affordance, not a
            promise: nobody arrives at Collie needing to know why a particular multiplexer will not
            open a tab, the way they arrive needing to know where their agent's history went. Every
            adapter shipped today declares `createTab`, so this hides on none of them — it asks
            anyway, because the alternative is a fourth adapter discovering the answer by 500ing. */}
        {newTab.capable && (
          <button
            type="button"
            onClick={() => onNewTab(workspaceId)}
            aria-label="New tab"
            className="flex size-8 shrink-0 items-center justify-center rounded-full border border-dashed border-border text-muted-foreground transition-colors hover:bg-accent active:scale-95"
          >
            <Plus className="size-4" />
          </button>
        )}
      </div>

      {actionsEnabled && (
        <TabActionsSheet
          open={sheetTab !== null}
          onClose={() => setSheetTab(null)}
          tab={sheetTab}
          scope={scope}
          readOnly={readOnly}
          onRenamed={onRenamed}
          onClosed={onClosed}
        />
      )}
    </>
  );
}
