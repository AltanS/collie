import { Icon } from "@/components/icons/icon";
import { Navigate, useLoaderData } from "react-router";

import { AppearanceIntro } from "@/components/appearance-intro";
import { CharacterPicker } from "@/components/character-picker";
import { CharacterSettingsRow } from "@/components/character-settings-row";
import { SettingSlot } from "@/components/setting-slot";
import { SettingsPage } from "@/components/settings-page";
import { Notice } from "@/components/ui/notice";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
import { BeltSizeControl } from "@/components/belt-size-control";
import { UsageRowControl } from "@/components/usage-row-control";
import { ZoomPillControl } from "@/components/zoom-pill-control";
import { PageZoomControl } from "@/components/page-zoom-control";
import { ChangesControl } from "@/components/changes-control";
import { ConnectionInfo } from "@/components/connection-info";
import { CrewSettingsCard } from "@/components/crew-settings-card";
import { KeepChatControl } from "@/components/keep-chat-control";
import { FontSettingsControl } from "@/components/font-settings";
import { HandControl } from "@/components/hand-control";
import { SentSuggestionsControl } from "@/components/sent-suggestions-control";
import { SpeechControl } from "@/components/speech-control";
import { HapticsControl } from "@/components/haptics-control";
import { HarnessBarControl } from "@/components/harness-bar-control";
import { HarnessPrefsControl } from "@/components/harness-prefs-control";
import { HillSwitchControl } from "@/components/hill-switch-card";
import { LanguageControl } from "@/components/language-control";
import { ClearNotificationsControl } from "@/components/clear-notifications-control";
import { NotifyPrefsControl } from "@/components/notify-prefs-control";
import { EnterSendsControl } from "@/components/enter-sends-control";
import { ProjectPicturesControl } from "@/components/project-pictures-control";
import { PaneNavControl } from "@/components/pane-nav-control";
import { PaneOrderControl } from "@/components/pane-order-control";
import { WideLayoutControl } from "@/components/wide-layout-control";
import { PairedDevices } from "@/components/paired-devices";
import { PushControl, usePushAvailability } from "@/components/push-control";
import { ReportControl } from "@/components/report-control";
import { ShortcutSettingsRow } from "@/components/shortcut-settings-row";
import { WorktreeFolderControl } from "@/components/worktree-folder-control";
import { SnoozeControl } from "@/components/snooze-control";
import { ThemeControl } from "@/components/theme-control";
import { ThemePickerControl } from "@/components/theme-picker-control";
import { CompactionsControl } from "@/components/compactions-control";
import { ToolCallsControl } from "@/components/tool-calls-control";
import { TourControl } from "@/components/tour-control";
import { TypefaceControl } from "@/components/typeface-control";
import { TelemetrySettingsCard, TelemetrySettingsRow } from "@/components/telemetry-settings-card";
import { MathControl } from "@/components/math-control";
import { TricksSettingsCard } from "@/components/tricks-settings-card";
import { TricksSwitchControl } from "@/components/tricks-switch-card";
import { TrickCardsWaiting } from "@/components/trick-cards";
import { ZenControl } from "@/components/zen-control";
import { FloatingThingsControl } from "@/components/floating-things-control";
import { useServerDiagnostics } from "@/hooks/use-server-diagnostics";
import { EMPTY_DEVICES, type DevicesData } from "@/lib/loaders";
import { settingsSectionPath } from "@/lib/nav";
import { useOptionalRootData } from "@/lib/route-data";
import { useScope } from "@/lib/session";

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
// Harnesses  — what Chat lifts out of each harness's own screen, per harness. The status line is
//              the first member; it sits after Appearance because it decides what the screen shows.
// Device     — how this phone TREATS you. Feedback, input, and what the pane menu is allowed to
//              offer. Nothing here changes a pixel until you do something.
// Voice      — how your voice becomes text: a hub with this phone's own choice and hands-free, and
//              two pages below it, Host speech (the host's option, for every device) and Whistle
//              model (its copies). Its row is never hidden; a host that offers nothing gets a page
//              that says so.
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
      {/* "Make Collie your own": one line and a docs link over the two cards that make the app
          yours, in the order a person decides them: the theme (Paste, Browse and Try live in its
          card), then which half of the theme you see. The header's character comes with the theme
          unless this device picks one: that is the Character row below them. */}
      <SettingSlot ids={["look.intro", "look.themesDocs"]}>
        <AppearanceIntro />
      </SettingSlot>
      {/* Which theme, then which half of it: the picker sits directly above the three-way (System,
          Light, Dark) because the two are one question asked twice, and a person who finds one
          should find the other. First on the page, because it is the one people come here for. */}
      <SettingSlot ids={["look.theme", "look.theme.about", "look.theme.browse", "look.theme.import", "look.theme.paste", "look.theme.export", "look.theme.remove", "look.theme.trial"]}>
        <ThemePickerControl />
      </SettingSlot>
      <SettingSlot ids={["look.lightDark"]}>
        <ThemeControl />
      </SettingSlot>
      {/* Which character the header draws on this device: one row with its value, and the page it
          opens lists them (ADR 0136, amended 2026-11-12). Under the theme because its default is
          "From the theme". */}
      <SettingSlot ids={["look.character"]}>
        <CharacterSettingsRow />
      </SettingSlot>
      {/* Beside appearance because both are "how this phone presents itself". */}
      <SettingSlot ids={["look.language"]}>
        <LanguageControl />
      </SettingSlot>
      {/* TWO FONT CARDS, ADJACENT, IN THIS ORDER. Adjacency answers the only question either one
          raises: "Typeface" is the APP's own face (ADR 0033), "Terminal font" is the mirror's.
          Reading them one after the other is what makes the split obvious. */}
      <SettingSlot ids={["look.typeface"]}>
        <TypefaceControl />
      </SettingSlot>
      <SettingSlot ids={["look.terminalFont", "look.textSize.terminal", "look.textSize.draft"]}>
        <FontSettingsControl />
      </SettingSlot>
      {/* How agent prose draws LaTeX. Under the two font cards, because it is the same question —
          what text looks like — asked of a formula, and above the cards that arrange surfaces. */}
      <SettingSlot ids={["look.math", "look.math.download", "look.math.remove"]}>
        <MathControl />
      </SettingSlot>
      {/* The harness bar, then the belt's size directly under what it carries: one factor for
          band, pills, icons and words (components/actions-row.tsx, `--belt-scale`). */}
      <SettingSlot ids={["keys.harnessShortcuts"]}>
        <HarnessBarControl />
      </SettingSlot>
      <SettingSlot ids={["look.beltSize"]}>
        <BeltSizeControl />
      </SettingSlot>
      {/* The belt's Zoom pill: in the Screen view or never (lib/zoom-pill.ts). Under the belt's size
          because both decide what that one belt carries. */}
      <SettingSlot ids={["chat.zoomButton"]}>
        <ZoomPillControl />
      </SettingSlot>
      {/* Whether a pinch zooms the whole page (lib/page-zoom.ts). Under the Zoom pill because both
          decide what a zoom does on this phone. On by default, for anyone who needs bigger text. */}
      <SettingSlot ids={["keys.pinchZoom"]}>
        <PageZoomControl />
      </SettingSlot>
      {/* How the usage row (the model, context and limits) draws its gauges: a percentage or dots
          (lib/usage-row.ts). Under the zoom cards because it too decides how the belt's surroundings read. */}
      <SettingSlot ids={["chat.contextLimits"]}>
        <UsageRowControl />
      </SettingSlot>
      {/* Which thumb the belt and the reply box are laid out for. Under the belt's size because both
          decide how that one belt is drawn. */}
      <SettingSlot ids={["keys.hand"]}>
        <HandControl />
      </SettingSlot>
      {/* Which way a pane list runs (ADR 0071). Here rather than in Device because it decides how a
          surface is ARRANGED, which is the same question every card above answers. The pane
          switcher's own toggle writes the same value; this is where you go to find it. */}
      <SettingSlot ids={["dashboard.paneOrder"]}>
        <PaneOrderControl />
      </SettingSlot>
      {/* Whether a tablet or an open Fold may show the sidebar and the strip of panes (ADR 0120). The
          way out for a screen where the layout misbehaves, so it sits with the other arrangement
          choices. Stored per device. */}
      <SettingSlot ids={["look.largeScreen"]}>
        <WideLayoutControl />
      </SettingSlot>
      {/* Whether Enter from a physical keyboard sends the reply (ADR 0157). Beside Large-screen layout, because
          both are about a keyboard and a screen big enough to have one. Off until the person turns it on;
          stored per device. */}
      <SettingSlot ids={["keys.enterSends"]}>
        <EnterSendsControl />
      </SettingSlot>
      {/* Whether a repository's own picture stands in for the agent logo (ADR 0160).
          On until the person turns it off; stored per device. */}
      <SettingSlot ids={["look.projectPictures"]}>
        <ProjectPicturesControl />
      </SettingSlot>
      {/* How the pane screen moves between panes and spaces by gesture (ADR 0121): Two fingers,
          Joystick or Off. Beside Large-screen layout, because both decide how the pane screen is
          arranged and moved through. Stored per device with the hand. */}
      <SettingSlot ids={["keys.paneNav"]}>
        <PaneNavControl />
      </SettingSlot>
      {/* Last, and it is the odd one here: every card above changes how a surface LOOKS, and this
          one changes what a surface CONTAINS. It earns the place anyway, because the question it
          answers is the same question — what do I want on screen — and filing it under Device would
          put a rendering choice beside haptics. */}
      <SettingSlot ids={["chat.toolCalls"]}>
        <ToolCallsControl />
      </SettingSlot>
      <SettingSlot ids={["chat.compactions"]}>
        <CompactionsControl />
      </SettingSlot>
      {/* Whether tricks may draw small moving pictures over the app (the `float` place). One switch for all of
          them, on by default; each trick keeps its own switch in Settings → Tricks. It decides what the app
          shows over a page, so it sits here with the other choices about what is on screen. */}
      <SettingSlot ids={["look.floatingThings"]}>
        <FloatingThingsControl />
      </SettingSlot>
    </SettingsPage>
  );
}

