import type { ReactNode } from "react";

import { Icon } from "@/components/icons/icon";
import { Button } from "@/components/ui/button";
import { Collapse } from "@/components/ui/collapse";
import { OneOf } from "@/components/ui/one-of";
import { cn } from "@/lib/utils";

// A QUIET TAP THAT OPENS A PART OF A CARD IN PLACE (M96), and the part it opens. Two of them, side by
// side on one row of a Decision card: "More" opens the body and the links, "Add a note" opens an
// optional text field. Each is a ghost button with a 44px tap floor (DESIGN.md §6), muted ink, and
// `aria-expanded`; the part arrives through `Collapse`, the only sanctioned way an in-flow surface
// appears (§11, hard rule 1).
//
// `aria-controls` is set only while the part is rendered: `Collapse` unmounts it once closed, and an
// id that names nothing would point a screen reader at nothing exactly when it decides whether to open.
//
// Owns no words: the caller passes them, because i18n lives on the feature side.

interface ToggleProps {
  open: boolean;
  onToggle: () => void;
  /** The id of the part this toggle opens (`FoldPanel`'s `id`). */
  controls: string;
  disabled?: boolean;
  className?: string;
  "data-slot"?: string;
}

/** The one look both toggles wear: a ghost button, 44px tall, muted. */
const TOGGLE = "h-11 px-3 text-muted-foreground";

/**
 * "More" and "Less", with the chevron that turns. Both words sit in one slot sized by the wider
 * (`OneOf`), so the switch moves nothing beside it (§2).
 */
export function MoreToggle({ open, onToggle, controls, disabled, className, more, less, ...rest }: ToggleProps & { more: string; less: string }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      aria-expanded={open}
      aria-controls={open ? controls : undefined}
      disabled={disabled}
      onClick={onToggle}
      className={cn(TOGGLE, className)}
      {...rest}
    >
      <OneOf
        active={open ? "less" : "more"}
        className="inline-grid"
        options={[
          { key: "more", node: more },
          { key: "less", node: less },
        ]}
      />
      <Icon name="expand" aria-hidden className={cn("transition-transform motion-reduce:transition-none", open && "rotate-180")} />
    </Button>
  );
}

/**
 * "Add a note": the offer of an optional text answer, the note glyph in front. A required answer is
 * never behind it; the caller draws that field open.
 */
export function NoteToggle({ open, onToggle, controls, disabled, className, label, ...rest }: ToggleProps & { label: string }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      aria-expanded={open}
      aria-controls={open ? controls : undefined}
      disabled={disabled}
      onClick={onToggle}
      className={cn(TOGGLE, className)}
      {...rest}
    >
      <Icon name="add-note" aria-hidden />
      {label}
    </Button>
  );
}

/** The part a toggle opens, through `Collapse`. Its `id` is the toggle's `controls`. */
export function FoldPanel({
  id,
  open,
  className,
  children,
  "data-slot": slot,
}: {
  id: string;
  open: boolean;
  className?: string;
  children: ReactNode;
  "data-slot"?: string;
}) {
  return (
    <Collapse open={open}>
      <div id={id} data-slot={slot} className={className}>
        {children}
      </div>
    </Collapse>
  );
}
