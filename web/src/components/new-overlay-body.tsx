import { createContext, useContext, type ReactNode } from "react";

import { Icon } from "@/components/icons/icon";
import { BottomBar } from "@/components/ui/bottom-bar";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";

// LAB (desktop pass 2, step 1): the New form's parts laid out over the screen it was called from. The parts
// are the page's own (routes/new.tsx); only where they stand changes. Removed or kept in step 2.

/** The overlay frame's title id, so the dialog is named by the heading its body draws. */
export const OverlayTitleId = createContext<string | undefined>(undefined);

/** The head of a form drawn over the screen: an optional back arrow, the title, and the close button. */
export function OverlayHead({ title, onClose, back }: { title: ReactNode; onClose: () => void; back?: { label: string; onClick: () => void } }) {
  const titleId = useContext(OverlayTitleId);
  return (
    <div data-slot="new-overlay-head" className="flex h-14 shrink-0 items-center gap-2 border-b border-rule px-2">
      {back !== undefined ? (
        <Button variant="ghost" size="icon" className="size-11" onClick={back.onClick} aria-label={back.label}>
          <Icon name="back" className="size-5" />
        </Button>
      ) : (
        <span className="w-2" />
      )}
      <h1 id={titleId} className="min-w-0 flex-1 truncate text-lg font-semibold tracking-tight">
        {title}
      </h1>
      <Button variant="ghost" size="icon" className="size-11" onClick={onClose} aria-label={t("common.closeAria")}>
        <Icon name="close" className="size-5" />
      </Button>
    </div>
  );
}

const COLUMN = "relative flex min-h-0 flex-col gap-4 overflow-y-auto p-4";

export function NewOverlayBody({
  frame,
  title,
  onClose,
  what,
  where,
  branch,
  summary,
  start,
  tail,
}: {
  frame: "panel" | "two" | "three";
  title: ReactNode;
  onClose: () => void;
  what: ReactNode;
  where: ReactNode;
  branch: ReactNode;
  summary: ReactNode;
  start: ReactNode;
  tail: ReactNode;
}) {
  const head = <OverlayHead title={title} onClose={onClose} />;
  if (frame === "panel") {
    // One column, today's order and today's foot.
    return (
      <div data-slot="new-overlay-body" data-frame={frame} className="flex min-h-0 flex-1 flex-col">
        {head}
        <div className={`${COLUMN} flex-1`}>
          {what}
          {where}
          {branch}
        </div>
        <BottomBar className="flex flex-col gap-2 px-4">
          {summary}
          {start}
        </BottomBar>
        {tail}
      </div>
    );
  }
  if (frame === "two") {
    // What at the left, where at the right, the foot under both: the summary at the left, Start at the right.
    return (
      <div data-slot="new-overlay-body" data-frame={frame} className="flex min-h-0 flex-1 flex-col">
        {head}
        <div className="grid min-h-0 flex-1 grid-cols-2">
          <div className={`${COLUMN} border-r border-rule`}>{what}</div>
          <div className={COLUMN}>
            {where}
            {branch}
          </div>
        </div>
        <div data-slot="new-overlay-foot" className="flex shrink-0 items-center gap-4 border-t border-band-rule bg-band-ground px-4 py-3">
          <div className="flex min-w-0 flex-1 flex-col gap-1">{summary}</div>
          <div className="flex w-64 shrink-0 flex-col [&>button]:w-full">{start}</div>
        </div>
        {tail}
      </div>
    );
  }
  // Three: what, where, and the worktree with the foot under it, read from the left to the right.
  return (
    <div data-slot="new-overlay-body" data-frame={frame} className="flex min-h-0 flex-1 flex-col">
      {head}
      <div className="grid min-h-0 flex-1 grid-cols-3">
        <div className={`${COLUMN} border-r border-rule`}>{what}</div>
        <div className={`${COLUMN} border-r border-rule`}>{where}</div>
        <div className="flex min-h-0 flex-col">
          <div className={`${COLUMN} flex-1`}>{branch}</div>
          <div data-slot="new-overlay-foot" className="flex shrink-0 flex-col gap-2 border-t border-band-rule bg-band-ground p-4">
            {summary}
            {start}
          </div>
        </div>
      </div>
      {tail}
    </div>
  );
}
