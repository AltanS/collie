// The terminal-draft preview (ADR 0061), a port of web/src/components/terminal-draft-preview.tsx and
// web/src/hooks/use-terminal-draft.ts.
//
// A read-only notice for a draft stranded on the terminal's input line (a message queued then recalled
// on the HOST, which `stripChrome` hides from the mirror). The phone's composer is exclusively
// phone-owned: a host draft is NEVER written into it implicitly. It is surfaced here and the operator
// deliberately takes over (copies it into the composer), so the two live input surfaces never fight.
// Its text tracks the live line, so watching the host type streams into this block; nothing here feeds
// back into the phone's field.
//
// IT FLOATS (ADR 0061). It used to be an in-flow strip, so every host keystroke that stranded or
// cleared a draft grew and shrank the footer and moved the belt, the field and the mirror's tail. The
// caller draws it over the bottom edge of the mirror, out of the layout, as a translucent card that
// covers terminal text and moves nothing. That is why it has no `Collapse`: nothing in flow changes
// size. The caller owns the wrapper (`pointer-events-none`, `data-slot="terminal-draft-notice"`).
import { on, type Handle } from "remix/component";
import { Terminal, X } from "lucide";

import { t } from "@web/lib/i18n";

import { useLocale } from "../lib/i18n-store";
import { createStore, type Store } from "../lib/store";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";

// A terminal draft must sit on the input line this long before it is surfaced. One snapshot flash is
// never actionable, and the flash that bit us is the composer's OWN in-flight reply: the bridge types
// the text, waits ~350 ms, then presses Enter, so for a poll or two the just-typed text sits alone on
// the input line, shape-identical to a stranded draft. At the hot poll cadence (1.5 s or less) this
// means the same text was seen across at least two polls; a genuinely stranded draft persists across
// turns, so it still surfaces, a beat later.
const STABLE_MIN_AGE_MS = 1_500;

/**
 * Normalise a draft or reply for the "is this my own in-flight reply?" comparison, the stability key
 * below, and the composer's per-draft "handled" bookkeeping: trim, and collapse whitespace runs, since
 * the mirror can pad or re-flow spacing on the input line (and a wrapped draft is folded to one
 * space-joined line upstream). Port of web/src/hooks/use-terminal-draft.ts `normalizeDraft`.
 */
export function normalizeDraft(s: string): string {
  return s.trim().replace(/\s+/g, " ");
}

/**
 * True when a terminal draft is (robustly) the same text the composer just sent: our own reply still
 * echoing on the input line before the bridge's pending Enter lands, not a stranded draft. Matches
 * exactly after normalisation, or when the mirror's copy is a truncated head of what we sent (a long
 * reply gets an ellipsis on the input line), guarded by a minimum length so a stray short prefix cannot
 * false-match. `carriesSend` is the pane adapter's `draftCarriesSend`, threaded in by the caller so
 * this module stays harness-neutral: it covers a harness that collapses a long send into its own token
 * (Claude's `[Pasted text #N +M lines]`), which shares no characters with what was sent.
 */
export function isSelfEcho(
  draft: string,
  sent: string,
  carriesSend?: (sent: string, draft: string) => boolean,
): boolean {
  const d = normalizeDraft(draft);
  const s = normalizeDraft(sent);
  if (d === s) return true;
  const [shorter, longer] = d.length <= s.length ? [d, s] : [s, d];
  const head = shorter.replace(/[….]+$/, "").trimEnd();
  if (head.length >= 8 && longer.startsWith(head)) return true;
  return carriesSend?.(sent, draft) ?? false;
}

/** The two timer doors, so a test can drive the 1.5 s without waiting. */
export interface DraftTimers {
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
}

const windowTimers: DraftTimers = {
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (id) => window.clearTimeout(id),
};

/**
 * Debounce the raw per-snapshot terminal draft (`extractInputDraft`) into one that only becomes
 * non-null once the SAME text has stayed on the input line continuously for 1.5 s. Feed it the raw
 * draft on every poll with `set(raw)`; read `value`. `extractInputDraft` is stateless per snapshot
 * (by design: it is a pure parse), so this is the cross-poll memory that tells a stranded draft from a
 * transient one: a changed draft resets the clock, and a cleared line (null) drops it at once.
 *
 * Stability is keyed on the NORMALISED draft, not the raw string: the mirror can re-flow spacing, pad
 * a trailing space or blink a cursor between polls, and if every such wobble reset the clock the
 * preview would never promote for a draft the operator is staring at. Only a real edit restarts the
 * timer. What `value` surfaces is the LATEST raw text at the moment of promotion; the normalisation
 * governs the timer, not what is displayed. The timer ends on `signal`.
 */
