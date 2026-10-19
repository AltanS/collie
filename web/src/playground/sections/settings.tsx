// Settings section of the states playground. Split out of app.tsx; see that file's header comment
// for the whole page's rules.

import { useEffect, useState } from "react";

import { LauncherHowSheet } from "@/components/launcher-how-sheet";
import { CommandPicker } from "@/components/new-command-picker";
import { FolderBrowse } from "@/components/new-space-browse";
import { NoPromptsSheet } from "@/components/no-prompts-sheet";
import { NotifyPrefsCard } from "@/components/notify-prefs-control";
import { SpaceOverview } from "@/components/space-overview";
import { ThemePickerControl, ThemePreviewSheet } from "@/components/theme-picker-control";
import { CodexConsentSheet, SpeechCards, type SpeechCardsProps } from "@/components/speech-control";
import { DEFAULT_THEME_ID, type Theme } from "@/lib/theme/schema";
import { addImported, removeImported, shippedThemes } from "@/lib/theme/store";
import { commandChoice, commandKey, commandOptions, offerFor, pickOfKey } from "@/lib/new-page";
import type { FolderBrowseResponse, LauncherItem, RecentRun, SttCapability, SttHostStatus, WhistleStatus } from "@/lib/types";
import {
  devicesPaired,
  devicesUnpaired,
  homeCrew,
  homeSolo,
  spacesWithWorktrees,
  watchedPanes,
} from "../fixtures";
import { NewRouter, SettingsRouter } from "../harness";
import { Card, Group, Section, Stage, type SectionDef } from "../layout";
import { PhoneFrameCard } from "./shared";

export const DEF: SectionDef = {
  id: "settings",
  title: "Settings",
  intent:
    "The whole settings route, mounted twice: once on a solo collie with nothing paired, once on a lead with three paired devices and a crew card to show for it. Then the Updates page it links to, which is where the check, the card, the peers and the one button now live.",
};

// ── The Shell half of the New page, with one-off commands (ADR 0095) ───────────────────────────────

/** What a 1.19.0 bridge lists under Shell: the shell and one operator row. */
const RUN_ITEMS: LauncherItem[] = [
  { key: "shell", start: { shell: true }, group: "commands", label: "Shell", source: "builtin", noPrompts: false, branch: true, available: true },
  {
    key: "row:make test",
    start: { command: "make test" },
    group: "commands",
    label: "make test",
    command: "make test",
    source: "operator",
    noPrompts: false,
    branch: false,
    available: true,
  },
];

/** The machine's history: a plain line, a line that skips prompts, and a line too long for its option. */
const RUN_RECENT: RecentRun[] = [
  { line: "make deploy --env staging", cwd: "/home/op/app", at: 3, noPrompts: false, available: true },
  { line: "codex --dangerously-bypass-approvals-and-sandbox", cwd: null, at: 2, noPrompts: true, available: true },
  { line: "journalctl --user -u collie.service --since today --no-pager", cwd: null, at: 1, noPrompts: false, available: true },
];

/** A history entry as a bridge lists it while `[phone] run` is off. */
function runOff(entry: RecentRun): RecentRun {
  return { line: entry.line, cwd: entry.cwd, at: entry.at, noPrompts: entry.noPrompts, available: false, reason: "run_off" };
}

/**
 * The real Command select and what hangs off it, fed by the real rules (`offerFor`, `commandOptions`),
 * with the choice and the typed line held here. The page's Start, the check and the history writes are
 * not wired: a card writes nothing.
 */
function CommandPickerDemo({ run, pick, line = "" }: { run: boolean; pick: string; line?: string }) {
  const [key, setKey] = useState(pick);
  const [typed, setTyped] = useState(line);
  const recentRuns = RUN_RECENT.map((e) => (run ? e : runOff(e)));
  const offer = offerFor({ harnesses: [], items: RUN_ITEMS, loaded: true, rows: [], canWorktree: true, run, recentRuns });
  const command = commandChoice(offer, pickOfKey(offer, key), null);
  return (
    <div className="p-4">
      <CommandPicker
        options={commandOptions(offer, "Just a shell")}
        value={commandKey(command)}
        onChoose={setKey}
        typed={command.kind === "typed" ? { line: typed, onLine: setTyped, onGo: () => {} } : null}
        recent={command.kind === "run" ? { busy: false, onRemove: () => {}, onClear: () => {} } : null}
      />
    </div>
  );
}

// ── The New page's Browse row (#467) ──────────────────────────────────────────────────────────────

const BROWSE_HOME = "/home/op";
/** A small disk for the card: each folder's sub-folders, `*` marking a repository. */
const BROWSE_TREE = new Map<string, readonly string[]>([
  [BROWSE_HOME, ["docs", "src", "notes"]],
  [`${BROWSE_HOME}/docs`, []],
  [`${BROWSE_HOME}/notes`, []],
  [`${BROWSE_HOME}/src`, ["*collie", "*plektra-api", "plektra-web", "*website"]],
  [`${BROWSE_HOME}/src/collie`, []],
  [`${BROWSE_HOME}/src/plektra-api`, []],
  [`${BROWSE_HOME}/src/plektra-web`, []],
  [`${BROWSE_HOME}/src/website`, []],
]);

