import type { ReactNode } from "react";
import { useLoaderData, useParams } from "react-router";

import { AppearanceIntro } from "@/components/appearance-intro";
import { BeltSizeControl } from "@/components/belt-size-control";
import { ChangesControl } from "@/components/changes-control";
import { CharacterPicker } from "@/components/character-picker";
import { CharacterSettingsRow } from "@/components/character-settings-row";
import { ClearNotificationsControl } from "@/components/clear-notifications-control";
import { CompactionsControl } from "@/components/compactions-control";
import { ConnectionInfo } from "@/components/connection-info";
import { CrewSettingsCard } from "@/components/crew-settings-card";
import { EnterSendsControl } from "@/components/enter-sends-control";
import { FloatingThingsControl } from "@/components/floating-things-control";
import { FontSettingsControl } from "@/components/font-settings";
import { HandControl } from "@/components/hand-control";
import { HapticsControl } from "@/components/haptics-control";
import { HarnessBarControl } from "@/components/harness-bar-control";
import { HarnessPrefsControl } from "@/components/harness-prefs-control";
import { HillSwitchControl } from "@/components/hill-switch-card";
import { KeepChatControl } from "@/components/keep-chat-control";
import { LanguageControl } from "@/components/language-control";
import { MachineLoadCard, MachineLoadSettings } from "@/components/machine-load-settings";
import { MathControl } from "@/components/math-control";
import { NotifyPrefsControl } from "@/components/notify-prefs-control";
import { PageZoomControl } from "@/components/page-zoom-control";
import { PairedDevices } from "@/components/paired-devices";
import { PaneNavControl } from "@/components/pane-nav-control";
import { PaneOrderControl } from "@/components/pane-order-control";
import {
  ChatTextSizeControl,
  KeysPadControl,
  PaneViewSettingControl,
  RawTerminalControl,
  ShortFormControl,
  TapToTypeControl,
  WholeReplyControl,
  WrapControl,
} from "@/components/pref-cards";
import { ProjectPicturesControl } from "@/components/project-pictures-control";
import { PushControl, usePushAvailability } from "@/components/push-control";
import { SentSuggestionsControl } from "@/components/sent-suggestions-control";
import { SettingSlot } from "@/components/setting-slot";
import { SettingsPage } from "@/components/settings-page";
import { ShortcutSettingsRow } from "@/components/shortcut-settings-row";
import { SnoozeControl } from "@/components/snooze-control";
import { SpeechControl } from "@/components/speech-control";
import { TelemetrySettingsCard, TelemetrySettingsRow } from "@/components/telemetry-settings-card";
import { ThemeControl } from "@/components/theme-control";
import { ThemePickerControl } from "@/components/theme-picker-control";
import { ToolCallsControl } from "@/components/tool-calls-control";
import { TrickCardsWaiting } from "@/components/trick-cards";
import { TricksSettingsCard } from "@/components/tricks-settings-card";
import { TricksSwitchControl } from "@/components/tricks-switch-card";
import { TypefaceControl } from "@/components/typeface-control";
import { UsageRowControl } from "@/components/usage-row-control";
import { Zone } from "@/components/voice-parts";
import { WideLayoutControl } from "@/components/wide-layout-control";
import { WorktreeFolderControl } from "@/components/worktree-folder-control";
import { ZenControl } from "@/components/zen-control";
import { ZoomPillControl } from "@/components/zoom-pill-control";
import { useLocale } from "@/hooks/use-locale";
import { useServerDiagnostics } from "@/hooks/use-server-diagnostics";
import { t } from "@/lib/i18n";
import { EMPTY_DEVICES, type DevicesData, type MachinesData } from "@/lib/loaders";
import { settingsSectionPath } from "@/lib/nav";
import { useOptionalRootData } from "@/lib/route-data";
import { useScope } from "@/lib/session";
import { pageDef } from "@/lib/settings/pages";
import type { PageId } from "@/lib/settings/types";

// ── THE ELEVEN SETTINGS PAGES (ADR 0170) ────────────────────────────────────────────────────────────────────────
//
// Each page is the registry's page (lib/settings/pages.ts) drawn with the controls Settings always had: its groups in
// the registry's order, each under its heading, and each control in a `SettingSlot` that names the registry rows it
// draws. The marks are what the completeness test reads (routes/settings-marks.test.tsx) and what a search result
// scrolls to. The split came from a card sort of 2026-11-21: eight readers, all language models (no user research),
// sorted every row, four of them into pages of their own; the operator chose the eleven from what they made.
//
// A group whose one card already carries the heading's words (Math, Zen mode, Changes, the Hill) draws no heading of
// its own: the same word twice, one above the other, reads as two things.
//
// Nothing here owns a value. A card writes through the hook it always wrote through, so a value set here and the
// same value in a pane's own sheet are one value.

