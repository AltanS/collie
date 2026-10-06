// The attachments waiting in the composer (a port of web/src/components/attachment-chip.tsx and the
// row the web composer drew around it, ADR 0060). The caller wraps this in a `Collapse` open while
// `list` is non-empty (REMIX3.md, rule 7) and gives it a line of its own above the field: the list
// takes `w-full basis-full`, built for the composer's `flex-wrap` box.
//
// A photo with a preview is a 40x40 thumbnail; anything else (a restored photo included, its blob URL
// died with the page) is a small tile with an icon and the name cut to fit. Its number sits in a badge
// on the top-left corner, the same `#N` its marker in the draft carries, and the x on the top-right
// removes the chip and that marker together. One uniform 1px border and no shadow: a token inside the
// composer's box, not a card.
//
// `inFront(attachment)` is true for the chip whose marker the operator deleted from the text: Send will
// put its path in front of the words (ADR 0060, point 7), and the chip says so BEFORE Send: dashed
// border, an arrow in the badge, a title and a screen-reader line. No dialog, no toast. The caller
// answers it with `isMarkerMissing(text, attachment)`; it is read in render, so typing the marker
// back clears the cue.
//
// A chip still `uploading` is dimmed under a spinner and its x stays live: removing it drops the
// result when it lands. Chips are keyed by `id`, so a poll or a new chip never moves the others.
import { on, type Handle } from "remix/component";
import { ArrowLeftToLine, FileText, Image as ImageIcon, LoaderCircle, X } from "lucide";

import { shortName } from "@web/lib/attachments";
import { t } from "@web/lib/i18n";
import { cn } from "@web/lib/utils";

import { useLocale } from "../lib/i18n-store";
import { Icon } from "../ui/icon";
import type { PendingAttachment } from "./attachments";

/**
 * The 44px floor for the chip's x, bought back as hit area (DESIGN.md §6): the face is `size-5`,
 * 20px, and `-inset-3` reaches 12px out on every side, so 20 + 24 = 44 in both axes. The button is
 * itself `absolute`, which already anchors its `::before`.
 */
const CHIP_REMOVE_TAP_TARGET = "before:absolute before:-inset-3 before:content-['']";

export interface AttachmentChipsProps {
  list: readonly PendingAttachment[];
  /** Read at tap time. */
  onRemove: (id: string) => void;
  /** Whether Send will put this chip's path in front of the words. Read in render. */
  inFront?: (attachment: PendingAttachment) => boolean;
  /** Greys every x, as web does while a send is in flight. */
  disabled?: boolean;
}

export function AttachmentChips(handle: Handle<AttachmentChipsProps>) {
  useLocale(handle);
  return () => {
    const { list, inFront, disabled } = handle.props;
    return (
      <ul
        data-testid="attachment-chips"
        aria-label={t("composer.attach.listAria")}
        class="flex w-full basis-full gap-2 overflow-x-auto px-1 pt-1 pb-0.5"
      >
        {list.map((attachment) => (
          <AttachmentChip
            key={attachment.id}
            attachment={attachment}
            inFront={inFront?.(attachment) ?? false}
            disabled={disabled === true}
            onRemove={() => handle.props.onRemove(attachment.id)}
          />
        ))}
      </ul>
    );
  };
}

interface AttachmentChipProps {
  attachment: PendingAttachment;
  inFront: boolean;
  disabled: boolean;
  onRemove: () => void;
}

function AttachmentChip(handle: Handle<AttachmentChipProps>) {
  return () => {
    const { attachment, inFront, disabled } = handle.props;
    const uploading = attachment.state === "uploading";
    const failed = attachment.state === "failed";
    const inFrontNote = inFront ? t("composer.attach.inFront", { name: attachment.name }) : null;
    const edge = failed
      ? "border-dashed border-destructive"
      : inFront
        ? "border-dashed border-foreground/60"
        : "border-border";
    const badge = attachment.n === undefined ? "" : `#${attachment.n}`;
    return (
      <li
        data-testid="attachment-chip"
        data-state={attachment.state}
        data-in-front={inFront ? "" : undefined}
        aria-busy={uploading ? "true" : undefined}
        title={inFrontNote ?? attachment.name}
        class="relative shrink-0"
      >
        {attachment.previewUrl !== undefined ? (
          <img
            src={attachment.previewUrl}
            alt={attachment.name}
            class={cn("size-10 rounded-md border object-cover", edge, uploading && "opacity-50")}
          />
        ) : (
          <div
            class={cn(
              "flex h-10 max-w-40 items-center gap-1.5 rounded-md border bg-muted/40 pr-6 pl-2 text-xs text-muted-foreground",
              edge,
              uploading && "opacity-50",
            )}
          >
            <Icon icon={attachment.kind === "image" ? ImageIcon : FileText} class="size-4 shrink-0" />
            <span class="truncate">{shortName(attachment.name)}</span>
          </div>
        )}
        <span class="pointer-events-none absolute -top-1 -left-1 flex items-center gap-0.5 rounded border border-border bg-background px-1 font-mono text-[10px] leading-3.5 text-foreground">
          {inFront ? <Icon icon={ArrowLeftToLine} class="size-2.5" /> : null}
          {badge}
        </span>
        {uploading ? (
          <span class="pointer-events-none absolute inset-0 grid place-items-center text-foreground">
            <Icon icon={LoaderCircle} class="size-4 animate-spin" />
          </span>
        ) : null}
        {inFrontNote !== null ? <span class="sr-only">{inFrontNote}</span> : null}
        <button
          type="button"
          data-testid="attachment-remove"
          disabled={disabled}
          aria-label={t("composer.attach.removeAria", { name: attachment.name })}
          mix={on("click", () => handle.props.onRemove())}
          class={cn(
            CHIP_REMOVE_TAP_TARGET,
            "absolute -top-1 -right-1 grid size-5 place-items-center rounded-full border border-border bg-background text-muted-foreground disabled:opacity-50",
          )}
        >
          <Icon icon={X} class="size-3" />
        </button>
      </li>
    );
  };
}