/**
 * The bridge's walk over {@link BROWSE_TREE}: the text resolved under home, the nearest folder that
 * exists, the rest as a case-insensitive name filter. Outside home is the bridge's `unknown-path`.
 */
const browseFixture: NonNullable<Parameters<typeof FolderBrowse>[0]["read"]> = (text) => {
  const raw = text.trim();
  const abs = (raw === "" || raw === "~" ? BROWSE_HOME : raw.startsWith("~/") ? `${BROWSE_HOME}/${raw.slice(2)}` : raw.startsWith("/") ? raw : `${BROWSE_HOME}/${raw}`).replace(/\/+$/u, "");
  if (abs !== BROWSE_HOME && !abs.startsWith(`${BROWSE_HOME}/`)) return Promise.resolve({ outcome: "unknown-path" });
  const parts = abs.slice(BROWSE_HOME.length).split("/").filter(Boolean);
  for (let depth = parts.length; depth >= 0; depth--) {
    const path = [BROWSE_HOME, ...parts.slice(0, depth)].join("/");
    const subs = BROWSE_TREE.get(path);
    if (subs === undefined) continue;
    const filter = parts.slice(depth).join("/");
    const folders = subs
      .map((s) => ({ name: s.replace(/^\*/u, ""), git: s.startsWith("*") }))
      .filter((f) => f.name.toLowerCase().startsWith(filter.toLowerCase()));
    const parent = depth === 0 ? null : [BROWSE_HOME, ...parts.slice(0, depth - 1)].join("/");
    const body: FolderBrowseResponse = { path, parent, folders, filter, truncated: false };
    return Promise.resolve({ outcome: "body", body });
  }
  return Promise.resolve({ outcome: "unknown-path" });
};

/** The Folder field and the Browse row under it, over the fixed tree. Use this folder only fills the field. */
function BrowseDemo({ initial }: { initial: string }) {
  const [value, setValue] = useState(initial);
  return (
    <div className="flex flex-col gap-2 p-4">
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="~ (home dir)"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        className="h-11 rounded-md border border-border bg-background px-3 font-mono text-sm"
      />
      <FolderBrowse value={value} home={BROWSE_HOME} scope={undefined} onNavigate={setValue} onUse={setValue} read={browseFixture} />
    </div>
  );
}

// ── Settings → Voice (ADR 0096, ADR 0097) ───────────────────────────────────────────────────────────

const WHISTLE_BYTES = 16_919_407;
const WHISTLE_SHA = "b6e02f048568ac5d01a2042556c658061e699acbc0aa2a1439f52f3d461dffeb";
const WHISTLE_REVISION = "ca5287601bef25af26dcf2e1b2bdc0843a7c19e5";
const WHISTLE_ABSENT: WhistleStatus = { state: "absent", bytes: WHISTLE_BYTES, hostEngine: false, hostTaken: false };
const WHISTLE_READY: WhistleStatus = {
  ...WHISTLE_ABSENT,
  state: "ready",
  sha256: WHISTLE_SHA,
  revision: WHISTLE_REVISION,
  fetchedAt: "2026-10-11T09:30:00.000Z",
};
/** The host runs Whistle: its provider is on and answers. */
const HOST_WHISTLE: SttCapability = { provider: "whistle", available: true, input: "wav-16k", maxDurationMs: 240_000 };
/** A copy on the phone, of the model the host holds. */
const PHONE_COPY = { sha256: WHISTLE_SHA, bytes: WHISTLE_BYTES, revision: WHISTLE_REVISION };

/** Where the host's `codex` lives in these cards. */
const CODEX_BIN = "/home/op/.local/bin/codex";
const OPEN_ALL: SttHostStatus["switchable"] = { whistle: { ok: true }, codex: { ok: true }, off: { ok: true } };
/** No provider on the host; Whistle not downloaded yet; Codex installed and signed in. */
const PROVIDER_NONE: SttHostStatus = {
  provider: "none",
  available: false,
  configuredBy: "none",
  codexBin: CODEX_BIN,
  switchable: { ...OPEN_ALL, whistle: { ok: false, reason: "not-ready" } },
};
/** No provider, the model is ready: all three choices open. */
const PROVIDER_NONE_READY: SttHostStatus = { ...PROVIDER_NONE, switchable: OPEN_ALL };
const PROVIDER_WHISTLE: SttHostStatus = { ...PROVIDER_NONE_READY, provider: "whistle", available: true, configuredBy: "file" };
const PROVIDER_CODEX: SttHostStatus = { ...PROVIDER_WHISTLE, provider: "codex", identity: "honest" };
const TERMINAL_LOCK: SttHostStatus["switchable"] = {
  whistle: { ok: false, reason: "terminal" },
  codex: { ok: false, reason: "terminal" },
  off: { ok: false, reason: "terminal" },
};

