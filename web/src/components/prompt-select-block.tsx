import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Loader2, MessageSquarePlus } from "lucide-react";

import type {
  PromptFamily,
  PromptFeedbackPurpose,
  PromptModel,
  PromptOption,
  PromptSubjectLine,
  StyledLine,
} from "@/lib/blocks";
import { FEEDBACK_MAX_LENGTH } from "@/lib/prompt-action";
import { OptionButton, OptionGroupCaption, PromptPanel } from "@/components/option-button";
import { MIRROR_INVERT, MIRROR_SPACE } from "@/components/mirror-space";
import { RawMirror } from "@/components/raw-mirror";
import { hasResizeObserver } from "@/lib/env";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** What a tap on this block asks for: an option's keystroke plan, or feedback typed on the phone. */
export type PromptBlockAction =
  | { kind: "option"; option: PromptOption }
  | { kind: "feedback"; text: string };

export interface PromptSelectBlockProps {
  /** The detected dialog: its subject and question (shown, and the group's label) + options. */
  prompt: PromptModel;
  /** The region this block replaced — passed through to PromptPanel as its way back (ADR 0056).
   *  Absent in a handful of presentational tests that construct a `PromptModel` by hand; those
   *  render with no Terminal control, which is the correct behaviour for a missing `raw`. */
  lines?: StyledLine[];
  /**
   * Injected send handler (from AgentChat). Presentational contract: this component NEVER touches
   * the network — it just reflects the sending state while the handler runs the race guard and
   * sends the option's keys (or drives the feedback choreography). Returning/throwing simply clears
   * the busy state.
   */
  onAction: (action: PromptBlockAction) => boolean | void | Promise<boolean | void>;
  /** Read-only device or a gone pane: buttons still render (for context) but can't be pressed. */
  disabled?: boolean;
}

// Family-aware caption at the top of the card — orients the reader ("the terminal is asking you
// something"). The subject and the question follow it on the card itself.
// A function, not a module-level object, so it re-reads the current locale on every call — a
// component that calls `useLocale()` re-renders on a language switch and this is called fresh.
function familyCaption(family: PromptFamily): string {
  switch (family) {
    case "select":
      return t("prompt.family.select");
    case "permission":
      return t("prompt.family.permission");
    case "trust":
      return t("prompt.family.trust");
    case "plan":
      return t("prompt.family.plan");
  }
}

// The badge glyph for a key a model didn't already give its own `keyLabel` — the same glyph the
// terminal itself draws for that key. Never the raw key NAME: a badge reading "Down" or "Up" tells
// the reader nothing a terminal ever showed them (the resume picker's footer names only the pointer
// and Esc; the folder-trust prompt's footer names only Enter and Esc — ADR 0055/0058). A digit falls
// through unchanged, since the badge already mirrors the menu's own digit in that case.
// Exported for its own unit test.
export function keyBadgeFallback(key: string): string {
  if (key === "Down") return "↓";
  if (key === "Up") return "↑";
  if (key === "Left") return "←";
  if (key === "Right") return "→";
  if (key === "Enter") return "⏎";
  if (key === "Escape") return "Esc";
  if (key === "Tab") return "Tab";
  return key;
}

/** Whether a subject row is the dialog's HEADER: its first painted run is bold, the way Claude
 *  paints `Bash command` or `Create file`. Exported for its own unit test. */
export function isHeaderRow(line: PromptSubjectLine | undefined): boolean {
  const first = line?.segments.find((s) => s.text.trim() !== "");
  return first?.bold === true;
}

/**
 * Whether a vertical scroller still hides content BELOW its fold: it overflows, and it is not
 * scrolled to the bottom. The same measuring as `useOverflowEdges` (ui/overflow-edges.tsx), turned to
 * the vertical axis: read on every render, on every `scroll` (passive) and whenever the box or its
 * content changes size, with the same 1px slack against sub-pixel rounding. React bails out of a
 * re-render when the answer is unchanged, so a scroll event costs no render per frame.
 */
function useMoreBelow<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [more, setMore] = useState(false);

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    setMore(el.scrollHeight > el.clientHeight && el.scrollTop + el.clientHeight < el.scrollHeight - 1);
  }, []);

  useLayoutEffect(measure);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.addEventListener("scroll", measure, { passive: true });
    return () => el.removeEventListener("scroll", measure);
  }, [measure]);

  // A font finishing, the viewport resizing, the keyboard opening. Guarded for jsdom.
  useEffect(() => {
    const el = ref.current;
    if (!el || !hasResizeObserver()) return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);

  return { ref, more };
}

