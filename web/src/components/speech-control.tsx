import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Icon } from "@/components/icons/icon";
import type { IconKey } from "@/components/icons/keys";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Collapse } from "@/components/ui/collapse";
import { Notice } from "@/components/ui/notice";
import { OneOf } from "@/components/ui/one-of";
import { SectionLabel } from "@/components/ui/section-label";
import { BottomSheet } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import {
  AudioLine,
  AudioValue,
  COMMAND_DOCS_URL,
  FactsSheet,
  Facts,
  HostCommand,
  InfoButton,
  InUseBadge,
  OptionCard,
  RecommendedBadge,
  optionName,
  ReadOnlyHostBanner,
  Ring,
  SETUP_COMMANDS,
  StateLine,
  StateWord,
  StepList,
  terminalOnly,
  TierLabel,
  Zone,
  type AboutId,
  type StepView,
} from "@/components/voice-parts";
import { VoiceEmpty } from "@/components/voice-empty";
import { useStoredModel } from "@/hooks/use-stored-model";
import { useLocale } from "@/hooks/use-locale";
import { useNav } from "@/hooks/use-nav";
import { fetchSttHost, fetchWhistleStatus, removeWhistleModel, setSttHost, startWhistleSetup } from "@/lib/api";
import { describeThrownError } from "@/lib/api-error-message";
import { dateTime } from "@/lib/format";
import { t, type MessageKey } from "@/lib/i18n";
import { formatDownloadSize, formatPercent } from "@/lib/machine-units";
import { voicePagePath, type VoicePage } from "@/lib/nav";
import { noteWhistleStatus, refreshOperatorConfig } from "@/lib/operator-config";
import { usePairing } from "@/lib/pairing";
import { useOptionalRootData } from "@/lib/route-data";
import { useScope } from "@/lib/session";
import {
  phoneEngineBlock,
  phoneEngineEnv,
  runSttProbe,
  setHandsFreeEnabled,
  setSttEnginePreference,
  sttModelErrorMessage,
  sttRecordingSupported,
  useHandsFree,
  useHostSttCapability,
  useOperatorConfigRead,
  useSttEnginePreference,
  useSttProbeState,
  useWhistleStatus,
  type PhoneEngineBlock,
  type SttEngineChoice,
} from "@/lib/stt";
import { CODEX_CONSENT_ID, CODEX_CONSENT_KEYS, CODEX_TRANSCRIBE_URL } from "@/lib/stt-consent";
import { downloadModel, removeModel, SttModelError, type StoredModel } from "@/lib/stt-model";
import { leadHost } from "@/lib/hosts";
import { isReadOnly, type ServerSummary, type SttCapability, type SttHostChoice, type SttHostStatus, type WhistleStatus } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  askFor,
  browserBlock,
  choiceOf,
  codexStateOf,
  currentHostProvider,
  guidedPlan,
  HOST_OPTIONS,
  hostNotReady,
  hostOptionOf,
  modelChip,
  namedSetup,
  oldWhistleWrapper,
  optionOfChoice,
  phoneChoiceInForce,
  reachOf,
  setupSteps,
  shortVersion,
  statusFacts,
  tierOf,
  voiceStatus,
  type EngineFact,
  type GuidedPlan,
  type HostLock,
  type HostOption,
  type ModelChip,
  type NamedSetup,
  type Readiness,
  type SetUpFact,
  type SetupStep,
  type StatusFacts,
  type VoiceStatus,
} from "@/lib/voice";
import { WHISTLE_MODEL_BYTES } from "@/stt/pins";

// SETTINGS → VOICE: WHERE YOUR SPEECH BECOMES TEXT (ADR 0096, ADR 0097).
//
// A hub and two pages below it. The hub answers the question a person opens Voice to ask, "what
// happens when I press the mic", with the engine in use as the title of its first card. Under it,
// hands-free, then "Change how speech works", which folds away the rest while speech works and
// stands open while it does not: this phone's own choice in full (On this phone or On your host),
// the host's option, and the model. The host's option reaches every device, so it is ONE row with a
// way in; its five options live on Host speech, one level down, where a change is a deliberate
// trip. The model's two copies (on the host, on this phone) live on Whistle model, the other page.
//
// THE TWO SCOPES ARE THE STRUCTURE. "Only this phone" and "Every device on your host" are the two
// section labels the hub has, so a person always knows which of the two a tap reaches. A device
// without the write grant sees one banner, and it covers the host's settings only: this phone's own
// choice and hands-free stay live.
//
// THE HOST'S OPTION CHANGES ONLY AMONG THREE (ADR 0097). Whistle, ChatGPT (Codex) and Off carry no
// key and run no command the operator chose. Your own command and a speech service are set up in a
// terminal on the host: the page prints the fixed commands and a "Check again", never a field. A
// change that sends audio further than before asks first, in a sheet; ChatGPT always opens its
// consent, the same words `collie stt setup` prints, and nothing is sent before "I accept".
//
// EVERY OPTION SAYS HOW TO SET IT UP, even when the app cannot switch to it: "How to set up" on each
// card, numbered steps, the app's own buttons where it may act and fixed commands where it may not.
// Under a terminal lock the steps of Whistle and ChatGPT begin with `collie stt off` on the host; the
// app itself still never changes a provider set up with a key or a command.
//
// NO SILENT SWITCH (ADR 0096 Decision 12). A phone that chose On this phone and lost its copy is
// paused, and says so with one action (Restore). It does not send audio to the host by itself.
//
// THIS FILE HAS TWO HALVES, as notify-prefs-control.tsx does. `SpeechCards` is the view: every fact
// it draws arrives as a prop, so the playground can show each state with no host behind it.
// `SpeechControl` is the controller: it reads the stores, polls, and owns the taps. The small pieces
// both halves share are in components/voice-parts.tsx; the rules behind the words in lib/voice.ts.
//
// THE BOX DOES NOT MOVE ON A STATE (DESIGN.md §2). A download's bar takes the place of the button
// that started it, and "How to set up" and "Change how speech works" open through `Collapse`. A tap
// between this phone's two choices repaints and never re-lays-out: both cards render the same rows
// either way, the selected look is paint (`OptionCard`), and the in-use card holds the words of both
// choices in `OneOf` slots. web/e2e/stt-phone.spec.ts measures it.

/** Cactus Compute made Whistle. The credit names them and links to them. */
export const CACTUS_URL = "https://cactuscompute.com";
/** The model's page, and the base of a link to one revision of it. */
export const WHISTLE_PAGE_URL = "https://huggingface.co/Cactus-Compute/whistle";

/** A full Hugging Face revision is a 40-character commit hash; only that shape becomes a link. */
const FULL_REVISION = /^[0-9a-f]{40}$/;

/** The reason "On this phone" is off for a reason of the browser, in words. */
const BLOCK_KEYS = {
  insecure: "settings.speech.engine.why.insecure",
  browser: "settings.speech.engine.why.browser",
  "wasm-csp": "settings.speech.engine.why.wasmCsp",
  engine: "settings.speech.engine.why.engine",
} as const satisfies Record<Exclude<PhoneEngineBlock, "host-not-ready">, MessageKey>;

/** The phone's own download, if one is under way. */
export type PhoneCopy = { received: number; total: number } | null;

/** "Set up speech on this phone" as it stands. A failure names its phase: the host's download or this phone's copy. */
export type GuidedRun = { kind: "idle" } | { kind: "running" } | { kind: "failed"; phase: "host" | "copy"; message: string };

/** Which Voice page is drawn: the hub, Host speech, or Whistle model. */
export type VoiceView = "hub" | VoicePage;

export interface SpeechCardsProps {
  /** The page to draw. */
  page: VoiceView;
  /** The host's model status. `null`: this collie offers none (an older bridge, or a crew member). */
  whistle: WhistleStatus | null;
  /** The host's speech provider, as `/api/config` says it. `null`: none is configured. */
  hostStt: SttCapability | null;
  /** The host's provider, who set it and what may be chosen (`GET /api/stt/host`). `null`: not known (an older bridge, or not read yet). */
  host: SttHostStatus | null;
  /** The first read of the host's provider has settled, answered or not. */
  hostRead: boolean;
  /** The choice being sent to the host, while it is in flight. */
  switching: SttHostChoice | null;
  /** A refused switch, in words, written on the Host speech page. */
  providerError: string | null;
  /** The host-wide confirm is open for this choice. */
  confirmTo: SttHostChoice | null;
  /** The ChatGPT consent sheet is open. */
  consentOpen: boolean;
  /** A refused ChatGPT switch, in words, written inside the open consent sheet. */
  consentError: string | null;
  /** This device may set up and change the host's model and option (the same rule every other write uses). */
  canWrite: boolean;
  /** This browser can record at all. */
  recording: boolean;
  /** What this device asked for. */
  engine: SttEngineChoice;
  /** Why "On this phone" cannot run, if it cannot. */
  block: PhoneEngineBlock | null;
  /** The phone's own copy: `null` none, `undefined` still looking. */
  local: StoredModel | null | undefined;
  /** The browser promised to keep the copy when space runs low. */
  persisted: boolean;
  /** The phone's download, while it runs. */
  copy: PhoneCopy;
  /** A failed host action or phone copy, in words. */
  hostError: string | null;
  phoneError: string | null;
  /** The host action in flight, so its button cannot be tapped twice. */
  hostBusy: boolean;
  /** A "Check again" read of the host is in flight. */
  checking: boolean;
  /** The second tap of "Remove" on the host's copy is armed. */
  confirmingRemove: boolean;
  /** Hands-free is on for this device. */
  handsFree: boolean;
  /** "Set up speech on this phone": idle, running, or stopped at a phase with that phase's words. */
  guided: GuidedRun;
  /** The info sheet open at first paint. The playground opens one; the page starts with none. */
  initialAbout?: AboutId | null;
  /** The option whose "How to set up" is open at first paint, on Host speech. */
  initialSetup?: HostOption | null;
  /** The host's name, where the API gives one (a crew's lead). Absent: the page says "Your host". */
  hostName?: string | null;
  /** The model's details open at first paint, on Whistle model. */
  initialDetails?: boolean;
  /** "Change how speech works" open (or closed) at first paint, on the hub. The playground sets it; the page decides from the status. */
  initialOpen?: boolean;
  onEngine: (choice: SttEngineChoice) => void;
  onHandsFree: (on: boolean) => void;
  /** Download the model to the host. */
  onSetup: () => void;
  /** Download the model to the host, then copy it to this phone once it is there. */
  onSetupBoth: () => void;
  onAskRemove: () => void;
  onCancelRemove: () => void;
  onRemove: () => void;
  /** A host choice was tapped. Whistle and Off are sent at once or after the confirm; ChatGPT opens the consent. */
  onChooseProvider: (choice: SttHostChoice) => void;
  onConfirm: () => void;
  onCancelConfirm: () => void;
  /** "I accept" in the consent sheet: the only path by which a ChatGPT switch reaches the host. */
  onAcceptConsent: () => void;
  onCancelConsent: () => void;
  onPhoneDownload: () => void;
  onPhoneRemove: () => void;
  /** Read the host's option again, after a step in its terminal. */
  onCheckAgain: () => void;
  onOpenPage: (page: VoicePage) => void;
  /** "Set up speech on this phone", or Try again after it stopped. */
  onGuidedSetup: () => void;
}

/** A thin determinate bar. `fraction` is 0..1. The same bar the update screen draws. */
function Bar({ fraction, label }: { fraction: number; label: string }) {
  const percent = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      aria-valuetext={formatPercent(fraction)}
      className="h-1 w-full overflow-hidden rounded-md bg-muted"
    >
      <div className="h-full bg-status-working motion-safe:transition-[width]" style={{ width: `${percent}%` }} />
    </div>
  );
}