export interface StableDraft {
  /** Feed the raw draft (or null) on every poll. */
  set(raw: string | null): void;
  /** Null until the same text has held for 1.5 s. */
  value: Store<string | null>;
}

export function createStableDraft(signal: AbortSignal, timers: DraftTimers = windowTimers): StableDraft {
  const value = createStore<string | null>(null);
  let key: string | null = null;
  let latest: string | null = null;
  let timer: number | null = null;
  const stop = (): void => {
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
  };
  signal.addEventListener("abort", stop, { once: true });
  return {
    value,
    set(raw) {
      if (signal.aborted) return;
      latest = raw;
      const nextKey = raw === null ? null : normalizeDraft(raw);
      // Unchanged key: the running timer keeps ticking and fires once the text has genuinely persisted.
      if (nextKey === key) return;
      key = nextKey;
      stop();
      if (nextKey === null) {
        value.set(null);
        return;
      }
      // A draft that just appeared or changed is not actionable yet: keep what was already promoted
      // only if it still normalises to the same key, otherwise blank it until it proves it is still
      // there after the delay.
      value.update((prev) => (prev !== null && normalizeDraft(prev) === nextKey ? prev : null));
      timer = timers.setTimeout(() => {
        timer = null;
        value.set(latest);
      }, STABLE_MIN_AGE_MS);
    },
  };
}

export interface TerminalDraftPreviewProps {
  /**
   * The live host draft, the RAW per-poll line, so host typing streams in. Display-only: this
   * component never writes into the composer. Read in render.
   */
  text: string;
  /**
   * Deliberate takeover: copy the current draft into the phone-owned composer and hide the preview.
   * `null` withdraws the affordance (absent, not greyed): the line holds the harness's OWN opaque token
   * rather than the user's words (Claude collapses a long paste into `[Pasted text #N +M lines]`), and
   * copying that would make the literal string the message. The preview still shows it. Called with
   * `adapter.draftIsOpaque?.(text) ? null : takeOver`. Read at tap time.
   */
  onTakeOver: (() => void) | null;
  /** The x: hide the notice until this draft is gone. The composer owns the lifetime. Read at tap time. */
  onDismiss: () => void;
}

/**
 * The 44px floor for the x, bought back as hit area (DESIGN.md §6): the face is `size-6`, 24px, and
 * `-inset-2.5` reaches 10px out on every side, so 24 + 20 = 44 in both axes.
 */
const DISMISS_TAP_TARGET = "relative before:absolute before:-inset-2.5 before:content-['']";

export function TerminalDraftPreview(handle: Handle<TerminalDraftPreviewProps>) {
  useLocale(handle);
  return () => {
    const { text, onTakeOver } = handle.props;
    return (
      <div
        data-testid="terminal-draft-preview"
        class="pointer-events-auto flex items-start gap-1.5 rounded-lg border border-foreground/20 bg-card/95 py-1.5 pr-1.5 pl-2.5 text-xs text-muted-foreground shadow-md backdrop-blur-sm"
      >
        <Icon icon={Terminal} class="mt-0.5 size-3 shrink-0" />
        <div class="min-w-0 flex-1">
          <div class="font-medium">{t("composer.draftPreview.title")}</div>
          <div class="mt-0.5 line-clamp-2 whitespace-pre-wrap break-words font-mono text-[11px] leading-snug text-muted-foreground/90">
            {text}
          </div>
        </div>
        {onTakeOver !== null ? (
          <Button
            variant="ghost"
            size="sm"
            data-testid="terminal-draft-take-over"
            class="h-6 shrink-0 self-center px-2 text-xs font-medium"
            mix={on("click", () => handle.props.onTakeOver?.())}
          >
            {t("composer.draftPreview.takeOver")}
          </Button>
        ) : null}
        <button
          type="button"
          data-testid="terminal-draft-dismiss"
          aria-label={t("composer.draftPreview.dismissAria")}
          mix={on("click", () => handle.props.onDismiss())}
          class={`${DISMISS_TAP_TARGET} grid size-6 shrink-0 self-center place-items-center rounded-full text-muted-foreground transition-colors active:bg-muted/60`}
        >
          <Icon icon={X} class="size-3.5" />
        </button>
      </div>
    );
  };
}
