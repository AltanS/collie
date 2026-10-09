import { useState } from "react";
import { Plus, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { SectionLabel } from "@/components/ui/section-label";
import { Segmented } from "@/components/ui/segmented";
import { ToggleButton } from "@/components/ui/toggle-button";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
import {
  chordKey,
  defaultLabel,
  F_KEYS,
  formatStep,
  isLoneInterrupt,
  MAX_LABEL,
  MAX_STEPS,
  NAMED_KEYS,
  needsSecondTap,
  parseStep,
  stepFace,
  stepsWords,
  stepWords,
  type ChordKey,
} from "@/lib/key-board";
import { MODIFIER_ORDER, type Modifier } from "@/lib/key-queue";
import { keysSendable } from "@/lib/mux-capability";
import { cn } from "@/lib/utils";

// The chord builder (M48 spec 03): hold any of Ctrl, Alt and Shift, press one key, and the preview
// shows the whole chord on its own line, up to four keys at once (Ctrl+Alt+Shift+T). A key may also
// send a short SEQUENCE of up to four such steps (Ctrl+B, then C): "Add step" appends one, and the
// step chips switch between them.
//
// NOTHING MOVES WHILE YOU BUILD (DESIGN.md §2). The sheet keeps one height from first paint to
// Save: the step row, the preview line and the status line each state their own height, the picker
// area is a fixed 116px whatever kind of key is showing, and the status line reserves two lines so a
// danger or refusal sentence replaces words and never adds a row.

type Kind = "char" | "named" | "fkeys";

interface StepDraft {
  readonly mods: readonly Modifier[];
  readonly kind: Kind;
  /** One typed character. Empty until typed. */
  readonly char: string;
  readonly named: string;
  readonly fkey: string;
}

const BLANK: StepDraft = { mods: [], kind: "char", char: "", named: "Enter", fkey: "F1" };

function draftOf(step: string): StepDraft {
  const parsed = parseStep(step);
  if (parsed === null) return BLANK;
  const kind: Kind = parsed.base.length === 1 ? "char" : /^F\d+$/.test(parsed.base) ? "fkeys" : "named";
  return {
    mods: parsed.mods,
    kind,
    char: kind === "char" ? parsed.base : "",
    named: kind === "named" ? parsed.base : BLANK.named,
    fkey: kind === "fkeys" ? parsed.base : BLANK.fkey,
  };
}

/** The canonical chord a draft stands for, or null while it has no key yet. */
function chordOf(draft: StepDraft): string | null {
  const base = draft.kind === "char" ? draft.char : draft.kind === "named" ? draft.named : draft.fkey;
  if (base === "") return null;
  const step = parseStep([...draft.mods, base].join("+"));
  return step === null ? null : formatStep(step);
}

const KINDS: readonly Kind[] = ["char", "named", "fkeys"];

export function ChordBuilder({
  initial,
  unsupportedKeys,
  onSave,
}: {
  /** The key being changed, or null when a new one is being added. */
  initial: ChordKey | null;
  /** The chords this multiplexer refuses (`/api/config`). A refused key shows grey, as on the pad. */
  unsupportedKeys: readonly string[];
  onSave: (key: ChordKey) => void;
}) {
  useLocale();
  const [drafts, setDrafts] = useState<readonly StepDraft[]>(() => (initial === null ? [BLANK] : initial.steps.map(draftOf)));
  const [current, setCurrent] = useState(0);
  const [name, setName] = useState(initial?.label ?? "");

  const draft = drafts[current] ?? BLANK;
  const edit = (patch: Partial<StepDraft>) =>
    setDrafts((all) => all.map((d, i) => (i === current ? { ...d, ...patch } : d)));
  const toggle = (m: Modifier) =>
    edit({ mods: draft.mods.includes(m) ? draft.mods.filter((x) => x !== m) : MODIFIER_ORDER.filter((x) => x === m || draft.mods.includes(x)) });

  const chords = drafts.map(chordOf);
  const complete = chords.every((c): c is string => c !== null);
  const steps = complete ? chords : [];
  const built = complete ? chordKey(steps, name.trim() === "" ? undefined : name) : null;

  const then = t("keys.pad.then");
  const preview = chords.map((c) => (c === null ? "…" : stepWords(c))).join(`, ${then} `);

  // One sentence, in a box that always holds two lines. The most serious true thing wins.
  const refusedStep = steps.find((s) => !keysSendable([s], unsupportedKeys));
  let status = t("keys.builder.status.empty");
  let alert = false;
  if (refusedStep !== undefined) {
    status = t("keys.builder.status.refused", { key: stepWords(refusedStep) });
    alert = true;
  } else if (complete) {
    const probe: ChordKey = { kind: "chord", steps };
    if (needsSecondTap(probe)) {
      status = t("keys.builder.status.danger");
      alert = true;
    } else if (isLoneInterrupt(steps)) {
      status = t("keys.builder.status.interrupt");
    } else {
      status = t("keys.builder.status.sends", { chord: stepsWords(steps, then) });
    }
  }

  const canAdd = complete && drafts.length < MAX_STEPS;
  const addStep = () => {
    setDrafts((all) => [...all, BLANK]);
    setCurrent(drafts.length);
  };
  const removeStep = () => {
    setDrafts((all) => all.filter((_, i) => i !== current));
    setCurrent((i) => Math.max(0, i - 1));
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="space-y-1.5">
        {/* The steps. Their row is 44px and scrolls sideways if four long chords ever outgrow it. */}
        <div role="group" aria-label={t("keys.builder.stepsAria")} className="flex h-11 items-center gap-1 overflow-x-auto">
          {drafts.map((_, i) => {
            const chord = chords[i] ?? null;
            return (
              <Button
                key={i}
                type="button"
                variant={i === current ? "default" : "outline"}
                size="sm"
                aria-pressed={i === current}
                aria-label={t("keys.builder.stepAria", { n: i + 1, chord: chord === null ? "…" : stepWords(chord) })}
                onClick={() => setCurrent(i)}
                className="h-9 shrink-0 px-3 font-mono"
              >
                {chord === null ? "…" : stepFace(chord)}
              </Button>
            );
          })}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={!canAdd}
            onClick={addStep}
            aria-label={t("keys.builder.addStep")}
            className="h-9 shrink-0 gap-1 px-2 text-muted-foreground"
          >
            <Plus className="size-4" aria-hidden="true" />
            {t("keys.builder.addStep")}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            disabled={drafts.length < 2}
            onClick={removeStep}
            aria-label={t("keys.builder.removeStep")}
            className="size-9 shrink-0 text-muted-foreground"
          >
            <X className="size-4" aria-hidden="true" />
          </Button>
        </div>
        <div
          data-slot="chord-preview"
          aria-label={t("keys.builder.previewAria")}
          className="flex h-11 items-center overflow-x-auto whitespace-nowrap rounded-sm border border-border bg-background px-3 font-mono text-base font-semibold"
        >
          {preview}
        </div>
        <p
          data-slot="chord-status"
          aria-live="polite"
          className={cn("line-clamp-2 h-10 text-sm leading-5", alert ? "text-status-working" : "text-muted-foreground")}
        >
          {status}
        </p>
      </div>

      <div>
        <SectionLabel placement="above">{t("keys.builder.hold")}</SectionLabel>
        <div className="flex gap-2">
          {MODIFIER_ORDER.map((m) => (
            <ToggleButton
              key={m}
              pressed={draft.mods.includes(m)}
              onPressedChange={() => toggle(m)}
              label={m === "ctrl" ? "Ctrl" : m === "alt" ? "Alt" : "Shift"}
              icon={null}
              text={m === "ctrl" ? "Ctrl" : m === "alt" ? "Alt" : "Shift"}
              className="flex-1 border border-border"
            />
          ))}
        </div>
      </div>

      <div className="space-y-2">
        <SectionLabel placement="above">{t("keys.builder.press")}</SectionLabel>
        <Segmented
          label={t("keys.builder.kindAria")}
          value={draft.kind}
          onChange={(kind) => edit({ kind })}
          options={KINDS.map((kind) => ({ value: kind, label: t(`keys.builder.kind.${kind}`) }))}
        />
        <div className="h-[116px]">
          {draft.kind === "char" && (
            <input
              aria-label={t("keys.builder.charAria")}
              value={draft.char}
              maxLength={2}
              onChange={(e) => {
                // The last character typed wins, lower-cased: Shift is its own button here, and a
                // phone keyboard that capitalises the first letter must not change the chord.
                const ch = [...e.target.value.toLowerCase()].at(-1) ?? "";
                const code = ch.charCodeAt(0);
                if (ch === "" || (ch.length === 1 && code >= 0x21 && code <= 0x7e)) edit({ char: ch });
              }}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              placeholder="t"
              className="h-11 w-full rounded-sm border border-border bg-background px-3 font-mono text-base focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            />
          )}
          {draft.kind === "named" && (
            <div className="grid grid-cols-5 gap-1">
              {NAMED_KEYS.map((key) => (
                <Button
                  key={key}
                  type="button"
                  variant={draft.named === key ? "default" : "outline"}
                  size="sm"
                  className="h-9 px-0"
                  aria-label={stepWords(key)}
                  aria-pressed={draft.named === key}
                  disabled={!keysSendable([key], unsupportedKeys)}
                  onClick={() => edit({ named: key })}
                >
                  <span className="truncate">{stepFace(key)}</span>
                </Button>
              ))}
            </div>
          )}
          {draft.kind === "fkeys" && (
            <div className="grid grid-cols-6 gap-1">
              {F_KEYS.map((key) => (
                <Button
                  key={key}
                  type="button"
                  variant={draft.fkey === key ? "default" : "outline"}
                  size="sm"
                  className="h-9 px-0"
                  aria-label={key}
                  aria-pressed={draft.fkey === key}
                  disabled={!keysSendable([key], unsupportedKeys)}
                  onClick={() => edit({ fkey: key })}
                >
                  {key}
                </Button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div>
        <SectionLabel placement="above">{t("keys.builder.nameLabel")}</SectionLabel>
        <input
          aria-label={t("keys.builder.nameAria")}
          value={name}
          maxLength={MAX_LABEL}
          onChange={(e) => setName(e.target.value.replace(/[\p{C}\p{Zl}\p{Zp}]/gu, ""))}
          placeholder={complete ? defaultLabel(steps) : ""}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className="h-11 w-full rounded-sm border border-border bg-background px-3 text-base focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        />
      </div>

      <Button
        type="button"
        className="h-11"
        disabled={built === null}
        onClick={() => built !== null && onSave(built)}
      >
        {t("keys.builder.save")}
      </Button>
    </div>
  );
}