/** A progress line: the bar and "7.3 MB of 16.9 MB" under it. Both numbers share the model's unit. */
function Progress({ received, total, label }: { received: number; total: number; label: string }) {
  return (
    <div className="space-y-1.5">
      <Bar fraction={total > 0 ? received / total : 0} label={label} />
      <p className="text-xs tabular-nums text-muted-foreground">
        {t("settings.speech.progress", { received: formatDownloadSize(received), total: formatDownloadSize(total) })}
      </p>
    </div>
  );
}

/** How an outside link looks here, as in the cache sheet and the launcher help: underlined, no icon. */
const LINK_CLASS =
  "break-words underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

function ExternalLink({ href, label, children }: { href: string; label?: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" aria-label={label} className={LINK_CLASS}>
      {children}
    </a>
  );
}

/**
 * A sentence with one link in it. The message carries `{link}` where the link goes, so a language
 * that puts the name elsewhere in the sentence still reads right.
 */
function SentenceWithLink({ message, link }: { message: MessageKey; link: ReactNode }) {
  const [before = "", after = ""] = t(message, { link: "{link}" }).split("{link}");
  return (
    <>
      {before}
      {link}
      {after}
    </>
  );
}

/** A name the host's settings give (a command, a model, a host name), as the terminal spells it. */
function Mono({ children }: { children: string }) {
  return <span className="font-mono break-all">{children}</span>;
}

/**
 * A sentence with names in it, each drawn as a node. The message carries `{slot}` where each goes,
 * so a language that orders them differently still reads right.
 */
function SentenceWith({ message, values }: { message: MessageKey; values: Record<string, ReactNode> }) {
  const marks = Object.fromEntries(Object.keys(values).map((key) => [key, `{${key}}`]));
  const parts = t(message, marks).split(/\{(\w+)\}/);
  return (
    <>
      {parts.map((part, i) => (i % 2 === 0 ? part : <span key={i}>{values[part] ?? part}</span>))}
    </>
  );
}

/** The model's version: the first seven characters of the Hugging Face revision, linked to that revision. */
function Version({ revision, sha256 }: { revision: string | undefined; sha256: string | undefined }) {
  const short = shortVersion(revision, sha256);
  if (revision === undefined || !FULL_REVISION.test(revision)) return <>{short}</>;
  return (
    <ExternalLink href={`${WHISTLE_PAGE_URL}/tree/${revision}`} label={t("settings.speech.detail.versionLink", { revision: short })}>
      {short}
    </ExternalLink>
  );
}

/** The model's size, formatted: the host's number, else the phone's, else the size this build pins. */
function modelSize(whistle: WhistleStatus | null, local: StoredModel | null | undefined): string {
  return formatDownloadSize(whistle?.bytes ?? local?.bytes ?? WHISTLE_MODEL_BYTES);
}

/** The host's option, from the status read or the config. `null`: a provider this build does not know. */
function hostOptionNow(props: Pick<SpeechCardsProps, "host" | "hostStt">): HostOption | null {
  return hostOptionOf(currentHostProvider(props.host, props.hostStt));
}

/** The host's option's name, or the provider id as the host sent it when this build does not know it. */
function hostOptionLabel(props: Pick<SpeechCardsProps, "host" | "hostStt">): string {
  const option = hostOptionNow(props);
  return option === null ? currentHostProvider(props.host, props.hostStt) : optionName(option);
}

/** Whether the host's option could serve a request now. */
function hostAvailable(props: Pick<SpeechCardsProps, "host" | "hostStt">): boolean {
  return props.host?.available ?? props.hostStt?.available ?? false;
}

/** The host's own words for why its option does not work, or the plain fallback. */
function hostReason(props: Pick<SpeechCardsProps, "host" | "hostStt">): string {
  return props.host?.reason ?? props.hostStt?.reason ?? t("settings.speech.provider.status.unavailable");
}

/** "Last changed by Pixel 8, 11 Oct 2026, 09:41." Nothing when the host recorded no device. */
function LastChanged({ host }: { host: SttHostStatus | null }) {
  if (host?.changedBy === undefined || host.changedAt === undefined) return null;
  const at = Date.parse(host.changedAt);
  if (Number.isNaN(at)) return null;
  return <p className="text-xs text-muted-foreground">{t("settings.voice.lastChanged", { device: host.changedBy, time: dateTime(at) })}</p>;
}

/** The views, drawn from what they are told. No store, no network. */
export function SpeechCards(props: SpeechCardsProps) {
  useLocale();
  const [about, setAbout] = useState<AboutId | null>(props.initialAbout ?? null);
  const sheets = (
    <>
      <FactsSheet about={about} hostOption={hostOptionNow(props)} size={modelSize(props.whistle, props.local)} onClose={() => setAbout(null)} />
      <HostConfirmSheet {...props} />
      <CodexConsentSheet
        open={props.consentOpen}
        codexBin={props.host?.codexBin ?? "codex"}
        busy={props.switching === "codex"}
        error={props.consentError}
        onAccept={props.onAcceptConsent}
        onCancel={props.onCancelConsent}
      />
    </>
  );
  if (props.page === "host") {
    return (
      <>
        <HostSpeechPage {...props} onAbout={setAbout} />
        {sheets}
      </>
    );
  }
  if (props.page === "model") return <WhistleModelPage {...props} />;
  return (
    <>
      <VoiceHub {...props} onAbout={setAbout} />
      {sheets}
    </>
  );
}

/** Whether the hub has anything to say: a model, a copy, or a host that answered about speech. */
export function voiceHubShown(props: Pick<SpeechCardsProps, "whistle" | "local" | "host" | "hostStt">): boolean {
  return props.whistle !== null || Boolean(props.local) || props.host !== null || props.hostStt !== null;
}

// ── THE HUB ─────────────────────────────────────────────────────────────────────────────────────

type WithAbout = SpeechCardsProps & { onAbout: (about: AboutId) => void };

/** "Ready. …", "Not ready. …": a readiness code in words, with the fact it rests on. */
const ready = (detail: string) => t("settings.voice.state.ready", { detail });
const notReady = (detail: string) => t("settings.voice.state.notReady", { detail });

function readinessWords(readiness: Readiness, props: SpeechCardsProps): string {
  switch (readiness) {
    case "phone-ready":
      return ready(t("settings.voice.ok.phone", { version: props.local ? shortVersion(props.local.revision, props.local.sha256) : "" }));
    case "phone-gone":
      return t("settings.voice.state.paused", { detail: t("settings.voice.why.phoneGone") });
    case "no-recording":
      return notReady(t("settings.voice.why.noRecording"));
    case "nothing":
      return t("settings.voice.state.notSetUp", { detail: t("settings.voice.why.nothing") });
    case "whistle-ready": {
      const whistle = props.whistle;
      return ready(
        whistle?.state === "ready" && (whistle.revision !== undefined || whistle.sha256 !== undefined)
          ? t("settings.voice.ok.whistle", { version: shortVersion(whistle.revision, whistle.sha256) })
          : t("settings.voice.ok.whistleModel"),
      );
    }
    case "command-found":
      return ready(t("settings.voice.ok.command"));
    case "service-set":
      return t("settings.voice.state.setUp", { detail: t("settings.voice.ok.service") });
    case "codex-ready":
      return ready(t("settings.voice.ok.codex"));
    case "other-ready":
      return ready(t("settings.voice.ok.other"));
    default:
      return notReady(notReadyDetail(readiness, props));
  }
}

const WHY_KEYS = {
  "whistle-no-model": "settings.voice.why.whistleNoModel",
  "whistle-no-engine": "settings.voice.why.whistleNoEngine",
  "command-missing": "settings.voice.why.commandMissing",
  "codex-missing": "settings.voice.why.codexMissing",
  "codex-signed-out": "settings.voice.why.codexSignedOut",
  "codex-other-login": "settings.voice.why.codexOtherLogin",
  "codex-unknown": "settings.voice.why.codexUnknown",
} as const satisfies Partial<Record<Readiness, MessageKey>>;

/** The page's own sentence for a readiness code, or `null` when only the host's words say it. */
function whyKey(readiness: Readiness): MessageKey | null {
  switch (readiness) {
    case "whistle-no-model":
    case "whistle-no-engine":
    case "command-missing":
    case "codex-missing":
    case "codex-signed-out":
    case "codex-other-login":
    case "codex-unknown":
      return WHY_KEYS[readiness];
    default:
      return null;
  }
}

/** Why a host option does not answer, in one sentence: the page's own words, or the host's. */
function notReadyDetail(readiness: Readiness, props: Pick<SpeechCardsProps, "host" | "hostStt">): string {
  const key = whyKey(readiness);
  return key === null ? t("settings.voice.why.hostSays", { reason: hostReason(props) }) : t(key);
}

/**
 * The card's title: what is configured, by name. A command or a speech service's model is the title
 * itself, in mono, as the host's settings spell it; otherwise the engine by name, with its maker
 * where the name alone would not say who made it. Nothing set up is said as such. A provider this
 * build does not know is shown as the host sent it.
 */
function titleNode(engine: EngineFact, named: NamedSetup, props: SpeechCardsProps): ReactNode {
  if (named.name !== null) return <Mono>{named.name}</Mono>;
  return titleWords(engine, props);
}

function titleWords(engine: EngineFact, props: SpeechCardsProps): string {
  switch (engine) {
    case "phone":
    case "whistle":
      return t("settings.voice.inUse.whistle");
    case "chatgpt":
      return t("settings.voice.inUse.chatgpt");
    case "command":
    case "service":
      return optionName(engine);
    case "other":
      return currentHostProvider(props.host, props.hostStt);
    case "off":
      return t("settings.voice.inUse.none");
  }
}

/** The line under the title: what kind of setup it is and where it runs. Nothing when no engine runs. */
function whereWords(facts: StatusFacts, named: NamedSetup, hostName: string | null | undefined): string | null {
  if (facts.runsOn === "phone") return t("settings.speech.phone.heading");
  if (facts.runsOn === "nothing") return null;
  const name = hostName ? { name: hostName } : null;
  switch (facts.engine) {
    case "command":
      return name ? t("settings.voice.inUse.commandHostNamed", name) : t("settings.voice.inUse.commandHost");
    case "service":
      if (named.endpoint !== null) return t("settings.voice.inUse.serviceAt", { endpoint: named.endpoint });
      break;
    case "chatgpt":
      return name ? t("settings.voice.inUse.codexHostNamed", name) : t("settings.voice.inUse.codexHost");
    default:
      break;
  }
  return name ? t("settings.voice.inUse.hostNamed", name) : t("settings.speech.host.heading");
}

/** "Model ggml-base.bin", the line under the title, or nothing when no model is named. */
function ModelLine({ model }: { model: string | null }) {
  if (model === null) return null;
  return <SentenceWith message="settings.voice.inUse.model" values={{ model: <Mono>{model}</Mono> }} />;
}

/**
 * The old Whistle wrapper as the host's own command: one plain line, and a way to Host speech, whose
 * lock note gives `collie stt off`, then Whistle. The lock itself stands (ADR 0097).
 */
function WrapperNote({ onOpenPage }: Pick<SpeechCardsProps, "onOpenPage">) {
  return (
    <div className="space-y-0.5">
      <p className="text-xs text-muted-foreground">{t("settings.voice.wrapper.note")}</p>
      <Button variant="link" className="h-11 px-0 text-xs" onClick={() => onOpenPage("host")}>
        {t("settings.voice.wrapper.switch")}
      </Button>
    </div>
  );
}

/** Whether a view of the card names the old Whistle wrapper. */
const viewsWrapper = (view: StatusView, props: SpeechCardsProps): boolean => view.lead.engine === "command" && oldWhistleWrapper(props.host);

