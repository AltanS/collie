import { Icon } from "@/components/icons/icon";
import { useEffect, useRef, useState } from "react";

import { ignoreHeldEnter, useArm } from "@/hooks/use-arm";

import { cn } from "@/lib/utils";
import { ARM_MS, ENTER_ARM_MS } from "@/lib/arm";
import { CORE_KEYS, missingCore } from "@/lib/key-board";
import { useKeyBoard } from "@/lib/key-board-store";
import type { IconKey } from "@/components/icons/keys";
import { lineText, type StyledLine, type UnreadDialogModel } from "@/lib/blocks";
import { keyLabel } from "@/lib/key-queue";
import { OptionGroupCaption, PromptPanel } from "@/components/option-button";
import { RawMirror } from "@/components/raw-mirror";
import { DismissButton } from "@/components/terminal-draft-preview";
import { t } from "@/lib/i18n";
import { useLocale } from "@/hooks/use-locale";

export interface UnreadDialogBlockProps {
  /**
   * The screen no grammar read, and the key its harness DECLARED as the way out (.adr/0053). Null for
   * the card a send refusal opened on a screen Collie cannot read (M102 spec 03): it has no declared key.
   */
  cancel: UnreadDialogModel | null;
  /** The whole pane's styled lines — rendered verbatim under the control (see below). */
  lines: StyledLine[];
  /**
   * Injected send handler (from AgentChat). Presentational contract: this component NEVER touches
   * the network — the race guard and the send live in lib/unread-dialog-action.ts's caller.
   */
  onAction: (key: string) => void | Promise<void>;
  /** Read-only device or a gone pane: everything renders (for context) but can't be pressed. */
  disabled?: boolean;
  /** The device's Wrap lines setting, so the whole-pane mirror wraps or pans as the pane mirror
   *  does (#372). Default false: it pans, as RawMirror does. */
  wrap?: boolean;
  /**
   * Opens the Report a problem sheet for this screen (ADR 0123, amendment 2026-10-28). Absent, the
   * card draws no report row (a crew member's pane, which the report route does not read yet). It is
   * a read, so a read-only device keeps it.
   */
  onReport?: () => void;
  /**
   * Called once per card instance for each pane and dialog it shows (M86 spec 05): the trouble signal.
   * A re-render of the same dialog is not a new call. Absent, nothing is called.
   */
  onShown?: () => void;
  /** The pane the card shows, so an instance another pane reuses calls {@link onShown} again. */
  paneId?: string;
  /**
   * Sends core keys through the Keys pad's own road, with its receipt (M102 spec 03): the caps the card
   * draws for a core key the person's board lacks. Absent, the card draws no cap.
   */
  onPadKeys?: (keys: string[]) => Promise<boolean>;
  /** "Send past this screen": opens the composer for one send past this screen (spec 01's override). Absent, no button. */
  onTypeAnyway?: () => void;
  /** The screen asks for a secret (a sign-in field, a password prompt): no "Send past this screen", a pointer to Type mode. */
  secret?: boolean;
  /**
   * The line the card says in place of its own caption: the exit of an answer that cannot go (M102 spec
   * 10) names what happened to the answer. Absent, the card says it cannot read the screen.
   */
  caption?: string;
  /** Closes the card (the exit's cross). Absent, no cross: the screen moving on closes it. */
  onClose?: () => void;
}

/** The pad's own faces for the core keys (nav-tray.tsx): arrows and Enter are glyphs, Esc is its word. */
const CORE_FACE: ReadonlyMap<string, IconKey> = new Map<string, IconKey>([
  ["Enter", "key-enter"],
  ["Up", "key-up"],
  ["Down", "key-down"],
  ["Left", "key-left"],
  ["Right", "key-right"],
]);

