import type { ReactNode } from "react";

import { HillArmedSlot, useHillSwitchArm, useHillSwitchValue, type HillSwitchValue } from "@/components/hill-switch-arm";
import { Icon } from "@/components/icons/icon";
import { ExperimentalBadge } from "@/components/experimental-badge";
import { FeatureTokenChip } from "@/components/token-use-label";
import { BuiltInLabel } from "@/components/trick-detail";
import { TrickRowFrame } from "@/components/trick-row-frame";
import { Card } from "@/components/ui/card";
import { ROW_OPEN_SWITCH } from "@/components/ui/row-open";
import { Switch } from "@/components/ui/switch";
import { useLocale } from "@/hooks/use-locale";
import { t, tn } from "@/lib/i18n";
import { HILL_DETAIL_KEY, trickDetailPath } from "@/lib/nav";
import { useScope } from "@/lib/session";

// THE HILL'S ROW, the first row of the trick list in Settings, Tricks (2026-11-22). The Hill is a trick that ships with Collie, so
// it stands in the list like one: the same row (`TrickRowFrame`, the stretched link of `ui/row-open.ts`), its mountain
// before the name (inside the link, so the lines under keep the row's full width), the label "Built in" in the neutral look, the Experimental badge and the token chip, the one line of
// what it is, a line while Decisions wait, and its own switch at the right. A tap anywhere but the switch opens its
// details page (`settings/tricks/hill`, components/hill-page.tsx). It holds no value of its own: the switch is the
// Hill's (`useHillSwitch`, `POST /api/hill/switch`), and its armed second tap is the head's (components/hill-switch-arm.tsx).
//
// THE ROW DOES NOT DEPEND ON THE TRICKS SWITCH. The Hill runs no trick code. With tricks off as a whole, on a crew member,
// and where the phone holds no tricks reply, the row is drawn and its switch works. The list card draws it first; where
// that card is not drawn it stands alone in `HillRowCard`, in the same card look.

/** The mark the settings search scrolls to: the row is the slot of `tricks.hill`, so the list's own rows keep their direct place in the list group. */
const MARKED = "scroll-my-4 data-[marked=true]:outline-2 data-[marked=true]:-outline-offset-2 data-[marked=true]:outline-ring";

export interface HillRowProps extends HillSwitchValue {
  /** The Hill's details page. */
  to: string;
}

/** The row itself, every value handed in, so the playground draws the real markup in each state. */
export function HillRow({ on, disabled, waiting, onToggle, to }: HillRowProps) {
  useLocale();
  const arm = useHillSwitchArm({ on, waiting, onToggle });
  return (
    <TrickRowFrame
      rowData={{ "data-hill-row": "", "data-setting": "tricks.hill" }}
      className={MARKED}
      to={to}
      name={t("settings.hill.label")}
      linkSlot="hill-about"
      glyph={<Icon name="hill" className="size-5 shrink-0 text-muted-foreground" aria-hidden />}
      wrapLabels
      labels={
        <>
          <BuiltInLabel />
          <ExperimentalBadge />
          <FeatureTokenChip feature="hill" />
        </>
      }
      description={t("settings.hill.row")}
      control={
        <span data-slot="hill-switch" className="flex shrink-0">
          <Switch checked={on} disabled={disabled} onCheckedChange={arm.flip} aria-label={t("settings.hill.label")} className={ROW_OPEN_SWITCH} />
        </span>
      }
      below={<HillArmedSlot arm={arm} waiting={waiting} className="mt-3" />}
    >
      {waiting > 0 && (
        <p data-line="slot" className="truncate text-xs text-muted-foreground">
          {tn("home.tabs.hill", waiting)}
        </p>
      )}
    </TrickRowFrame>
  );
}

/** The row with the Hill's own value: the bridge's switch, the open count, the details page of the machine in view. */
export function HillRowControl() {
  const value = useHillSwitchValue();
  const scope = useScope();
  return <HillRow {...value} to={trickDetailPath(HILL_DETAIL_KEY, scope)} />;
}

/** A list card that holds only the Hill's row: the card's look, for where the trick list is not drawn. */
export function HillRowCard({ children }: { children: ReactNode }) {
  return (
    <Card className="gap-0 py-0" data-testid="hill-row-card">
      <div data-slot="list-group">{children}</div>
    </Card>
  );
}