function setUpWords(setUp: SetUpFact): string {
  switch (setUp.kind) {
    case "settings": {
      const at = Date.parse(setUp.at);
      return t("settings.voice.fact.setUp.settings", { device: setUp.by, time: Number.isNaN(at) ? setUp.at : dateTime(at) });
    }
    case "terminal":
      return t("settings.voice.fact.setUp.terminal");
    case "env":
      return t("settings.voice.fact.setUp.env");
    case "phone":
      return t("settings.voice.fact.setUp.phone");
    case "none":
      return t("settings.voice.fact.setUp.none");
  }
}

/** The one sentence under the facts that a state owes, or `null`. */
function statusNote(status: VoiceStatus, props: SpeechCardsProps): string | null {
  if (status.kind === "paused") return t(status.action === "restore" ? "settings.voice.status.paused.detail" : "settings.voice.status.paused.noCopy");
  if (status.kind === "no-recording" && props.block === "insecure") return t("settings.speech.engine.why.insecure");
  return null;
}

/**
 * One way the card can read: for this phone's choice `key`, the status it leads to and its facts.
 * `lead` names the engine the choice would run: the same facts, except that a browser that cannot
 * record still names the engine it would use, and the status line says why it cannot.
 */
interface StatusView {
  key: SttEngineChoice;
  status: VoiceStatus;
  facts: StatusFacts;
  lead: StatusFacts;
  /** What "Set up speech on this phone" would do from this view, or `null` when it is not offered. */
  plan: GuidedPlan | null;
  /** What the lead engine's setup names: a command, a model, a service's host. */
  named: NamedSetup;
}

/** Whether a view of the card carries an action: Restore, Fix, or "Set up speech on this phone". */
function hasAction(view: StatusView): boolean {
  if (view.plan !== null) return true;
  if (view.status.kind === "paused") return view.status.action === "restore";
  return view.status.kind === "host" && view.status.action === "fix";
}

/**
 * The progress of "Set up speech on this phone", one display for both phases: which phase runs,
 * in words, and its bytes. The host's phase reads the host's own count (polled once a second); the
 * copy's phase reads this phone's.
 */
function GuidedProgress({ whistle, copy, local }: Pick<SpeechCardsProps, "whistle" | "copy" | "local">) {
  const hostPhase = copy === null && whistle?.state !== "ready";
  const label = t(hostPhase ? "settings.voice.guided.host" : "settings.voice.guided.copy");
  const total = copy?.total ?? whistle?.bytes ?? local?.bytes ?? WHISTLE_MODEL_BYTES;
  const received = copy !== null ? copy.received : hostPhase ? (whistle?.received ?? 0) : 0;
  return (
    <div className="space-y-1.5">
      <p className="flex items-center gap-1.5 text-xs font-medium">
        <Icon name="busy" aria-hidden className="size-3.5 animate-spin" />
        {label}
      </p>
      <Progress received={received} total={total} label={label} />
    </div>
  );
}

/**
 * "Set up speech on this phone": one button for the whole way, and in its place while it runs, the
 * progress of both phases. A failure stops the run: the phase's own words stand above the button,
 * which then reads Try again. A device that may not ask the host for the model reads the one
 * sentence it reads under On this phone, and has no button.
 */
function GuidedAction({ plan, props }: { plan: GuidedPlan; props: SpeechCardsProps }) {
  if (plan === "needs-host") return <p className="text-xs text-muted-foreground">{t("settings.voice.copy.needsHost")}</p>;
  const { guided } = props;
  const failed = guided.kind === "failed" ? guided : null;
  return (
    <div className="space-y-2">
      <Collapse open={failed !== null}>
        <p role="status" className="text-xs text-status-blocked">
          {failed?.message}
        </p>
      </Collapse>
      <OneOf
        active={guided.kind === "running" ? "running" : "idle"}
        options={[
          {
            key: "idle",
            node: (
              <Button className="h-11" onClick={props.onGuidedSetup}>
                {failed !== null ? <Icon name="refresh" className="size-4" /> : <Icon name="voice-on-phone" className="size-4" />}
                {t(failed !== null ? "settings.speech.host.retry" : "settings.voice.guided.action")}
              </Button>
            ),
          },
          { key: "running", node: <GuidedProgress whistle={props.whistle} copy={props.copy} local={props.local} /> },
        ]}
      />
    </div>
  );
}

/**
 * The action a state owes, in the card: Restore for a paused phone; "Set up speech on this phone"
 * while speech does not work and this device can run the engine; Fix for a host option that does
 * not answer, beside it. Never a second way to change a setting.
 */
function StatusAction({ view, props }: { view: StatusView; props: SpeechCardsProps }) {
  const { status, plan } = view;
  if (status.kind === "paused" && status.action === "restore") {
    return (
      <Button className="h-11" disabled={props.copy !== null || browserBlock(props.block) !== null} onClick={props.onPhoneDownload}>
        {props.copy !== null ? <Icon name="busy" className="size-4 animate-spin" /> : <Icon name="download" className="size-4" />}
        {t("settings.voice.restore", { size: modelSize(props.whistle, props.local) })}
      </Button>
    );
  }
  const fix = status.kind === "host" && status.action === "fix" && (
    <Button variant="outline" className="h-11" onClick={() => props.onOpenPage("host")}>
      <Icon name="fix" className="size-4" />
      {t("settings.voice.fix")}
    </Button>
  );
  if (plan === null) return fix || null;
  return (
    <div className="space-y-2">
      <GuidedAction plan={plan} props={props} />
      {fix}
    </div>
  );
}

/**
 * The card for what is in use. Its title is the engine itself ("Whistle by Cactus Compute"), the
 * line under it where the engine runs, then the status sentence with what it rests on, where audio
 * goes, and, quietly, who set it up. Then the one action that fixes the state. A small "When you
 * press the mic" names the card above its title.
 *
 * A TAP ON THIS PHONE'S CHOICE MOVES NOTHING BELOW (DESIGN.md §2). Every value sits in a `OneOf` that
 * holds the words of BOTH choices, the one in force and the one a tap would make, so each line is
 * already as tall as the taller of the two. `views` lists both while both can be chosen.
 */
function InUseCard({ views, active, props }: { views: readonly StatusView[]; active: SttEngineChoice; props: SpeechCardsProps }) {
  const slot = (key: string, render: (view: StatusView) => ReactNode) => (
    <OneOf key={key} active={active} options={views.map((view) => ({ key: view.key, node: render(view) }))} />
  );
  const anyWhere = views.some((view) => whereWords(view.lead, view.named, props.hostName) !== null);
  const anyModel = views.some((view) => view.named.model !== null);
  const anyWrapper = views.some((view) => viewsWrapper(view, props));
  const anySetUp = views.some((view) => view.facts.setUp.kind !== "none");
  const anyNote = views.some((view) => statusNote(view.status, props) !== null);
  const anyAction = views.some(hasAction);
  const row = (label: string, render: (view: StatusView) => ReactNode) => (
    <div key={label} className="contents">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{slot(label, render)}</dd>
    </div>
  );
  return (
    <Card className="gap-0 py-0">
      <section aria-label={t("settings.voice.status.label")} className="space-y-3 p-4">
        <div className="space-y-1">
          <SectionLabel>{t("settings.voice.status.label")}</SectionLabel>
          <div role="heading" aria-level={2} className="text-base leading-snug font-semibold break-words">
            {slot("title", (view) => titleNode(view.lead.engine, view.named, props))}
          </div>
          {anyModel && (
            <div data-line="model" className="text-sm break-words">
              {slot("model", (view) => <ModelLine model={view.named.model} />)}
            </div>
          )}
          {anyWhere && (
            <div data-line="where" className="text-sm text-muted-foreground">
              {slot("where", (view) => whereWords(view.lead, view.named, props.hostName))}
            </div>
          )}
        </div>
        {slot("status", (view) => <StateLine state={view.status.state}>{readinessWords(view.facts.readiness, props)}</StateLine>)}
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-xs leading-relaxed">
          {row(t("settings.voice.audio.label"), (view) => (
            <AudioValue
              reach={view.status.reach}
              text={view.status.kind === "host" && view.status.option === null ? t("settings.voice.audio.unknown") : undefined}
            />
          ))}
          {anySetUp &&
            row(t("settings.voice.fact.setUp"), (view) =>
              view.facts.setUp.kind === "none" ? null : <span className="text-muted-foreground">{setUpWords(view.facts.setUp)}</span>,
            )}
        </dl>
        {anyNote && slot("note", (view) => <p className="text-xs text-muted-foreground">{statusNote(view.status, props)}</p>)}
        {anyWrapper && slot("wrapper", (view) => (viewsWrapper(view, props) ? <WrapperNote onOpenPage={props.onOpenPage} /> : null))}
        {anyAction && slot("action", (view) => <StatusAction view={view} props={props} />)}
      </section>
    </Card>
  );
}

/**
 * One of this phone's two choices, as a selectable card. The radio is the top of the card; the info
 * button sits beside it, outside the radio; the setup line sits under it, indented to the text's left
 * edge so it reads as part of the choice. Both cards render the same rows whichever is chosen.
 */
function ChoiceCard({
  checked,
  disabled,
  icon,
  title,
  what,
  recommended = false,
  reach,
  audioText,
  onChoose,
  onAbout,
  children,
}: {
  checked: boolean;
  disabled: boolean;
  icon: IconKey;
  title: string;
  what: ReactNode;
  /** The "Recommended" badge beside the title. It may stand with "In use". */
  recommended?: boolean;
  reach: VoiceStatus["reach"];
  audioText?: string;
  onChoose: () => void;
  onAbout: () => void;
  children?: ReactNode;
}) {
  return (
    <OptionCard selected={checked}>
      <button
        type="button"
        role="radio"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => {
          if (!checked) onChoose();
        }}
        className="flex min-h-11 w-full items-start gap-3 p-4 pr-14 text-left transition-colors active:bg-muted/60 disabled:active:bg-transparent"
      >
        <Ring checked={checked} />
        <span className={cn("min-w-0 flex-1 space-y-1", disabled && !checked && "opacity-60")}>
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-sm font-medium">{title}</span>
            <Icon name={icon} aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            <InUseBadge shown={checked} />
            {/* After In use, whose slot is held while hidden: on a narrow phone Recommended wraps
                below, rather than pushing the empty slot onto a line of its own. */}
            {recommended && <RecommendedBadge />}
          </span>
          <span className="block space-y-0.5 text-xs text-muted-foreground">{what}</span>
          <span className="block pt-1">
            <AudioLine reach={reach} text={audioText} />
          </span>
        </span>
      </button>
      <InfoButton name={title} onClick={onAbout} />
      {children !== undefined && <div className="space-y-2 pr-4 pb-4 pl-12">{children}</div>}
    </OptionCard>
  );
}

const SHORT_KEYS = {
  whistle: "settings.voice.short.whistle",
  command: "settings.voice.short.command",
  service: "settings.voice.short.service",
  chatgpt: "settings.voice.short.chatgpt",
} as const satisfies Record<Exclude<HostOption, "off">, MessageKey>;

/** Which of this phone's two choices can be tapped now. */
/** Whether each of this phone's two choices can be tapped. */
interface ChoicesOpen {
  phone: boolean;
  host: boolean;
}

function choicesOpen(props: SpeechCardsProps): ChoicesOpen {
  const inForce = phoneChoiceInForce(props.engine, props.block);
  return {
    // "On this phone" needs a copy and a browser that can run it. A copy that is gone while it is
    // chosen keeps it chosen (paused), so the radio stays where the person put it.
    phone: browserBlock(props.block) === null && (props.local !== null || inForce === "phone"),
    host: hostOptionNow(props) !== "off",
  };
}