/** One group of a page: its heading from the registry, unless its one card says it already. */
export function Group({ page, id, hint, bare = false, children }: { page: PageId; id: string; hint?: string; bare?: boolean; children: ReactNode }) {
  const group = pageDef(page).groups.find((g) => g.id === id);
  if (group === undefined) throw new Error(`no group "${id}" on ${page}`);
  if (bare) return <>{children}</>;
  return (
    <Zone label={t(group.heading)} hint={hint}>
      {children}
    </Zone>
  );
}

/** A page: its title and its line from the registry. */
function Page({ id, keepScroll, children }: { id: PageId; keepScroll?: boolean; children: ReactNode }) {
  useLocale();
  const page = pageDef(id);
  return (
    <SettingsPage title={page.title} blurb={page.blurb === null ? undefined : t(page.blurb)} keepScroll={keepScroll}>
      {children}
    </SettingsPage>
  );
}

// ── 1. Look and feel ─────────────────────────────────────────────────────────────────────────────────────────────
// What the app looks like on this device. The theme first, because it is what people come here for; the character
// under it, because its default is "From the theme"; then words (language, the two faces, the three text sizes, in
// one group, because a reader looked for "one Text page"), math, and the layout choices.
export function SettingsLookRoute() {
  return (
    <Page id="look">
      <Group page="look" id="theme">
        <SettingSlot ids={["look.intro", "look.themesDocs"]}>
          <AppearanceIntro />
        </SettingSlot>
        <SettingSlot ids={["look.theme", "look.theme.about", "look.theme.browse", "look.theme.import", "look.theme.paste", "look.theme.export", "look.theme.remove", "look.theme.trial"]}>
          <ThemePickerControl />
        </SettingSlot>
        <SettingSlot ids={["look.lightDark"]}>
          <ThemeControl />
        </SettingSlot>
      </Group>
      <Group page="look" id="character" bare>
        <SettingSlot ids={["look.character"]}>
          <CharacterSettingsRow />
        </SettingSlot>
      </Group>
      <Group page="look" id="text">
        <SettingSlot ids={["look.language"]}>
          <LanguageControl />
        </SettingSlot>
        <SettingSlot ids={["look.typeface"]}>
          <TypefaceControl />
        </SettingSlot>
        <SettingSlot ids={["look.textSize.chat"]}>
          <ChatTextSizeControl />
        </SettingSlot>
        <SettingSlot ids={["look.terminalFont", "look.textSize.terminal", "look.textSize.draft"]}>
          <FontSettingsControl />
        </SettingSlot>
      </Group>
      <Group page="look" id="math" bare>
        <SettingSlot ids={["look.math", "look.math.download", "look.math.remove"]}>
          <MathControl />
        </SettingSlot>
      </Group>
      <Group page="look" id="layout">
        <SettingSlot ids={["look.beltSize"]}>
          <BeltSizeControl />
        </SettingSlot>
        <SettingSlot ids={["look.largeScreen"]}>
          <WideLayoutControl />
        </SettingSlot>
        <SettingSlot ids={["look.projectPictures"]}>
          <ProjectPicturesControl />
        </SettingSlot>
        <SettingSlot ids={["look.floatingThings"]}>
          <FloatingThingsControl />
        </SettingSlot>
      </Group>
    </Page>
  );
}

/** Look and feel → Character: the radio list of characters, one level below. */
export function SettingsCharacterRoute() {
  const scope = useScope();
  return (
    <SettingsPage title="settings.character.title" parent={settingsSectionPath("look", scope)}>
      <SettingSlot ids={["look.character", "look.characterMoves"]}>
        <CharacterPicker />
      </SettingSlot>
    </SettingsPage>
  );
}

