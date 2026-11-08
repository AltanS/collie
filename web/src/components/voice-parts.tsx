import { useId, type ReactNode } from "react";
import { Icon } from "@/components/icons/icon";
import type { IconKey } from "@/components/icons/keys";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { CopyableBlock } from "@/components/ui/copyable-block";
import { Notice } from "@/components/ui/notice";
import { SectionLabel } from "@/components/ui/section-label";
import { BottomSheet } from "@/components/ui/sheet";
import { useLocale } from "@/hooks/use-locale";
import { t, type MessageKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { leavesNetwork, reachOf, type HostOption, type Reach, type StepMark, type VoiceState } from "@/lib/voice";

// ── THE PIECES SETTINGS → VOICE IS BUILT FROM ───────────────────────────────────────────────────
//
// Small views with every fact handed in, shared by the three Voice pages (components/speech-control.tsx)
// and the playground. The rules they keep, so every page keeps them the same way:
//
//  · The audio line is ONE component. Every option, the in-use card, the confirm sheet and the facts
//    sheet print it, with the same label ("Audio") in the same column, so the eye finds it in the
//    same place.
//  · Audio that leaves the host's network carries an icon and the words, in neutral ink, never a
//    colour alone.
//  · A state is an icon in its status ink beside a word in the foreground ink.
//  · Every control is at least 44px tall (DESIGN.md §6). A selected option is ONE look, `OptionCard`,
//    on the hub and on Host speech alike: a 2px primary edge on all four sides, a light primary tint,
//    the filled radio and the "In use" badge. The second pixel of the edge is an inset ring, so the
//    box keeps the 1px border it always has and nothing moves (§2). The badge's slot is held while
//    it is hidden, for the same reason. No accent border on one side.

/** One zone of a page: a section label naming WHO a setting reaches, and one plain line under it. */
export function Zone({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="space-y-2">
      <div>
        <h2 id={id}>
          <SectionLabel>{label}</SectionLabel>
        </h2>
        {hint !== undefined && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

/** A sub-label inside a zone: the two tiers of the host's options. Quieter than the zone's label. */
export function TierLabel({ children }: { children: ReactNode }) {
  return <h3 className="pt-1 text-xs font-medium text-muted-foreground">{children}</h3>;
}

/**
 * The one banner a device without the write grant sees. It covers the host's settings only: this
 * phone's own choice and hands-free stay live, because they are this device's and change nothing on
 * the host.
 */
export function ReadOnlyHostBanner() {
  useLocale();
  return (
    // shrink-0 for the reason LockedNote gives: a direct child of the settings scroller.
    <Notice tone="info" variant="box" icon={<Icon name="locked" />} className="shrink-0">
      {t("settings.voice.readOnly")}
    </Notice>
  );
}

/** The marker for audio that leaves the host's network: an icon and the words, in neutral ink. */
export function LeavesMarker() {
  return (
    <Badge variant="outline" className="mt-1 gap-1 rounded-sm font-medium">
      <Icon name="leaves-network" aria-hidden />
      {t("settings.voice.leaves")}
    </Badge>
  );
}

const AUDIO_KEYS = {
  phone: "settings.voice.audio.phone",
  host: "settings.voice.audio.host",
  command: "settings.voice.audio.command",
  service: "settings.voice.audio.service",
  chatgpt: "settings.voice.audio.chatgpt",
  nowhere: "settings.voice.audio.nowhere",
} as const satisfies Record<Reach, MessageKey>;

/** The fixed sentence for where audio goes. */
export function audioSentence(reach: Reach): string {
  return t(AUDIO_KEYS[reach]);
}

/**
 * The audio line's value: the fixed sentence, and the marker when the audio leaves the network.
 * `text` replaces the sentence only where no destination exists (nothing recorded, nothing to send
 * to yet, a provider this build does not know).
 */
export function AudioValue({ reach, text }: { reach: Reach | null; text?: string }) {
  const sentence = text ?? (reach === null ? t("settings.voice.audio.none") : audioSentence(reach));
  return (
    <span className="block min-w-0">
      <span className="block">{sentence}</span>
      {reach !== null && leavesNetwork(reach) && <LeavesMarker />}
    </span>
  );
}

/** The fixed audio line. Same label, same column, same sentence for the same destination. */
export function AudioLine({ reach, text }: { reach: Reach | null; text?: string }) {
  return (
    <span className="flex gap-2 text-xs leading-relaxed">
      <span className="w-12 shrink-0 text-muted-foreground">{t("settings.voice.audio.label")}</span>
      <AudioValue reach={reach} text={text} />
    </span>
  );
}

const STATE_LOOK = {
  works: { icon: "voice-ready", ink: "text-status-done" },
  setup: { icon: "voice-setup", ink: "text-status-working" },
  paused: { icon: "voice-paused", ink: "text-status-blocked" },
  broken: { icon: "voice-broken", ink: "text-status-blocked" },
} satisfies Record<VoiceState, { icon: IconKey; ink: string }>;

/** A state as an icon in its status ink and a word in the foreground ink: never colour alone. */
export function StateWord({ state, word }: { state: VoiceState; word: string }) {
  const { icon, ink } = STATE_LOOK[state];
  return (
    <span className="inline-flex items-center gap-1.5 text-sm font-medium">
      <Icon name={icon} aria-hidden className={cn("size-4 shrink-0", ink)} />
      {word}
    </span>
  );
}

/**
 * A state as a sentence: the icon in its status ink at the first line, the words in the foreground
 * ink. The words carry the meaning on their own; the colour only repeats it.
 */
export function StateLine({ state, children }: { state: VoiceState; children: ReactNode }) {
  const { icon, ink } = STATE_LOOK[state];
  return (
    <span className="flex items-start gap-1.5 text-xs font-medium leading-relaxed">
      <Icon name={icon} aria-hidden className={cn("mt-px size-4 shrink-0", ink)} />
      <span className="min-w-0 break-words">{children}</span>
    </span>
  );
}

/** The selected look, the one string for it. Light and dark both keep the text's contrast (≥ 5.6:1). */
const SELECTED = "border-primary bg-[color-mix(in_oklab,var(--primary)_6%,var(--card))] ring-1 ring-inset ring-primary";

/**
 * One selectable option, on the hub and on Host speech. Selected: a 2px primary edge all round (the
 * card's own 1px border recoloured, plus a 1px inset ring, so the box does not grow), and a light
 * primary tint. Unselected: the neutral card. Only paint changes between the two.
 */
export function OptionCard({ selected, className, children }: { selected: boolean; className?: string; children: ReactNode }) {
  return (
    <Card data-selected={selected ? "" : undefined} className={cn("relative gap-0 py-0", selected && SELECTED, className)}>
      {children}
    </Card>
  );
}

/** "In use", beside a selected option's title. Hidden, not removed, when not selected, so the title row keeps its width. */
export function InUseBadge({ shown }: { shown: boolean }) {
  return (
    <Badge aria-hidden={shown ? undefined : true} className={cn("rounded-sm", !shown && "invisible")}>
      {t("settings.voice.inUse")}
    </Badge>
  );
}

/**
 * "Recommended", beside On this phone's title. Neutral, an outline with no fill, so it never reads as
 * the selected look or as "In use"; both may stand at once.
 */
export function RecommendedBadge() {
  return (
    <Badge variant="outline" className="rounded-sm">
      {t("settings.voice.recommended")}
    </Badge>
  );
}

/** A radio's ring. The border is always there; choosing fills the dot, so nothing moves (§2). */
export function Ring({ checked, busy = false }: { checked: boolean; busy?: boolean }) {
  return (
    <span
      aria-hidden
      className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border-2 border-muted-foreground"
    >
      {busy ? (
        <Icon name="busy" className="size-3 animate-spin" />
      ) : (
        <span className={cn("size-2.5 rounded-full", checked ? "bg-primary" : "bg-transparent")} />
      )}
    </span>
  );
}

/**
 * The small info button beside an option's title. It sits OUTSIDE the option's own button (a button
 * cannot hold a button), laid over the row's top-right corner, so a tap on it never chooses the
 * option or opens a page. 44px of reach around a 16px icon; the negative inset keeps the row's height.
 */
export function InfoButton({ name, onClick, className }: { name: string; onClick: () => void; className?: string }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={t("settings.voice.about.aria", { option: name })}
      className={cn("absolute top-1.5 right-1.5 size-11 text-muted-foreground", className)}
      onClick={onClick}
    >
      <Icon name="info" className="size-4" />
    </Button>
  );
}

/** A two-column list of facts: label, value. */
export function Facts({ rows, className }: { rows: readonly { label: string; value: ReactNode }[]; className?: string }) {
  return (
    <dl className={cn("grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-xs", className)}>
      {rows.map((row) => (
        <div key={row.label} className="contents">
          <dt className="text-muted-foreground">{row.label}</dt>
          <dd className="min-w-0 break-words">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

// ── THE FIVE FACTS ──────────────────────────────────────────────────────────────────────────────

/** What an info button is about: this phone's two choices, or one of the host's five options. */
export type AboutId = "phone" | "host" | HostOption;

interface FactSet {
  /** The audio line's destination, or `null` for "it depends on the host's option". */
  readonly reach: Reach | null;
  readonly offline: MessageKey;
  readonly cost: MessageKey;
  readonly setup: MessageKey;
  readonly speed: MessageKey;
}

/**
 * The same five facts for every option, in the same order, so they can be compared down the column.
 * A fact that depends on a provider Collie does not run (a speech service, your own command) says so
 * in general terms; nothing here names a price or a speed Collie has not measured.
 */
const FACTS = {
  phone: {
    reach: "phone",
    offline: "settings.voice.facts.yes",
    cost: "settings.voice.facts.free",
    setup: "settings.voice.facts.phone.setup",
    speed: "settings.voice.facts.phone.speed",
  },
  whistle: {
    reach: "host",
    offline: "settings.voice.facts.whistle.offline",
    cost: "settings.voice.facts.free",
    setup: "settings.voice.facts.whistle.setup",
    speed: "settings.voice.facts.whistle.speed",
  },
  command: {
    reach: "command",
    offline: "settings.voice.facts.dependsCommand",
    cost: "settings.voice.facts.dependsCommand",
    setup: "settings.voice.facts.terminal",
    speed: "settings.voice.facts.dependsCommand",
  },
  service: {
    reach: "service",
    offline: "settings.voice.facts.no",
    cost: "settings.voice.facts.service.cost",
    setup: "settings.voice.facts.service.setup",
    speed: "settings.voice.facts.service.speed",
  },
  chatgpt: {
    reach: "chatgpt",
    offline: "settings.voice.facts.no",
    cost: "settings.voice.facts.chatgpt.cost",
    setup: "settings.voice.facts.chatgpt.setup",
    speed: "settings.voice.facts.internet",
  },
  off: {
    reach: "nowhere",
    offline: "settings.voice.facts.off.offline",
    cost: "settings.voice.facts.free",
    setup: "settings.voice.facts.off.setup",
    speed: "settings.voice.facts.off.speed",
  },
  /** "On your host" while the host has no option this build can describe. */
  hostAny: {
    reach: null,
    offline: "settings.voice.facts.dependsHost",
    cost: "settings.voice.facts.dependsHost",
    setup: "settings.voice.facts.hostAny.setup",
    speed: "settings.voice.facts.hostAny.speed",
  },
} as const satisfies Record<HostOption | "phone" | "hostAny", FactSet>;

const OPTION_NAMES = {
  whistle: "settings.voice.option.whistle",
  command: "settings.voice.option.command",
  service: "settings.voice.option.service",
  chatgpt: "settings.voice.option.chatgpt",
  off: "settings.speech.provider.option.off",
} as const satisfies Record<HostOption, MessageKey>;

/** An option's name on the Host speech page. */
export function optionName(option: HostOption): string {
  return t(OPTION_NAMES[option]);
}

/** The name an info button and its sheet carry. */
export function aboutName(about: AboutId): string {
  if (about === "phone") return t("settings.speech.phone.heading");
  if (about === "host") return t("settings.speech.host.heading");
  return optionName(about);
}

/**
 * The facts sheet an info button opens: the option's name as the title, then the five facts as a
 * two-column list. `hostOption` is what the host uses now; "On your host" shows that option's facts,
 * or the general ones while the host has none.
 */
export function FactsSheet({
  about,
  hostOption,
  size,
  onClose,
}: {
  about: AboutId | null;
  hostOption: HostOption | null;
  /** The model's size, already formatted ("16.9 MB"). */
  size: string;
  onClose: () => void;
}) {
  useLocale();
  const key = about === null ? null : about === "host" ? (hostOption === null || hostOption === "off" ? "hostAny" : hostOption) : about;
  const facts = key === null ? null : FACTS[key];
  return (
    <BottomSheet open={about !== null} onClose={onClose} title={about === null ? undefined : aboutName(about)}>
      {facts !== null && (
        <dl className="grid grid-cols-[3.5rem_minmax(0,1fr)] gap-x-2 gap-y-2 text-sm leading-relaxed">
          <dt className="text-muted-foreground">{t("settings.voice.audio.label")}</dt>
          <dd className="min-w-0">
            <span className="block">{facts.reach === null ? t("settings.voice.audio.hostAny") : audioSentence(facts.reach)}</span>
            {facts.reach !== null && leavesNetwork(facts.reach) && <LeavesMarker />}
          </dd>
          <dt className="text-muted-foreground">{t("settings.voice.facts.offline")}</dt>
          <dd className="min-w-0">{t(facts.offline, { size })}</dd>
          <dt className="text-muted-foreground">{t("settings.voice.facts.cost")}</dt>
          <dd className="min-w-0">{t(facts.cost, { size })}</dd>
          <dt className="text-muted-foreground">{t("settings.voice.facts.setup")}</dt>
          <dd className="min-w-0">{t(facts.setup, { size })}</dd>
          <dt className="text-muted-foreground">{t("settings.voice.facts.speed")}</dt>
          <dd className="min-w-0">{t(facts.speed, { size })}</dd>
        </dl>
      )}
    </BottomSheet>
  );
}

// ── COMMANDS FOR THE HOST'S TERMINAL ────────────────────────────────────────────────────────────

/** A command to run on the host, with the Copy icon. Never translated: it is what the terminal takes. */
export function HostCommand({ command }: { command: string }) {
  return (
    <CopyableBlock text={command} label={t("copyable.command")}>
      <p className="wrap-anywhere rounded-sm border border-border bg-background py-2 pr-10 pl-3 font-mono text-xs">{command}</p>
    </CopyableBlock>
  );
}

/**
 * The commands Host speech prints to copy, as `cli/stt.ts` takes them. Placeholders in angle
 * brackets, never a value that looks real. Never translated: they are what the terminal takes. Never a
 * field to edit: a key or a command the operator chose stays on the host's keyboard (ADR 0029).
 */
export const SETUP_COMMANDS = {
  off: "collie stt off",
  status: "collie stt status",
  whistleHost: "collie stt whistle --host",
  command: "collie stt setup --provider local-cli --command <path> --args <list>",
  /** The docs' whisper-cli example (docs/voice-and-push.md, "Run your own command"). */
  commandExample: `collie stt setup --provider local-cli --command whisper-cli --args '["-m", "/srv/my models/ggml-base.bin", "-nt"]'`,
  service: "collie stt setup --provider openai-compatible --url <base-url> --model <name> --key <api-key>",
  codexLogin: "codex login",
  codexLoginStatus: "codex login status",
  codexSetup: "collie stt setup --provider codex",
} as const;

/** Where the docs explain your own command: the "Run your own command" section on colliepwa.dev. */
export const COMMAND_DOCS_URL = "https://colliepwa.dev/docs/voice-and-push#run-your-own-command-the-local-cli-provider";

/** One numbered step: its number (or a check once done), the sentence, and what it needs under it. */
export interface StepView {
  key: string;
  mark: StepMark;
  text: string;
  body?: ReactNode;
}

/**
 * Numbered steps, one sentence each. The step to take next carries a "Next" badge and a filled
 * number; a step already done carries a check in place of its number. Words, never colour alone.
 */
export function StepList({ steps }: { steps: readonly StepView[] }) {
  return (
    <ol className="space-y-3">
      {steps.map((step, i) => (
        <li key={step.key} aria-current={step.mark === "next" ? "step" : undefined} className="flex gap-2.5">
          <span
            aria-hidden
            className={cn(
              "flex size-5 shrink-0 items-center justify-center rounded-full border text-[11px] font-medium tabular-nums",
              step.mark === "next" ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground text-muted-foreground",
            )}
          >
            {step.mark === "done" ? <Icon name="done" className="size-3" /> : i + 1}
          </span>
          <div className="min-w-0 flex-1 space-y-2">
            <p className="text-xs leading-relaxed">
              {step.text}
              {step.mark === "done" && <span className="sr-only"> {t("settings.voice.setup.done")}</span>}
              {step.mark === "next" && (
                <Badge variant="outline" className="ml-1.5 rounded-sm align-middle">
                  {t("settings.voice.setup.next")}
                </Badge>
              )}
            </p>
            {step.body}
          </div>
        </li>
      ))}
    </ol>
  );
}

/** Whether an option is set up only in a terminal on the host. */
export function terminalOnly(option: HostOption): option is "command" | "service" {
  return option === "command" || option === "service";
}

/** The audio line's reach for an option. */
export function optionReach(option: HostOption): Reach {
  return reachOf(option);
}
