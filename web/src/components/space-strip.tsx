import { useRef, useState } from "react";
import { ChevronLeft } from "lucide-react";

import { AddButton } from "@/components/ui/add-button";
import { Chip } from "@/components/ui/chip";
import {
  LabelledStrip,
  STRIP_TAP_TARGET,
  STRIP_TAP_TARGET_SQUARE,
} from "@/components/ui/labelled-strip";
import { SpaceActionsSheet } from "@/components/space-actions-sheet";
import { cn } from "@/lib/utils";
import { worstTriage } from "@/lib/triage";
import { useMuxCapability, useMuxDeclared, useMuxHasSpaces } from "@/lib/mux-capability";
import type { AgentView, WorkspaceView } from "@/lib/types";
import type { Scope } from "@/lib/scope";
import { t } from "@/lib/i18n";
import { useLocale } from "@/hooks/use-locale";
import { useRevealActive } from "@/hooks/use-reveal-active";

interface SpaceStripProps {
  workspaces: WorkspaceView[];
  agents: AgentView[];
  /**
   * The addressed host (`?h=`, or the lead absent one) — the same value the space route looks its
   * panes up under. Without it, a chip matched agents by `workspaceId` alone, so a blocked agent in
   * another machine's identically-numbered space coloured this one's chip too (#209). Undefined on a
   * solo install, which is what every agent's own `host` is there too.
   */
  host?: string;
  /** Selected workspace id, or null for the "All" triage view. */
  selected: string | null;
  onSelect: (workspaceId: string | null) => void;
  onNewSpace: () => void;
  /** True while a Space create (from this row's sheet, or the worktree sheet it shares a flag with)
   *  is in flight — disables the "+" and swaps its icon for a spinner, the same feedback the tab
   *  strip's own "+" gives. */
  creatingSpace?: boolean;
  /** When set (the drill-in view), lead with an explicit "‹ Back" button to the dashboard instead
   *  of the "All" chip — so the way back is obvious, not reliant on the header wordmark. */
  onBack?: () => void;
  /** Session scope for the long-press space actions (rename); undefined = primary. */
  scope?: Scope;
  /** Drop the long-press write action when the device isn't authorised (the sheet shows a note). */
  readOnly?: boolean;
  /** A saved copy is on screen: the long-press sheet shows a note in place of rename. */
  savedCopy?: boolean;
  /**
   * Revalidate after a rename. A long-press (or a tap on the active chip) opens the space sheet only when this is
   * set AND the machine declares `renameSpace`; otherwise the chips stay plain tap-to-switch.
   */
  onRenamed?: () => void;
}