/** A Voice page with every fact handed in, as the real control hands them. Taps do nothing. */
function SpeechDemo(over: Partial<SpeechCardsProps>) {
  return (
    <div className="space-y-4 p-4">
      <SpeechCards
        page="hub"
        whistle={WHISTLE_ABSENT}
        hostStt={null}
        host={PROVIDER_NONE}
        hostRead
        switching={null}
        providerError={null}
        confirmTo={null}
        consentOpen={false}
        consentError={null}
        canWrite
        recording
        engine="host"
        block={null}
        local={null}
        persisted={false}
        copy={null}
        hostError={null}
        phoneError={null}
        hostBusy={false}
        checking={false}
        confirmingRemove={false}
        handsFree={false}
        onEngine={() => {}}
        onHandsFree={() => {}}
        onSetup={() => {}}
        onSetupBoth={() => {}}
        onAskRemove={() => {}}
        onCancelRemove={() => {}}
        onRemove={() => {}}
        onChooseProvider={() => {}}
        onConfirm={() => {}}
        onCancelConfirm={() => {}}
        onAcceptConsent={() => {}}
        onCancelConsent={() => {}}
        onPhoneDownload={() => {}}
        onPhoneRemove={() => {}}
        onCheckAgain={() => {}}
        onOpenPage={() => {}}
        guided={{ kind: "idle" }}
        onGuidedSetup={() => {}}
        {...over}
      />
    </div>
  );
}

// ── The Theme card (M57 spec 05) ─────────────────────────────────────────────────────────────────

/** The default theme's two halves, which a playground theme is built from. */
function baseTheme(): Theme {
  const found = shippedThemes().find((theme) => theme.id === DEFAULT_THEME_ID);
  if (found === undefined) throw new Error("the shipped theme collie is missing");
  return found;
}

/** An imported theme for the library card: a warm light ground and a blue-black dark one. */
function seedTheme(): Theme {
  const base = baseTheme();
  return {
    version: 1,
    id: "playground-warm",
    name: "Playground warm",
    author: "Playground",
    light: { ...base.light, background: "#f6f1ea", card: "#fffdf8" },
    dark: { ...base.dark, background: "#10141c", card: "#171c26" },
  };
}

/** A theme whose light ink is too pale for its ground: two failing floors, both in the light half. */
function paleTheme(): Theme {
  const base = baseTheme();
  return {
    version: 1,
    id: "playground-pale",
    name: "Playground pale",
    author: "Playground",
    light: { ...base.light, foreground: "#aaaaaa" },
    // The default theme's own dark destructive pair is 2.77:1 (a known finding); a darker ground and
    // a white ink keep this card at exactly the two light failures.
    dark: { ...base.dark, destructive: "#7f1d1d", "destructive-foreground": "#ffffff" },
  };
}

/** The real card over a library that holds one imported theme, put there for as long as the card is mounted. */
function ThemePickerDemo() {
  useEffect(() => {
    addImported(seedTheme());
    return () => removeImported("playground-warm");
  }, []);
  return <ThemePickerControl />;
}

