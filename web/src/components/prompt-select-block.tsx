import { useEffect, useRef, useState } from "react";
import { Loader2, MessageSquarePlus } from "lucide-react";

import type { PromptFamily, PromptFeedbackPurpose, PromptModel, PromptOption } from "@/lib/blocks";
import { FEEDBACK_MAX_LENGTH } from "@/lib/prompt-action";
import { OptionButton, OptionGroupCaption, PromptPanel } from "@/components/option-button";

/** What a tap on this block asks for: an option's keystroke plan, or feedback typed on the phone. */
export type PromptBlockAction =
  | { kind: "option"; option: PromptOption }
  | { kind: "feedback"; text: string };

export interface PromptSelectBlockProps {
  /** The detected dialog: question (screen-reader label) + selectable options as buttons. */
  prompt: PromptModel;
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

// Family-aware caption above the options — orients the reader ("the terminal is asking you
// something") without repeating the question, which stays in the raw scrollback just above.
const FAMILY_CAPTION = {
  select: "Choose an option",
  permission: "Permission required",
  trust: "Trust this folder?",
  plan: "Review the plan",
} satisfies Record<PromptFamily, string>;

// Copy is purpose-aware: Claude's plan-approval input is deny-with-feedback; Grok's `z` row is
// a custom answer. Missing purpose is Claude (the only row submitPromptFeedback will type into).
const FEEDBACK_COPY = {
  "plan-change": {
    offer: "Tell Claude what to change",
    editorLabel: "What should Claude change?",
    placeholder: "Say what to do differently…",
    help: "Sends the plan back with your notes — Claude keeps planning instead of starting work.",
    send: "Send feedback",
    sending: "Sending feedback…",
    focused:
      "The feedback box has the keyboard in the terminal — these buttons would type into it instead of answering. They resume when it closes.",
    typedPrefix: "Feedback is being written in the terminal: ",
  },
  "free-text": {
    // No phone composer: the Claude plan-feedback send path is the wrong recipe for this row.
    offer: null,
    editorLabel: "",
    placeholder: "",
    help: "",
    send: "",
    sending: "",
    focused:
      "The free-text row has the keyboard in the terminal — these buttons would type into it instead of answering. They resume when it closes.",
    typedPrefix: "A custom answer is being written in the terminal: ",
  },
} satisfies Record<
  PromptFeedbackPurpose,
  {
    offer: string | null;
    editorLabel: string;
    placeholder: string;
    help: string;
    send: string;
    sending: string;
    focused: string;
    typedPrefix: string;
  }
>;

// Native, tappable rendering of a Claude single-choice dialog. Every visible string — the option
// label and its description — is a React text node (the XSS boundary is unchanged; nothing is ever
// set as innerHTML). Real <button>s, so they're keyboard-focusable and screen-reader-announced; the
// group is labelled by the question (which stays visible in the raw scrollback just above, so it's
// not repeated here). Each row leads with its terminal-menu digit (KeyBadge) so the mapping is
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
export function PromptSelectBlock({ prompt, onAction, disabled }: PromptSelectBlockProps) {
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
    ? FEEDBACK_COPY[feedback.purpose === "free-text" ? "free-text" : "plan-change"]
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
    <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" aria-label="Sending" />
  );

  return (
    <PromptPanel ariaLabel={prompt.question}>
      <OptionGroupCaption>{FAMILY_CAPTION[prompt.family]}</OptionGroupCaption>
      <div className="flex flex-col gap-1">
        {prompt.options.map((option, index) => {
          const id = `opt-${index}`;
          const busy = sending === id;
          return (
            <OptionButton
              key={index}
              tone={busy ? "busy" : "default"}
              keyLabel={option.keyLabel ?? option.keys[0]}
              label={option.label}
              description={option.description}
              disabled={locked}
              onClick={() => press(id, { kind: "option", option })}
              trailing={
                busy ? (
                  <Loader2
                    className="mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground"
                    aria-label="Sending"
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
          {feedback.text ? <span className="text-muted-foreground"> ({feedback.text})</span> : null}
        </div>
      ) : feedback && feedbackCopy && feedback.text !== "" ? (
        <div className="flex items-start gap-2 rounded-lg border border-border/60 bg-muted/30 px-3 py-2">
          <MessageSquarePlus
            className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
            aria-label="Feedback in the terminal"
          />
          <span className="min-w-0 flex-1 text-xs text-foreground/90">
            {feedbackCopy.typedPrefix}
            {feedback.text}
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
            aria-label="Feedback text"
            placeholder={feedbackCopy.placeholder}
            className="w-full resize-none rounded-md border border-border/60 bg-background px-2 py-1.5 text-sm text-foreground outline-none focus:border-primary/60"
          />
          <p className="text-[11px] leading-snug text-muted-foreground">{feedbackCopy.help}</p>
          <div className="flex items-center justify-end gap-1.5">
            <button
              type="button"
              disabled={sending !== null}
              onClick={() => setEditorOpen(false)}
              className="rounded-md px-2.5 py-1.5 text-xs text-muted-foreground transition-colors active:bg-muted disabled:opacity-60"
            >
              Cancel
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