export function SettingsHarnessesRoute() {
  return (
    <SettingsPage title="settings.section.harnesses.title">
      {/* One card, one row per harness the web has an adapter for, Claude Code first. Its own page
          rather than a card on Appearance: the rows are per HARNESS, a list that grows with every
          adapter, and Appearance is a handful of cards about the phone. Each switch is a standing
          per-device choice about what Chat lifts out of that harness's screen. */}
      <SettingSlot ids={["chat.statusLine"]}>
        <HarnessPrefsControl />
      </SettingSlot>
    </SettingsPage>
  );
}

export function SettingsDeviceRoute() {
  return (
    <SettingsPage title="settings.section.device.title">
      {/* Renders nothing where vibrate is unsupported. */}
      <SettingSlot ids={["keys.haptics"]}>
        <HapticsControl />
      </SettingSlot>
      {/* AVAILABILITY ONLY. This row does not turn zen on — it decides whether the pane's actions
          sheet offers the "Zen mode" row at all. Off by default, because zen takes away every way
          back except one floating button. */}
      <SettingSlot ids={["keys.zen", "keys.zenTurn"]}>
        <ZenControl />
      </SettingSlot>
      {/* Whether a shell pane offers lines from Sent above its box as you type (M61). A standing choice
          about this phone's composer, stored with the display prefs. */}
      <SettingSlot ids={["keys.sentSuggestions"]}>
        <SentSuggestionsControl />
      </SettingSlot>
      {/* How a pane's Changes view finds repos (ADR 0065). Read by the pane menu, not by here. */}
      <SettingSlot ids={["dashboard.changes.nested", "dashboard.changes.depth"]}>
        <ChangesControl />
      </SettingSlot>
      {/* The list of desktop shortcuts (M108), the visible control of the `help` action. A button that opens
          the same sheet `prefix+?` does, and only on a device that has shown a hardware key press. Renders
          nothing before that. */}
      <SettingSlot ids={["keys.shortcuts"]}>
        <ShortcutSettingsRow />
      </SettingSlot>
      {/* What this phone keeps of each pane's Chat, and for how long (M46 spec 09). Here, beside the
          Changes search, because it is a standing decision about the device, not about a look. */}
      <SettingSlot ids={["privacy.keepChat", "privacy.keepChat.clear"]}>
        <KeepChatControl />
      </SettingSlot>
      {/* The ONLY way back to a tour that was interrupted — the tour is marked seen the moment it
          opens. An action, so the row ends in a button rather than a Switch. */}
      <SettingSlot ids={["updates.firstScreen"]}>
        <TourControl />
      </SettingSlot>
    </SettingsPage>
  );
}