// A horizontal strip of spaces (Herdr workspaces) above the home list. In the drill-in (`onBack`
// set), it leads with a Back button to the dashboard, then the sibling spaces for quick switching;
// otherwise it leads with the "All" triage chip. A trailing + creates a new space. The space focused
// in the desktop TUI gets a subtle ring; a space with a blocked agent gets a dot.
export function SpaceStrip({
  workspaces,
  agents,
  host,
  selected,
  onSelect,
  onNewSpace,
  creatingSpace = false,
  onBack,
  scope,
  readOnly,
  savedCopy,
  onRenamed,
}: SpaceStripProps) {
  const [sheetSpace, setSheetSpace] = useState<WorkspaceView | null>(null);
  const newSpace = useMuxCapability("createSpace", scope);
  // A durable program makes no space by hand, but it offers starters, and `onNewSpace` opens the New
  // page, which lists exactly those (route space.tsx). So the "+" is drawn for either (M51 spec 08).
  const startersOpen = useMuxDeclared("starters", scope);
  // The space sheet has one row, Rename, which a program draws only when it takes renames (M53 spec 05). With no
  // such declaration, or no callback to revalidate with, a space chip stays a plain switch and opens nothing.
  const renameOpen = useMuxDeclared("renameSpace", scope);
  const actionsEnabled = renameOpen && onRenamed !== undefined;
  // Whether the multiplexer underneath can hold more than one space AT ALL (bridge/mux/
  // capabilities.ts `spaces`). Not "how many are there right now": one space out of many is a herd
  // the operator is about to add to, while one space out of one is a level their multiplexer does
  // not have — and a row of switches with exactly one switch on it says the wrong thing about which.
  const hasSpaces = useMuxHasSpaces();
  useLocale();
  const scrollerRef = useRef<HTMLDivElement>(null);
  // Keyed on `selected`; the drill-in (`onBack` set) has no active chip at all — "Back" isn't one —
  // so there is nothing this strip needs to reveal there, and the hook simply finds no element.
  useRevealActive(scrollerRef, selected);
  // On a one-space multiplexer the tab strip is the top level and this row has nothing to offer —
  // except the way back, which is navigation rather than a space and must not disappear with them.
  // With no back button there is nothing left to render at all.
  if (!hasSpaces && onBack === undefined) return null;
  // The name sits ABOVE the row, not beside it, and outside the scroller — see LabelledStrip, which
  // also carries the `shrink-0` this strip needs as a child of the space route's `flex-1 flex-col`
  // scroller. The label is drawn in BOTH branches, including the drill-in that leads with Back:
  // dropping it there would make this strip 50px in one state and 67px in the other, so navigating
  // in and out would jump the whole page by 17px. State does not get to change the box.
  // border-b border-rule on the strip: this band closes its own bottom, from ABOVE, so the division between
  // the Spaces row and the Tabs row below it is drawn once, not by whatever the tab bar draws
  // from below, which would land on the same y and read as a doubled 2px line.
  return (
    <>
      <LabelledStrip
        label={t("space.strip.title")}
        className="border-b border-rule"
        scrollerRef={scrollerRef}
      >
        {onBack ? (
          <button
            type="button"
            onClick={onBack}
            // `rounded-md` (2px): a chevron plus a word is a stadium, and it leads a row of chips that
            // now take the house radius. Full-round stays reserved for the square "+" at the end.
            // It stands in a chip's place, so it takes a chip's height (py-1.5, 34px) and a chip's
            // tap floor (STRIP_TAP_TARGET, 46px hit box) — the row must not answer the way back
            // differently from the way sideways.
            className={cn(
              STRIP_TAP_TARGET,
              "flex shrink-0 items-center gap-0.5 rounded-md border border-border bg-background py-1.5 pl-1.5 pr-3 text-sm font-medium text-foreground transition-colors hover:bg-muted active:scale-95",
            )}
          >
            <ChevronLeft className="size-4" />
            {t("space.strip.back")}
          </button>
        ) : (
          <Chip label={t("space.strip.all")} active={selected === null} onClick={() => onSelect(null)} />
        )}
        {hasSpaces &&
          workspaces.map((w) => (
            <Chip
              key={w.workspaceId}
              label={w.label}
              active={selected === w.workspaceId}
              ring={w.focused}
              // Same dot language as the tab strip directly below it, and as the herd list. Host-
              // qualified: another machine's identically-numbered space is not this one, however an
              // UNTAGGED agent (an un-widened solo body) matches any host — the same rule
              // `ambientPanes`/`findPane` use in lib/hosts.ts.
              status={worstTriage(
                agents.filter(
                  (a) => a.workspaceId === w.workspaceId && (a.host === undefined || a.host === host),
                ),
              )}
              onClick={() => onSelect(w.workspaceId)}
              // Long-press (and a tap on the already-active chip) opens the space sheet, like a tab's.
              onLongPress={actionsEnabled ? () => setSheetSpace(w) : undefined}
              onTapActive={actionsEnabled ? () => setSheetSpace(w) : undefined}
            />
          ))}
        {/* Hidden when the multiplexer cannot open a space (M10/06). No explanation HERE: this strip
            is a one-line row of chips with no room for a sentence, and the dashboard's Spaces section
            — the other place this "+" appears — carries the adapter's reason in full. Saying it twice
            in two shapes is how one wording rule turns into two. */}
        {(newSpace.capable || startersOpen) && (
          // 32px drawn, 46x46 hit: STRIP_TAP_TARGET_SQUARE adds the horizontal half of the floor,
          // which only this button needs and only this button can safely take (it is last in the row).
          <AddButton
            size="md"
            reach={STRIP_TAP_TARGET_SQUARE}
            label={t("space.overview.new.aria")}
            busy={creatingSpace}
            onClick={onNewSpace}
          />
        )}
      </LabelledStrip>
      {actionsEnabled && (
        <SpaceActionsSheet
          open={sheetSpace !== null}
          onClose={() => setSheetSpace(null)}
          space={sheetSpace}
          scope={scope}
          readOnly={readOnly}
          savedCopy={savedCopy}
          onRenamed={onRenamed}
        />
      )}
    </>
  );
}