// The UNREAD-DIALOG CARD — one declared key over a screen Collie could not read (.adr/0053).
//
// This is the least confident block in the family and it must look it. It claims nothing about the
// screen: no title lifted, no options, no footer parsed. The caption says what is true ("Collie
// cannot read this screen. You can.") and the single button says only the KEY, never what the key does — on
// Muse that key steps back rather than dismisses, so a label promising "cancel" would be a lie on a
// real harness.
//
// The region is the WHOLE pane, mirrored verbatim BY DEFAULT — the screen is the only thing the
// operator has to read when nothing else is understood, so unlike the four cards that fully replace
// their region this one never hides it. Same treatment as menu-block.tsx: React text nodes only, and
// the agent's own terminal colours (MIRROR_SPACE / MIRROR_INVERT, ADR 0002), via the shared
// RawMirror, wrapped or panned by the device's Wrap lines setting like the pane mirror. PromptPanel's
// own Terminal toggle (ADR 0056) still applies on top, for a decluttered view with the key control put
// away, and that view's mirror keeps the same setting.
//
// DESIGN.md §2: the in-flight state recolours the button and changes NOTHING else — no spinner child
// appears, no border is added, no padding moves. The border is reserved in the base string and the
// pending state only repaints it, so the card the operator is reading does not shift under the tap.
// DESIGN.md §6: `min-h-11` is the 44px tap floor, stated as a floor and never a fixed height.
// ARM, THEN SEND (#339). The declared key is sent on the SECOND tap. A screen this card could not
// read may be a question dialog whose Escape ends the whole turn (opencode's `esc dismiss`), and
// the first tap must not be able to do that. The first tap only arms: the button's words change
// (never its size), and it disarms by itself after ARM_MS. The wording names "Dismiss" only when
// the screen's own rows print `esc dismiss`; otherwise it names the key, never a verb.
const NAMES_A_DISMISS = /\besc\s+dismiss\b/i;