export function SettingsSection() {
  return (
    <Section def={DEF}>
      <Group title="Settings">
        <Card
          state="settings-solo-unpaired"
          label="settings, solo collie, nothing paired"
          reach="tap the gear from the dashboard. With no device paired, the bridge answers no read and no write, and the Paired devices card offers the pairing verb instead of a list."
          note="The whole real route. Two things on it still reach the network on purpose — /api/config for the diagnostics build, and the browser's own push subscription — and both fail soft, so the page renders whole with no bridge."
          span={2}
        >
          <PhoneFrameCard height={760}>
            <SettingsRouter home={homeSolo} devices={devicesUnpaired} />
          </PhoneFrameCard>
        </Card>

        <Card
          state="settings-lead-paired"
          label="settings, lead of a crew, three devices paired"
          reach="pair a phone with `collie pair`, then open Settings on the lead. The Crew card appears only on a multi-machine roster; the device list names which row is the phone you are holding."
          note="One Updates row, where three update cards used to stand. Its status line follows the footer chip's old precedence and its chevron says it opens a page."
          span={2}
        >
          <PhoneFrameCard height={760}>
            <SettingsRouter home={homeCrew} devices={devicesPaired} />
          </PhoneFrameCard>
        </Card>
      </Group>

      <Group title="Theme">
        <Card
          state="theme-picker"
          label="the Theme card, one imported theme in the library"
          reach="open Settings, Appearance. The card is the first one on the page, above System, Light and Dark."
          note="The real component over the real store. The pills are the shipped themes, then the imported one, each with a disc of its light and dark ground. Tapping a pill applies it to this whole page, because that is what it does on a phone; tap the first pill to come back. Import opens a file chooser, Export saves the active theme, Remove is a disabled slot until an imported theme is active, so nothing in the card changes height."
        >
          <PhoneFrameCard height={420}>
            <div className="p-3">
              <ThemePickerDemo />
            </div>
          </PhoneFrameCard>
        </Card>

        <Card
          state="theme-preview-failing"
          label="the preview sheet, a theme with two failing contrast floors"
          reach="pick a theme file with Import. The sheet opens before anything is kept."
          note="Two warnings, both for the light half, one line each. A failed floor warns and Apply stays on; only a refused file stops an import, and that shows a different sheet with only Close."
        >
          <PhoneFrameCard height={880}>
            <ThemePreviewSheet theme={paleTheme()} onApply={() => {}} onCancel={() => {}} />
          </PhoneFrameCard>
        </Card>
      </Group>

      <Group title="Voice">
        <Card
          state="voice-nothing-installed"
          label="1: the hub, nothing set up"
          reach="open Settings, Voice, on a host with no speech option and no Whistle model yet."
          note="The card's title says Speech is not set up, and that nothing is recorded; its action is Set up speech on this phone, one tap for the whole way (cards 25 and 26). Change how speech works stands open, because there is something to do. On this phone carries Recommended, and On your host says what a host is. On this phone offers Set up, which downloads to the host and then copies to the phone. On your host is off, and the host's row says it has no option yet."
        >
          <Stage height={1100}>
            <SpeechDemo block="host-not-ready" />
          </Stage>
        </Card>

        <Card
          state="voice-host-downloading"
          label="2: Whistle model, the host is downloading"
          reach="tap Download to host on the Whistle model page. The bar follows the host's own count, asked once a second while the page is open, and ends when the host says ready or failed."
          note="There is no cancel: the host finishes or fails on its own."
        >
          <Stage height={900}>
            <SpeechDemo page="model" whistle={{ ...WHISTLE_ABSENT, state: "downloading", received: 7_400_000 }} block="host-not-ready" />
          </Stage>
        </Card>

        <Card
          state="voice-host-ready"
          label="3: Whistle model, ready on the host, phone not set up"
          reach="after the host's download finishes. Details unfolds the checksum and when the host fetched it."
          note="The credit names Cactus Compute and the licence. The version links to its revision on Hugging Face. Copy to this phone is the next step."
        >
          <Stage height={1000}>
            <SpeechDemo page="model" whistle={WHISTLE_READY} host={PROVIDER_NONE_READY} initialDetails />
          </Stage>
        </Card>

        <Card
          state="voice-phone-copying"
          label="4: Whistle model, the phone is copying"
          reach="tap Copy to this phone. The bar takes the place of the button; the copy is checked against the host's hash before it is kept."
          note="Leaving the page ends a copy in progress, and nothing is kept from a half-finished one."
        >
          <Stage height={900}>
            <SpeechDemo page="model" whistle={WHISTLE_READY} host={PROVIDER_NONE_READY} copy={{ received: 7_400_000, total: WHISTLE_BYTES }} />
          </Stage>
        </Card>

        <Card
          state="voice-both-ready"
          label="5: the hub, both ready, On this phone"
          reach="after the copy finishes, choose On this phone, then tap Change how speech works. On a later visit it starts closed (card 23)."
          note="The title names Whistle by Cactus Compute, on this phone, and the copy the status rests on (Ready. Whistle ca52876 is on this phone.). On this phone wears the selected look. The host's row says Whistle on your host. The model's row says Both ready."
        >
          <Stage height={1100}>
            <SpeechDemo
              whistle={{ ...WHISTLE_READY, hostEngine: true }}
              hostStt={HOST_WHISTLE}
              host={PROVIDER_WHISTLE}
              engine="phone"
              local={PHONE_COPY}
              persisted
              initialOpen
            />
          </Stage>
        </Card>

        <Card
          state="voice-newer-on-host"
          label="6: Whistle model, a newer model on the host"
          reach="when the host's model changes after this phone copied it. The phone's version differs from the host's."
          note="The phone keeps working with its own copy. Update copies the new one over it. The hub's model row says Update."
        >
          <Stage height={1000}>
            <SpeechDemo
              page="model"
              whistle={{ ...WHISTLE_READY, hostEngine: true }}
              hostStt={HOST_WHISTLE}
              host={PROVIDER_WHISTLE}
              engine="phone"
              local={{ sha256: "a".repeat(64), bytes: WHISTLE_BYTES, revision: "1f0e2d3c4b5a69788796a5b4c3d2e1f001122334" }}
              persisted={false}
            />
          </Stage>
        </Card>

        <Card
          state="voice-browser-cannot"
          label="7: the hub, this browser cannot run the engine"
          reach="open Settings, Voice, over plain HTTP on a phone. The same reason shows when the browser has no WebAssembly, or when it blocks the engine."
          note="Shown with Change how speech works opened. On this phone is off with the reason under it. On your host is in force, so dictation works through the host, and the card names Whistle on your host."
        >
          <Stage height={1100}>
            <SpeechDemo whistle={{ ...WHISTLE_READY, hostEngine: true }} hostStt={HOST_WHISTLE} host={PROVIDER_WHISTLE} block="insecure" initialOpen />
          </Stage>
        </Card>

        <Card
          state="voice-read-only"
          label="8: the hub, a read-only device"
          reach="open Settings, Voice, on a device that may not write. Copying to the phone is a read; changing the host is a write."
          note="Shown with Change how speech works opened. One banner covers the host's settings. This phone's own choice and hands-free stay live, because they change nothing on the host."
        >
          <Stage height={1150}>
            <SpeechDemo
              whistle={{ ...WHISTLE_READY, hostEngine: true }}
              hostStt={HOST_WHISTLE}
              host={PROVIDER_WHISTLE}
              canWrite={false}
              local={PHONE_COPY}
              initialOpen
            />
          </Stage>
        </Card>

        <Card
          state="voice-paused"
          label="17: the hub, paused, this phone's copy is gone"
          reach="choose On this phone, then clear the site's storage, or let the browser evict the copy."
          note="The card still names Whistle by Cactus Compute, on this phone, and says Paused. The choice stays on this phone. Collie does not switch to the host by itself (ADR 0096 Decision 12). Restore in the card is the one action; Change how speech works stands open, where choosing On your host is the person's other way out."
        >
          <Stage height={1100}>
            <SpeechDemo whistle={{ ...WHISTLE_READY, hostEngine: true }} hostStt={HOST_WHISTLE} host={PROVIDER_WHISTLE} engine="phone" />
          </Stage>
        </Card>

        <Card
          state="voice-info-sheet"
          label="18: the five facts, from an info button"
          reach="tap the round i beside an option's title, on the hub or on Host speech."
          note="Audio, Offline, Cost, Setup and Speed for that option. The tap does not choose the option or open a page."
        >
          <Stage height={1100}>
            <SpeechDemo
              whistle={{ ...WHISTLE_READY, hostEngine: true }}
              hostStt={HOST_WHISTLE}
              host={PROVIDER_WHISTLE}
              local={PHONE_COPY}
              initialAbout="phone"
              initialOpen
            />
          </Stage>
        </Card>
      </Group>

      <Group title="Voice: Host speech">
        <Card
          state="voice-provider-none"
          label="9: Host speech, nothing set up"
          reach="open Settings, Voice, Host speech, on a host with no option, the model already downloaded and Codex signed in."
          note="Five option cards in two tiers, then Off on its own, chosen. Whistle and ChatGPT can be chosen. Every card has How to set up; Your own command is open here: the commands to copy, the whisper-cli example and the docs link, never a form."
        >
          <Stage height={1100}>
            <SpeechDemo page="host" whistle={WHISTLE_READY} host={PROVIDER_NONE_READY} initialSetup="command" />
          </Stage>
        </Card>

        <Card
          state="voice-provider-whistle"
          label="10: Host speech, Whistle on"
          reach="choose Whistle on your host, then Change for every device."
          note="Whistle wears the selected look: the primary edge all round, the tint, the filled radio and In use. The line under the page names the device that changed it, and when."
        >
          <Stage height={1000}>
            <SpeechDemo
              page="host"
              whistle={WHISTLE_READY}
              host={{ ...PROVIDER_WHISTLE, changedBy: "Pixel 8", changedAt: "2026-10-11T09:41:00.000Z" }}
            />
          </Stage>
        </Card>

        <Card
          state="voice-provider-codex-honest"
          label="11: Host speech, ChatGPT on, honest identity"
          reach="choose ChatGPT subscription and tap I accept; the endpoint took Collie under its own name."
          note="The identity line says what the recorded word means."
        >
          <Stage height={1000}>
            <SpeechDemo page="host" whistle={WHISTLE_READY} host={PROVIDER_CODEX} />
          </Stage>
        </Card>

        <Card
          state="voice-provider-codex-fallback"
          label="12: Host speech, ChatGPT on, fallback identity"
          reach="as 11, when the endpoint refused Collie's own name and accepted only the Codex CLI's headers."
          note="The fallback is said in plain words. Off ends it."
        >
          <Stage height={1000}>
            <SpeechDemo page="host" whistle={WHISTLE_READY} host={{ ...PROVIDER_CODEX, identity: "codex-cli" }} />
          </Stage>
        </Card>

        <Card
          state="voice-provider-terminal"
          label="13: Host speech, a speech service set up in a terminal"
          reach="a host where the operator ran collie stt setup --provider openai-compatible, with a key."
          note="In use, never changed here. The other choices are closed, and the commands that change it or turn it off are there to copy and run on the host. Each option still says how to set it up; Whistle and ChatGPT start with collie stt off (card 21)."
        >
          <Stage height={1100}>
            <SpeechDemo
              page="host"
              whistle={WHISTLE_READY}
              host={{ provider: "openai-compatible", available: true, configuredBy: "file", switchable: TERMINAL_LOCK }}
            />
          </Stage>
        </Card>

        <Card
          state="voice-provider-codex-signed-out"
          label="14: Host speech, Codex not signed in"
          reach="a host where codex is installed but codex login status says Not logged in."
          note="ChatGPT is closed and says why in one sentence. Its How to set up marks the sign-in step Next, with codex login to copy. Whistle waits for the model."
        >
          <Stage height={1100}>
            <SpeechDemo
              page="host"
              host={{ ...PROVIDER_NONE, switchable: { ...PROVIDER_NONE.switchable, codex: { ok: false, reason: "codex-signed-out" } } }}
            />
          </Stage>
        </Card>

        <Card
          state="voice-provider-read-only"
          label="15: Host speech, a read-only device"
          reach="open Host speech on a device without the write grant."
          note="The banner, then every option with its audio line and its facts. In use marks the one in use; nothing can be chosen."
        >
          <Stage height={1000}>
            <SpeechDemo page="host" whistle={WHISTLE_READY} host={PROVIDER_CODEX} canWrite={false} />
          </Stage>
        </Card>

        <Card
          state="voice-provider-consent"
          label="16: Use your ChatGPT subscription?, the consent sheet"
          reach="tap ChatGPT subscription on Host speech. Nothing is sent to the host before I accept."
          note="The host-wide line and the audio line, then the words collie stt setup prints, kept equal by a test. I accept sends the consent's id with the switch; the host then checks the sign-in and probes the endpoint, honest name first."
        >
          <Stage height={760}>
            <CodexConsentSheet open codexBin={CODEX_BIN} busy={false} error={null} onAccept={() => {}} onCancel={() => {}} />
          </Stage>
        </Card>

        <Card
          state="voice-provider-confirm"
          label="19: Use Whistle on your host?, the host-wide confirm"
          reach="tap Whistle on your host while the host is Off. A step that sends audio further asks first; a step back is sent on the tap."
          note="Now and After, each with where audio goes. Change for every device sends the switch."
        >
          <Stage height={1000}>
            <SpeechDemo page="host" whistle={WHISTLE_READY} host={PROVIDER_NONE_READY} confirmTo="whistle" />
          </Stage>
        </Card>
      </Group>

      <Group title="Voice: the fixes of 2026-10-11">
        <Card
          state="voice-hub-codex-signed-out"
          label="20: the hub, ChatGPT on the host, Codex signed out"
          reach="a host on the ChatGPT subscription whose Codex was signed out since. The device that chose it is named."
          note="The card's title names ChatGPT subscription (OpenAI), on your host by name in a crew, then Not ready with what the host found, Audio, and Set up from Settings by the device. Fix opens Host speech, where ChatGPT's steps are already open. Change how speech works stands open."
        >
          <Stage height={1150}>
            <SpeechDemo
              whistle={WHISTLE_READY}
              hostStt={{ provider: "codex", available: false, reason: "Codex is not signed in, run `codex login`" }}
              host={{
                ...PROVIDER_CODEX,
                available: false,
                changedBy: "Pixel 8",
                changedAt: "2026-10-11T09:41:00.000Z",
                switchable: { ...OPEN_ALL, codex: { ok: false, reason: "codex-signed-out" } },
              }}
              hostName="bluefin"
            />
          </Stage>
        </Card>

        <Card
          state="voice-provider-terminal-steps"
          label="21: Host speech, a terminal lock, Whistle's steps"
          reach="as 13, then tap How to set up under Whistle on your host."
          note="The app never changes a provider set up with a key or a command (ADR 0097), so the steps start on the host: collie stt off, then collie stt whistle --host."
        >
          <Stage height={1300}>
            <SpeechDemo
              page="host"
              whistle={WHISTLE_READY}
              host={{ provider: "openai-compatible", available: true, configuredBy: "file", switchable: TERMINAL_LOCK }}
              initialSetup="whistle"
            />
          </Stage>
        </Card>

        <Card
          state="voice-provider-chatgpt-steps"
          label="22: Host speech, ChatGPT ready to choose, its steps"
          reach="a host with Codex installed and signed in with ChatGPT, then tap How to set up under ChatGPT subscription."
          note="Install and sign in are done; the last step is Next, and its button opens the consent sheet (card 16)."
        >
          <Stage height={1300}>
            <SpeechDemo page="host" whistle={WHISTLE_READY} host={PROVIDER_WHISTLE} initialSetup="chatgpt" />
          </Stage>
        </Card>

        <Card
          state="voice-hub-ready-folded"
          label="23: the hub, ready, Whistle on this phone, folded"
          reach="open Settings, Voice, on a phone that runs Whistle from its own copy. Every visit while speech works starts here."
          note="What is in use comes first: Whistle by Cactus Compute, On this phone, Ready with the version, Audio and Set up. Then hands-free, a daily behaviour. Then one closed row, Change how speech works; everything that sets speech up waits behind it."
        >
          <Stage height={640}>
            <SpeechDemo
              whistle={{ ...WHISTLE_READY, hostEngine: true }}
              hostStt={HOST_WHISTLE}
              host={PROVIDER_WHISTLE}
              engine="phone"
              local={PHONE_COPY}
              persisted
              hostName="bluefin"
            />
          </Stage>
        </Card>

        <Card
          state="voice-hub-ready-opened"
          label="24: the hub, ready, Change how speech works opened"
          reach="as 23, then tap Change how speech works."
          note="It opens in place, through Collapse: Only this phone with its two choices, Every device on your host with its row and See all five options and how to set them up, then the Whistle model row, unchanged. A tap between the two choices still moves nothing."
        >
          <Stage height={1250}>
            <SpeechDemo
              whistle={{ ...WHISTLE_READY, hostEngine: true }}
              hostStt={HOST_WHISTLE}
              host={PROVIDER_WHISTLE}
              engine="phone"
              local={PHONE_COPY}
              persisted
              hostName="bluefin"
              initialOpen
            />
          </Stage>
        </Card>

        <Card
          state="voice-hub-guided-host"
          label="25: the hub, Set up speech on this phone, the host's step"
          reach="tap Set up speech on this phone on a host without the model. The copy to this phone and the choice follow by themselves."
          note="One display for both steps: it names the step that runs, Downloading to your host… then Copying to this phone…, with the bytes, in the place the button stood."
        >
          <Stage height={1100}>
            <SpeechDemo block="host-not-ready" whistle={{ ...WHISTLE_ABSENT, state: "downloading", received: 7_400_000 }} guided={{ kind: "running" }} />
          </Stage>
        </Card>

        <Card
          state="voice-hub-guided-failed"
          label="26: the hub, Set up speech on this phone stopped"
          reach="as 25, when the copy to this phone fails, here because the host is busy with other phones."
          note="The run stops at the step that failed. Its own words stand above the button, which now reads Try again and starts the run over from where things are."
        >
          <Stage height={1100}>
            <SpeechDemo
              whistle={WHISTLE_READY}
              host={PROVIDER_NONE_READY}
              guided={{ kind: "failed", phase: "copy", message: "The host is busy copying the model to other phones. Try again shortly." }}
            />
          </Stage>
        </Card>
      </Group>

      <Group title="Notify when">
        <Card
          state="settings-notify-cache-row"
          label="notify card, the fourth switch and the panes watched one by one"
          reach="scroll to Notify when in Settings. The fifth row is the cache warning, off by default,
            and the section under it names the panes switched on one at a time from their own sheets —
            which is what makes the global-OR-per-pane rule visible instead of implicit."
          note="The real card with a fixture: the playground answers no API, so the controller's two
            fetches are replaced by handed-in values rather than stubbed."
        >
          <Stage height={420}>
            <div className="p-4">
              <NotifyPrefsCard
                prefs={{ blocked: true, done: false, updates: true, cache: false, machines: true }}
                busy={false}
                onToggle={() => {}}
                entries={watchedPanes}
                entriesBusy={false}
                onForget={() => {}}
              />
            </div>
          </Stage>
        </Card>
      </Group>

      <Group title="Updates">
        <Card
          state="updates-page"
          label="updates, the page the Settings row opens"
          reach="tap the Updates row in Settings. The check control on top, then one card carrying the version, the preflight, the run progress, a read-only line per peer, and the single action button."
          note="No bridge here, so the card's own read of /api/update/check never lands: the versions come from the snapshot and the peer lines stay empty. Against a live lead the same card grows one line per member, worst first."
          span={2}
        >
          <PhoneFrameCard height={760}>
            <SettingsRouter home={homeCrew} devices={devicesPaired} start="/settings/updates" />
          </PhoneFrameCard>
        </Card>
      </Group>

      <Group title="Spaces">
        <Card
          state="spaces-repo-worktrees"
          label="spaces, a repo and its worktrees"
          reach="open a worktree of a repo you already have open as a space. Herdr reports the repo on both, so the list nests the worktree under the checkout showing that repo — no extra call, and nothing to switch on."
          note="`blog` sits outside any repo and stays flat, which is the same row it always was. A worktree whose repo is NOT open would also stay flat: there would be nothing to indent under."
          span={2}
        >
          <PhoneFrameCard height={430}>
            <SpaceOverview
              workspaces={spacesWithWorktrees}
              // No agents: this card is about SHAPE. With a herd attached every row also carries its
              // triage tint, and a wall of "needs you" red says nothing about nesting.
              agents={[]}
              onOpen={() => {}}
              onNewSpace={() => {}}
              open
              onOpenChange={() => {}}
            />
          </PhoneFrameCard>
        </Card>

        <Card
          state="new-page"
          label="the New page"
          reach="tap + New on the dashboard, the folder button on the Spaces list, or the empty dashboard's first-agent card. A pane's ⋯ New agent in a worktree opens it with the worktree switch on."
          note="The agents and the commands are the chosen machine's own answer (GET /api/launchers), so this card shows what the bridge behind the playground reports. What cannot run there stays in its list, disabled, with its reason in brackets. Start is pinned to the foot."
          span={2}
        >
          <PhoneFrameCard height={640}>
            <NewRouter home={homeSolo} />
          </PhoneFrameCard>
        </Card>

        <Card
          state="new-page-browse"
          label="New page, Browse folders"
          reach="on the New page, tap Browse under the Folder field, beside Favourites and Recent."
          note="The sub-folders of what the field holds, on the chosen machine, read by name under home with the Files view's limits. Tap a folder to go in (the field follows), Up or a crumb to go back, Use this folder to fill the field and move on to Start. Typing narrows the list after a pause: try ~/src/ple. A folder that is a repository carries a git badge. This card reads a fixed tree, not the bridge."
        >
          <Stage height={560}>
            <BrowseDemo initial="~/src" />
          </Stage>
        </Card>

        <Card
          state="new-page-pick-host"
          label="New page, crew, pick a machine"
          reach="open the New page on a lead with peers. On a solo collie the machine select is not rendered at all."
          note="The select is on the machine the start lands on: the one the list was already showing (?machine=workshop here), or the lead. A machine that cannot take writes stays in the list, disabled, with a word for why in brackets."
          span={2}
        >
          <PhoneFrameCard height={640}>
            <NewRouter home={homeCrew} start="/new?machine=workshop" />
          </PhoneFrameCard>
        </Card>

        <Card
          state="new-page-run-typed"
          label="New page, Shell, Type a command"
          reach="on the New page, switch to Shell and pick Type a command… in the Command select. It shows when the machine's launchers.toml leaves [phone] run on, which is the default."
          note="One monospace field right under the select, with the corrections of the keyboard turned off and Go on the return key. The row is reserved only while the option is chosen, so picking it is a choice and typing moves nothing. On the real page the summary above Start reads Runs `htop` in ~/projects on bluefin, and Start checks the line first, so a line that skips permission prompts asks before its first run."
        >
          <Stage height={240}>
            <CommandPickerDemo run pick="typed" line="htop" />
          </Stage>
        </Card>

        <Card
          state="new-page-run-recent"
          label="New page, Shell, a Recent entry chosen"
          reach="on the New page, switch to Shell and pick a line from the Recent group, which lists the one-off lines run on that machine, newest first. Starting it runs that line again."
          note="The option shows the line, cut when long, with (No prompts) where it applies. A small Remove from history and Clear history sit under the select while an entry is chosen; Clear history asks first, in a sheet. Picking an entry fills the folder with the one it last ran in, unless you changed the folder on this visit. The card writes nothing."
        >
          <Stage height={380}>
            <CommandPickerDemo run pick="run:make deploy --env staging" />
          </Stage>
        </Card>

        <Card
          state="new-page-run-off"
          label="New page, Shell, one-off commands turned off"
          reach="on the New page, switch to Shell on a machine whose launchers.toml sets [phone] run = false."
          note="The history stays in the list, each line disabled with its reason in brackets, and Type a command… is gone."
        >
          <Stage height={120}>
            <CommandPickerDemo run={false} pick="shell" />
          </Stage>
        </Card>

        <Card
          state="new-page-add"
          label="Add your own, Agent, a recipe"
          reach="on the New page, tap Add your own under the Agent select. It shows when the machine's launchers.toml lets a phone add."
          note="Pick the harness, tap the option chips (one per group), read the line Collie will type, and tap Add. The list below is every row a phone added on that machine, with Rename and Remove, and the operator's own rows locked. The recipes and rows are the chosen machine's own answer, so this card shows what the bridge behind the playground reports."
          span={2}
        >
          <PhoneFrameCard height={760}>
            <NewRouter home={homeSolo} start="/new/add?kind=agent" />
          </PhoneFrameCard>
        </Card>

        <Card
          state="new-page-add-command"
          label="Add your own, Command, a typed line"
          reach="on the New page, switch to Shell and tap Add your own under the Command select. Agent has the same way under Write a command."
          note="A typed line is off until the operator sets [phone] free_text = true; then the card shows one disabled row saying so. Check the line shows every hidden character as its code before Add turns on."
          span={2}
        >
          <PhoneFrameCard height={760}>
            <NewRouter home={homeSolo} start="/new/add?kind=command" />
          </PhoneFrameCard>
        </Card>

        <Card
          state="new-page-add-how"
          label="How adding works, the explainer sheet"
          reach="on the Add your own page, tap How adding works."
          note="The recipe, Write a command and how the operator turns it on, this machine's launchers.toml path with one example row and a Copy button, where phone rows live, and the docs link."
        >
          <Stage height={640}>
            <LauncherHowSheet open onClose={() => {}} file="/home/op/.config/collie/launchers.toml" />
          </Stage>
        </Card>

        <Card
          state="new-page-no-prompts-confirm"
          label="Start without prompts?, the confirm sheet"
          reach="on the New page, tap Start on a launcher with the No prompts badge for the first time on this phone and machine. The dashboard's Launch strip and the switcher's Launch section ask the same question."
          note="Asked once per phone, machine and line. Cancel does nothing; Start remembers the answer and goes on."
        >
          <Stage height={520}>
            <NoPromptsSheet
              ask={{ command: "claude --dangerously-skip-permissions", folder: "~/projects/collie", machine: "workshop" }}
              onStart={() => {}}
              onCancel={() => {}}
            />
          </Stage>
        </Card>
      </Group>
    </Section>
  );
}
