import { ArrowLeftToLine, FileText, Image, X } from "lucide-react";

import { useLocale } from "@/hooks/use-locale";
import { shortName } from "@/lib/attachments";
import type { DraftAttachment } from "@/lib/drafts";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** A chip as the composer holds it: the stored draft attachment plus, for a photo picked in this
 *  page session, the blob URL its thumbnail draws from. */
export interface ComposerAttachment extends DraftAttachment {
  previewUrl?: string;
}

/**
 * The 44px floor for the chip's x, bought back as hit area (DESIGN.md §6): the face is `size-5`,
 * 20px, and `-inset-3` reaches 12px out on every side, so 20 + 24 = 44 in both axes. The same idiom
 * as the composer's own `TOOLBAR_TAP_TARGET`, at a smaller face. No `relative` here: the button is
 * itself `absolute`, which already anchors its `::before`.
 */
const CHIP_REMOVE_TAP_TARGET = "before:absolute before:-inset-3 before:content-['']";

/**
 * One attachment waiting in the composer (ADR 0060). A photo with a preview is a 40x40 thumbnail;
 * anything else, a restored photo included (its blob URL died with the page), is a small tile with
 * an icon and the file name cut to fit. Its number sits in a badge on the top-left corner, the same
 * `#N` its marker in the draft carries, and the x on the top-right corner removes the chip and that
 * marker together.
 *
 * One uniform 1px border and no shadow: it is a token inside the composer's box, not a card.
 *
 * `inFront` is the chip whose marker the operator deleted from the text: Send will put its path in
 * front of the words, not where the marker stood (ADR 0060, point 7). It says so before Send, not
 * after: the border turns dashed, the badge gains an arrow to the line's start, and the title and
 * a screen-reader line spell it out. No dialog, no toast; typing the marker back clears it.
 */
export function AttachmentChip({
  attachment,
  onRemove,
  disabled,
  inFront = false,
}: {
  attachment: ComposerAttachment;
  onRemove: () => void;
  disabled?: boolean;
  inFront?: boolean;
}) {
  useLocale();
  const Icon = attachment.kind === "image" ? Image : FileText;
  const inFrontNote = inFront ? t("composer.attach.inFront", { name: attachment.name }) : null;
  const edge = inFront ? "border-dashed border-foreground/60" : "border-border";
  return (
    <li
      className="relative shrink-0"
      title={inFrontNote ?? attachment.name}
      data-in-front={inFront ? "" : undefined}
    >
      {attachment.previewUrl !== undefined ? (
        <img
          src={attachment.previewUrl}
          alt={attachment.name}
          className={cn("size-10 rounded-md border object-cover", edge)}
        />
      ) : (
        <div
          className={cn(
            "flex h-10 max-w-40 items-center gap-1.5 rounded-md border bg-muted/40 pr-6 pl-2 text-xs text-muted-foreground",
            edge,
          )}
        >
          <Icon aria-hidden="true" className="size-4 shrink-0" />
          <span className="truncate">{shortName(attachment.name)}</span>
        </div>
      )}
      <span className="pointer-events-none absolute -top-1 -left-1 flex items-center gap-0.5 rounded border border-border bg-background px-1 font-mono text-[10px] leading-3.5 text-foreground">
        {inFront && <ArrowLeftToLine aria-hidden="true" className="size-2.5" />}#{attachment.n}
      </span>
      {inFrontNote !== null && <span className="sr-only">{inFrontNote}</span>}
      <button
        type="button"
        onClick={onRemove}
        disabled={disabled}
        aria-label={t("composer.attach.removeAria", { name: attachment.name })}
        className={cn(
          CHIP_REMOVE_TAP_TARGET,
          "absolute -top-1 -right-1 grid size-5 place-items-center rounded-full border border-border bg-background text-muted-foreground disabled:opacity-50",
        )}
      >
        <X className="size-3" />
      </button>
    </li>
  );
}