/**
 * What the dialog asks about (`PromptModel.subject`), above the question. The card used to leave it
 * in the raw scrollback above itself, which the docked card (ADR 0059) and the Chat view no longer
 * show, so a subagent's permission read "Yes / No" and nothing else.
 *
 * A header row (bold in the terminal) is the card's title, in text weight: its bold runs in the
 * foreground, the rest (` · from the general-purpose agent`) muted. Every other row is the command,
 * diff or warning, drawn as the mirror draws it (RawMirror: mono, the agent's own colours, React text
 * nodes only) but wrapping, and capped at about 40% of the dock's 55dvh with its own scroll, so a
 * long diff never pushes the buttons out of the dock.
 */
function PromptSubject({ subject }: { subject: PromptSubjectLine[] }) {
  const header = isHeaderRow(subject[0]) ? subject[0]! : null;
  const rest = header ? subject.slice(1) : subject;
  // A blank row right under the header is the gap the terminal left after it; the card has its own.
  const body = rest[0]?.segments.every((s) => s.text.trim() === "") ? rest.slice(1) : rest;
  return (
    <>
      {header ? (
        <p data-slot="prompt-subject-title" className="font-content pl-0.5 text-sm leading-snug wrap-anywhere">
          {header.segments.map((s, i) => (
            <span key={i} className={s.bold ? "font-medium text-foreground" : "text-muted-foreground"}>
              {i === 0 ? s.text.trimStart() : s.text}
            </span>
          ))}
        </p>
      ) : null}
      {body.length > 0 ? <SubjectBody lines={body} /> : null}
    </>
  );
}

/**
 * The subject's rows in their scrolling box, and the fade while rows still hide below it. The fade is
 * the belt's pattern turned to the vertical axis (actions-row.tsx: a ground-coloured layer under a
 * `mask-image` gradient). Its ground is the mirror's own, so it wears the same dark-space colours and
 * the same light-theme inversion as the box it sits on (ADR 0002). It draws nothing when the box fits
 * or is scrolled to its end, and it never takes a tap or a scroll.
 */
function SubjectBody({ lines }: { lines: PromptSubjectLine[] }) {
  const { ref, more } = useMoreBelow<HTMLPreElement>();
  return (
    <div data-slot="prompt-subject" className="relative">
      <RawMirror ref={ref} lines={lines} wrap className="max-h-[22dvh] overflow-y-auto overscroll-contain" />
      {more ? (
        <div
          aria-hidden
          data-slot="prompt-subject-more"
          className={cn(
            "pointer-events-none absolute inset-x-0 bottom-0 h-12 rounded-b-lg [mask-image:linear-gradient(to_bottom,transparent,black)]",
            MIRROR_SPACE,
            MIRROR_INVERT,
          )}
        />
      ) : null}
    </div>
  );
}

interface FeedbackCopy {
  offer: string | null;
  editorLabel: string;
  placeholder: string;
  help: string;
  send: string;
  sending: string;
  focused: string;
  typedPrefix: string;
}

// Copy is purpose-aware: Claude's plan-approval input is deny-with-feedback; Grok's `z` row is
// a custom answer. Missing purpose is Claude (the only row submitPromptFeedback will type into).
// A function (not a module-level object) for the same locale-freshness reason as familyCaption.
function feedbackCopyFor(purpose: PromptFeedbackPurpose): FeedbackCopy {
  if (purpose === "free-text") {
    // No phone composer: the Claude plan-feedback send path is the wrong recipe for this row.
    return {
      offer: null,
      editorLabel: "",
      placeholder: "",
      help: "",
      send: "",
      sending: "",
      focused: t("prompt.feedback.freeText.focused"),
      typedPrefix: t("prompt.feedback.freeText.typedPrefix"),
    };
  }
  return {
    offer: t("prompt.feedback.planChange.offer"),
    editorLabel: t("prompt.feedback.planChange.editorLabel"),
    placeholder: t("prompt.feedback.planChange.placeholder"),
    help: t("prompt.feedback.planChange.help"),
    send: t("prompt.feedback.planChange.send"),
    sending: t("prompt.feedback.planChange.sending"),
    focused: t("prompt.feedback.planChange.focused"),
    typedPrefix: t("prompt.feedback.planChange.typedPrefix"),
  };
}

