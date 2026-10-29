import { ArrowLeftToLine, ClipboardPaste, FileText, Image, Pencil, X } from "lucide-react";

import { useLocale } from "@/hooks/use-locale";
import { pasteLineCount, shortName } from "@/lib/attachments";
import type { DraftAttachment } from "@/lib/drafts";
import { t, tn } from "@/lib/i18n";
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
 * The 44px floor for a paste chip's face, which is a button the operator taps to open the editor
 * (DESIGN.md §6, the same move as `STRIP_TAP_TARGET` in ui/labelled-strip.tsx). The face is `h-10`,
 * 40px, inside a strip that scrolls sideways, so the reach may not leave the strip's padding box or
 * it is clipped and stops taking taps (labelled-strip's note 2). An inset resolves against the
 * padding box, 1px inside the border: `-top-[4px]` lands 3px above the face, inside the strip's
 * `pt-1`, and `-bottom-[2px]` 1px below it, inside its `pb-0.5`, so 38 + 4 + 2 = 44 tall. Across,
 * `min-w-11` keeps the face itself 44px at the least. Change the strip's padding and re-measure.
 */
const CHIP_PASTE_TAP_TARGET =
  "relative min-w-11 before:absolute before:inset-x-0 before:-top-[4px] before:-bottom-[2px] before:content-['']";

/**
 * The 44px floor for a photo thumbnail that opens the image editor (DESIGN.md §6). The face is the
 * 40px thumbnail itself. The reach is the paste chip's recipe (see `CHIP_PASTE_TAP_TARGET`): it
 * stays inside the strip's padding box, 2px out on each side and 3px above, 1px below. The x on the
 * corner is a later sibling, so it keeps its own taps where the two overlap.
 */
const CHIP_EDIT_TAP_TARGET =
  "relative block before:absolute before:-inset-x-0.5 before:-top-[4px] before:-bottom-[2px] before:content-['']";

/**
 * One attachment waiting in the composer (ADR 0060). A photo with a preview is a 40x40 thumbnail;
 * anything else, a restored photo included (its blob URL died with the page), is a small tile with
 * an icon and the file name cut to fit. Its number sits in a badge on the top-left corner, the same
 * `#N` its marker in the draft carries, and the x on the top-right corner removes the chip and that
 * marker together. A photo that still has its bytes in memory (`onEdit`) is a button: a tap on the
 * thumbnail opens the image editor on it, and a small pencil on its bottom-right corner says so.
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
  onSelect,
  onEdit,
  disabled,
  inFront = false,
}: {
  attachment: ComposerAttachment;
  onRemove: () => void;
  onSelect?: () => void;
  onEdit?: () => void;
  disabled?: boolean;
  inFront?: boolean;
}) {
  useLocale();
  const isPaste = attachment.kind === "paste";
  const Icon = attachment.kind === "image" ? Image : isPaste ? ClipboardPaste : FileText;
  const inFrontNote = inFront ? t("composer.attach.inFront", { name: attachment.name }) : null;
  const edge = inFront ? "border-dashed border-foreground/60" : "border-border";
  const pasteStats = isPaste
    ? tn("composer.paste.chipStats", pasteLineCount(attachment.path), {
        chars: attachment.path.length,
      })
    : null;
  return (
    <li
      className="relative shrink-0"
      title={inFrontNote ?? attachment.name}
      data-in-front={inFront ? "" : undefined}
    >
      {attachment.previewUrl !== undefined && onEdit !== undefined ? (
        <button
          type="button"
          onClick={onEdit}
          disabled={disabled}
          aria-label={t("composer.imageEdit.edit")}
          className={cn(CHIP_EDIT_TAP_TARGET, "disabled:opacity-50")}
        >
          <img
            src={attachment.previewUrl}
            alt={attachment.name}
            className={cn("size-10 rounded-md border object-cover", edge)}
          />
          <span
            aria-hidden="true"
            className="pointer-events-none absolute right-0.5 bottom-0.5 grid size-4 place-items-center rounded-sm border border-border bg-background text-foreground"
          >
            <Pencil className="size-2.5" />
          </span>
        </button>
      ) : attachment.previewUrl !== undefined ? (
        <img
          src={attachment.previewUrl}
          alt={attachment.name}
          className={cn("size-10 rounded-md border object-cover", edge)}
        />
      ) : isPaste ? (
        <button
          type="button"
          onClick={onSelect}
          disabled={disabled}
          aria-label={t("composer.paste.editAria", { n: attachment.n })}
          className={cn(
            CHIP_PASTE_TAP_TARGET,
            "flex h-10 max-w-44 flex-col justify-center gap-0.5 rounded-md border bg-muted/40 pr-6 pl-2 text-left text-xs text-foreground transition-colors hover:bg-muted disabled:opacity-50",
            edge,
          )}
        >
          <span className="flex items-center gap-1 font-medium leading-none">
            <Icon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{pasteStats}</span>
          </span>
          <span className="truncate font-mono text-[10px] leading-tight text-muted-foreground">
            {shortName(attachment.name, 22)}
          </span>
        </button>
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
