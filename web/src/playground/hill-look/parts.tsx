// Pieces the "Hill look" options share (M96 design round, 2026-11-09). DEV-ONLY. Each is a look a
// real build would promote into `components/ui/` the moment a second screen needs it (DESIGN.md §1);
// here they live beside the options so a rejected option leaves nothing behind in the app.

import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";

import { AgentIcon } from "@/components/agent-icon";
import { Icon } from "@/components/icons/icon";
import { OptionButton } from "@/components/option-button";
import { ImageSheet } from "@/components/ui/image-sheet";
import { OverflowEdges } from "@/components/ui/overflow-edges";
import { useArm } from "@/hooks/use-arm";
import { cacheClockNow, subscribeCacheClock } from "@/lib/cache-clock";
import type { HillDecision, HillOption, HillPriority } from "@/lib/hill/wire";
import { ageWords } from "@/lib/hill/words";
import { trickIconOf } from "@/lib/tricks/icons";
import { cn } from "@/lib/utils";

import { playgroundMedia } from "../fixtures/hill/decisions";
import { HOST_SLOT, TRICK_ICON_OF } from "./fixtures";

/** Literal class strings, so Tailwind sees each one (DESIGN.md §4: the tint lands on the glyph only). */
const HOST_INK = ["text-host-0", "text-host-1", "text-host-2", "text-host-3", "text-host-4", "text-host-5", "text-host-6", "text-host-7", "text-host-8", "text-host-9"] as const;

export function hostInk(host: string | null): string {
  if (host === null) return "text-muted-foreground";
  const slot = HOST_SLOT.get(host);
  return slot === undefined ? "text-muted-foreground" : (HOST_INK[slot] ?? "text-muted-foreground");
}

/**
 * PRIORITY AS A SHAPE: a small range of three peaks, as many of them filled as the Decision is
 * urgent. Now fills three, Today two, Later one. Reads without colour, like the status shapes
 * (DESIGN.md §3); the ink is the second channel, `now` in the caution ink the card already uses.
 */
export function PeakGlyph({ priority, className }: { priority: HillPriority; className?: string }) {
  const filled = priority === "now" ? 3 : priority === "today" ? 2 : 1;
  const ink = priority === "now" ? "text-status-working" : priority === "today" ? "text-foreground" : "text-muted-foreground";
  // Three peaks, low to high, overlapping like a ridge. Each filled peak is solid; the rest an outline.
  const peaks = ["M1 13 L5 7 L9 13 Z", "M5 13 L10 4 L15 13 Z", "M10 13 L15 1 L20 13 Z"];
  return (
    <svg aria-hidden viewBox="0 0 21 14" className={cn("h-3 w-[18px] shrink-0", ink, className)}>
      {peaks.map((d, i) => (
        <path key={d} d={d} fill={i < filled ? "currentColor" : "var(--card)"} stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      ))}
    </svg>
  );
}

export const PRIORITY_WORD = { now: "Now", today: "Today", later: "Later" } as const satisfies Record<HillPriority, string>;

/** Who asks: the agent's own logo tile, or the trick's glyph on a neutral tile of the same size. */
export function SenderMark({ decision, className, iconClassName }: { decision: HillDecision; className?: string; iconClassName?: string }) {
  if (decision.from.kind === "agent") return <AgentIcon agent={decision.from.harness} className={cn("rounded-sm", className)} />;
  const Glyph = trickIconOf(decision.from.trickId === null ? undefined : TRICK_ICON_OF.get(decision.from.trickId));
  return (
    <span aria-hidden className={cn("flex shrink-0 items-center justify-center rounded-sm border border-border bg-secondary text-foreground", className)}>
      <Glyph className={cn("size-[60%]", iconClassName)} />
    </span>
  );
}

/** The bridge clock's age of a decision, ticked by the page's one shared clock. */
export function useAge(at: number): string {
  const now = useSyncExternalStore(subscribeCacheClock, cacheClockNow, cacheClockNow);
  return ageWords(at, now);
}

/** "trick" or the machine, with its glyph in the machine's colour. */
export function HostLine({ decision, className }: { decision: HillDecision; className?: string }) {
  if (decision.from.kind === "trick") {
    return (
      <span className={cn("inline-flex min-w-0 items-center gap-1", className)}>
        <Icon name="mod-icon-plug" aria-hidden className="size-3 shrink-0" />
        <span className="truncate">trick</span>
      </span>
    );
  }
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1", className)}>
      <Icon name="machine" aria-hidden className={cn("size-3 shrink-0", hostInk(decision.from.host))} />
      <span className="truncate">{decision.from.host}</span>
    </span>
  );
}

/** Images as a strip: thumbnails at one height, scrolling sideways with the house fade. A tap opens the picture sheet. */
const STRIP_H = { sm: { px: 88, cls: "h-[88px]" }, md: { px: 112, cls: "h-28" }, lg: { px: 140, cls: "h-[140px]" } } as const;