// Native, tappable rendering of a Claude single-choice dialog. Every visible string — the subject,
// the question, the option label and its description — is a React text node (the XSS boundary is
// unchanged; nothing is ever set as innerHTML). The card reads top to bottom as the dialog does: the
// family caption, the subject (what is asked about, when the grammar found it), the question, the
// options. The question is shown on every card, and it still labels the group for a screen reader:
// the raw scrollback that used to show it sits off screen once the card docks (ADR 0059), and the
// Chat view never shows it. Real <button>s, so they're keyboard-focusable and screen-reader-announced.
// Each row leads with its terminal-menu digit (KeyBadge) so the mapping is
// visible. One option can be in flight at a time — its spinner shows and the rest lock, preventing a
// double-send.
//
// A dialog carrying an inline text input (the plan approval's "Tell Claude what to change") adds two
// surfaces below the options, and one state in which the options themselves are dead:
//
//   * FOCUSED — `❯` is on the input row, so the terminal routes every digit into it as a character
//     and no button on this dialog can fire (issue #95: they used to render as ordinary buttons and
//     silently type into the desktop user's sentence). Everything locks behind a banner; polling
//     clears it the moment the pointer moves off. Same treatment as PreviewSelectBlock's note field.
//   * TEXT ALREADY IN THE BOX — the options answer normally, but Collie will not type: re-entering a
//     non-empty field puts the caret at position 0, so our words would be prepended to theirs. The
//     affordance is replaced by a read-only card showing what is in there.
//
// Only the empty, unfocused state offers the composer, whose Send drives digit → focus → type →
// Enter and lands as DENY-with-feedback (the agent re-plans) — which is what the button says.
export function PromptSelectBlock({ prompt, lines, onAction, disabled }: PromptSelectBlockProps) {
  useLocale();
  const [sending, setSending] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  // Focused from an effect rather than with `autoFocus`: the attribute only acts on the very first
  // mount of the element, so re-opening the editor after a cancel would leave the field unfocused —
  // and it gives assistive tech no chance to announce the surrounding panel first.
  const editorRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (editorOpen) editorRef.current?.focus();
  }, [editorOpen]);

  const [draft, setDraft] = useState("");
  const feedback = prompt.feedback;
  const terminalFocused = feedback?.focused ?? false;
  const locked = Boolean(disabled) || sending !== null || terminalFocused;
  const feedbackCopy = feedback
    ? feedbackCopyFor(feedback.purpose === "free-text" ? "free-text" : "plan-change")
    : null;

  async function press(id: string, action: PromptBlockAction): Promise<boolean> {
    if (locked) return false;
    setSending(id);
    try {
      // A handler that returns nothing is taken at its word (the presentational tests inject one);
      // only an explicit `false` means "didn't send".
      return (await onAction(action)) !== false;
    } finally {
      setSending(null);
    }
  }

  async function sendFeedback() {
    const text = draft.trim();
    if (text.length === 0) return;
    // The editor closes only on a send that actually landed. A refused one (the guard saw the dialog
    // move) would otherwise throw away up to FEEDBACK_MAX_LENGTH characters someone thumb-typed on a
    // phone — the longest text this app ever asks anyone to type — with no way to get them back.
    if (await press("feedback", { kind: "feedback", text })) setEditorOpen(false);
  }

  const busyIcon = (
    <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" aria-label={t("prompt.sendingAria")} />
  );

  return (
    <PromptPanel ariaLabel={prompt.question} raw={lines}>
      <OptionGroupCaption>{prompt.caption ?? familyCaption(prompt.family)}</OptionGroupCaption>
      {prompt.subject && prompt.subject.length > 0 ? <PromptSubject subject={prompt.subject} /> : null}
      {/* A dialog that names itself (`/resume`'s "Resume session") already shows its title as the
          caption; saying it twice adds nothing. */}
      {prompt.question !== prompt.caption ? (
        <p
          data-slot="prompt-question"
          className="font-content pl-0.5 text-sm leading-snug whitespace-pre-line text-foreground wrap-anywhere"
        >
          {prompt.question}
        </p>
      ) : null}
      <div className="flex flex-col gap-1">
        {prompt.options.map((option, index) => {
          const id = `opt-${index}`;
          const busy = sending === id;
          return (
            <OptionButton
              key={index}
              tone={busy ? "busy" : "default"}
              keyLabel={option.keyLabel ?? keyBadgeFallback(option.keys[0]!)}
              label={option.label}
              description={option.description}
              disabled={locked}
              onClick={() => press(id, { kind: "option", option })}
              trailing={
                busy ? (
                  <Loader2
                    className="mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground"
                    aria-label={t("prompt.sendingAria")}
                  />
                ) : null
              }
            />
          );
        })}
      </div>

      {/* The inline text input, in whichever of its states this screen is in. OUR OWN send comes
          first: the choreography focuses the row and fills it, so from the moment Send is pressed the
          screen is briefly indistinguishable from "someone at the terminal is typing" — and saying
          that to the person who just pressed the button would be a lie about their own action. */}
      {feedback && feedbackCopy && sending === "feedback" ? (
        <div className="flex items-center gap-2 rounded-lg border border-border/70 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          {busyIcon}
          {feedbackCopy.sending}
        </div>
      ) : feedback && feedbackCopy && terminalFocused ? (
        <div className="rounded-lg border border-dashed border-status-working/50 px-3 py-2 text-xs text-status-working">
          {feedbackCopy.focused}
          {feedback.text ? (
            <span className="font-content text-muted-foreground"> ({feedback.text})</span>
          ) : null}
        </div>
      ) : feedback && feedbackCopy && feedback.text !== "" ? (
        <div className="flex items-start gap-2 rounded-lg border border-border/60 bg-muted/30 px-3 py-2">
          <MessageSquarePlus
            className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
            aria-label={t("prompt.feedback.typedAria")}
          />
          <span className="min-w-0 flex-1 text-xs text-foreground/90">
            {feedbackCopy.typedPrefix}
            <span className="font-content">{feedback.text}</span>
          </span>
        </div>
      ) : feedback && feedbackCopy && feedbackCopy.offer && editorOpen ? (
        <div className="flex flex-col gap-1.5 rounded-lg border border-border/70 bg-muted/30 px-3 py-2">
          <label
            htmlFor="plan-feedback-text"
            className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground"
          >
            <MessageSquarePlus className="size-3.5 shrink-0" />
            {feedbackCopy.editorLabel}
          </label>
          <textarea
            id="plan-feedback-text"
            ref={editorRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={FEEDBACK_MAX_LENGTH}
            rows={3}
            aria-label={t("prompt.feedback.planChange.textAria")}
            placeholder={feedbackCopy.placeholder}
            className="w-full resize-none rounded-md border border-border/60 bg-background px-2 py-1.5 text-sm text-foreground focus:border-primary/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          />
          <p className="text-[11px] leading-snug text-muted-foreground">{feedbackCopy.help}</p>
          <div className="flex items-center justify-end gap-1.5">
            <button
              type="button"
              disabled={sending !== null}
              onClick={() => setEditorOpen(false)}
              className="rounded-md px-2.5 py-1.5 text-xs text-muted-foreground transition-colors active:bg-muted disabled:opacity-60"
            >
              {t("prompt.feedback.cancel")}
            </button>
            <button
              type="button"
              disabled={locked || draft.trim().length === 0}
              onClick={() => void sendFeedback()}
              className="flex items-center gap-1.5 rounded-md border border-primary/60 bg-primary/15 px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors active:bg-primary/25 disabled:opacity-60"
            >
              {sending === "feedback" ? busyIcon : null}
              {feedbackCopy.send}
            </button>
          </div>
        </div>
      ) : feedback && feedbackCopy && feedbackCopy.offer ? (
        <button
          type="button"
          disabled={locked}
          onClick={() => {
            setDraft("");
            setEditorOpen(true);
          }}
          className="flex w-full items-center gap-2 rounded-lg border border-dashed border-border/60 px-3 py-1.5 text-left text-xs text-muted-foreground transition-colors active:bg-muted disabled:opacity-60"
        >
          <MessageSquarePlus className="size-3.5 shrink-0" />
          {feedbackCopy.offer}
        </button>
      ) : null}
    </PromptPanel>
  );
}