// ── 2. Chat and terminal ─────────────────────────────────────────────────────────────────────────────────────────
// What a pane shows. The groups are the Display sheet's own ("Both views", "Chat", "Terminal"), so the sheet and this
// page read alike, and the values are the sheet's: set here, the sheet shows it, and the other way round.
export function SettingsChatRoute() {
  return (
    <Page id="chat">
      <Group page="chat" id="both">
        <SettingSlot ids={["chat.view"]}>
          <PaneViewSettingControl />
        </SettingSlot>
        <SettingSlot ids={["chat.shortForm"]}>
          <ShortFormControl />
        </SettingSlot>
      </Group>
      <Group page="chat" id="chat">
        <SettingSlot ids={["chat.toolCalls"]}>
          <ToolCallsControl />
        </SettingSlot>
        <SettingSlot ids={["chat.compactions"]}>
          <CompactionsControl />
        </SettingSlot>
      </Group>
      <Group page="chat" id="terminal">
        <SettingSlot ids={["chat.wrap"]}>
          <WrapControl />
        </SettingSlot>
        <SettingSlot ids={["chat.wholeReply"]}>
          <WholeReplyControl />
        </SettingSlot>
        <SettingSlot ids={["chat.rawTerminal"]}>
          <RawTerminalControl />
        </SettingSlot>
        <SettingSlot ids={["chat.zoomButton"]}>
          <ZoomPillControl />
        </SettingSlot>
      </Group>
      <Group page="chat" id="status">
        <SettingSlot ids={["chat.contextLimits"]}>
          <UsageRowControl />
        </SettingSlot>
        {/* One row per harness the web has an adapter for, Claude Code first. */}
        <SettingSlot ids={["chat.statusLine"]}>
          <HarnessPrefsControl />
        </SettingSlot>
      </Group>
    </Page>
  );
}

// ── 3. Keys and touch ────────────────────────────────────────────────────────────────────────────────────────────
// How this device takes your input: typing, the Keys pad, touch, and zen, which takes every way back but one.
export function SettingsKeysRoute() {
  return (
    <Page id="keys">
      <Group page="keys" id="typing">
        <SettingSlot ids={["keys.enterSends"]}>
          <EnterSendsControl />
        </SettingSlot>
        <SettingSlot ids={["keys.sentSuggestions"]}>
          <SentSuggestionsControl />
        </SettingSlot>
        <SettingSlot ids={["keys.harnessShortcuts"]}>
          <HarnessBarControl />
        </SettingSlot>
        {/* Renders nothing before this device has shown a hardware key press. */}
        <SettingSlot ids={["keys.shortcuts"]}>
          <ShortcutSettingsRow />
        </SettingSlot>
      </Group>
      <Group page="keys" id="pad">
        <SettingSlot ids={["keys.pad.edit", "keys.pad.presets", "keys.pad.copy"]}>
          <KeysPadControl />
        </SettingSlot>
      </Group>
      <Group page="keys" id="touch">
        <SettingSlot ids={["keys.tapToType"]}>
          <TapToTypeControl />
        </SettingSlot>
        <SettingSlot ids={["keys.hand"]}>
          <HandControl />
        </SettingSlot>
        <SettingSlot ids={["keys.pinchZoom"]}>
          <PageZoomControl />
        </SettingSlot>
        <SettingSlot ids={["keys.paneNav"]}>
          <PaneNavControl />
        </SettingSlot>
        {/* Renders nothing where vibrate is unsupported. */}
        <SettingSlot ids={["keys.haptics"]}>
          <HapticsControl />
        </SettingSlot>
      </Group>
      <Group page="keys" id="zen" bare>
        {/* AVAILABILITY ONLY: whether the pane's ⋮ menu offers Zen mode at all. */}
        <SettingSlot ids={["keys.zen", "keys.zenTurn"]}>
          <ZenControl />
        </SettingSlot>
      </Group>
    </Page>
  );
}