export function ImageStrip({ decision, size = "md" }: { decision: HillDecision; size?: keyof typeof STRIP_H }) {
  const { px: height, cls } = STRIP_H[size];
  if (decision.media.length === 0) return null;
  return (
    <OverflowEdges cue="none" className="-mx-4">
      {(ref) => (
        <div ref={ref} className="flex min-w-0 flex-1 gap-2 overflow-x-auto overscroll-x-contain px-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {decision.media.map((m, i) => {
            const w = m.width !== null && m.height !== null ? Math.round((height * m.width) / m.height) : height;
            const alt = m.caption ?? `Image ${i + 1} of ${decision.media.length}`;
            return (
              <figure key={m.id} className="flex shrink-0 flex-col gap-1" style={{ width: w }}>
                <ImageSheet
                  src={playgroundMedia(decision.id, m)}
                  alt={alt}
                  title={alt}
                  className="block rounded-sm"
                  imgClassName={cn("block w-full rounded-sm border border-border bg-muted object-cover", cls)}
                />
                {m.caption !== undefined && <figcaption className="font-content truncate text-[11px] text-muted-foreground">{m.caption}</figcaption>}
              </figure>
            );
          })}
        </div>
      )}
    </OverflowEdges>
  );
}

/**
 * The card's answer behaviour, shared by every option so none of them drifts from today's card: the
 * draft, More, and the armed second tap on a `confirm` option and on Dismiss (`useArm`, as the real
 * card). With no bridge, a send only marks the option picked.
 */
export function useDecisionAnswer(decision: HillDecision) {
  const [draft, setDraft] = useState("");
  const [moreOpen, setMoreOpen] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const { armed, tap, disarm } = useArm<string>();
  const text = draft.trim() === "" ? null : draft.trim();
  const required = decision.text === "required";
  const optionsBlocked = required && text === null;
  const recommended = decision.options.find((o) => o.intent === decision.recommends?.intent);

  useEffect(() => {
    if (picked !== null) disarm();
  }, [picked, disarm]);

  function choose(option: HillOption) {
    if (optionsBlocked) return;
    if (option.confirm !== undefined) {
      if (tap(`option:${option.intent}`) !== "fire") return;
    } else disarm();
    setPicked(option.intent);
  }
  function dismiss() {
    if (tap("dismiss") !== "fire") return;
    setPicked("dismiss");
  }
  function sendWords() {
    if (text === null) return;
    disarm();
    setPicked("answer");
  }
  function edit(next: string) {
    setDraft(next);
    if (armed?.startsWith("option:")) disarm();
  }
  return { draft, edit, moreOpen, setMoreOpen, noteOpen, setNoteOpen, picked, armed, text, required, optionsBlocked, recommended, choose, dismiss, sendWords };
}

export type DecisionAnswer = ReturnType<typeof useDecisionAnswer>;

/** One option as the real card draws it (OptionButton), with a trailing slot the option fills. */
export function DecisionOption({
  option,
  answer,
  keyLabel,
  trailing,
  className,
}: {
  option: HillOption;
  answer: DecisionAnswer;
  keyLabel?: ReactNode;
  trailing?: ReactNode;
  className?: string;
}) {
  const isArmed = answer.armed === `option:${option.intent}`;
  const isPicked = answer.picked === option.intent;
  return (
    <OptionButton
      tone={isArmed ? "armed" : isPicked ? "selected" : "default"}
      keyLabel={keyLabel}
      label={isArmed && option.confirm !== undefined ? option.confirm : option.label}
      aria-label={isArmed && option.confirm !== undefined ? `${option.confirm}: tap again to confirm` : undefined}
      description={option.detail}
      disabled={answer.optionsBlocked}
      onClick={() => answer.choose(option)}
      className={cn("min-h-11 items-center", className)}
      trailing={trailing}
    />
  );
}

/** Two short options sit side by side, as today's card does. */
export function sideBySide(options: readonly HillOption[]): boolean {
  return options.length === 2 && options.every((o) => o.label.length <= 16 && o.detail === undefined);
}

/** The written answer: a field, the required hint, and Send. The real card's field, its classes kept. */
export function AnswerField({ decision, answer, placeholder, className }: { decision: HillDecision; answer: DecisionAnswer; placeholder?: string; className?: string }) {
  if (decision.text === "none") return null;
  return (
    <textarea
      value={answer.draft}
      onChange={(e) => answer.edit(e.target.value)}
      placeholder={placeholder ?? (answer.required ? "Write your answer" : "Add a note")}
      aria-label="Your answer"
      rows={2}
      spellCheck={false}
      className={cn(
        "min-h-11 w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-base text-foreground placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        className,
      )}
    />
  );
}

/** The Dismiss control with its armed second tap, both words in one slot so arming moves nothing. */
export function DismissButton({ answer, className }: { answer: DecisionAnswer; className?: string }) {
  const armed = answer.armed === "dismiss";
  return (
    <button
      type="button"
      onClick={answer.dismiss}
      className={cn(
        "inline-grid h-11 shrink-0 items-center rounded-md border border-transparent px-3 text-sm font-medium transition-colors",
        armed ? "border-destructive/40 bg-destructive/10 text-destructive" : "text-muted-foreground hover:bg-muted/50",
        className,
      )}
    >
      <span className={cn("col-start-1 row-start-1", armed && "invisible")}>Dismiss</span>
      <span aria-hidden={!armed} className={cn("col-start-1 row-start-1", !armed && "invisible")}>
        Dismiss?
      </span>
    </button>
  );
}

/** "Your answer goes to collie lead on bluefin", or to the trick. */
export function goesTo(decision: HillDecision): string {
  if (decision.target === null) return `Your answer goes to the ${decision.from.label} trick`;
  return decision.target.host === null ? `Your answer goes to ${decision.target.label}` : `Your answer goes to ${decision.target.label} on ${decision.target.host}`;
}
