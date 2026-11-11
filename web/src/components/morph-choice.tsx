import { useEffect } from "react";

import { Icon } from "@/components/icons/icon";
import { OptionButton, type OptionTone } from "@/components/option-button";
import { Badge } from "@/components/ui/badge";
import { useArm } from "@/hooks/use-arm";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
import type { MorphChoice, MorphMedia, MorphOption } from "@/lib/morph/wire";
import type { ViewPictures } from "@/lib/tricks/render";
import { cn } from "@/lib/utils";

// TODO(agent-view web): SECURITY rule 8, an agent view draws no Hill-card look. This block still borrows the
// Decision card's option buttons and arm; the web half must give it a look of its own.
//
// THE DECISION BLOCK of a Morph screen: one question and one to five options, drawn under the view with
// the hill's option buttons and its arm, exactly as the Decision card draws its options
// (components/decision-card.tsx): the label, the detail as the description, `confirm` as the armed
// second tap, the recommended star in the trailing slot and the busy spinner in that same slot, so a
// mark arriving moves no label (DESIGN.md §2).
//
// A PICK IS A MESSAGE. The block only says which option was tapped; the Morph body sends it through the
// composer (`picked "<label>"`), marks it until the next screen, and holds every option while it is in
// flight.
//
// A SETTLED CHOICE ({@link MorphChoiceDone}): a choice the agent sent with `picked`, or one the operator
// picked that now stands in the "Earlier screen" fold. The picked option at full contrast with the check,
// an "Answered" badge beside the question, every other option a plain quiet row, and nothing to tap. No
// grey wash: the quiet rows are muted ink, never a lowered opacity.
//
// PREVIEWS. An option with a `preview` shows that picture above its button, as one card: a tap on the
// picture opens it at full size (paging through every preview of the block), a tap on the button picks.
// Two options with previews stand side by side when both stay readable at a phone's width
// ({@link sideBySide}); otherwise every option is stacked.

/** A label this short or shorter fits a half-width button at 360 px on two lines at most. */
const SIDE_LABEL_MAX = 24;
/** A detail this short or shorter stays at three lines or fewer in a half-width button at 360 px. */
const SIDE_DETAIL_MAX = 60;
/** The tallest a preview frame stands: a phone screenshot is cut by `contain`, never by the frame. */
const PREVIEW_MAX_SIDE = "280px";
const PREVIEW_MAX_STACKED = "220px";
/** The frame's shape when the bridge could not read the picture's size. */
const PREVIEW_RATIO_FALLBACK = "4 / 3";

/**
 * Whether two preview cards stand side by side at 360 to 390 px: exactly two options, both with a
 * preview, short labels and short details. Each card is then about 170 px wide; a longer text would wrap
 * past three lines and the pair would read worse than a stack.
 */
export function sideBySide(choice: MorphChoice): boolean {
  if (choice.options.length !== 2) return false;
  return choice.options.every((option) => option.preview !== undefined && option.label.length <= SIDE_LABEL_MAX && (option.detail?.length ?? 0) <= SIDE_DETAIL_MAX);
}

function ratioOf(media: MorphMedia | undefined): string {
  if (media === undefined || media.width === null || media.height === null) return PREVIEW_RATIO_FALLBACK;
  return `${String(media.width)} / ${String(media.height)}`;
}

export interface MorphChoiceBlockProps {
  choice: MorphChoice;
  /** The screen's pictures, for the previews; absent when the screen holds none. */
  pictures: ViewPictures | undefined;
  media: readonly MorphMedia[];
  /** The option the operator picked on this screen, or null. */
  picked: number | null;
  /** The option whose send is in flight, or null. */
  busy: number | null;
  /** A pick may send: a live pane on a device that may write. */
  canAct: boolean;
  onPick: (index: number) => void;
}

function toneOf({ busy, armed, picked }: { busy: boolean; armed: boolean; picked: boolean }): OptionTone {
  if (busy) return "busy";
  if (armed) return "armed";
  if (picked) return "selected";
  return "default";
}