// ── 4. Notifications ─────────────────────────────────────────────────────────────────────────────────────────────
// This device's push first, then what notifies, for every device. The switches that are bridge-wide mount while the
// push state is unknown and leave only once the bridge is known to have no push keys: gating on a late answer put
// about 400px into the middle of the page one frame late. Machine load is a notification too, so its rules have a
// door here; they are each machine's own (components/machine-load-settings.tsx).
export function SettingsNotificationsRoute() {
  const root = useOptionalRootData();
  const availability = usePushAvailability();
  // SAFETY: `machinesLoader` returns `MachinesData` for this route; `undefined` is the harness case.
  const machines = (useLoaderData() as MachinesData | undefined) ?? NO_MACHINES;
  const push = availability !== "server-off";
  useLocale();
  return (
    <Page id="notifications">
      <Group page="notifications" id="device">
        <SettingSlot ids={["notifications.push"]}>
          <PushControl />
        </SettingSlot>
      </Group>
      {push && (
        <>
          <Group page="notifications" id="when" hint={t("settings.group.notifications.whenHint")}>
            <SettingSlot ids={["notifications.needsYou", "notifications.finished", "notifications.perAgent", "notifications.newVersion", "notifications.decisions"]}>
              <NotifyPrefsControl only={{ rows: ["blocked", "done", "individual", "updates", "decisions"], watched: false }} />
            </SettingSlot>
          </Group>
          <Group page="notifications" id="cache">
            <SettingSlot ids={["notifications.cacheCold", "notifications.cacheWatch"]}>
              <NotifyPrefsControl only={{ rows: ["cache"], watched: true }} />
            </SettingSlot>
          </Group>
        </>
      )}
      <Group page="notifications" id="load">
        {push && (
          <SettingSlot ids={["notifications.machineLoad"]}>
            <NotifyPrefsControl only={{ rows: ["machines"], watched: false }} />
          </SettingSlot>
        )}
        <SettingSlot ids={["notifications.load.cpu", "notifications.load.memory", "notifications.load.disk", "notifications.load.above", "notifications.load.for"]}>
          <MachineLoadSettings data={machines} />
        </SettingSlot>
      </Group>
      {push && (
        <Group page="notifications" id="quiet">
          <SettingSlot ids={["notifications.doNotDisturb"]}>
            <SnoozeControl snoozedUntil={root?.snoozedUntil ?? null} />
          </SettingSlot>
          <SettingSlot ids={["notifications.clear"]}>
            <ClearNotificationsControl />
          </SettingSlot>
        </Group>
      )}
    </Page>
  );
}

const NO_MACHINES: MachinesData = { census: null, error: false };

/** Notifications → one machine's load alerts: the card its own page draws, one level below Notifications. */
export function SettingsMachineLoadRoute() {
  const scope = useScope();
  const { machine } = useParams();
  // SAFETY: `machinesLoader` returns `MachinesData` for this route; `undefined` is the harness case.
  const data = (useLoaderData() as MachinesData | undefined) ?? NO_MACHINES;
  const row = data.census?.machines.find((m) => m.id === machine);
  return (
    <SettingsPage title="settings.group.notifications.load" heading={row?.name} parent={settingsSectionPath("notifications", scope)}>
      <SettingSlot ids={["notifications.load.cpu", "notifications.load.memory", "notifications.load.disk", "notifications.load.above", "notifications.load.for"]}>
        {row !== undefined && <MachineLoadCard row={row} />}
      </SettingSlot>
    </SettingsPage>
  );
}

// ── 5. Voice ─────────────────────────────────────────────────────────────────────────────────────────────────────
// How your voice becomes text: the hub, and two pages below it (the host's option, for every device, and the Whistle
// model's copies). The groups are SpeechControl's own headings; the page draws none above them.
export function SettingsVoiceRoute() {
  return (
    <Page id="voice">
      <SettingSlot ids={["voice.status", "voice.audio", "voice.change", "voice.fix", "voice.phone", "voice.handsFree", "voice.host", "voice.model"]}>
        <SpeechControl page="hub" />
      </SettingSlot>
    </Page>
  );
}

/** Voice → Host speech: the host's options, for every device on it. */
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

/** Voice → Whistle model: the model's credit and its two copies, on the host and on this phone. */
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

// ── 6. Dashboard and projects ────────────────────────────────────────────────────────────────────────────────────
// How the Dashboard lists panes, where new worktrees go, and how a Changes view finds repos (ADR 0065).
export function SettingsDashboardRoute() {
  return (
    <Page id="dashboard">
      <Group page="dashboard" id="dashboard">
        <SettingSlot ids={["dashboard.paneOrder"]}>
          <PaneOrderControl />
        </SettingSlot>
      </Group>
      <Group page="dashboard" id="projects">
        {/* One row per machine (ADR 0093 note). */}
        <SettingSlot ids={["dashboard.worktreeFolder"]}>
          <WorktreeFolderControl />
        </SettingSlot>
      </Group>
      <Group page="dashboard" id="changes" bare>
        <SettingSlot ids={["dashboard.changes.nested", "dashboard.changes.depth"]}>
          <ChangesControl />
        </SettingSlot>
      </Group>
    </Page>
  );
}