/** This phone's two choices, with the setup each needs written inside it. */
function PhoneChoices(props: WithAbout) {
  const { engine, block, onEngine, onAbout } = props;
  const inForce = phoneChoiceInForce(engine, block);
  const open = choicesOpen(props);
  const option = hostOptionNow(props);
  const hostOff = option === "off";
  const hostWhat = hostOff
    ? t("settings.voice.choice.host.off")
    : t("settings.voice.choice.host.what", { option: option === null ? currentHostProvider(props.host, props.hostStt) : t(SHORT_KEYS[option]) });
  return (
    <div role="radiogroup" aria-label={t("settings.voice.phone.hint")} className="space-y-2">
      <ChoiceCard
        checked={inForce === "phone"}
        disabled={!open.phone}
        icon="voice-on-phone"
        title={t("settings.speech.phone.heading")}
        what={t("settings.voice.choice.phone.what")}
        recommended
        reach="phone"
        onChoose={() => onEngine("phone")}
        onAbout={() => onAbout("phone")}
      >
        <PhoneCopyLine {...props} />
      </ChoiceCard>
      <ChoiceCard
        checked={inForce === "host"}
        disabled={!open.host}
        icon="voice-on-host"
        title={t("settings.speech.host.heading")}
        what={
          <>
            {/* The first place a newcomer meets "host" on the hub, so it says what a host is, once. */}
            <span className="block">{t("settings.voice.host.means")}</span>
            <span className="block">{hostWhat}</span>
          </>
        }
        reach={hostOff || option === null ? null : reachOf(option)}
        audioText={hostOff ? t("settings.voice.audio.nothingYet") : option === null ? t("settings.voice.audio.unknown") : undefined}
        onChoose={() => onEngine("host")}
        onAbout={() => onAbout("host")}
      />
    </div>
  );
}

/**
 * The phone choice's own setup line: what its copy of the model needs, and the one button for it.
 * It reads the copy and the host's model, never which choice is in force, so a tap between the two
 * choices leaves it as it is.
 */
function PhoneCopyLine(props: SpeechCardsProps) {
  const { whistle, local, copy, block, canWrite, hostBusy, phoneError, onPhoneDownload, onSetupBoth } = props;
  const why = browserBlock(block);
  const size = modelSize(whistle, local);
  const newer = Boolean(local) && whistle?.state === "ready" && whistle.sha256 !== undefined && whistle.sha256 !== local?.sha256;
  let line: ReactNode;
  if (copy !== null) {
    line = (
      <div className="space-y-2">
        <p className="text-xs">{t("settings.speech.phone.copying")}</p>
        <Progress received={copy.received} total={copy.total} label={t("settings.speech.progressAria")} />
      </div>
    );
  } else if (local) {
    line = (
      <p className="text-xs text-muted-foreground">
        {newer ? t("settings.voice.copy.older") : t("settings.voice.copy.ready", { version: shortVersion(local.revision, local.sha256) })}
      </p>
    );
  } else if (why !== null) {
    line = <p className="text-xs">{t(BLOCK_KEYS[why])}</p>;
  } else if (whistle?.state === "ready") {
    line = (
      <>
        <Button variant="outline" className="h-11" disabled={local === undefined} onClick={onPhoneDownload}>
          <Icon name="download" className="size-4" />
          {t("settings.voice.copy.toPhone", { size })}
        </Button>
        <p className="text-xs text-muted-foreground">{t("settings.voice.copy.toPhone.note")}</p>
      </>
    );
  } else if (whistle?.state === "downloading") {
    line = (
      <div className="space-y-2">
        <p className="text-xs">{t("settings.speech.host.downloading")}</p>
        <Progress received={whistle.received ?? 0} total={whistle.bytes} label={t("settings.speech.progressAria")} />
      </div>
    );
  } else if (whistle === null) {
    line = <p className="text-xs text-muted-foreground">{t("settings.voice.copy.noWhistle")}</p>;
  } else if (!canWrite) {
    line = <p className="text-xs text-muted-foreground">{t("settings.voice.copy.needsHost")}</p>;
  } else {
    // Absent, or a download that failed: one button that does both steps, the host's download and
    // then this phone's copy.
    line = (
      <>
        {whistle.state === "failed" && <p className="text-xs font-medium">{t("settings.speech.host.failed")}</p>}
        <Button variant="outline" className="h-11" disabled={hostBusy || local === undefined} onClick={onSetupBoth}>
          {hostBusy ? <Icon name="busy" className="size-4 animate-spin" /> : <Icon name="download" className="size-4" />}
          {t("settings.voice.copy.setup", { size })}
        </Button>
        <p className="text-xs text-muted-foreground">{t("settings.voice.copy.setup.note")}</p>
      </>
    );
  }
  return (
    <>
      {line}
      {phoneError !== null && (
        <p role="status" className="text-xs text-status-blocked">
          {phoneError}
        </p>
      )}
    </>
  );
}

/** The hub's one row for the host: what it uses, where audio goes, who changed it, and a way in. */
function HostSummaryRow(props: SpeechCardsProps) {
  const option = hostOptionNow(props);
  const broken = option !== "off" && !hostAvailable(props);
  return (
    <Card className="gap-0 py-0">
      <button
        type="button"
        onClick={() => props.onOpenPage("host")}
        className="flex min-h-11 w-full items-start gap-3 p-4 text-left transition-colors active:bg-muted/60"
      >
        <Icon name="voice-on-host" aria-hidden className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 space-y-1">
          <span className="block text-sm font-medium">{hostOptionLabel(props)}</span>
          {broken && (
            <span className="block">
              <StateWord state="broken" word={t("settings.voice.status.broken")} />
            </span>
          )}
          <span className="block pt-0.5">
            <AudioLine reach={option === null ? null : reachOf(option)} text={option === null ? t("settings.voice.audio.unknown") : undefined} />
          </span>
          <span className="block pt-0.5">
            <LastChanged host={props.host} />
          </span>
        </span>
        <Icon name="row-go" aria-hidden className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
      </button>
    </Card>
  );
}

/** The way to every option and its steps, under the host's row. */
function AllOptionsRow({ onOpenPage }: Pick<SpeechCardsProps, "onOpenPage">) {
  return (
    <Card className="gap-0 py-0">
      <button
        type="button"
        onClick={() => onOpenPage("host")}
        className="flex min-h-11 w-full items-center gap-3 px-4 py-3 text-left transition-colors active:bg-muted/60"
      >
        <Icon name="all-options" aria-hidden className="size-5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 text-sm font-medium">{t("settings.voice.host.allOptions")}</span>
        <Icon name="row-go" aria-hidden className="size-5 shrink-0 text-muted-foreground" />
      </button>
    </Card>
  );
}

/**
 * Hands-free, with the one extra line it owes when the text it would send unread came back from a
 * service off the host. The warning names the provider, and arrives through `Collapse`.
 */
function HandsFreeCard(props: SpeechCardsProps) {
  const { handsFree, onHandsFree, engine, block } = props;
  const option = hostOptionNow(props);
  const viaHost = phoneChoiceInForce(engine, block) === "host";
  const warn = handsFree && viaHost && (option === "chatgpt" || option === "service");
  return (
    <Card className="gap-0 py-0">
      <div className="flex items-center justify-between gap-4 p-4">
        <div className="flex min-w-0 items-start gap-3">
          <Icon name="mic" className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="font-medium">{t("settings.handsFree.title")}</div>
            <p className="text-sm text-muted-foreground">{t("settings.handsFree.description")}</p>
          </div>
        </div>
        <div className="flex h-6 w-11 shrink-0 items-center justify-center">
          <Switch checked={handsFree} onCheckedChange={onHandsFree} aria-label={t("settings.handsFree.ariaLabel")} />
        </div>
      </div>
      <Collapse open={warn}>
        <div className="px-4 pb-4">
          <Notice tone="caution" variant="box" icon={<Icon name="warning" />}>
            {t(option === "chatgpt" ? "settings.voice.handsFree.warn.chatgpt" : "settings.voice.handsFree.warn.service")}
          </Notice>
        </div>
      </Collapse>
    </Card>
  );
}

const CHIP_LOOK = {
  gone: { ink: "text-status-blocked", word: "settings.voice.model.chip.gone" },
  update: { ink: "text-status-working", word: "settings.speech.phone.update" },
  downloading: { ink: "text-status-working", word: "settings.voice.copyState.downloading" },
  failed: { ink: "text-status-blocked", word: "settings.voice.copyState.failed" },
  absent: { ink: "text-muted-foreground", word: "settings.voice.copyState.absent" },
  both: { ink: "text-status-done", word: "settings.voice.model.chip.both" },
  host: { ink: "text-status-done", word: "settings.speech.host.heading" },
  phone: { ink: "text-status-done", word: "settings.speech.phone.heading" },
} as const satisfies Record<ModelChip, { ink: string; word: MessageKey }>;

/** The hub's row for the model: who made it, its size, a chip with its state in words, and a way in. */
function ModelHubRow(props: SpeechCardsProps) {
  const chip = CHIP_LOOK[modelChip({ whistle: props.whistle, local: props.local, phoneInForce: phoneChoiceInForce(props.engine, props.block) === "phone" })];
  return (
    <Card className="gap-0 py-0">
      <button
        type="button"
        onClick={() => props.onOpenPage("model")}
        className="flex min-h-11 w-full items-center gap-3 p-4 text-left transition-colors active:bg-muted/60"
      >
        <Icon name="voice-model" aria-hidden className="size-5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">{t("settings.voice.model.title")}</span>
          <span className="block text-xs text-muted-foreground">{t("settings.voice.model.by", { size: modelSize(props.whistle, props.local) })}</span>
        </span>
        <Badge variant="outline" className="gap-1 rounded-sm">
          <span aria-hidden className={cn("size-2 rounded-full bg-current", chip.ink)} />
          {t(chip.word)}
        </Badge>
        <Icon name="row-go" aria-hidden className="size-5 shrink-0 text-muted-foreground" />
      </button>
    </Card>
  );
}

/**
 * "Change how speech works": one row that folds away everything a person needs only to set speech
 * up or change it, this phone's two choices, the host's option and the model. It opens in place,
 * through `Collapse`, on the person's own tap, so the page may grow then.
 */
