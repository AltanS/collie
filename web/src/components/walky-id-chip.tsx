import { Fragment, type ComponentType } from "react";

import { useWalkyChips } from "@/components/walky-log";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
import { splitWalkyIds } from "@/lib/walky";
import { cn } from "@/lib/utils";

// A walky talky message id in running text, drawn as a chip that opens the Messages sheet on that
// message (M62). The id in the text is a CLAIM: an agent can print any `wt_` and twelve characters.
// So a chip is drawn only where the pane's log HOLDS the id (`useWalkyChips`), and every other id
// stays the plain text it was. With no sheet to open there is no chip at all.
//
// ── THE SHAPE ─────────────────────────────────────────────────────────────────
// Monospace and quiet: a hairline edge on a faint wash, the muted ink. Louder than that and a reply
// full of ids would look like a form. It is a button, never a link: it moves nothing off the screen,
// it opens a sheet over it.
//
// The 44px floor is bought as HIT area, the way the strips buy it (ui/labelled-strip.tsx): the drawn
// box stays one line of text high, and a transparent `::before` reaches out above and below it, so a
// line of prose does not grow. Two chips on neighbouring lines have touching reaches, and each tap
// goes to the nearer one.
//
// `onDark` is for the command block, which is drawn in the mirror's own colour space (DESIGN.md §8):
// inside it every colour is a literal of that space, never a token.

const CHIP_CLASS =
  "relative inline-block select-none rounded-sm border px-1 py-px align-baseline font-mono text-[0.9em] leading-snug whitespace-nowrap [font-variant-ligatures:none] before:absolute before:-inset-x-1 before:-inset-y-3 before:content-[''] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:opacity-70";
const CHIP_TONE = "border-border bg-muted/50 text-muted-foreground";
const CHIP_TONE_DARK = "border-white/20 bg-white/10 text-inherit";

export function WalkyIdChip({ id, onOpen, onDark = false }: { id: string; onOpen: (id: string) => void; onDark?: boolean }) {
  useLocale();
  return (
    <button
      type="button"
      data-slot="walky-id-chip"
      data-id={id}
      aria-label={t("walky.chip.aria", { id })}
      onClick={() => onOpen(id)}
      className={cn(CHIP_CLASS, onDark ? CHIP_TONE_DARK : CHIP_TONE)}
    >
      {id}
    </button>
  );
}

/**
 * A run of text with each id the log holds drawn as a chip, and everything else as it was. `plain`
 * is the component that draws a text part (the caller's own highlight rule); the default is the bare string.
 * With no chip to draw this returns the text as it came, so a screen with no messages pays one
 * `includes` per run.
 */
export function WalkyIds({
  text,
  plain: Plain,
  onDark = false,
}: {
  text: string;
  plain?: ComponentType<{ text: string }>;
  onDark?: boolean;
}) {
  const chips = useWalkyChips();
  if (chips === null || !text.includes("wt_")) return Plain === undefined ? <>{text}</> : <Plain text={text} />;
  const parts = splitWalkyIds(text, chips.holds);
  if (parts.length === 1 && parts[0]?.kind === "text") return Plain === undefined ? <>{text}</> : <Plain text={text} />;
  return (
    <>
      {parts.map((part, i) => (
        <Fragment key={i}>
          {part.kind === "id" ? (
            <WalkyIdChip id={part.id} onOpen={chips.open} onDark={onDark} />
          ) : Plain === undefined ? (
            part.text
          ) : (
            <Plain text={part.text} />
          )}
        </Fragment>
      ))}
    </>
  );
}
