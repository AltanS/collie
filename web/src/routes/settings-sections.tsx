import { useLoaderData } from "react-router";
import { FlaskConical } from "lucide-react";

import { SettingsPage } from "@/components/settings-page";
import { Notice } from "@/components/ui/notice";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
import { BeltSizeControl } from "@/components/belt-size-control";
import { ChangesControl } from "@/components/changes-control";
import { ConnectionInfo } from "@/components/connection-info";
import { CrewSettingsCard } from "@/components/crew-settings-card";
import { FontSettingsControl } from "@/components/font-settings";
import { HandsFreeControl } from "@/components/hands-free-control";
import { HapticsControl } from "@/components/haptics-control";
import { HarnessBarControl } from "@/components/harness-bar-control";
import { LanguageControl } from "@/components/language-control";
import { NotifyPrefsControl } from "@/components/notify-prefs-control";
import { PaneOrderControl } from "@/components/pane-order-control";
import { PairedDevices } from "@/components/paired-devices";
import { PushControl, usePushAvailability } from "@/components/push-control";
import { SnoozeControl } from "@/components/snooze-control";
import { ThemeControl } from "@/components/theme-control";
import { CompactionsControl } from "@/components/compactions-control";
import { ToolCallsControl } from "@/components/tool-calls-control";
import { TourControl } from "@/components/tour-control";
import { TypefaceControl } from "@/components/typeface-control";
import { UpdatesSettingsCard } from "@/components/updates-settings-card";
import { ZenControl } from "@/components/zen-control";
import { useServerBuild } from "@/hooks/use-server-build";
import { EMPTY_DEVICES, type DevicesData } from "@/lib/loaders";
import { useOptionalRootData } from "@/lib/route-data";

// ── THE SETTINGS SECTIONS ───────────────────────────────────────────────────────────────────────
//
// Settings was one column of seventeen cards, and the file said so: "Settings is a flat stack of
// cards and has no headings at all; introducing the first one here would imply four more." It
// implied four more. On a phone the stack was over a thousand pixels of scroll with nothing to
// skim by, so a person looking for one switch had to read every card to find it.
//
// It is an index now, each row opening one of these. Each page is short enough to take in at once,
// which is the whole reason for the split: not fewer settings, fewer at a time.
//
// ── WHY A FILE'S WORTH OF ROUTES EACH LIVE IN ONE ────────────────────────────
// Every other route in this directory is its own file because every other route has behaviour.
// These have none: each is an ordered list of cards that already exist, and the order IS the
// design. Five files of eight lines each would hide five one-line decisions in five places. The
// order within each page is commented where it is not obvious; the split between pages is
// commented once, here.
//
// ── THE SPLIT ────────────────────────────────────────────────────────────────
// Appearance — how this phone PRESENTS itself. Anything you would change to make the app look
//              different, including what the mirror renders with.
// Device     — how this phone TREATS you. Feedback, input, and what the pane menu is allowed to
//              offer. Nothing here changes a pixel until you do something.
// Alerts     — when Collie speaks up, on this device and bridge-wide.
// System     — what this thing is talking to, and whether it is well. Diagnostics and access.
// Experiments— what is not finished. The odd one out: it is the only section that can be absent,
//              and the only one whose CONTRACT, not whose subject, decides membership.
//
// The line that took the most argument is Changes (`ChangesControl`): it decides how a pane's
// Changes view FINDS repos, which sounds like appearance and is not. It is read by the pane menu
// and it changes what a request asks the bridge for, so it sits in Device beside zen's
// availability — both are standing decisions about what this phone may do, not about how it looks.

export function SettingsAppearanceRoute() {
  return (
    <SettingsPage title="settings.section.appearance.title">
      {/* The one people come here for, so it is first on the page they land on for it. */}
      <ThemeControl />
      {/* Beside appearance because both are "how this phone presents itself". */}
      <LanguageControl />
      {/* TWO FONT CARDS, ADJACENT, IN THIS ORDER. Adjacency answers the only question either one
          raises: "Typeface" is the APP's own face (ADR 0033), "Terminal font" is the mirror's.
          Reading them one after the other is what makes the split obvious. */}
      <TypefaceControl />
      <FontSettingsControl />
      {/* The harness bar, then the belt's size directly under what it carries: one factor for
          band, pills, icons and words (components/actions-row.tsx, `--belt-scale`). */}
      <HarnessBarControl />
      <BeltSizeControl />
      {/* Which way a pane list runs (ADR 0071). Here rather than in Device because it decides how a
          surface is ARRANGED, which is the same question every card above answers. The pane
          switcher's own toggle writes the same value; this is where you go to find it. */}
      <PaneOrderControl />
      {/* Last, and it is the odd one here: every card above changes how a surface LOOKS, and this
          one changes what a surface CONTAINS. It earns the place anyway, because the question it
          answers is the same question — what do I want on screen — and filing it under Device would
          put a rendering choice beside haptics. */}
      <ToolCallsControl />
      <CompactionsControl />
    </SettingsPage>
  );
}

