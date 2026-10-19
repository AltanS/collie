import { ArrowLeft } from "lucide-react";

import { BottomBar } from "@/components/ui/bottom-bar";
import { Button } from "@/components/ui/button";
import type { Hand } from "@/hooks/use-display-prefs";
import { useKeyboardOpen } from "@/hooks/use-keyboard";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

// THE BACK A PHONE'S THUMB CAN REACH (DESIGN.md §12): a screen below a pane repeats its header's Back
// at the bottom, on the side of the hand that holds the phone. The Changes screen was the first to
// draw it; the zoomed output (components/output-zoom.tsx) is the second, so it lives here.

/**
 * A phone, as these screens draw it: under Tailwind's `md` (768px), where the column stops filling
 * the width and caps at `md:max-w-screen-md`. From there up the header arrow is in reach and the
 * bottom Back is not drawn.
 */
export const PHONE_QUERY = "(max-width: 767.98px)";

/**
 * The screen's one Back: what the header arrow does and what it is called, at the level on screen.
 * The header arrow and the bottom Back (a phone's thumb cannot reach the header) both take this
 * object, so the two cannot drift apart; a level that changes its way back changes both at once.
 */
export interface BackControl {
  /** ALREADY TRANSLATED. Where the tap lands, the arrow's accessible name. */
  label: string;
  go: () => void;
}

/** The Back button of the bottom bar: the header arrow's act and name, plus the word. */
export function BackButton({ back, className }: { back: BackControl; className?: string }) {
  return (
    <Button variant="outline" className={cn("h-11", className)} onClick={back.go} aria-label={back.label}>
      <ArrowLeft className="size-4" />
      {t("files.back")}
    </Button>
  );
}

/**
 * The bar under a level that has no other bottom controls: Back alone, on the side of the hand that
 * holds the phone, as wide as its word and not the row. Gone while the on-screen keyboard is up: the
 * bar would ride up over the keys and cost the screen a row's height it needs to show what is being
 * typed.
 */
export function BackBar({ back, hand }: { back: BackControl; hand: Hand }) {
  const keyboard = useKeyboardOpen();
  if (keyboard) return null;
  return (
    <BottomBar className={cn("flex", hand === "left" ? "justify-start" : "justify-end")}>
      <BackButton back={back} className="min-w-28" />
    </BottomBar>
  );
}