// ── 8. Tricks and the Hill ───────────────────────────────────────────────────────────────────────────────────────
// Both experiments, each with its one switch, and while the Tricks switch is on, the list. The Experiments page's
// notice moved onto the two switches: each says the whole of it and wears the Experimental badge. A bookmark of the
// list while tricks are off lands here too, on the switch that turns them on.
export function SettingsTricksRoute() {
  const root = useOptionalRootData();
  const on = root?.tricksOff !== true;
  return (
    <Page id="tricks" keepScroll>
      <Group page="tricks" id="tricks" bare>
        <SettingSlot ids={["tricks.enabled"]}>
          <TricksSwitchControl />
        </SettingSlot>
        {on && (
          <>
            {/* The cards of Collie's own that wait for a yes (M96 spec 14): with the Hill off, the one list of them. */}
            <SettingSlot ids={["tricks.waiting"]}>
              <TrickCardsWaiting />
            </SettingSlot>
            <SettingSlot ids={["tricks.list", "tricks.addRepo", "tricks.addRepo.link", "tricks.official.add", "tricks.official.update"]}>
              <TricksSettingsCard />
            </SettingSlot>
          </>
        )}
      </Group>
      <Group page="tricks" id="hill" bare>
        <SettingSlot ids={["tricks.hill"]}>
          <HillSwitchControl />
        </SettingSlot>
      </Group>
    </Page>
  );
}

// ── 9. Devices and machines ──────────────────────────────────────────────────────────────────────────────────────
// What this device may do and what it talks to: pairing, the paired devices, the machines, the connection.
export function SettingsDevicesRoute() {
  const root = useOptionalRootData();
  const diagnostics = useServerDiagnostics();
  // This page's OWN loader: the paired-device registry (lib/loaders.ts devicesLoader). Defaulted rather than asserted:
  // a harness that mounts this route without the loader must still render the rest of the page.
  // SAFETY: `devicesLoader` returns `DevicesData` for this route; `undefined` is the case the default exists for.
  const devices = (useLoaderData() as DevicesData | undefined) ?? EMPTY_DEVICES;
  return (
    <Page id="devices">
      {/* The pairing card holds this device's own pairing and the list of every paired device, as one card. */}
      <SettingSlot ids={["devices.pair", "devices.pair.code", "devices.pair.name", "devices.unpair", "devices.paired", "devices.revoke"]}>
        <PairedDevices data={devices} />
      </SettingSlot>
      <Group page="devices" id="machines">
        {/* Machines on every install; the crew's census only on a crew. */}
        <SettingSlot ids={["devices.machines", "devices.crew"]}>
          <CrewSettingsCard />
        </SettingSlot>
      </Group>
      <Group page="devices" id="connection" bare>
        <SettingSlot
          ids={["devices.connection", "devices.connection.endpoint", "devices.connection.secure", "devices.connection.bridge", "devices.connection.access", "devices.connection.masking", "devices.connection.serverBuild"]}
        >
          <ConnectionInfo bridge={root?.bridge} device={root?.device} build={diagnostics.build} redact={diagnostics.redact} denied={root?.authError === true} />
        </SettingSlot>
      </Group>
    </Page>
  );
}

// ── 10. Privacy and data ─────────────────────────────────────────────────────────────────────────────────────────
// What this phone keeps, and what leaves this machine.
export function SettingsPrivacyRoute() {
  return (
    <Page id="privacy">
      <Group page="privacy" id="phone">
        <SettingSlot ids={["privacy.keepChat", "privacy.keepChat.clear"]}>
          <KeepChatControl />
        </SettingSlot>
      </Group>
      <Group page="privacy" id="leaves">
        {/* One row with its state; the switch, the cause and the next message are the page it opens. */}
        <SettingSlot ids={["privacy.telemetry"]}>
          <TelemetrySettingsRow />
        </SettingSlot>
      </Group>
    </Page>
  );
}

/** Privacy and data → Telemetry: the whole card, one level below. */
export function SettingsInstallCountRoute() {
  const scope = useScope();
  return (
    <SettingsPage title="telemetry.card.title" parent={settingsSectionPath("privacy", scope)}>
      <SettingSlot ids={["privacy.telemetry", "privacy.telemetry.next", "privacy.telemetry.docs"]}>
        <TelemetrySettingsCard />
      </SettingSlot>
    </SettingsPage>
  );
}