function ChangeDisclosure({ open, onToggle, children }: { open: boolean; onToggle: () => void; children: ReactNode }) {
  const id = useId();
  return (
    // shrink-0: a direct child of the settings scroller, which is a flex column (see LockedNote).
    <div className="shrink-0">
      <Card className="gap-0 py-0">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={onToggle}
          className="flex min-h-11 w-full items-center gap-3 px-4 py-3 text-left transition-colors active:bg-muted/60"
        >
          <Icon name="change-options" aria-hidden className="size-5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 text-sm font-medium">{t("settings.voice.change")}</span>
          <Icon name="expand" aria-hidden className={cn("size-5 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
        </button>
      </Card>
      <div id={id}>
        <Collapse open={open}>
          <div className="space-y-4 pt-4">{children}</div>
        </Collapse>
      </div>
    </div>
  );
}

/**
 * THE HUB PUTS WHAT IS IN USE FIRST. The card names the engine; under it, hands-free, a daily
 * behaviour rather than setup; then "Change how speech works", which holds this phone's choice, the
 * host's option and the model. While speech works it starts closed on every visit: what is set up
 * needs nothing more. While it does not (nothing set up, paused, a host option that does not
 * answer, a browser that cannot record) it starts open, because the person has something to do,
 * and the card carries the one action as before.
 *
 * The decision waits for the facts: the host's first read and this phone's look for its own copy.
 * Until both have settled it stays closed, so a page that turns out ready never opens and folds on
 * its own. Once open, by the page or by a tap, it stays open for the visit until the person closes
 * it: a tap that makes speech work (choosing On this phone) does not fold the page under the finger.
 */
function VoiceHub(props: WithAbout) {
  const input = {
    local: props.local,
    block: props.block,
    provider: currentHostProvider(props.host, props.hostStt),
    available: hostAvailable(props),
    whistle: props.whistle,
    recording: props.recording,
  };
  const inForce = phoneChoiceInForce(props.engine, props.block);
  const open = choicesOpen(props);
  // The choices the card holds words for: the one in force, and the other while it can be tapped.
  // Once held, a choice stays held for this visit, so a tap that closes the other choice (a paused
  // phone moved to the host) does not shrink the card under the finger either.
  const held = useRef(new Set<SttEngineChoice>());
  held.current.add(inForce);
  for (const choice of ["phone", "host"] as const) if (open[choice]) held.current.add(choice);
  const factsInput = { host: props.host, whistle: props.whistle };
  const views: StatusView[] = (["phone", "host"] as const)
    .filter((choice) => held.current.has(choice))
    .map((choice) => {
      const status = voiceStatus({ ...input, engine: choice });
      const facts = statusFacts(status, factsInput);
      const lead = props.recording ? facts : statusFacts(voiceStatus({ ...input, engine: choice, recording: true }), factsInput);
      const plan = guidedPlan({ status, block: props.block, recording: props.recording, whistle: props.whistle, local: props.local, canWrite: props.canWrite });
      const named = namedSetup(lead.engine, { host: props.host, whistle: props.whistle, local: props.local });
      return { key: choice, status, facts, lead, plan, named };
    });
  const works = views.find((view) => view.key === inForce)?.status.state === "works";
  const settled = props.hostRead && props.local !== undefined;
  // Something to do, seen once the facts settled: the fold opens, and stays open for the visit.
  const [needsWork, setNeedsWork] = useState(false);
  if (settled && !works && !needsWork) setNeedsWork(true);
  const [tapped, setTapped] = useState<boolean | null>(props.initialOpen ?? null);
  const changeOpen = tapped ?? needsWork;
  // Hands-free decides what happens to text a microphone made, so it is shown wherever there is one:
  // a host provider, or this phone's own copy, in a browser that records. It does not follow which
  // choice is in force, so a tap between the two does not bring it or take it away.
  const handsFreeShown = props.recording && (props.hostStt !== null || Boolean(props.local));
  return (
    <>
      {!props.canWrite && <ReadOnlyHostBanner />}
      <InUseCard views={views} active={inForce} props={props} />
      {handsFreeShown && (
        <Zone label={t("settings.voice.after.label")}>
          <HandsFreeCard {...props} />
        </Zone>
      )}
      <ChangeDisclosure open={changeOpen} onToggle={() => setTapped(!changeOpen)}>
        <Zone label={t("settings.voice.phone.label")} hint={t("settings.voice.phone.hint")}>
          <PhoneChoices {...props} />
        </Zone>
        <Zone label={t("settings.voice.host.label")} hint={t("settings.voice.host.hint")}>
          <HostSummaryRow {...props} />
          <AllOptionsRow onOpenPage={props.onOpenPage} />
        </Zone>
        {(props.whistle !== null || Boolean(props.local)) && <ModelHubRow {...props} />}
      </ChangeDisclosure>
    </>
  );
}

// ── HOST SPEECH ─────────────────────────────────────────────────────────────────────────────────

function lockOf(host: SttHostStatus): HostLock | null {
  const reason = host.switchable.off.reason;
  return reason === "env" || reason === "terminal" || reason === "unreadable" ? reason : null;
}

/** An option set up in a terminal, by the environment, or a file that cannot be read: what to run instead of a choice. */
function LockedNote({ lock }: { lock: HostLock }) {
  return (
    // shrink-0: a direct child of the settings scroller, which is a flex column. The box's own
    // min-h-[42px] replaces min-height:auto, so without it the column squeezed this note to one
    // line and its commands drew over the options below.
    <Notice tone="info" variant="box" icon={<Icon name="info" />} className="shrink-0">
      <div className="space-y-2">
        {lock === "terminal" ? (
          <>
            <p>{t("settings.speech.provider.locked.terminal")}</p>
            <HostCommand command="collie stt setup" />
            <p>{t("settings.speech.provider.locked.off")}</p>
            <HostCommand command={SETUP_COMMANDS.off} />
          </>
        ) : (
          <>
            <p>{t(lock === "env" ? "settings.speech.provider.locked.env" : "settings.speech.provider.locked.unreadable")}</p>
            <HostCommand command={SETUP_COMMANDS.status} />
          </>
        )}
      </div>
    </Notice>
  );
}

const WHAT_KEYS = {
  whistle: "settings.voice.option.whistle.what",
  command: "settings.voice.option.command.what",
  service: "settings.voice.option.service.what",
  chatgpt: "settings.voice.option.chatgpt.what",
  off: "settings.voice.option.off.what",
} as const satisfies Record<HostOption, MessageKey>;

const CAVEAT_KEYS = {
  command: "settings.voice.option.command.caveat",
  chatgpt: "settings.voice.option.chatgpt.caveat",
} as const satisfies Partial<Record<HostOption, MessageKey>>;

interface RowProps extends WithAbout {
  option: HostOption;
  /** The host's option is this one. */
  inUse: boolean;
  /** This device may choose here: it may write, the host answered, and nothing locks the choice. */
  interactive: boolean;
  /** Drawn with no ring: a device that may not write, or a host that said nothing. */
  readOnlyRow: boolean;
  /** What locks every choice, or `null`. */
  lock: HostLock | null;
}

/** One host option's facts: name and the "In use" badge, what it is, the audio line, and the one thing it cannot promise. */
function OptionFacts({ option, inUse }: { option: HostOption; inUse: boolean }) {
  const caveat = option === "command" || option === "chatgpt" ? CAVEAT_KEYS[option] : null;
  return (
    <span className="min-w-0 flex-1 space-y-1">
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-sm font-medium">{optionName(option)}</span>
        <InUseBadge shown={inUse} />
      </span>
      <span className="block text-xs text-muted-foreground">{t(WHAT_KEYS[option])}</span>
      <span className="block pt-1">
        <AudioLine reach={reachOf(option)} />
      </span>
      {caveat !== null && (
        <span className="flex gap-1.5 pt-1 text-xs text-muted-foreground">
          <Icon name="info" aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          <span>{t(caveat)}</span>
        </span>
      )}
    </span>
  );
}

/**
 * One host option, as a card with the selected look when the host uses it. A write device sees a
 * radio; it can be tapped for the three the app switches (Whistle, ChatGPT, Off) when the host says
 * they may be chosen, and never for the two set up in a terminal. A read-only device sees the same
 * card with no ring. Every option carries "How to set up", whatever the device may do.
 */
function HostOptionRow(props: RowProps) {
  const { option, inUse, interactive, readOnlyRow, host, switching, onChooseProvider, onAbout } = props;
  const facts = <OptionFacts option={option} inUse={inUse} />;
  const choice = choiceOf(option);
  const sw = choice === null || host === null ? null : host.switchable[choice];
  const disabled = !interactive || choice === null || sw?.ok !== true || switching !== null;
  return (
    <OptionCard selected={inUse}>
      {readOnlyRow ? (
        <div className="flex items-start gap-3 p-4 pr-14">
          <span className="size-5 shrink-0" aria-hidden />
          {facts}
        </div>
      ) : (
        <button
          type="button"
          role="radio"
          aria-checked={inUse}
          disabled={disabled && !inUse}
          aria-disabled={inUse && disabled ? true : undefined}
          onClick={() => {
            if (!inUse && choice !== null && !disabled) onChooseProvider(choice);
          }}
          className="flex min-h-11 w-full items-start gap-3 p-4 pr-14 text-left transition-colors active:bg-muted/60 disabled:active:bg-transparent"
        >
          <Ring checked={inUse} busy={choice !== null && switching === choice} />
          {/* A terminal option is not dimmed: it is not closed, it is set up elsewhere, and says how below. */}
          <span className={cn("min-w-0 flex-1", disabled && !inUse && choice !== null && "opacity-60")}>{facts}</span>
        </button>
      )}
      <InfoButton name={optionName(option)} onClick={() => onAbout(option)} />
      <div className="space-y-2 pr-4 pb-2 pl-12">
        <OptionState {...props} />
        <SetupDisclosure {...props} />
      </div>
    </OptionCard>
  );
}

/**
 * What is true of an option now, under its facts on the text's left edge: why the option in use
 * does not work, the recorded ChatGPT identity, that a terminal option is changed in the terminal,
 * and why a closed choice is closed, in one sentence. What to do about it is in "How to set up".
 */
function OptionState(props: RowProps) {
  const { option, inUse, interactive, readOnlyRow, host, whistle } = props;
  const parts: ReactNode[] = [];
  const choice = choiceOf(option);
  const sw = choice === null || host === null ? null : host.switchable[choice];

  if (inUse && option !== "off" && !hostAvailable(props)) {
    parts.push(
      <div key="broken" className="space-y-1">
        <StateWord state="broken" word={t("settings.voice.status.broken")} />
        <p className="text-xs">{notReadyDetail(hostNotReady(option, { host, whistle }), props)}</p>
      </div>,
    );
  }
  if (inUse && option !== "off") {
    const configured = configuredLine(option, host);
    if (configured !== null) {
      parts.push(
        <p key="configured" className="text-xs text-muted-foreground">
          {configured}
        </p>,
      );
    }
  }
  if (inUse && option === "chatgpt" && host?.identity !== undefined) {
    parts.push(
      <p key="identity" className="text-xs text-muted-foreground">
        <span className="font-mono">{host.identity}</span>{" "}
        {t(host.identity === "codex-cli" ? "settings.speech.provider.identity.codexCli" : "settings.speech.provider.identity.honest")}
      </p>,
    );
  }
  if (inUse && terminalOnly(option) && !readOnlyRow) {
    parts.push(
      <p key="terminal" className="text-xs text-muted-foreground">
        {t("settings.voice.terminal.inUse")}
      </p>,
    );
  }
  // A closed choice, with its reason in one sentence. Not under a lock: the note above the list says
  // it once.
  if (interactive && !inUse && sw !== null && sw.ok === false) {
    const closed: Readiness | null =
      sw.reason === "not-ready" ? "whistle-no-model" : option === "chatgpt" ? hostNotReady("chatgpt", { host, whistle }) : null;
    if (closed !== null && closed !== "host-says") {
      parts.push(
        <p key="closed" className="text-xs text-muted-foreground">
          {notReadyDetail(closed, props)}
        </p>,
      );
    }
  }
  if (parts.length === 0) return null;
  return <div className="space-y-2">{parts}</div>;
}

/**
 * "Configured: whistle-stt, model ggml-base.bin": the option in use, by the names the host's settings
 * give, on Host speech. `null` when the host named nothing (an older host, or nothing to name).
 */
function configuredLine(option: HostOption, host: SttHostStatus | null): ReactNode {
  const setup = host?.setup;
  if (setup === undefined) return null;
  const { command, model, endpoint } = setup;
  if (option === "command" && command !== undefined) {
    return model === undefined ? (
      <SentenceWith message="settings.voice.configured.command" values={{ command: <Mono>{command}</Mono> }} />
    ) : (
      <SentenceWith message="settings.voice.configured.commandModel" values={{ command: <Mono>{command}</Mono>, model: <Mono>{model}</Mono> }} />
    );
  }
  if (option === "service" && endpoint !== undefined) {
    return model === undefined ? (
      <SentenceWith message="settings.voice.configured.endpoint" values={{ endpoint: <Mono>{endpoint}</Mono> }} />
    ) : (
      <SentenceWith message="settings.voice.configured.service" values={{ model: <Mono>{model}</Mono>, endpoint: <Mono>{endpoint}</Mono> }} />
    );
  }
  if (model !== undefined) return <SentenceWith message="settings.voice.configured.model" values={{ model: <Mono>{model}</Mono> }} />;
  return null;
}

/** The model's download, as a step's body: its bar while it runs, its failure, or the button. */
function WhistleDownload({
  whistle,
  hostBusy,
  onSetup,
}: {
  whistle: WhistleStatus;
  hostBusy: boolean;
  onSetup: () => void;
}) {
  if (whistle.state === "ready") return null;
  if (whistle.state === "downloading") {
    return <Progress received={whistle.received ?? 0} total={whistle.bytes} label={t("settings.speech.progressAria")} />;
  }
  return (
    <div className="space-y-1">
      {whistle.state === "failed" && <p className="text-xs font-medium">{t("settings.speech.host.failed")}</p>}
      <Button variant="outline" className="h-11" disabled={hostBusy} onClick={onSetup}>
        {hostBusy ? <Icon name="busy" className="size-4 animate-spin" /> : <Icon name="download" className="size-4" />}
        {t("settings.speech.host.download", { size: formatDownloadSize(whistle.bytes) })}
      </Button>
    </div>
  );
}

/** One step's sentence and what it needs under it: a command to copy, or the app's own button. */
function stepView(step: SetupStep, props: RowProps): StepView {
  const { inUse, host, whistle, switching, canWrite, hostBusy, onSetup, onChooseProvider } = props;
  const base = { key: step.id, mark: step.mark };
  const command = (text: string, line: string): StepView => ({ ...base, text, body: <HostCommand command={line} /> });
  switch (step.id) {
    case "lock-off":
      return command(t("settings.voice.setup.lockOff"), SETUP_COMMANDS.off);
    case "lock-env":
      return command(t("settings.voice.setup.lockEnv"), SETUP_COMMANDS.status);
    case "lock-unreadable":
      return command(t("settings.voice.setup.lockUnreadable"), SETUP_COMMANDS.status);
    case "whistle-download":
      return {
        ...base,
        text: t("settings.voice.setup.whistle.download"),
        body: whistle === null ? undefined : <WhistleDownload whistle={whistle} hostBusy={hostBusy} onSetup={onSetup} />,
      };
    case "whistle-use": {
      const open = host?.switchable.whistle.ok === true && switching === null;
      return {
        ...base,
        text: t("settings.voice.setup.whistle.use"),
        body: inUse ? undefined : (
          <Button variant="outline" className="h-11" disabled={!open} onClick={() => onChooseProvider("whistle")}>
            {switching === "whistle" ? <Icon name="busy" className="size-4 animate-spin" /> : <Icon name="voice-on-host" className="size-4" />}
            {t("settings.voice.setup.whistle.useAction")}
          </Button>
        ),
      };
    }
    case "whistle-command":
      return command(t("settings.voice.setup.whistle.command"), SETUP_COMMANDS.whistleHost);
    case "command-run":
      return {
        ...base,
        text: t("settings.voice.setup.command.run"),
        body: (
          <>
            <HostCommand command={SETUP_COMMANDS.command} />
            <p className="text-xs text-muted-foreground">{t("settings.voice.setup.command.example")}</p>
            <HostCommand command={SETUP_COMMANDS.commandExample} />
          </>
        ),
      };
    case "service-run":
      return command(t("settings.voice.setup.service.run"), SETUP_COMMANDS.service);
    case "codex-install":
      return { ...base, text: t("settings.voice.setup.codex.install") };
    case "codex-login":
      return {
        ...base,
        text: t("settings.voice.setup.codex.login"),
        body: (
          <>
            <HostCommand command={SETUP_COMMANDS.codexLogin} />
            {codexStateOf(host) === "unknown" && (
              <>
                <p className="text-xs text-muted-foreground">{t("settings.voice.setup.codex.status")}</p>
                <HostCommand command={SETUP_COMMANDS.codexLoginStatus} />
              </>
            )}
          </>
        ),
      };
    case "codex-use": {
      if (!canWrite) return command(t("settings.voice.setup.codex.useTerminal"), SETUP_COMMANDS.codexSetup);
      const open = props.interactive && host?.switchable.codex.ok === true && switching === null;
      return {
        ...base,
        text: t("settings.voice.setup.codex.use"),
        body: inUse ? undefined : (
          <Button variant="outline" className="h-11" disabled={!open} onClick={() => onChooseProvider("codex")}>
            {t("settings.voice.setup.codex.useAction")}
          </Button>
        ),
      };
    }
    case "off-choose":
      return command(t("settings.voice.setup.off.choose"), SETUP_COMMANDS.off);
    case "off-command":
      return command(t("settings.voice.setup.off.command"), SETUP_COMMANDS.off);
  }
}

/**
 * "How to set up", folded: numbered steps, one sentence each, commands as fixed lines to copy, and
 * the app's own buttons where the app may act. Open at first paint only for the option in use when
 * it does not work, so the way to fix it is already on screen. It opens through `Collapse`: a tap the
 * person made, and the cards below glide rather than jump.
 */
function SetupDisclosure(props: RowProps) {
  const { option, inUse, interactive, lock, host, whistle, checking, onCheckAgain, initialSetup } = props;
  const broken = inUse && option !== "off" && !hostAvailable(props);
  const [open, setOpen] = useState(initialSetup === option || broken);
  const steps = setupSteps(option, {
    lock,
    // Whistle's own buttons need the host's model status; a host that offers none gets the command.
    interactive: interactive && (option !== "whistle" || whistle !== null),
    inUse,
    working: hostAvailable(props),
    whistleReady: whistle?.state === "ready",
    codex: codexStateOf(host),
  });
  return (
    <div>
      <Button type="button" variant="ghost" className="-ml-2 h-11 px-2 text-xs" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {t("settings.voice.setup.how")}
        <Icon name="expand" aria-hidden className={cn("size-4 transition-transform", open && "rotate-180")} />
      </Button>
      <Collapse open={open}>
        <div className="space-y-3 pt-1 pb-3">
          {option === "command" && <p className="text-xs">{t("settings.voice.setup.command.what")}</p>}
          <StepList steps={steps.map((step) => stepView(step, props))} />
          {option === "service" && <p className="text-xs text-muted-foreground">{t("settings.voice.setup.service.key")}</p>}
          {option === "command" && (
            <p className="text-xs">
              <ExternalLink href={COMMAND_DOCS_URL}>{t("settings.voice.setup.command.docs")}</ExternalLink>
            </p>
          )}
          {option !== "off" && (
            <div className="space-y-1">
              <Button type="button" variant="outline" className="h-11" disabled={checking} onClick={onCheckAgain}>
                {checking ? <Icon name="busy" className="size-4 animate-spin" /> : <Icon name="retry" className="size-4" />}
                {t("settings.voice.checkAgain")}
              </Button>
              <p className="text-xs text-muted-foreground">{t("settings.voice.terminal.check")}</p>
            </div>
          )}
        </div>
      </Collapse>
    </div>
  );
}

/**
 * The five host options in the order audio travels: two tiers, then Off on its own. One card per
 * option, so the one in use can wear the selected look on all four sides.
 */
function HostSpeechPage(props: WithAbout) {
  const { host, hostRead, canWrite, providerError, consentOpen } = props;
  const current = hostOptionNow(props);
  const lock = host === null ? null : lockOf(host);
  // A host that has not said what may be chosen (an older bridge) is drawn like a read-only device,
  // without the banner: nothing here could be sent to it.
  const readOnlyRow = !canWrite || host === null;
  const interactive = !readOnlyRow && lock === null;
  const row = (option: HostOption) => (
    <HostOptionRow
      key={option}
      {...props}
      option={option}
      inUse={current === option}
      interactive={interactive}
      readOnlyRow={readOnlyRow}
      lock={lock}
    />
  );
  const tier = (which: "stays" | "leaves") => HOST_OPTIONS.filter((o) => tierOf(o) === which).map(row);
  return (
    <>
      {!canWrite && <ReadOnlyHostBanner />}
      <div className="space-y-1">
        <p className="text-sm">
          {t("settings.voice.host.means")} {t("settings.voice.hostPage.intro")}
        </p>
        <LastChanged host={host} />
      </div>
      {!readOnlyRow && lock !== null && <LockedNote lock={lock} />}
      {current === null && (
        <p className="text-xs text-muted-foreground">
          {t("settings.voice.hostPage.other", { provider: currentHostProvider(host, props.hostStt) })}
        </p>
      )}
      {hostRead && (
        <div
          role={readOnlyRow ? undefined : "radiogroup"}
          aria-label={readOnlyRow ? undefined : t("settings.voice.hostPage.group")}
          className="space-y-2"
        >
          <TierLabel>{t("settings.voice.tier.stays")}</TierLabel>
          {tier("stays")}
          <TierLabel>{t("settings.voice.tier.leaves")}</TierLabel>
          {tier("leaves")}
          <div className="pt-2">{row("off")}</div>
        </div>
      )}
      {providerError !== null && !consentOpen && (
        <p role="status" className="text-xs text-status-blocked">
          {providerError}
        </p>
      )}
    </>
  );
}

// ── THE TWO SHEETS ──────────────────────────────────────────────────────────────────────────────

/**
 * The host-wide confirm, for a change that sends audio further than before. Before and after, each
 * with its audio line, then the sentence that is the reason this sheet exists.
 */
function HostConfirmSheet(props: SpeechCardsProps) {
  const { confirmTo, onConfirm, onCancelConfirm } = props;
  const before = hostOptionNow(props);
  const after = confirmTo === null ? null : optionOfChoice(confirmTo);
  return (
    <BottomSheet
      open={confirmTo !== null}
      onClose={onCancelConfirm}
      title={after === null ? undefined : t("settings.voice.confirm.title", { option: optionName(after) })}
    >
      {after !== null && (
        <div className="flex flex-col gap-4">
          <p className="text-sm font-medium">{t("settings.voice.confirm.reach")}</p>
          <div className="space-y-3 rounded-sm border border-border p-3">
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">
                {t("settings.voice.confirm.now", { option: before === null ? currentHostProvider(props.host, props.hostStt) : optionName(before) })}
              </p>
              <AudioLine reach={before === null ? null : reachOf(before)} text={before === null ? t("settings.voice.audio.unknown") : undefined} />
            </div>
            <div className="space-y-1 border-t border-border pt-3">
              <p className="text-xs text-muted-foreground">{t("settings.voice.confirm.after", { option: optionName(after) })}</p>
              <AudioLine reach={reachOf(after)} />
            </div>
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="outline" className="h-11 flex-1" onClick={onCancelConfirm}>
              {t("dialog.cancel")}
            </Button>
            <Button type="button" className="h-11 flex-1" onClick={onConfirm}>
              {t("settings.voice.confirm.action")}
            </Button>
          </div>
        </div>
      )}
    </BottomSheet>
  );
}

/**
 * The ChatGPT consent, before anything is sent to the host. The words are `collie stt setup`'s
 * (lib/stt-consent.ts says how they are kept equal), with the host-wide sentence and the audio line
 * above them, and "I accept" is the only control that sends a Codex switch. While the host checks the
 * sign-in and probes the endpoint, the sheet stays open with the button busy, and a refusal is
 * written here, under the words it refused.
 */
export function CodexConsentSheet({
  open,
  codexBin,
  busy,
  error,
  onAccept,
  onCancel,
}: {
  open: boolean;
  /** The binary whose sign-in pays, as the host found it. */
  codexBin: string;
  busy: boolean;
  error: string | null;
  onAccept: () => void;
  onCancel: () => void;
}) {
  useLocale();
  return (
    <BottomSheet open={open} onClose={busy ? () => {} : onCancel} title={t("settings.speech.provider.consent.title")}>
      <div className="flex flex-col gap-3">
        <p className="text-sm font-medium">{t("settings.voice.confirm.reach")}</p>
        <AudioLine reach="chatgpt" />
        {CODEX_CONSENT_KEYS.map((key) => (
          <p key={key} className="text-sm break-words">
            {t(key, { url: CODEX_TRANSCRIBE_URL, codexBin })}
          </p>
        ))}
        {busy && (
          <p role="status" className="text-xs text-muted-foreground">
            {t("settings.speech.provider.consent.probing")}
          </p>
        )}
        {error !== null && !busy && (
          <p role="status" className="text-xs text-status-blocked">
            {error}
          </p>
        )}
        <div className="flex gap-2 pt-1">
          <Button type="button" variant="outline" className="h-11 flex-1" disabled={busy} onClick={onCancel}>
            {t("dialog.cancel")}
          </Button>
          <Button type="button" className="h-11 flex-1" disabled={busy} onClick={onAccept}>
            {busy && <Icon name="busy" className="size-4 animate-spin" />}
            {t("settings.speech.provider.consent.accept")}
          </Button>
        </div>
      </div>
    </BottomSheet>
  );
}

// ── WHISTLE MODEL ───────────────────────────────────────────────────────────────────────────────

/** The credit, always first wherever the model is shown: who made it, its licence, its page. */
function ModelCredit() {
  return (
    <Card className="gap-0 py-0">
      <div className="flex items-start gap-3 p-4">
        <Icon name="voice-model" className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 space-y-1">
          <div className="font-medium">{t("settings.speech.whistle.title")}</div>
          <p className="text-sm text-muted-foreground">
            <SentenceWithLink
              message="settings.speech.credit"
              link={<ExternalLink href={CACTUS_URL}>{t("settings.speech.credit.maker")}</ExternalLink>}
            />
          </p>
          <p className="text-sm text-muted-foreground">
            <SentenceWithLink
              message="settings.speech.licence"
              link={<ExternalLink href={WHISTLE_PAGE_URL}>{t("settings.speech.licence.page")}</ExternalLink>}
            />
          </p>
        </div>
      </div>
    </Card>
  );
}

/** "Details", folded: the checksum and the date, which a person compares rarely. */
function Details({ rows, initial }: { rows: { label: string; value: ReactNode }[]; initial: boolean }) {
  const [open, setOpen] = useState(initial);
  if (rows.length === 0) return null;
  return (
    <div>
      <Button type="button" variant="ghost" className="-ml-2 h-11 px-2 text-xs" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {t("settings.voice.details")}
        <Icon name="expand" className={cn("size-4 transition-transform", open && "rotate-180")} />
      </Button>
      <Collapse open={open}>
        <div className="pb-1">
          <Facts rows={rows} />
        </div>
      </Collapse>
    </div>
  );
}

/** One copy of the model: where it is, its state in a word, then what it needs. */
function CopyCard({
  id,
  where,
  icon,
  state,
  children,
}: {
  id: string;
  where: string;
  icon: IconKey;
  state: { look: VoiceStatus["state"]; word: string };
  children: ReactNode;
}) {
  return (
    <Card className="gap-0 py-0">
      <section aria-labelledby={id} className="space-y-2 p-4">
        <h2 id={id} className="flex items-center gap-2">
          <Icon name={icon} aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          <span className="text-sm font-medium">{where}</span>
        </h2>
        <StateWord state={state.look} word={state.word} />
        {children}
      </section>
    </Card>
  );
}

/** A copy's state word and the look it wears. */
interface CopyStateWord {
  look: VoiceStatus["state"];
  word: string;
}

function hostCopyState(whistle: WhistleStatus): CopyStateWord {
  switch (whistle.state) {
    case "ready":
      return { look: "works", word: t("settings.voice.copyState.ready") };
    case "downloading":
      return { look: "setup", word: t("settings.voice.copyState.downloading") };
    case "failed":
      return { look: "broken", word: t("settings.voice.copyState.failed") };
    case "absent":
      return { look: "setup", word: t("settings.voice.copyState.absent") };
  }
}

function HostCopy(props: SpeechCardsProps & { whistle: WhistleStatus }) {
  const { whistle, canWrite, hostError, hostBusy, confirmingRemove, onSetup, onAskRemove, onCancelRemove, onRemove, initialDetails } = props;
  const size = formatDownloadSize(whistle.bytes);
  const hostUsesIt = hostOptionNow(props) === "whistle";
  return (
    <CopyCard id="speech-host-step" where={t("settings.speech.host.heading")} icon="voice-on-host" state={hostCopyState(whistle)}>
      {whistle.state === "absent" &&
        (canWrite ? (
          <div className="space-y-2">
            <Button className="h-11" disabled={hostBusy} onClick={onSetup}>
              {hostBusy ? <Icon name="busy" className="size-4 animate-spin" /> : <Icon name="download" className="size-4" />}
              {t("settings.speech.host.download", { size })}
            </Button>
            <p className="text-xs text-muted-foreground">{t("settings.speech.host.absent")}</p>
          </div>
        ) : (
          <p className="text-xs">{t("settings.speech.host.readOnly")}</p>
        ))}
      {whistle.state === "downloading" && (
        <div className="space-y-2">
          <p className="text-xs">{t("settings.speech.host.downloading")}</p>
          <Progress received={whistle.received ?? 0} total={whistle.bytes} label={t("settings.speech.progressAria")} />
        </div>
      )}
      {whistle.state === "failed" && (
        <div className="space-y-2">
          {whistle.reason !== undefined && <p className="text-xs text-muted-foreground">{whistle.reason}</p>}
          {canWrite ? (
            <Button className="h-11" variant="outline" disabled={hostBusy} onClick={onSetup}>
              {hostBusy && <Icon name="busy" className="size-4 animate-spin" />}
              {t("settings.speech.host.retry")}
            </Button>
          ) : (
            <p className="text-xs">{t("settings.speech.host.readOnly")}</p>
          )}
        </div>
      )}
      {whistle.state === "ready" && (
        <>
          <Facts
            rows={[
              { label: t("settings.speech.detail.version"), value: <Version revision={whistle.revision} sha256={whistle.sha256} /> },
              { label: t("settings.speech.detail.size"), value: size },
            ]}
          />
          <Details
            initial={initialDetails === true}
            rows={[
              ...(whistle.sha256 === undefined
                ? []
                : [
                    {
                      label: t("settings.speech.detail.checksum"),
                      // The full value is one hover or long-press away; eight characters is what a person compares.
                      value: (
                        <span className="font-mono" title={whistle.sha256}>
                          {`sha256 ${whistle.sha256.slice(0, 8)}…`}
                        </span>
                      ),
                    },
                  ]),
              ...(whistle.fetchedAt === undefined || Number.isNaN(Date.parse(whistle.fetchedAt))
                ? []
                : [{ label: t("settings.speech.detail.downloaded"), value: dateTime(Date.parse(whistle.fetchedAt)) }]),
            ]}
          />
          {canWrite && !confirmingRemove && (
            <div className="space-y-1 pt-1">
              <Button variant="outline" className="h-11" onClick={onAskRemove}>
                {t("settings.speech.host.remove")}
              </Button>
              <p className="text-xs text-muted-foreground">
                {t(hostUsesIt ? "settings.voice.model.removeHost.inUse" : "settings.voice.model.removeHost.idle")}
              </p>
            </div>
          )}
          {canWrite && confirmingRemove && (
            <div className="space-y-2">
              <p className="text-xs text-foreground">{t("settings.speech.host.remove.confirm")}</p>
              <div className="flex gap-2">
                <Button variant="ghost" className="h-11" disabled={hostBusy} onClick={onCancelRemove}>
                  {t("settings.speech.host.remove.cancel")}
                </Button>
                <Button variant="destructive" className="h-11" disabled={hostBusy} onClick={onRemove}>
                  {hostBusy ? <Icon name="busy" className="size-4 animate-spin" /> : <Icon name="delete" className="size-4" />}
                  {t("settings.speech.host.remove.action")}
                </Button>
              </div>
            </div>
          )}
        </>
      )}
      {hostError !== null && (
        <p role="status" className="text-xs text-status-blocked">
          {hostError}
        </p>
      )}
    </CopyCard>
  );
}

function PhoneCopy(props: SpeechCardsProps) {
  const { whistle, block, local, persisted, copy, phoneError, engine, onPhoneDownload, onPhoneRemove } = props;
  const hostReady = whistle?.state === "ready";
  const newer = local !== null && local !== undefined && hostReady && whistle?.sha256 !== undefined && whistle.sha256 !== local.sha256;
  const why = browserBlock(block);
  const size = modelSize(whistle, local);
  const gone = local === null && phoneChoiceInForce(engine, block) === "phone";
  const state: { look: VoiceStatus["state"]; word: string } = local
    ? newer
      ? { look: "setup", word: t("settings.voice.copyState.older") }
      : { look: "works", word: t("settings.voice.copyState.ready") }
    : gone
      ? { look: "paused", word: t("settings.voice.copyState.gone") }
      : { look: "setup", word: t("settings.voice.copyState.notSetUp") };
  return (
    <CopyCard id="speech-phone-step" where={t("settings.speech.phone.heading")} icon="voice-on-phone" state={state}>
      {copy !== null ? (
        <div className="space-y-2">
          <p className="text-xs">{t("settings.speech.phone.copying")}</p>
          <Progress received={copy.received} total={copy.total} label={t("settings.speech.progressAria")} />
        </div>
      ) : local ? (
        <>
          <Facts
            rows={[
              { label: t("settings.speech.detail.version"), value: <Version revision={local.revision} sha256={local.sha256} /> },
              { label: t("settings.speech.detail.size"), value: formatDownloadSize(local.bytes) },
            ]}
          />
          <p className="text-xs text-muted-foreground">{persisted ? t("settings.speech.phone.kept") : t("settings.speech.phone.mayClear")}</p>
          {newer && (
            <div className="flex min-h-11 items-center justify-between gap-3">
              <span className="min-w-0 text-xs">{t("settings.speech.phone.newer")}</span>
              <Button className="h-11 shrink-0" disabled={why !== null} onClick={onPhoneDownload}>
                {t("settings.speech.phone.update")}
              </Button>
            </div>
          )}
          <div className="space-y-1 pt-1">
            <Button variant="outline" className="h-11" onClick={onPhoneRemove}>
              {t("settings.speech.phone.remove")}
            </Button>
            <p className="text-xs text-muted-foreground">
              {phoneChoiceInForce(engine, block) === "phone"
                ? t("settings.voice.model.removePhone.inUse")
                : t("settings.voice.model.removePhone.idle", { size })}
            </p>
          </div>
        </>
      ) : why !== null ? (
        // This browser cannot run the engine, so a button would only lead to a dead end.
        <p className="text-xs">{t(BLOCK_KEYS[why])}</p>
      ) : hostReady ? (
        <Button variant={gone ? "default" : "outline"} className="h-11" disabled={local === undefined} onClick={onPhoneDownload}>
          <Icon name="download" className="size-4" />
          {t(gone ? "settings.voice.restore" : "settings.voice.copy.toPhone", { size })}
        </Button>
      ) : (
        <p className="text-xs text-muted-foreground">{t("settings.voice.model.phoneNeedsHost")}</p>
      )}
      {phoneError !== null && (
        <p role="status" className="text-xs text-status-blocked">
          {phoneError}
        </p>
      )}
    </CopyCard>
  );
}

function WhistleModelPage(props: SpeechCardsProps) {
  return (
    <>
      {!props.canWrite && <ReadOnlyHostBanner />}
      <ModelCredit />
      {props.whistle !== null && <HostCopy {...props} whistle={props.whistle} />}
      <PhoneCopy {...props} />
    </>
  );
}

// ── THE CONTROLLER ──────────────────────────────────────────────────────────────────────────────

/** The lead's name on a crew's roster, the machine speech runs on. A solo host is named nowhere, so `null`. */
function leadName(servers: readonly ServerSummary[] | undefined): string | null {
  const id = leadHost(servers);
  return servers?.find((s) => s.id === id)?.name ?? null;
}

/** How often the host is asked while its download runs. Only while the page is on screen. */
export const WHISTLE_POLL_MS = 1000;
/** Failed polls in a row after which the polling stops, so a host that went away is not asked forever. */
const POLL_FAILURE_LIMIT = 10;

/**
 * The Voice pages, wired. Write access is read the way the dashboard reads it: the bridge's device
 * gate (`isReadOnly`, from the root loader) or a refused pairing, either of which makes this device
 * read-only. Nothing here decides it by itself, and the bridge still enforces it on every write.
 */
export function SpeechControl({ page = "hub" }: { page?: VoiceView }) {
  useLocale();
  const nav = useNav();
  const scope = useScope();
  const root = useOptionalRootData();
  const { refused } = usePairing();
  const canWrite = !isReadOnly(root?.device) && !refused;
  const whistle = useWhistleStatus();
  const hostStt = useHostSttCapability();
  const configRead = useOperatorConfigRead();
  const engine = useSttEnginePreference();
  const probe = useSttProbeState();
  const handsFree = useHandsFree();
  const { model: stored, persisted } = useStoredModel();
  // The copy a guided run just made, held until the store's own look answers. The store learns of a
  // new copy a moment after the download resolves; without this, the run would choose On this phone
  // over a store that still says "no copy", and the card would read Paused for that moment. `over`
  // is the store's answer the copy was held against: any newer answer replaces it.
  const [justCopied, setJustCopied] = useState<{ model: StoredModel; over: StoredModel | null | undefined } | null>(null);
  const local = justCopied !== null && justCopied.over === stored ? (stored ?? justCopied.model) : stored;

  const [copy, setCopy] = useState<PhoneCopy>(null);
  const [hostError, setHostError] = useState<string | null>(null);
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [hostBusy, setHostBusy] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const copyAbort = useRef<AbortController | null>(null);
  const [host, setHost] = useState<SttHostStatus | null>(null);
  const [hostRead, setHostRead] = useState(false);
  const [checking, setChecking] = useState(false);
  const [switching, setSwitching] = useState<SttHostChoice | null>(null);
  const [providerError, setProviderError] = useState<string | null>(null);
  const [confirmTo, setConfirmTo] = useState<SttHostChoice | null>(null);
  const [consentOpen, setConsentOpen] = useState(false);
  const [consentError, setConsentError] = useState<string | null>(null);
  // "Set up" on the hub: once the host's download is ready, this phone copies it.
  const copyWhenReady = useRef(false);
  // "Set up speech on this phone": the run in words for the card, and whether a run is under way,
  // read by the steps that end it (the copy chooses On this phone; a failure stops it).
  const [guided, setGuided] = useState<GuidedRun>({ kind: "idle" });
  const guiding = useRef(false);

  // THE HOST'S OPTION, read when the page opens and again whenever the model changes state, because
  // a ready model is what opens the Whistle row and a removed one may take the option with it. An
  // older bridge answers 404 and the host is drawn from the config alone; nothing here retries.
  const modelKey = `${whistle?.state ?? "none"}:${whistle?.sha256 ?? ""}:${whistle?.hostEngine === true}`;
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        setHost(await fetchSttHost(controller.signal));
      } catch {
        if (controller.signal.aborted) return;
      }
      setHostRead(true);
    })();
    return () => controller.abort();
  }, [modelKey]);

  const block = phoneEngineBlock({
    env: phoneEngineEnv(),
    probe,
    haveLocalModel: local !== null,
    hostReady: whistle?.state === "ready",
  });

  // Ask the worker once whether this browser runs the engine, as soon as there is a model to run and
  // nothing else already rules the phone out. Costs one short-lived worker, once per page session.
  const visible = whistle !== null || local !== null;
  const envOk = block === null || block === "host-not-ready";
  useEffect(() => {
    if (visible && envOk) void runSttProbe();
  }, [visible, envOk]);

  // THE POLL: once a second, only while the host is downloading and only while the page is visible.
  const downloading = whistle?.state === "downloading";
  useEffect(() => {
    if (!downloading) return;
    const controller = new AbortController();
    let inFlight = false;
    let failures = 0;
    async function poll(): Promise<void> {
      if (inFlight || document.visibilityState === "hidden") return;
      inFlight = true;
      try {
        noteWhistleStatus(await fetchWhistleStatus(controller.signal));
        failures = 0;
      } catch {
        failures += 1;
        if (failures >= POLL_FAILURE_LIMIT) clearInterval(id);
      } finally {
        inFlight = false;
      }
    }
    const id = setInterval(() => void poll(), WHISTLE_POLL_MS);
    return () => {
      controller.abort();
      clearInterval(id);
    };
  }, [downloading]);

  // Leaving the page ends a copy in progress; nothing is kept from a half-finished one.
  useEffect(() => () => copyAbort.current?.abort(), []);

  async function hostAction(work: () => Promise<WhistleStatus>, refresh = false): Promise<void> {
    setHostBusy(true);
    setHostError(null);
    try {
      noteWhistleStatus(await work());
      // The host's option may have changed with it, and the microphone follows the option.
      if (refresh) void refreshOperatorConfig();
    } catch (error) {
      copyWhenReady.current = false;
      const message = describeThrownError(error);
      setHostError(message);
      if (page === "hub") setPhoneError(message);
      stopGuided("host", message);
    } finally {
      setHostBusy(false);
      setConfirmingRemove(false);
    }
  }

  /** Read the host's option once more, after a step in its terminal. */
  async function checkAgain(): Promise<void> {
    setChecking(true);
    try {
      setHost(await fetchSttHost());
      void refreshOperatorConfig();
    } catch (error) {
      setProviderError(describeThrownError(error));
    } finally {
      setChecking(false);
    }
  }

  /**
   * Send one choice to the host. ChatGPT only ever arrives here from "I accept", with the id of the
   * consent text the sheet showed; Whistle and Off arrive on the tap or from the confirm. The answer
   * is the host's new status, and the config is re-read with it, because the microphone follows it.
   */
  async function switchProvider(choice: SttHostChoice): Promise<void> {
    setSwitching(choice);
    setProviderError(null);
    setConsentError(null);
    try {
      setHost(await setSttHost(choice, choice === "codex" ? CODEX_CONSENT_ID : undefined));
      setConsentOpen(false);
      void refreshOperatorConfig();
    } catch (error) {
      if (choice === "codex") setConsentError(describeThrownError(error));
      else setProviderError(describeThrownError(error));
      // What the host says now, so a row that closed meanwhile shows why.
      fetchSttHost().then(setHost, () => undefined);
    } finally {
      setSwitching(null);
    }
  }

  /** A guided run stops at `phase`, with that phase's own words, and offers Try again. */
  function stopGuided(phase: "host" | "copy", message: string): void {
    if (!guiding.current) return;
    guiding.current = false;
    setGuided({ kind: "failed", phase, message });
  }

  /** A guided run ends where it set out to: On this phone, chosen. `copied`: the copy it just made. */
  function finishGuided(copied?: StoredModel): void {
    if (!guiding.current) return;
    guiding.current = false;
    if (copied !== undefined) setJustCopied({ model: copied, over: stored });
    setSttEnginePreference("phone");
    setGuided({ kind: "idle" });
  }

  async function phoneDownload(): Promise<void> {
    if (whistle === null) return;
    const controller = new AbortController();
    copyAbort.current = controller;
    setPhoneError(null);
    setCopy({ received: 0, total: whistle.bytes });
    try {
      const copied = await downloadModel(whistle, (received, total) => setCopy({ received, total }), controller.signal);
      // The first worker to load once the copy exists is stored by the service worker, so the engine
      // also starts offline. A probe is a worker load.
      void runSttProbe();
      finishGuided(copied);
    } catch (error) {
      if (!(error instanceof SttModelError && error.code === "aborted")) {
        const message = sttModelErrorMessage(error);
        setPhoneError(message);
        stopGuided("copy", message);
      } else {
        guiding.current = false;
      }
    } finally {
      setCopy(null);
      copyAbort.current = null;
    }
  }

  // "Set up" asked for both steps: the copy follows the host's download, once, when it is ready.
  const hostReady = whistle?.state === "ready";
  const hostFailed = whistle?.state === "failed";
  useEffect(() => {
    if (!copyWhenReady.current) return;
    if (hostFailed) {
      copyWhenReady.current = false;
      stopGuided("host", t("settings.speech.host.failed"));
    }
    if (!hostReady || copy !== null) return;
    copyWhenReady.current = false;
    void phoneDownload();
    // `phoneDownload` reads the latest status itself; this runs on the host's answer only.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [hostReady, hostFailed]);

  const props: SpeechCardsProps = {
    page,
    whistle,
    hostStt,
    host,
    hostRead,
    switching,
    providerError,
    confirmTo,
    consentOpen,
    consentError,
    canWrite,
    recording: sttRecordingSupported(),
    engine,
    block,
    local,
    persisted,
    copy,
    hostError,
    phoneError,
    hostBusy,
    checking,
    confirmingRemove,
    handsFree,
    onEngine: setSttEnginePreference,
    onHandsFree: setHandsFreeEnabled,
    onSetup: () => void hostAction(startWhistleSetup),
    onSetupBoth: () => {
      copyWhenReady.current = true;
      setPhoneError(null);
      void hostAction(startWhistleSetup);
    },
    onAskRemove: () => setConfirmingRemove(true),
    onCancelRemove: () => setConfirmingRemove(false),
    onRemove: () => void hostAction(removeWhistleModel, true),
    onChooseProvider: (choice) => {
      setProviderError(null);
      const ask = askFor(hostOptionOf(currentHostProvider(host, hostStt)), choice);
      if (ask === "consent") {
        // Nothing is sent before "I accept".
        setConsentError(null);
        setConsentOpen(true);
      } else if (ask === "confirm") {
        setConfirmTo(choice);
      } else {
        void switchProvider(choice);
      }
    },
    onConfirm: () => {
      const choice = confirmTo;
      setConfirmTo(null);
      if (choice !== null) void switchProvider(choice);
    },
    onCancelConfirm: () => setConfirmTo(null),
    onAcceptConsent: () => void switchProvider("codex"),
    onCancelConsent: () => setConsentOpen(false),
    onPhoneDownload: () => void phoneDownload(),
    onPhoneRemove: () => {
      setPhoneError(null);
      void removeModel();
    },
    onCheckAgain: () => void checkAgain(),
    guided,
    onGuidedSetup: () => {
      // One tap, the whole way: the host's download if it lacks the model (this device may write, or
      // the card offers no button), then this phone's copy, then On this phone. Each step is the one
      // its own row runs, with the same error handling; a failure stops the run where it failed.
      if (guiding.current) return;
      guiding.current = true;
      setGuided({ kind: "running" });
      setPhoneError(null);
      if (local) {
        finishGuided();
      } else if (whistle?.state === "ready") {
        void phoneDownload();
      } else if (whistle?.state === "downloading") {
        copyWhenReady.current = true;
      } else {
        copyWhenReady.current = true;
        void hostAction(startWhistleSetup);
      }
    },
    onOpenPage: (to) => nav.down(voicePagePath(to, scope)),
    hostName: leadName(root?.servers),
  };

  if (page === "hub") {
    // The index always offers Voice, so a page with nothing to show says why, once the host has
    // answered both reads and this phone has looked for its own copy.
    if (!voiceHubShown(props)) return configRead && hostRead && local === null ? <VoiceEmpty /> : null;
  }
  return <SpeechCards {...props} />;
}
