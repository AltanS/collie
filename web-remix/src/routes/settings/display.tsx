// The Appearance cards that are plain per-device choices over `lib/prefs.ts`: the harness bar, the
// belt's size, which way a pane list runs, and what a session view draws (tool calls, compactions).
// Ports of web/'s HarnessBarControl, BeltSizeControl, PaneOrderControl, ToolCallsControl and
// CompactionsControl; their long arguments stay in web/ and are not repeated here.
import { on, type Handle } from "remix/component";
import { ArrowDownUp, Clock, FolderTree, Hourglass, Rows3, Scissors, SlidersHorizontal, Wrench, type IconNode } from "lucide";

import { BELT_SCALES, type BeltScale } from "@web/hooks/use-dash-prefs";
import { t, type MessageKey } from "@web/lib/i18n";
import { PANE_ORDERS, type PaneOrder } from "@web/lib/pane-order";
import { cn } from "@web/lib/utils";

import { useLocale } from "../../lib/i18n-store";
import { dashPrefs, harnessBar, setDashPref } from "../../lib/prefs";
import { useStore } from "../../lib/store";
import { Card } from "../../ui/card";
import { Icon } from "../../ui/icon";
import { Switch } from "../../ui/switch";
import { CardHead, ChoiceBand, SwitchSlot } from "./parts";

/** ON by default: the way OUT of a row the operator can already see. */
export function HarnessBarControl(handle: Handle) {
  const read = useStore(handle, harnessBar);
  useLocale(handle);
  return () => (
    <Card class="gap-0 py-0" data-testid="harness-bar-card">
      <CardHead icon={SlidersHorizontal} title={t("settings.harnessBar.title")} description={t("settings.harnessBar.description")}>
        <SwitchSlot>
          <Switch checked={read()} aria-label={t("settings.harnessBar.title")} onCheckedChange={(next) => harnessBar.set(next)} />
        </SwitchSlot>
      </CardHead>
    </Card>
  );
}

const BELT_LABELS = {
  1.15: "settings.beltSize.option.default",
  1.3: "settings.beltSize.option.large",
  1.5: "settings.beltSize.option.larger",
} as const satisfies Record<BeltScale, MessageKey>;

/** `--belt-scale`: three sizes the belt was measured at, and no in-between one. */
export function BeltSizeControl(handle: Handle) {
  const read = useStore(handle, dashPrefs);
  useLocale(handle);
  return () => (
    <Card class="gap-0 py-0" data-testid="belt-size-card">
      <CardHead icon={Rows3} title={t("settings.beltSize.title")} description={t("settings.beltSize.description")} />
      <ChoiceBand
        class="border-t border-border p-2"
        label={t("settings.beltSize.title")}
        value={read().beltScale}
        options={BELT_SCALES.map((scale) => ({ value: scale, label: t(BELT_LABELS[scale]) }))}
        onChange={(scale) => setDashPref("beltScale", BELT_SCALES.find((s) => s === scale) ?? BELT_SCALES[0])}
      />
    </Card>
  );
}

const ORDER_SEGMENTS = {
  place: { label: "paneOrder.place", icon: FolderTree },
  activity: { label: "paneOrder.activity", icon: Clock },
  cache: { label: "paneOrder.cache", icon: Hourglass },
} as const satisfies Record<PaneOrder, { label: MessageKey; icon: IconNode }>;

/** Place by default (ADR 0063); activity is the order the operator asks for (ADR 0071). */
export function PaneOrderControl(handle: Handle) {
  const read = useStore(handle, dashPrefs);
  useLocale(handle);
  return () => {
    const order = read().paneOrder;
    return (
      <Card class="gap-0 py-0" data-testid="pane-order-card">
        <CardHead icon={ArrowDownUp} title={t("paneOrder.aria")} description={t("settings.paneOrder.description")} />
        <div class="border-t border-border p-2">
          <div role="radiogroup" aria-label={t("paneOrder.aria")} class="flex gap-1">
            {PANE_ORDERS.map((value) => {
              const { label, icon } = ORDER_SEGMENTS[value];
              const selected = value === order;
              return (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={selected ? "true" : "false"}
                  mix={on("click", () => setDashPref("paneOrder", value))}
                  class={cn(
                    "flex min-h-11 flex-1 items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                    selected ? "bg-muted text-foreground" : "text-muted-foreground active:bg-muted",
                  )}
                >
                  <Icon icon={icon} class="size-4 shrink-0" />
                  {t(label)}
                </button>
              );
            })}
          </div>
        </div>
      </Card>
    );
  };
}

/** OFF by default: what the agent SAID is what the page is for; what it DID is one tap away. */
export function ToolCallsControl(handle: Handle) {
  const read = useStore(handle, dashPrefs);
  useLocale(handle);
  return () => (
    <Card class="gap-0 py-0" data-testid="tool-calls-card">
      <CardHead icon={Wrench} title={t("settings.tools.title")} description={t("settings.tools.description")}>
        <Switch
          checked={read().showToolCalls}
          aria-label={t("settings.tools.title")}
          onCheckedChange={(next) => setDashPref("showToolCalls", next)}
        />
      </CardHead>
    </Card>
  );
}

/** OFF by default: one marker line where the compaction happened, never the recap's text. */
export function CompactionsControl(handle: Handle) {
  const read = useStore(handle, dashPrefs);
  useLocale(handle);
  return () => (
    <Card class="gap-0 py-0" data-testid="compactions-card">
      <CardHead icon={Scissors} title={t("settings.compactions.title")} description={t("settings.compactions.description")}>
        <Switch
          checked={read().showCompactions}
          aria-label={t("settings.compactions.title")}
          onCheckedChange={(next) => setDashPref("showCompactions", next)}
        />
      </CardHead>
    </Card>
  );
}
