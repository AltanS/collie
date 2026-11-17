import { Icon } from "@/components/icons/icon";

import { ToggleButton } from "@/components/ui/toggle-button";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";

// The Dashboard's "needs you" switch (ADR 0147 rule 8, the old Focus tab of ADRs 0066 and 0068). One
// toggle button at the end of the summary line's row; the pane order is a select on the row below.
// On, each workspace shows only the panes that need you; it is a filter and never a sort.
//
// It wears `CircleDot`, the icon the Focus tab wore, so a person who knew the tab finds the switch.
// It is not a bell: a bell reads as a notification inbox even at rest, and a red count on it reads as
// two alerts stacked, while a dotted circle reads as a place to look. The glyph key is `needs-you`
// (components/icons/keys.ts).
// On, it takes the primary tint (`bg-primary/10 text-primary`, as the Changes filter button does)
// and a hairline primary ring. The ring is what keeps it apart from a selected segment of the pane
// switcher's order toggle, which is `bg-muted`: with the brand's near-black primary the two fills
// read alike, and one control on and the other selected must never look like the same state.
// The glyph is the control and the accessible name says what it does; `aria-pressed` says its state.
// A 44px square, like the order toggle's segments. The look is `ui/toggle-button.tsx`, which the
// Files view's Ignored toggle wears too.
export function NeedsYouSwitch({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  useLocale();
  return (
    <ToggleButton
      pressed={on}
      onPressedChange={onChange}
      label={t("home.needsYouOnly")}
      icon={<Icon name="needs-you" className="size-4 shrink-0" />}
    />
  );
}
