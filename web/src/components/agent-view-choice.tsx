import { useEffect } from "react";

import { Icon } from "@/components/icons/icon";
import { Badge } from "@/components/ui/badge";
import { ListGroup } from "@/components/ui/list-group";
import { useArm } from "@/hooks/use-arm";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
import type { ViewChoice, ViewMedia, ViewOption } from "@/lib/agent-view/wire";
import type { ViewPictures } from "@/lib/tricks/render";
import { cn } from "@/lib/utils";

// THE DECISION BLOCK of an agent view's screen: one question and one to five options, drawn under the
// view. ITS OWN LOOK (agent views SECURITY rule 8, N3): an agent view draws no Hill look, so the options
// are rows of one framed list (`ui/list-group.tsx`), each a full-width 44px row with a round mark at its
// start, the label and the detail, and the recommended star or the busy spinner in one fixed slot at its
// end, so a mark arriving moves no label (DESIGN.md §2). Never the Hill's option buttons, never a
// Decision card's frame.
//
// A PICK IS A MESSAGE. The block only says which option was tapped; the view sends it (the bridge types
// `picked "<label>"`), marks it until the next screen, and holds every option while it is in flight.
//
// A `confirm` ARMS IN COLLIE'S LOOK (lead condition 6). The first tap arms the row: the row takes the
// armed ink and edge and Collie's own words, "Tap again to send" with the label that goes, and the agent's
// `confirm` word as the second line. The second tap sends. The armed state is never the agent's words alone.
//
// A SETTLED CHOICE ({@link ViewChoiceDone}): a choice the agent sent with `picked`, or one the operator
// picked that now stands in the "Earlier screen" fold. The picked option at full contrast with the check,
// an "Answered" badge beside the question, every other option a plain quiet row, and nothing to tap. No
// grey wash: the quiet rows are muted ink, never a lowered opacity.
//
// PREVIEWS. An option with a `preview` shows that picture above its row's words, inside the row: a tap on
// the picture opens it at full size (paging through every preview of the block), a tap on the row picks.

/** The tallest a preview frame stands: a phone screenshot is cut by `contain`, never by the frame. */
const PREVIEW_MAX = "220px";
/** The frame's shape when the bridge could not read the picture's size. */
const PREVIEW_RATIO_FALLBACK = "4 / 3";

function ratioOf(media: ViewMedia | undefined): string {
  if (media === undefined || media.width === null || media.height === null) return PREVIEW_RATIO_FALLBACK;
  return `${String(media.width)} / ${String(media.height)}`;
}

export interface ViewChoiceBlockProps {
  choice: ViewChoice;
  /** The screen's pictures, for the previews; absent when the screen holds none. */
  pictures: ViewPictures | undefined;
  media: readonly ViewMedia[];
  /** The option the operator picked on this screen, or null. */
  picked: number | null;
  /** The option whose send is in flight, or null. */
  busy: number | null;
  /** A pick may send: a live pane on a device that may write, no turn running, no question waiting. */
  canAct: boolean;
  onPick: (index: number) => void;
}

