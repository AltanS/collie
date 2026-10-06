// The Settings section pages. Port of web/src/routes/settings-sections.tsx, read there for why the
// split is Appearance / Device / Alerts / System / Experiments, and why each page is an ordered list
// of cards whose order IS the design.
//
//   Appearance   how this phone PRESENTS itself, including what the mirror renders with
//   Device       how this phone TREATS you: feedback, input, what the pane menu may offer
//   Alerts       when Collie speaks up, on this device and bridge-wide
//   System       what this thing is talking to, and whether it is well
//   Experiments  what is not finished: the only section that can be absent from the index
import type { Handle } from "remix/component";
import { FlaskConical } from "lucide";

import { t, type MessageKey } from "@web/lib/i18n";
import { settingsPath } from "@web/lib/nav";

import { address } from "../../lib/data";
import { useLocale } from "../../lib/i18n-store";
import { useStore } from "../../lib/store";
import { Icon } from "../../ui/icon";
import { Notice } from "../../ui/notice";
import { BridgeWideAlerts, PushControl } from "./alerts";
import { LanguageControl, ThemeControl } from "./appearance";
import { ChangesControl, HandsFreeControl, HapticsControl, TourControl, ZenControl } from "./device";
import { BeltSizeControl, CompactionsControl, HarnessBarControl, PaneOrderControl, ToolCallsControl } from "./display";
import { FontSettingsControl } from "./fonts";
import { SettingsPage } from "./page";
import { PairedDevices } from "./paired-devices";
import { ConnectionInfo, CrewCard, UpdatesRow } from "./system";
import { TypefaceControl } from "./typeface";

export type SettingsSection = "appearance" | "device" | "alerts" | "system" | "experiments";

const TITLES = {
  appearance: "settings.section.appearance.title",
  device: "settings.section.device.title",
  alerts: "settings.section.alerts.title",
  system: "settings.section.system.title",
  experiments: "settings.section.experiments.title",
} as const satisfies Record<SettingsSection, MessageKey>;

export function isSettingsSection(value: string): value is SettingsSection {
  return Object.hasOwn(TITLES, value);
}

export function SettingsSectionRoute(handle: Handle<{ section: SettingsSection }>) {
  const where = useStore(handle, address);
  useLocale(handle);
  return () => {
    const { section } = handle.props;
    return (
      // Keyed by section: a move from one section to another is a new page with its own cards.
      <SettingsPage key={section} title={TITLES[section]} up={settingsPath(where().scope)}>
        {section === "appearance" ? (
          <>
            {/* The one people come here for, so it is first. */}
            <ThemeControl />
            <LanguageControl />
            {/* TWO FONT CARDS, ADJACENT, IN THIS ORDER: "Typeface" is the APP's own face (ADR 0033),
                "Terminal font" is the mirror's. Reading them one after the other is what makes the
                split obvious. */}
            <TypefaceControl />
            <FontSettingsControl />
            <HarnessBarControl />
            <BeltSizeControl />
            <PaneOrderControl />
            {/* The odd one: every card above changes how a surface LOOKS, these two what it CONTAINS. */}
            <ToolCallsControl />
            <CompactionsControl />
          </>
        ) : null}
        {section === "device" ? (
          <>
            <HapticsControl />
            <HandsFreeControl />
            {/* AVAILABILITY ONLY: this row decides whether the actions sheet offers "Zen mode". */}
            <ZenControl />
            <ChangesControl />
            {/* The only way back to a tour that was interrupted: an action, so the row ends in a button. */}
            <TourControl />
          </>
        ) : null}
        {section === "alerts" ? (
          <>
            <PushControl />
            <BridgeWideAlerts />
          </>
        ) : null}
        {section === "system" ? (
          <>
            {/* ONE row for the whole subject: updating is a flow, and it lives on /settings/updates. */}
            <UpdatesRow />
            {/* Access sits with the connection diagnostics: both answer "what is this device allowed to do". */}
            <PairedDevices />
            <CrewCard />
            <ConnectionInfo />
          </>
        ) : null}
        {section === "experiments" ? (
          <Notice variant="box" tone="caution" icon={<Icon icon={FlaskConical} />}>
            {t("settings.experiments.contract")}
          </Notice>
        ) : null}
      </SettingsPage>
    );
  };
}