export function MorphChoiceBlock({ choice, pictures, media, picked, busy, canAct, onPick }: MorphChoiceBlockProps) {
  useLocale();
  const { armed, tap, disarm } = useArm<string>();
  const blocked = !canAct || busy !== null;
  const recommended = choice.recommends === undefined ? undefined : choice.options[choice.recommends.option];
  const side = sideBySide(choice);
  const previews = choice.options.flatMap((option) => (option.preview === undefined ? [] : [option.preview]));

  // An option that cannot be picked now holds no arm: the arm was for a pick that can no longer go.
  useEffect(() => {
    if (blocked) disarm();
  }, [blocked, disarm]);

  function choose(option: MorphOption, index: number) {
    if (blocked) return;
    if (option.confirm !== undefined && tap(`option:${String(index)}`) !== "fire") return;
    if (option.confirm === undefined) disarm();
    onPick(index);
  }

  const armedOption = choice.options.find((_, i) => armed === `option:${String(i)}`);

  return (
    <section data-slot="morph-choice" aria-label={choice.question} className="mt-4 flex min-w-0 flex-col gap-2">
      {choice.question !== undefined && (
        <p data-slot="morph-choice-question" className="font-content text-sm font-semibold break-words">
          {choice.question}
        </p>
      )}
      <div data-slot="morph-choice-options" data-layout={side ? "side" : "stack"} className={cn("min-w-0 gap-2", side ? "grid grid-cols-2 items-start" : "flex flex-col")}>
        {choice.options.map((option, i) => {
          const isArmed = armed === `option:${String(i)}`;
          const isBusy = busy === i;
          const isRecommended = choice.recommends?.option === i;
          const button = (
            <OptionButton
              data-slot="morph-option"
              tone={toneOf({ busy: isBusy, armed: isArmed, picked: picked === i })}
              label={isArmed && option.confirm !== undefined ? option.confirm : option.label}
              aria-label={isArmed && option.confirm !== undefined ? t("hill.armed", { label: option.confirm }) : undefined}
              description={option.detail}
              disabled={blocked}
              onClick={() => choose(option, i)}
              className="min-h-12 items-center px-3"
              trailing={
                // One 16px slot on every option, so the spinner or the mark arriving moves no label.
                <span aria-hidden className="flex size-4 shrink-0 items-center justify-center text-status-working">
                  {isBusy ? (
                    <Icon name="busy" className="size-3.5 animate-spin text-muted-foreground" />
                  ) : isRecommended ? (
                    <Icon name="recommended" data-slot="morph-recommended-mark" className="size-3.5" />
                  ) : null}
                </span>
              }
            />
          );
          if (option.preview === undefined || pictures === undefined) return <div key={`${String(i)}:${option.label}`} className="min-w-0">{button}</div>;
          return (
            <div key={`${String(i)}:${option.label}`} data-slot="morph-option-card" className="flex min-w-0 flex-col gap-1.5">
              {pictures.draw({
                refs: previews,
                index: previews.indexOf(option.preview),
                fit: "contain",
                ratio: ratioOf(media[option.preview]),
                maxHeight: side ? PREVIEW_MAX_SIDE : PREVIEW_MAX_STACKED,
              })}
              {button}
            </div>
          );
        })}
      </div>
      {recommended !== undefined && choice.recommends?.why !== undefined && (
        <p data-slot="morph-choice-why" className="flex min-w-0 items-start gap-1.5 text-xs text-muted-foreground">
          <Icon name="recommended" aria-hidden className="mt-px size-3.5 shrink-0 text-status-working" />
          <span className="min-w-0 break-words">{choice.recommends.why}</span>
        </p>
      )}
      {/* The mark is decorative; a reader hears which option it is here. */}
      {recommended !== undefined && <span className="sr-only">{t("hill.recommended", { label: recommended.label })}</span>}
      {/* A live region on the button itself is unreliable; this one announces the armed wording. */}
      <span className="sr-only" aria-live="polite">
        {armedOption?.confirm === undefined ? "" : t("hill.armed", { label: armedOption.confirm })}
      </span>
    </section>
  );
}

export interface MorphChoiceDoneProps {
  choice: MorphChoice;
  /** The option settled on. */
  picked: number;
  pictures: ViewPictures | undefined;
}

/** A settled choice: the picked option marked, the others quiet, no control; see the header. */
export function MorphChoiceDone({ choice, picked, pictures }: MorphChoiceDoneProps) {
  useLocale();
  const chosen = choice.options[picked];
  return (
    <section data-slot="morph-choice" data-done="" aria-label={choice.question} className="mt-4 flex min-w-0 flex-col gap-2">
      <div className="flex min-w-0 items-center gap-2">
        {choice.question !== undefined && (
          <p data-slot="morph-choice-question" className="min-w-0 font-content text-sm font-semibold break-words">
            {choice.question}
          </p>
        )}
        <Badge variant="ok" data-slot="morph-answered-badge">
          <Icon name="answered" aria-hidden />
          {t("view.receipt.answered")}
        </Badge>
      </div>
      <ul data-slot="morph-choice-options" className="flex min-w-0 flex-col gap-1">
        {choice.options.map((option, i) => {
          const isPicked = i === picked;
          return (
            <li
              key={`${String(i)}:${option.label}`}
              data-slot="morph-option-done"
              data-picked={isPicked ? "" : undefined}
              // One border on every row, coloured only on the picked one, so the mark moves nothing (DESIGN.md §2).
              className={cn("flex min-h-11 min-w-0 items-center gap-2 rounded-lg border px-3 py-2", isPicked ? "border-status-done/40 bg-card text-foreground" : "border-transparent text-muted-foreground")}
            >
              <span aria-hidden className="flex size-4 shrink-0 items-center justify-center text-status-done">
                {isPicked && <Icon name="answered" className="size-3.5" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className={cn("block text-sm break-words", isPicked && "font-medium")}>{option.label}</span>
                {option.detail !== undefined && <span className="block text-xs break-words text-muted-foreground">{option.detail}</span>}
              </span>
              {isPicked && option.preview !== undefined && pictures !== undefined && (
                <span className="size-12 shrink-0 overflow-hidden rounded-md">{pictures.draw({ refs: [option.preview], index: 0, fit: "cover", ratio: "1 / 1", maxHeight: "48px" })}</span>
              )}
            </li>
          );
        })}
      </ul>
      {chosen !== undefined && <span className="sr-only">{t("view.receipt.pickedLabel", { label: chosen.label })}</span>}
    </section>
  );
}