export function UnreadDialogBlock({ cancel, lines, onAction, disabled, wrap, onReport, onShown, paneId, onPadKeys, onTypeAnyway, secret = false, caption: said, onClose }: UnreadDialogBlockProps) {
  useLocale();
  const [sending, setSending] = useState(false);
  const locked = disabled || sending;
  // The person's own Keys pad is the key row (M102 spec 03, the picked option "Your Keys pad"): the card
  // draws a cap only for a core key that board lacks, with the pad's face and the key's name. Never a
  // digit, a letter or a word that guesses what the key means here.
  const lost = missingCore(useKeyBoard());
  // The arm belongs to ONE card on ONE pane: its pane and its declared key, never its rows. A screen Collie cannot
  // read moves all the time (a progress bar, a dot cycle, streaming text), the live screen is in view, and the
  // person's own Keys pad carries no rows guard either (the M102 review 2, J). Another pane reusing this instance,
  // or another declared key, is never armed by the old one's tap.
  const identity = `${paneId ?? ""}\n${cancel?.key ?? ""}`;
  const [armedFor, setArmedFor] = useState<string | null>(null);
  const armed = armedFor === identity;
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Enter on this card asks the same second tap as the declared key (the review of 2026-11-16, point
  // 3): the screen may hold a menu whose highlighted default is "Yes", and Enter would confirm it. The
  // arm is `useArm`'s, keyed by the card's identity: a second tap inside ARM_DWELL_MS is the same touch
  // landing twice and keeps the arm, and the arm lasts ENTER_ARM_MS, as the Keys pad's Enter does.
  const enterArm = useArm<string>(ENTER_ARM_MS);
  const enterArmed = enterArm.armed === identity;
  const disarmEnter = enterArm.disarm;
  const caption = said ?? t("unreadDialog.caption");
  const dismissWording = lines.some((l) => NAMES_A_DISMISS.test(lineText(l)));

  useEffect(() => () => clearTimeout(timer.current), []);
  // The trouble signal (M86 spec 05): once per instance for each pane and card, the same identity the arm keys
  // on. A poll that re-renders the card, with any rows, calls nothing.
  const shownKey = identity;
  const shownFor = useRef<string | null>(null);
  useEffect(() => {
    if (onShown === undefined || shownFor.current === shownKey) return;
    shownFor.current = shownKey;
    onShown();
  }, [shownKey, onShown]);
  // A card that stops being pressable (read-only device, gone pane) also stops being armed.
  useEffect(() => {
    if (!disabled) return;
    clearTimeout(timer.current);
    setArmedFor(null);
    disarmEnter();
  }, [disabled, disarmEnter]);

  function pressCap(step: string) {
    if (disabled || onPadKeys === undefined) return;
    if (step === "Enter") {
      // "armed" and "dwell" both send nothing; only a second tap after the dwell presses Enter.
      if (enterArm.tap(identity) !== "fire") return;
      void onPadKeys([step]);
      return;
    }
    disarmEnter();
    void onPadKeys([step]);
  }

  async function press() {
    if (locked || cancel === null) return;
    if (!armed) {
      setArmedFor(identity);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setArmedFor(null), ARM_MS);
      return;
    }
    clearTimeout(timer.current);
    setArmedFor(null);
    setSending(true);
    try {
      await onAction(cancel.key);
    } finally {
      setSending(false);
    }
  }

  const armedLabel = dismissWording
    ? t("unreadDialog.confirmDismiss")
    : t("unreadDialog.confirmKey", { key: cancel === null ? "" : keyLabel(cancel.key) });
  const capsShown = onPadKeys !== undefined && lost.length > 0;
  const enterArmedLabel = t("unreadDialog.confirmKey", { key: keyLabel("Enter") });
  const spoken = armed ? armedLabel : enterArmed ? enterArmedLabel : "";

  return (
    // rawMode (ADR 0056 counsel fix): this card always shows the mirror by default (below), so
    // its control only puts the button away — never a swap from nothing.
    <PromptPanel ariaLabel={caption} raw={lines} rawMode="declutter" wrap={wrap}>
      {onClose === undefined ? (
        <OptionGroupCaption>{caption}</OptionGroupCaption>
      ) : (
        <div className="flex items-center justify-between gap-2">
          <OptionGroupCaption>{caption}</OptionGroupCaption>
          <DismissButton onDismiss={onClose} label={t("answerExit.closeAria")} />
        </div>
      )}

      <div role="group" aria-label={t("unreadDialog.keysAria")} className="flex flex-wrap items-center gap-1">
        {cancel !== null && (
          <button
            type="button"
            disabled={locked}
            aria-busy={sending}
            onClick={press}
            className={cn(
              "font-content flex min-h-11 min-w-0 flex-auto items-center justify-center rounded-lg border px-3 py-2 text-sm font-medium text-foreground transition-colors disabled:opacity-60",
              sending || armed
                ? "border-primary bg-primary/25"
                : "border-primary/60 bg-primary/15 active:bg-primary/25",
            )}
          >
            {armed ? armedLabel : keyLabel(cancel.key)}
          </button>
        )}
        {/* A cap only for a core key the person's board lacks, so Esc, Enter and the arrows are always
            one tap away. Its tap goes through the Keys pad's road, with its receipt; nothing retries. */}
        {capsShown &&
          lost.map((name) => {
            const step = CORE_KEYS.find((core) => core.name === name)?.step ?? name;
            const face = CORE_FACE.get(name);
            const capArmed = step === "Enter" && enterArmed;
            return (
              <button
                key={name}
                type="button"
                data-slot="unread-dialog-cap"
                disabled={disabled}
                aria-label={capArmed ? enterArmedLabel : name}
                onClick={() => pressCap(step)}
                onKeyDown={step === "Enter" ? ignoreHeldEnter : undefined}
                className={cn(
                  "flex h-11 shrink-0 items-center justify-center rounded-md border font-mono text-xs text-foreground disabled:opacity-60",
                  capArmed ? "min-w-12 border-primary bg-primary/25 px-2" : "w-12 border-border bg-muted/40 active:bg-muted",
                )}
              >
                {capArmed ? (
                  <span className="font-content truncate">{enterArmedLabel}</span>
                ) : face === undefined ? (
                  keyLabel(step)
                ) : (
                  <Icon name={face} className="size-4" aria-hidden="true" />
                )}
              </button>
            );
          })}
        {onTypeAnyway !== undefined && !secret && (
          <button
            type="button"
            data-slot="unread-dialog-type-anyway"
            disabled={disabled}
            onClick={onTypeAnyway}
            className="inline-flex h-11 min-w-0 flex-auto items-center justify-center gap-1.5 rounded-lg border border-border bg-secondary px-3 text-sm font-medium text-secondary-foreground disabled:opacity-60"
          >
            <Icon name="direct-typing" className="size-4" aria-hidden="true" />
            <span className="truncate">{t("unreadDialog.typeAnyway")}</span>
          </button>
        )}
      </div>
      {/* Hard stop 6b: a screen that asks for a secret gets no "Send past this screen"; Type mode is the way. */}
      {secret && <p className="text-xs text-muted-foreground">{t("unreadDialog.secret")}</p>}
      {/* A live region on the button itself is unreliable; this one announces the armed wording. */}
      <span role="status" className="sr-only">
        {spoken}
      </span>
      {/* Report a problem: a quiet row under the key, always there when offered, so nothing moves.
          It only opens the sheet; nothing leaves the phone without the person's own taps there. */}
      {onReport !== undefined && (
        <button
          type="button"
          data-slot="unread-dialog-report"
          onClick={onReport}
          className="inline-flex min-h-11 w-full items-center justify-center gap-1.5 text-xs text-muted-foreground underline underline-offset-2"
        >
          <Icon name="report-problem" className="size-3.5" />
          {t("unreadDialog.report")}
        </button>
      )}

      {/* The mirror is its own scroller, capped, and opens at its bottom: the dialog is the LAST rows of
          the pane, and the old rows above it are what a top-anchored box showed (#667). Capped here so
          the key button above it stays on the screen instead of scrolling away with the dock. */}
      <RawMirror
        lines={lines}
        wrap={wrap}
        anchor="bottom"
        className="max-h-[30dvh] overflow-y-auto overscroll-contain"
      />
    </PromptPanel>
  );
}