export function SettingsVoiceRoute() {
  return (
    <SettingsPage title="settings.section.voice.title">
      {/* The hub (ADR 0096, ADR 0097): what happens when the mic is pressed, this phone's own choice,
          one row for the host's option with a way in, hands-free, and one row for the model. Says why
          it is empty on a host that offers nothing, since the index row is never hidden. */}
      <SettingSlot ids={["voice.status", "voice.audio", "voice.change", "voice.fix", "voice.phone", "voice.handsFree", "voice.host", "voice.model"]}>
        <SpeechControl page="hub" />
      </SettingSlot>
    </SettingsPage>
  );
}

/** Settings → Voice → Host speech: the host's five options, for every device on it. */
export function SettingsVoiceHostRoute() {
  const scope = useScope();
  return (
    <SettingsPage title="settings.voice.hostPage.title" parent={settingsSectionPath("voice", scope)}>
      <SettingSlot ids={["voice.host.uses", "voice.host.useOnHost", "voice.host.useChatgpt", "voice.host.useWhistle", "voice.host.changeForAll"]}>
        <SpeechControl page="host" />
      </SettingSlot>
    </SettingsPage>
  );
}

/** Settings → Voice → Whistle model: the model's credit and its two copies, on the host and on this phone. */
export function SettingsVoiceModelRoute() {
  const scope = useScope();
  return (
    <SettingsPage title="settings.voice.model.title" parent={settingsSectionPath("voice", scope)}>
      <SettingSlot ids={["voice.model.setUp", "voice.model.removeHost", "voice.model.copyToPhone", "voice.model.removePhone", "voice.model.restore", "voice.model.details"]}>
        <SpeechControl page="model" />
      </SettingSlot>
    </SettingsPage>
  );
}