export function ViewChoiceBlock({ choice, pictures, media, picked, busy, canAct, onPick }: ViewChoiceBlockProps) {
  useLocale();
  const { armed, tap, disarm } = useArm<string>();
  const blocked = !canAct || busy !== null;
  const recommended = choice.recommends === undefined ? undefined : choice.options[choice.recommends.option];
  const previews = choice.options.flatMap((option) => (option.preview === undefined ? [] : [option.preview]));

  // An option that cannot be picked now holds no arm: the arm was for a pick that can no longer go.
  useEffect(() => {
    if (blocked) disarm();
  }, [blocked, disarm]);

  function choose(option: ViewOption, index: number) {
    if (blocked) return;
    if (option.confirm !== undefined && tap(`option:${String(index)}`) !== "fire") return;
    if (option.confirm === undefined) disarm();
    onPick(index);
  }

  const armedOption = choice.options.find((_, i) => armed === `option:${String(i)}`);

  return (
    <section data-slot="view-choice" aria-label={choice.question} className="mt-4 flex min-w-0 flex-col gap-2">
      {choice.question !== undefined && (
        <p data-slot="view-choice-question" className="font-content text-sm font-semibold break-words">
          {choice.question}
        </p>
      )}
      <ListGroup as="ul" data-slot="view-choice-options" className="min-w-0">
        {choice.options.map((option, i) => {
          const isArmed = armed === `option:${String(i)}` && option.confirm !== undefined;
          const isBusy = busy === i;
          const isPicked = picked === i;
          const isRecommended = choice.recommends?.option === i;
          return (
            <li key={`${String(i)}:${option.label}`} className="min-w-0">
              {option.preview !== undefined && pictures !== undefined && (
                <div data-slot="view-option-preview" className="px-3.5 pt-2.5">
                  {pictures.draw({ refs: previews, index: previews.indexOf(option.preview), fit: "contain", ratio: ratioOf(media[option.preview]), maxHeight: PREVIEW_MAX })}
                </div>
              )}
              <button
                type="button"
                data-slot="view-option"
                data-armed={isArmed ? "" : undefined}
                aria-pressed={isPicked}
                aria-busy={isBusy || undefined}
                aria-label={isArmed ? t("view.armed", { label: option.label }) : undefined}
                disabled={blocked}
                onClick={() => choose(option, i)}
                className={cn(
                  // One 1px edge on every row, coloured only when armed, so arming moves nothing (DESIGN.md §2).
                  "flex min-h-11 w-full min-w-0 items-center gap-3 border border-transparent px-3.5 py-2.5 text-left transition-colors hover:bg-accent active:bg-muted disabled:cursor-default disabled:text-muted-foreground disabled:hover:bg-transparent",
                  isArmed && "border-status-blocked text-status-blocked",
                )}
              >
                <span aria-hidden className={cn("flex size-4 shrink-0 items-center justify-center rounded-sm border", isPicked ? "border-primary bg-primary text-primary-foreground" : "border-border")}>
                  {isPicked && <Icon name="answered" className="size-3" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium break-words">{isArmed ? t("view.armed", { label: option.label }) : option.label}</span>
                  {isArmed ? (
                    option.confirm !== undefined && <span className="block text-xs break-words">{option.confirm}</span>
                  ) : (
                    option.detail !== undefined && <span className="block text-xs break-words text-muted-foreground">{option.detail}</span>
                  )}
                </span>
                {/* One 16px slot on every option, so the spinner or the star arriving moves no label. */}
                <span aria-hidden className="flex size-4 shrink-0 items-center justify-center text-status-working">
                  {isBusy ? <Icon name="busy" className="size-3.5 animate-spin text-muted-foreground" /> : isRecommended ? <Icon name="recommended" data-slot="view-recommended-mark" className="size-3.5" /> : null}
                </span>
              </button>
            </li>
          );
        })}
      </ListGroup>
      {recommended !== undefined && choice.recommends?.why !== undefined && (
        <p data-slot="view-choice-why" className="flex min-w-0 items-start gap-1.5 text-xs text-muted-foreground">
          <Icon name="recommended" aria-hidden className="mt-px size-3.5 shrink-0 text-status-working" />
          <span className="min-w-0 break-words">{choice.recommends.why}</span>
        </p>
      )}
      {/* The mark is decorative; a reader hears which option it is here. */}
      {recommended !== undefined && <span className="sr-only">{t("hill.recommended", { label: recommended.label })}</span>}
      {/* A live region on the button itself is unreliable; this one announces the armed wording. */}
      <span className="sr-only" aria-live="polite">
        {armedOption?.confirm === undefined ? "" : t("view.armed", { label: armedOption.label })}
      </span>
    </section>
  );
}

export interface ViewChoiceDoneProps {
  choice: ViewChoice;
  /** The option settled on. */
  picked: number;
  pictures: ViewPictures | undefined;
}

/** A settled choice: the picked option marked, the others quiet, no control; see the header. */
export function ViewChoiceDone({ choice, picked, pictures }: ViewChoiceDoneProps) {
  useLocale();
  const chosen = choice.options[picked];
  return (
    <section data-slot="view-choice" data-done="" aria-label={choice.question} className="mt-4 flex min-w-0 flex-col gap-2">
      <div className="flex min-w-0 items-center gap-2">
        {choice.question !== undefined && (
          <p data-slot="view-choice-question" className="min-w-0 font-content text-sm font-semibold break-words">
            {choice.question}
          </p>
        )}
        <Badge variant="ok" data-slot="view-answered-badge">
          <Icon name="answered" aria-hidden />
          {t("view.receipt.answered")}
        </Badge>
      </div>
      <ListGroup as="ul" data-slot="view-choice-options" className="min-w-0">
        {choice.options.map((option, i) => {
          const isPicked = i === picked;
          return (
            <li key={`${String(i)}:${option.label}`} data-slot="view-option-done" data-picked={isPicked ? "" : undefined} className={cn("flex min-h-11 min-w-0 items-center gap-3 px-3.5 py-2", isPicked ? "text-foreground" : "text-muted-foreground")}>
              <span aria-hidden className={cn("flex size-4 shrink-0 items-center justify-center rounded-sm border", isPicked ? "border-status-done bg-status-done text-background" : "border-border")}>
                {isPicked && <Icon name="answered" className="size-3" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className={cn("block text-sm break-words", isPicked && "font-medium")}>{option.label}</span>
                {option.detail !== undefined && <span className="block text-xs break-words text-muted-foreground">{option.detail}</span>}
              </span>
              {isPicked && option.preview !== undefined && pictures !== undefined && (
                <span className="size-12 shrink-0 overflow-hidden rounded-sm">{pictures.draw({ refs: [option.preview], index: 0, fit: "cover", ratio: "1 / 1", maxHeight: "48px" })}</span>
              )}
            </li>
          );
        })}
      </ListGroup>
      {chosen !== undefined && <span className="sr-only">{t("view.receipt.pickedLabel", { label: chosen.label })}</span>}
    </section>
  );
}