export function SettingsDeviceRoute() {
  return (
    <SettingsPage title="settings.section.device.title">
      {/* Renders nothing where vibrate is unsupported. */}
      <HapticsControl />
      {/* Renders nothing where no provider is configured or the browser cannot record. */}
      <HandsFreeControl />
      {/* AVAILABILITY ONLY. This row does not turn zen on — it decides whether the pane's actions
          sheet offers the "Zen mode" row at all. Off by default, because zen takes away every way
          back except one floating button. */}
      <ZenControl />
      {/* How a pane's Changes view finds repos (ADR 0065). Read by the pane menu, not by here. */}
      <ChangesControl />
      {/* The ONLY way back to a tour that was interrupted — the tour is marked seen the moment it
          opens. An action, so the row ends in a button rather than a Switch. */}
      <TourControl />
    </SettingsPage>
  );
}

export function SettingsAlertsRoute() {
  const root = useOptionalRootData();
  const availability = usePushAvailability();
  return (
    <SettingsPage title="settings.section.alerts.title">
      <PushControl />
      {/* Mounted while push state is still UNKNOWN, and only removed once we positively learn the
          bridge has no VAPID keys. Gating on truthiness instead inserted ~400px into the middle of
          the page one frame late, shoving everything below it down. These two are bridge-wide
          settings — which transitions notify, and quiet hours — so they are meaningful whatever
          this particular device's push status turns out to be. */}
      {availability !== "server-off" && (
        <>
          <NotifyPrefsControl />
          <SnoozeControl snoozedUntil={root?.snoozedUntil ?? null} />
        </>
      )}
    </SettingsPage>
  );
}

/**
 * What the Experiments heading promises, said once at the top.
 *
 * A SCOPE NOTICE (DESIGN.md §11): it outlives the operator's next interaction and it is about this
 * view, so it holds space rather than floating. No `Collapse` around it, because it never appears
 * or disappears — it is a standing property of the page, not a state the page enters. `announce`
 * stays `"none"` for the same reason: a notice that never changes must not claim a live region.
 */
function ExperimentsContract() {
  useLocale();
  return (
    <Notice variant="box" tone="caution" icon={<FlaskConical className="size-4" />}>
      {t("settings.experiments.contract")}
    </Notice>
  );
}

/**
 * The fifth section, and the one whose heading is a promise rather than a subject.
 *
 * "Experimental" is a property of this SECTION'S CONTRACT, not an adjective on a card: everything
 * filed here may change shape, lose settings, or be withdrawn in a patch release, and that sentence
 * is worth saying once at the top rather than repeating per row. Which is also why an experiment's
 * switch is not a card in Appearance: read that page's own header above — every card there answers
 * "what do I want on screen", the ordering is argued card by card, and `ToolCallsControl` is
 * already flagged as "the odd one". An unstable toggle dropped in beside it breaks the rule the
 * page states about itself.
 *
 * The section renders even when `lib/experiments.ts` is empty, because the route stays; the
 * SETTINGS INDEX is what hides the row (routes/settings.tsx). A bookmark then lands on a page
 * carrying its contract and nothing else, which is the honest answer to "where did it go".
 */
export function SettingsExperimentsRoute() {
  return (
    <SettingsPage title="settings.section.experiments.title">
      <ExperimentsContract />
      {/* Nothing is filed here since Chat graduated (ADR 0082). The next experiment is a card here. */}
    </SettingsPage>
  );
}

export function SettingsSystemRoute() {
  const root = useOptionalRootData();
  const serverBuild = useServerBuild();
  // This page's OWN loader: the paired-device registry (lib/loaders.ts devicesLoader).
  // Defaulted rather than asserted: a harness that mounts this route without the loader (or a
  // navigation whose loader threw) must still render the rest of the page, not crash it.
  // SAFETY: `devicesLoader` returns `DevicesData` for this route; `undefined` is the case the
  // default below exists for. React Router types a data-mode `useLoaderData()` as `unknown`.
  const devices = (useLoaderData() as DevicesData | undefined) ?? EMPTY_DEVICES;
  return (
    <SettingsPage title="settings.section.system.title">
      {/* ONE row for the whole subject: updating is a flow with a lead, N peers, progress and a
          rollback state, so it lives on `/settings/updates` and this is the row that opens it. */}
      <UpdatesSettingsCard />
      {/* Access sits with the connection diagnostics — both answer "what is this device allowed to
          do, and why". Pairing is the gate you can change from here; ConnectionInfo below only
          reports the header-based one. */}
      <PairedDevices data={devices} />
      {/* Renders NOTHING on a solo install — the card owns that gate itself (useCrew().multi). */}
      <CrewSettingsCard />
      <ConnectionInfo bridge={root?.bridge} device={root?.device} build={serverBuild} />
    </SettingsPage>
  );
}