export function SettingsAlertsRoute() {
  const root = useOptionalRootData();
  const availability = usePushAvailability();
  return (
    <SettingsPage title="settings.section.alerts.title">
      <SettingSlot ids={["notifications.push"]}>
        <PushControl />
      </SettingSlot>
      {/* Mounted while push state is still UNKNOWN, and only removed once we positively learn the
          bridge has no VAPID keys. Gating on truthiness instead inserted ~400px into the middle of
          the page one frame late, shoving everything below it down. These three are bridge-wide —
          which transitions notify, quiet hours, and clearing what was sent — so they are meaningful
          whatever this particular device's push status turns out to be. */}
      {availability !== "server-off" && (
        <>
          <SettingSlot ids={["notifications.needsYou", "notifications.finished", "notifications.perAgent", "notifications.newVersion", "notifications.machineLoad", "notifications.decisions", "notifications.cacheCold", "notifications.cacheWatch"]}>
            <NotifyPrefsControl />
          </SettingSlot>
          <SettingSlot ids={["notifications.doNotDisturb"]}>
            <SnoozeControl snoozedUntil={root?.snoozedUntil ?? null} />
          </SettingSlot>
          <SettingSlot ids={["notifications.clear"]}>
            <ClearNotificationsControl />
          </SettingSlot>
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
export function ExperimentsContract() {
  useLocale();
  return (
    <Notice variant="box" tone="caution" icon={<Icon name="experiments" className="size-4" />}>
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
 * Today it holds the Hill's one switch and the one switch for Tricks as a whole.
 */
export function SettingsExperimentsRoute() {
  return (
    <SettingsPage title="settings.section.experiments.title">
      <ExperimentsContract />
      {/* The Hill (bridge/hill/switch.ts): an experiment, off by default, and this is its one switch. Drawn from
          the snapshot, so it never waits on a reading of its own. Bridge-wide, like the notification switches. */}
      <SettingSlot ids={["tricks.hill"]}>
        <HillSwitchControl />
      </SettingSlot>
      {/* Tricks as a whole are an experiment too (bridge/tricks/feature-switch.ts), and this is their one switch,
          like the Hill's. While it is on, Settings shows a Tricks row for the list; off, the row is gone. */}
      <SettingSlot ids={["tricks.enabled"]}>
        <TricksSwitchControl />
      </SettingSlot>
    </SettingsPage>
  );
}

/**
 * Settings → Tricks (M94 slice 04): the list, one switch per trick. Its own section rather than a card
 * on System, because the rows are per TRICK, a list that grows with every folder the operator makes
 * (the same reason Harnesses is a page of its own).
 *
 * The switch for tricks as a whole is NOT here: it is the Tricks card in Settings, Experiments (2026-11-18), and
 * the index offers this page's row only while that switch is on. A deep link or a bookmark to this page while
 * the switch is off REDIRECTS (replace, so Back does not return to a page that only redirects) to Settings,
 * Experiments, where the switch is. The value is the snapshot's `tricksOff`, so the answer is there from the
 * first frame and the list never flashes.
 */
export function SettingsTricksRoute() {
  const root = useOptionalRootData();
  const scope = useScope();
  if (root?.tricksOff === true) return <Navigate to={settingsSectionPath("experiments", scope)} replace />;
  return (
    <SettingsPage title="settings.section.tricks.title" keepScroll>
      {/* The cards of Collie's own that wait for a yes (M96 spec 14): with the Hill off, the one list of them. */}
      <SettingSlot ids={["tricks.waiting"]}>
        <TrickCardsWaiting />
      </SettingSlot>
      <SettingSlot ids={["tricks.list", "tricks.addRepo", "tricks.addRepo.link", "tricks.official.add", "tricks.official.update"]}>
        <TricksSettingsCard />
      </SettingSlot>
    </SettingsPage>
  );
}

export function SettingsSystemRoute() {
  const root = useOptionalRootData();
  const diagnostics = useServerDiagnostics();
  // This page's OWN loader: the paired-device registry (lib/loaders.ts devicesLoader).
  // Defaulted rather than asserted: a harness that mounts this route without the loader (or a
  // navigation whose loader threw) must still render the rest of the page, not crash it.
  // SAFETY: `devicesLoader` returns `DevicesData` for this route; `undefined` is the case the
  // default below exists for. React Router types a data-mode `useLoaderData()` as `unknown`.
  const devices = (useLoaderData() as DevicesData | undefined) ?? EMPTY_DEVICES;
  return (
    <SettingsPage title="settings.section.system.title">
      {/* Access sits with the connection diagnostics — both answer "what is this device allowed to
          do, and why". Pairing is the gate you can change from here; ConnectionInfo below only
          reports the header-based one. */}
      <SettingSlot ids={["devices.pair", "devices.pair.code", "devices.pair.name", "devices.unpair", "devices.paired", "devices.revoke"]}>
        <PairedDevices data={devices} />
      </SettingSlot>
      {/* Renders NOTHING on a solo install — the card owns that gate itself (useCrew().multi). */}
      <SettingSlot ids={["devices.crew", "devices.machines"]}>
        <CrewSettingsCard />
      </SettingSlot>
      {/* Where this machine's new worktrees go by default (ADR 0093 note): one row per machine. */}
      <SettingSlot ids={["dashboard.worktreeFolder"]}>
        <WorktreeFolderControl />
      </SettingSlot>
      <SettingSlot ids={["devices.connection", "devices.connection.endpoint", "devices.connection.secure", "devices.connection.bridge", "devices.connection.access", "devices.connection.masking", "devices.connection.serverBuild"]}>
        <ConnectionInfo
          bridge={root?.bridge}
          device={root?.device}
          build={diagnostics.build}
          redact={diagnostics.redact}
          denied={root?.authError === true}
        />
      </SettingSlot>
      {/* The anonymous install count (M86 spec 02, ADR 0129): one row with its state, above the report
          card because both are about what this machine says to Collie's host. The switch, the cause
          and the next message are the page the row opens. */}
      <SettingSlot ids={["privacy.telemetry"]}>
        <TelemetrySettingsRow />
      </SettingSlot>
      {/* Report a problem (ADR 0123): the offer's switch and the sheet's third door, with the diagnostics
          because a report is the one way those leave this phone, and only by the person's taps. */}
      <SettingSlot ids={["updates.reportOffer", "updates.report"]}>
        <ReportControl />
      </SettingSlot>
    </SettingsPage>
  );
}

/** Settings → Appearance → Character: the radio list of characters, one level below Appearance. */
export function SettingsCharacterRoute() {
  const scope = useScope();
  return (
    <SettingsPage title="settings.character.title" parent={settingsSectionPath("appearance", scope)}>
      <SettingSlot ids={["look.character", "look.characterMoves"]}>
        <CharacterPicker />
      </SettingSlot>
    </SettingsPage>
  );
}

/** Settings → System → Telemetry: the whole card, one level below System. */
export function SettingsInstallCountRoute() {
  const scope = useScope();
  return (
    <SettingsPage title="telemetry.card.title" parent={settingsSectionPath("system", scope)}>
      <SettingSlot ids={["privacy.telemetry", "privacy.telemetry.next", "privacy.telemetry.docs"]}>
        <TelemetrySettingsCard />
      </SettingSlot>
    </SettingsPage>
  );
}
