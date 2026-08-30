import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { ChangeEvent, ClipboardEvent, ReactNode } from "react";
import { useRevalidator } from "react-router";
import { Check, ImagePlus, Keyboard, Loader2, Mic, Send, Settings2, Slash, Square, Terminal, X, Zap } from "lucide-react";

import type { DisplayPrefs } from "@/hooks/use-display-prefs";
import type { AgentStatus } from "@/lib/types";
import { usePendingConfirm } from "@/hooks/use-pending-confirm";
import { useDirectTyping } from "@/hooks/use-direct-typing";
import { useLocale } from "@/hooks/use-locale";
import { t as translate, tn as translatePlural } from "@/lib/i18n";
import { setStatus } from "@/lib/status";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ChatInput } from "@/components/ui/chat/chat-input";
import { NavTray } from "@/components/nav-tray";
import { CommandPalette } from "@/components/command-palette";
import { QuickActionsContent } from "@/components/quick-actions";
import { DisplayPrefsContent } from "@/components/display-prefs";
import { SectionLabel } from "@/components/ui/section-label";
import * as api from "@/lib/api";
import { describeApiError, describeThrownError } from "@/lib/api-error-message";
import { commandsFor } from "@/lib/agent-commands";
import { useMuxCapability, useMuxUnsupportedKeys } from "@/lib/mux-capability";
import { useOperatorCommands, useOperatorKeys } from "@/lib/operator-config";
import { ctrlPresetsFor } from "@/lib/operator-keys";
import { isDestructiveInput } from "@/lib/destructive";
import { HostChip } from "@/components/host-chip";
import { StatusWordSlot } from "@/components/status-badge";
import { useAmbientHost, useHostLabel } from "@/components/pack-provider";
import { clearDraft, fitsDraftStore, loadDraft, saveDraft } from "@/lib/drafts";
import { useHoldReload } from "@/lib/reload-guard";
import { isSelfEcho, normalizeDraft } from "@/hooks/use-terminal-draft";
import { adapterFor } from "@/lib/harness";
import { sendGuardedReply } from "@/lib/reply-action";
import { TerminalDraftPreview } from "@/components/terminal-draft-preview";
import { scopeKey, type Scope } from "@/lib/scope";
import { DirectTypingStrip } from "@/components/direct-typing-strip";
import { RecordingStrip } from "@/components/recording-strip";
import { useSttRecorder } from "@/hooks/use-stt-recorder";
import { useHandsFree, useSttCapability } from "@/lib/stt";
import { NoEchoNotice } from "@/components/no-echo-notice";

export interface ComposerHandle {
  /** Focus the input and put the caret at the end — used by the mirror-tap-to-focus in AgentChat. */
  focusInput: () => void;
}

interface ComposerProps {
  paneId: string;
  /** Which machine + which named session the pane lives in — scopes every write to the right Herdr. */
  scope?: Scope;
  /** The pane's agent name — drives the slash-command palette and the reply-vs-shell placeholder. */
  agent: string | undefined | null;
  /** True for a bare shell pane (tweaks the placeholder copy, and is its own status word). */
  isShell: boolean;
  /**
   * What the pane is DOING, as the word on the status strip above the controls row. Undefined only
   * when there is no pane left to describe (`gone`), where the strip stands empty.
   *
   * It lives here rather than in the pane header because that is where the operator's question is:
   * the header's caption line held this one word and nothing else, so the top of a 60px row was
   * spent on it. Beside the host it completes a sentence — which machine, and what is it doing —
   * at the surface being typed into. The header keeps the DOT badged on the agent's own tile; the
   * word is the half of that pair a colour-blind reader can use (status-badge.tsx measures why),
   * so it moved rather than went.
   */
  status?: AgentStatus;
  /** The reading is the last snapshot's, not live — dims the word exactly as the header's dot dims. */
  stale?: boolean;
  /** Pane is gone (no agent) — locks the composer with a distinct placeholder. */
  gone: boolean;
  /** This device isn't authorised to type — locks the composer with a distinct placeholder. */
  readOnly: boolean;
  /**
   * The pane's MACHINE is not reachable from the lead, so a write would be refused before it left
   * the lead (PACK_PROTOCOL.md §10.3) — the refusal text, naming the host, or undefined when writes
   * may proceed. Always undefined on a solo install, so nothing here changes for one machine.
   *
   * Locks the composer exactly as `readOnly` does. It is NOT folded into `readOnly` by the caller
   * because the two say different things and the operator's next move differs: one is "this device
   * will never be allowed to type", the other is "this machine is quiet, wait for the next poll".
   */
  hostBlock?: string;
  /** A dialog (prompt/wizard/preview/multi-select) is on screen, so the TUI's keyboard belongs to it.
   * Free-text sending is refused while true — see send(). Answer it with its own buttons instead. */
  dialogPresent: boolean;
  /** Latest pane text — clears the pending-send preview once the mirror echoes the send back. */
  text: string;
  /** A user draft stranded on the terminal's "❯" input line (extractInputDraft), STABILISED across
   * polls (useStableTerminalDraft) — non-null only once the same text has held for ~1.5s. Gates the
   * APPEARANCE of the read-only draft preview, so a one-poll blip or an in-flight send never flashes it. */
  terminalDraft: string | null;
  /** The SAME draft, but the RAW per-poll value (pre-stabilisation). Once the preview is showing, its
   * text tracks this live so host typing streams into it; it also drives the send()-time pre-clear (the
   * actual current "❯" line) and unmounts the preview when it goes null. Never written into the input. */
  rawTerminalDraft: string | null;
  /** Mirror display prefs — the View row lives here, but the mirror (in AgentChat) reads the same
   * single instance, so they're threaded through rather than each calling useDisplayPrefs. */
  prefs: DisplayPrefs;
  setWrap: (wrap: boolean) => void;
  stepFontSize: (delta: number) => void;
  setRawTerminal: (raw: boolean) => void;
  setTapToFocus: (tapToFocus: boolean) => void;
  /** Snap the mirror to the live tail (follow + revalidate + scroll) after a successful send. */
  onSent: () => void;
}

// The composer cluster at the bottom of the pane view — everything a phone keyboard can't do on its
// own: quick actions, an agent-aware slash-command palette, an inline key tray (via
// `pane.send_keys`), image upload, display prefs, and the reply Send (with a destructive-command
// two-tap guard). Its state (draft, sending, upload, pending preview, its own Keys/Quick/Agent
// sheets) is entirely local; it reaches AgentChat only through `onSent` (to re-follow the tail) and
// exposes `focusInput` so the mirror tap can bring up the keyboard.
//
// "display" joined the drawer union when the permanent icon-only View row was retired: wrap / raw
// terminal / font size are settings you touch once, so they cost a whole row of a phone viewport for
// nothing, and the raw-terminal toggle in particular was an unlabelled `>_` glyph nobody could
// decode. They now live behind the ⚙ on the single Controls row, as labelled rows in the same
// in-flow dock (they change how the mirror LOOKS, so the mirror has to stay visible while you flip
// them). Find moved the other way — to the header, where its find bar already takes over the row.
type ComposerDrawer = "quick" | "cmd" | "keys" | "display" | null;

// The Controls row's "on" look, authored once so an open dock and an armed mode can never drift
// apart. `hover:` is pinned to the same tint: without it, hovering an already-on control repaints it
// with the ghost variant's hover background and it reads as switching off under the cursor.
const CONTROL_ON = "bg-control-on text-control-on-foreground hover:bg-control-on";
const CONTROL_OFF = "text-muted-foreground";

// The box every LABELLED control on that row wears. Authored once because the row's whole defect was
// per-button drift in a fixed width: four buttons sized by their own text, in a container that is
// 366px on a 390px phone and cannot grow.
//
// `shrink` is the load-bearing word. `ui/button.tsx`'s base string carries `shrink-0`, so `flex-1`
// (which does set flex-shrink:1, in a shorthand) lost to the longhand and every button sat at its
// CONTENT width. Measured on the pane screen at 390px: the row's scrollWidth ran 18px past its
// clientWidth in English and 70px past in Japanese, and the overflow-x-hidden ancestor on the pane
// column cut the ⚙ in half rather than letting it scroll — the control was not reachable at all.
// Restoring flex-shrink, plus `min-w-0` to lift the flex item's min-content floor, plus `truncate`
// on the label span (below) makes the row structurally incapable of exceeding its container: the
// worst case is now an ellipsis on the longest word, not a missing button.
//
// `h-11` is 44px — the tap target the row never actually had (it was `h-8`/32px). It costs the
// composer 12px of height, and that is the trade: a control you can hit beats a control that only
// looks tidy.
//
// The icon sits ABOVE the word (`flex-col`) rather than beside it, and that is a MEASUREMENT, not a
// taste. Side by side, a 74.5px button spends 16px on the icon and its gap before the first letter,
// which leaves ~38px of text — and four of the six shipped locales ellipsised at 390px, CJK worst
// (`エージェント` is six full-width glyphs). Stacked, the word gets the button's whole width and a
// 10px size, so all six draw in full at 390px and only ja's longest ellipsises at 320px. A fix that
// only reads in English is not a fix.
const CONTROL_BUTTON =
  "h-11 min-w-0 flex-1 shrink flex-col gap-0.5 px-1 has-[>svg]:px-1 text-[10px] font-medium leading-none [&>svg]:shrink-0";
// The label inside that box. `truncate` needs a box of its own to clip against — a bare text node
// in a flex button has none — and `max-w-full` is what keeps that box from simply being the text's
// own width.
const CONTROL_LABEL = "max-w-full truncate";

// Pause after clearing a stranded terminal draft so the TUI settles before pane.send_text.
const TUI_SETTLE_MS = 350;

// Grace window after a send during which a terminal draft matching what we just sent is treated as
// our own in-flight reply (still on the "❯" line before the bridge's pending Enter lands), NOT a
// stranded draft. Wide enough to cover a slow tailnet round-trip; the parent's cross-poll
// stabilisation (useStableTerminalDraft) closes the other half of the same window.
const SENT_ECHO_GRACE_MS = 5_000;

// Burst window for post-keypress revalidation (see scheduleKeyRevalidate).
const KEY_REVALIDATE_MS = 300;

// Shared in-flow dock chrome for Keys/Quick — an IN-FLOW panel (never an overlay), so the terminal
// mirror's flex-1 box shrinks and its tail stays visible while the dock is open (a covering sheet
// hid exactly the prompt you were driving). Full-bleed top border + capped height keep the mirror
// usable on a phone. The header (title + Close X) is a NON-scrolling child of a flex column; only the
// body below it scrolls (max-h + overflow), so the Close X can never scroll out of reach on a short
// viewport with a tall tray. One wrapper so Keys and Quick can't drift apart.
function ComposerDock({
  title,
  host,
  onClose,
  children,
}: {
  title: string;
  /** The machine a key sent from this dock lands on. Renders nothing on a single-host install. */
  host?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div className="-mx-3 mb-2 flex flex-col border-t border-border bg-background">
      <div className="flex items-center justify-between px-3 pt-2">
        <div className="flex min-w-0 items-center gap-2">
          <SectionLabel>{title}</SectionLabel>
          {/* A key press from the Keys dock IS a write into a terminal — the dock names which one. */}
          <HostChip host={host} variant="target" />
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 text-muted-foreground"
          onClick={onClose}
          aria-label={translate("composer.dock.closeAria", { title })}
        >
          <X className="size-4" />
        </Button>
      </div>
      <div className="max-h-[45dvh] min-h-0 overflow-y-auto">{children}</div>
    </div>
  );
}

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(
  { paneId, scope, agent, isShell, status, stale, gone, readOnly, hostBlock, dialogPresent, text, terminalDraft, rawTerminalDraft, prefs, setWrap, stepFontSize, setRawTerminal, setTapToFocus, onSent },
  ref,
) {
  const revalidator = useRevalidator();
  useLocale();
  // Every write affordance is off when the pane is gone, this device is read-only, OR the pane's
  // machine is unreachable from the lead. All three are "the write cannot land"; only the copy below
  // differs, because only the copy tells you what to do about it.
  // …plus a fourth: the multiplexer underneath cannot type into a pane at all (M10/06). It is a
  // FOURTH reason, ANDed in rather than folded into any of the three, because capability gating
  // composes with the app's locks and never substitutes for one — a pane that is gone stays gone
  // however capable the multiplexer is, and vice versa.
  //
  // Two capabilities, one lock: a reply is `typeText` then `sendKeys` (bridge/mux/capabilities.ts),
  // and half a reply is not a feature. `typeText`'s reason is preferred when both are missing —
  // it is the half that fails first.
  const canType = useMuxCapability("typeText");
  const canSendKeys = useMuxCapability("sendKeys");
  const missingSend = !canType.capable ? canType : !canSendKeys.capable ? canSendKeys : null;
  const locked = gone || readOnly || hostBlock !== undefined || missingSend !== null;
  // The machine every write on this row lands on. The pane view addresses one host (the pane's own,
  // carried in `?h=` since the row was opened), so the ambient scope IS the target here. Undefined on
  // a solo install, which renders no chip and leaves every confirm string unchanged.
  const writeHost = useAmbientHost(scope?.host);
  // The word for the status strip. A bare shell has no agent and therefore no agent status, but it
  // still owes the strip a word or a solo install's strip would be empty; a GONE pane has nothing
  // left to describe, and the strip stands empty rather than reporting a stale state as current.
  const statusWord: AgentStatus | "shell" | undefined = isShell ? "shell" : status;
  // Its display name, or undefined when there is no pack — the copy-level half of the hide rule.
  const writeHostLabel = useHostLabel(scope?.host);
  // …and a ref alongside it, for the ONE caller that reads it after an await. `send()` checks
  // `locked` once, up front, but its pre-clear sweep goes out on the far side of the pre-flight's
  // pane read; a re-render that locks the composer in that window must be able to stop the most
  // destructive keys this component sends. Every other write affordance is either disabled by React
  // or funnelled through `pressKeys`, which is synchronous with its own check.
  const lockedRef = useRef(locked);
  lockedRef.current = locked;

  // The phone-owned draft, restored from (and written through to) the per-pane draft store — the
  // pane view is keyed by paneId, so without this, stepping over to another tab mid-reply ate the
  // message. Lazy initialiser so the restore happens on the mount, before first paint.
  const [input, setInput] = useState(() => loadDraft(scope, paneId) ?? "");
  // Mirror of `input` for the write-through path: updateInput needs the previous value to apply a
  // functional update AND to persist the result, without either reading stale state or doing the
  // save inside a (double-invoked) state updater.
  const inputValueRef = useRef(input);
  // Which pane the current `input` belongs to. DetailRoute keys AgentChat by paneId, so in the app a
  // pane→pane navigation remounts this component and the lazy initialiser above does the work — but
  // the component must not depend on that: if it is ever rendered with a changed paneId/session in
  // place, the effect below saves the outgoing pane's draft and loads the incoming one, so pane A's
  // text can never surface in pane B.
  // Compared by VALUE (its cache key), never by object identity: a scope is a value passed as an
  // object, and an identity compare here would re-run the save/restore below on every poll.
  const scopeId = scopeKey(scope);
  const draftPaneRef = useRef({ scope, scopeId, paneId });

  /**
   * Set the draft AND persist it. Every write to `input` goes through here — an empty value removes
   * the stored key, so the deliberate-clear paths (verified send, user emptying the box) need no
   * special case.
   *
   * PERSISTENCE STOPS while a password prompt is on screen (#103). By the time the notice appears the
   * secret is already in the 48h store — the write-through ran on every keystroke, before any send was
   * attempted — so `noEchoRef` gates the save AND the pane-leave save below, and the outcome that sets
   * it removes the stored copy outright. The button was never enough: the operator who taps Send,
   * gives up and walks to a laptop (which is exactly what #103 reports doing, for three days) never
   * presses anything, and the pane-leave path would have re-saved it on the way out.
   *
   * Gating on a REF, not the state, because the two must change in the same tick as the outcome that
   * decides it — a render behind is a render in which the next keystroke is still being stored.
   * The in-memory draft is untouched: a false positive costs one draft its ability to survive the OS
   * killing the PWA, which is a cheap price for never storing a real one.
   */
  function updateInput(value: string) {
    inputValueRef.current = value;
    setInput(value);
    if (noEchoRef.current !== null) return;
    saveDraft(scope, paneId, value);
  }

  /** {@link updateInput} for the appenders, which need the current value to build the next one.
   *  Split from it rather than overloaded on the argument: the two callers are different shapes,
   *  and the ref — not React state — is what carries "the current value" here. */
  function updateInputFrom(next: (prev: string) => string) {
    updateInput(next(inputValueRef.current));
  }

  useEffect(() => {
    const prev = draftPaneRef.current;
    if (prev.paneId === paneId && prev.scopeId === scopeId) return;
    if (noEchoRef.current === null) saveDraft(prev.scope, prev.paneId, inputValueRef.current);
    draftPaneRef.current = { scope, scopeId, paneId };
    const restored = loadDraft(scope, paneId) ?? "";
    inputValueRef.current = restored;
    setInput(restored);
    noticeNoEchoRef.current(null); // it described the pane we just left
  }, [scope, scopeId, paneId]);
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  // Pending-send preview: set on a successful send, cleared when the mirror catches up (next text
  // update) or after a 6s safety timeout. Shows "You sent: …" so the user knows the message landed.
  const [lastSent, setLastSent] = useState<string | null>(null);
  const [justSent, setJustSent] = useState(false); // brief ✓ on the send button after a send
  // Terminal-draft preview bookkeeping. The composer input is EXCLUSIVELY phone-owned — a host draft
  // is never written into it implicitly; it only surfaces in a read-only preview the user can
  // deliberately Take over. There is no user-facing dismiss — the preview is honest state (a draft
  // really is stranded on the host's line), so it stays visible until the host line clears, the user
  // takes it over, or the user sends. `handledKey` is the NORMALISED text the user has handled (took
  // over or sent) — the preview stays hidden while the live draft still normalises to it, so it can't
  // re-latch onto the same text we just copied/sent (the raw line still holds it until the host clears
  // or Enter lands); a genuinely different draft is fair game again. `previewLatched` is the show/hide
  // latch: a STABLE draft flips it on (gating appearance behind the 1.5s stability), and it stays on —
  // its text tracking the RAW draft live — until the host line clears or the user acts (see the effects
  // below).
  const [handledKey, setHandledKey] = useState<string | null>(null);
  const [previewLatched, setPreviewLatched] = useState(false);
  // Composer sheets are mutually exclusive — at most one open (Keys / Quick / Agent / Display).
  const [drawer, setDrawer] = useState<ComposerDrawer>(null);
  // Keys staged in the (unmounted-on-close) NavTray, pushed up so leaving the Keys dock can guard a
  // composed sequence. See requestDrawer.
  const [queuedKeys, setQueuedKeys] = useState(0);
  // Two-tap guard for discarding that sequence. Separate from sendConfirm so an armed "Really send?"
  // and an armed discard can't clobber each other.
  const discardConfirm = usePendingConfirm();

  // The SINGLE choke point for every drawer transition. Closing the Keys dock destroys the composed
  // queue (NavTray unmounts, useKeyQueue resets) — deliberate, because a queue that survived into a
  // later open would let Send fire yesterday's chord sequence into today's TUI state, and this
  // surface's whole safety story is "you review exactly what is about to go on the wire". So the fix
  // for a mis-tap is a confirm, not persistence.
  //
  // Routed through here rather than guarding the dock's ✕ alone: the Keys toggle and the Quick /
  // Agent / Display buttons all unmount the tray just as effectively. An armed-but-EMPTY queue (a
  // lone `once` modifier, no chips) does not arm the confirm — one tap of setup isn't work worth
  // protecting, and over-guarding just trains you to double-tap through it reflexively.
  function requestDrawer(next: ComposerDrawer) {
    if (drawer === "keys" && next !== "keys" && queuedKeys > 0 && !discardConfirm.confirm("discard")) {
      setStatus(
        translatePlural("composer.discard.confirmKeys", queuedKeys, { count: queuedKeys }),
        "info",
      );
      return;
    }
    discardConfirm.reset();
    setDrawer(next);
  }
  const closeDrawer = () => requestDrawer(null);
  // Two-tap guard for destructive commands (rm -rf, force-push, …): the first tap arms a "Really
  // send?" state on the Send button (auto-disarms after 3 s), the second actually sends. Same shared
  // confirm the command palette uses for /clear.
  const sendConfirm = usePendingConfirm();
  // Two-tap override for a `blocked` pre-flight ("the input box isn't on screen"). Separate from
  // sendConfirm so a destructive-command confirm and an override can't clobber each other, and given
  // a longer window than the 3s default: unlike "Really send?", this one asks you to read a sentence
  // explaining WHY nothing was typed before deciding to overrule it.
  const forceConfirm = usePendingConfirm(10_000);

  // The password prompt the last refused send was looking at, if it was one (#103). Set from the
  // guard's own live read — never re-derived from `display`, which is a snapshot — and cleared by the
  // ✕, by arming Type, by a send that goes through, and by leaving the pane. Not persisted: it is a
  // statement about what is on screen right now.
  //
  // It is state AND a ref because it has two jobs on two clocks: the strip renders from the state,
  // while the draft write-through (updateInput, above) has to stop storing keystrokes in the same tick
  // the outcome lands, not on the render after. `noticeNoEcho` is the only writer of both — go through
  // it, or the two disagree and the gap is measured in stored passwords.
  const [noEcho, setNoEcho] = useState<{ prompt: string; typed: boolean } | null>(null);
  const noEchoRef = useRef<{ prompt: string; typed: boolean } | null>(null);

  /** Raise or clear the password-prompt notice. Raising it also DROPS the stored draft: at that moment
   *  we know the field holds a secret the pane never accepted, and leaving it in a 48h store to be
   *  restored on the next visit is the leak #103 asked about. The in-memory value stays — the operator
   *  can still read it, hand it to Type, or dismiss the notice and carry on. */
  function noticeNoEcho(next: { prompt: string; typed: boolean } | null) {
    noEchoRef.current = next;
    setNoEcho(next);
    if (next !== null) clearDraft(scope, paneId);
  }

  // The pane-change effect below is a LIFECYCLE handler, not a reactive computation: it must fire
  // when the addressed pane changes and on nothing else. `noticeNoEcho` is re-created every render,
  // so naming it as a dependency would re-run the effect on every render instead. A latest-value
  // ref says that outright and still calls the current closure.
  const noticeNoEchoRef = useRef(noticeNoEcho);
  noticeNoEchoRef.current = noticeNoEcho;

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const direct = useDirectTyping({
    paneKey: `${scopeId}\0${paneId}`,
    inputRef,
    // The ref, not `input`: the password-prompt handoff clears the draft and arms in one tick.
    replyDraft: () => inputValueRef.current,
    canActivate: () => !(locked || sending || uploading),
    // `locked` covers a gone pane, a read-only device, and the idle pause. A LOST CONNECTION is
    // deliberately not added here: the mode already disarms on a failed batch, which is the same
    // event observed directly rather than inferred from a timer, and it fires whether or not any
    // banner has decided the connection counts as lost yet.
    suspended: locked,
    sendKeys: pressKeys,
    onActivate: () => {
      sendConfirm.reset();
      forceConfirm.reset();
      noticeNoEcho(null); // the notice's whole job was to get you here
    },
    focusInput: focusInputEnd,
  });

  // ── VOICE (ADR 0029) ──────────────────────────────────────────────────────────────────────────
  //
  // `null` unless the bridge published a provider AND this browser can actually record — one
  // predicate in lib/stt.ts, so the button here and the row in Settings can never disagree. Absent
  // is the feature being off: no button at all, not a disabled one.
  const stt = useSttCapability();
  const handsFree = useHandsFree();
  // The microphone is armed state, and it obeys the same rules as "Type into terminal": it dies on a
  // pane switch, on any composer lock, and on a hidden page, and it is never persisted. The clip is
  // DISCARDED on each of those, not finished — see the hook's header for why an orphaned transcript
  // is worse than no transcript.
  const recorder = useSttRecorder({
    enabled: stt?.available === true && !locked && !direct.active,
    paneKey: `${scopeId}\0${paneId}`,
    suspended: locked || direct.active,
    onTranscript: acceptTranscript,
    onError: (message) => setStatus(message, "error"),
  });
  // Whether the round button at the end of the row is the microphone rather than Send. True only on
  // an EMPTY box, which is the one state where Send can do nothing anyway; the first character typed
  // hands the button straight back. `direct.active` keeps it, because there the same button is the
  // "stop typing into the terminal" control and that must not be displaceable.
  const micIsPrimary = stt !== null && !direct.active && input.trim() === "";

  /**
   * What happens to a finished transcript.
   *
   * DEFAULT: it lands in the draft at the caret, and the operator reads it before sending — a
   * transcript is text of unusually low confidence going into a real terminal.
   *
   * HANDS-FREE: it goes out through `send()`, the same guarded path the Send button uses, with every
   * pre-flight and the reply guard intact (ADR 0029 — through the guards, never around them). Three
   * things withdraw it, and all three fall back to inserting rather than refusing:
   *
   *  • **A draft is already in the box.** Merging dictated words onto text the operator typed and
   *    sending the result would send a sentence nobody has read. The two get combined in the box
   *    instead, where the Send button is still theirs to press.
   *  • **A password prompt is on screen** (ADR 0017). Typing behaves the same way there — the pane
   *    gets nothing until the operator acts — and a spoken secret is the last thing to auto-submit.
   *  • **The composer can't send at all** (locked, or a dialog owns the keyboard). `send()` would
   *    refuse anyway; inserting keeps the words.
   */
  function acceptTranscript(transcript: string) {
    const draftEmpty = inputValueRef.current.trim() === "";
    const mayHandsFree =
      handsFree && draftEmpty && noEchoRef.current === null && !locked && !dialogPresent;
    if (mayHandsFree) {
      void send(transcript, false);
      return;
    }
    insertTranscript(transcript);
  }

  /** Splice a transcript into the draft AT THE CARET (the field is where the operator left it, and
   *  dictating a clause into the middle of a sentence is the whole point of a caret), padded with a
   *  space when it would otherwise weld itself to the word in front of it. */
  function insertTranscript(transcript: string) {
    direct.deactivateSilently();
    const el = inputRef.current;
    const prev = inputValueRef.current;
    const start = el?.selectionStart ?? prev.length;
    const end = el?.selectionEnd ?? prev.length;
    const before = prev.slice(0, start);
    const after = prev.slice(end);
    const inserted = before !== "" && !/\s$/.test(before) ? ` ${transcript}` : transcript;
    updateInput(`${before}${inserted}${after}`);
    const caret = start + inserted.length;
    // Deferred like every other focus in this component: React has to swap the controlled value
    // before a selection range means anything.
    setTimeout(() => {
      const field = inputRef.current;
      if (!field) return;
      field.focus();
      field.setSelectionRange(caret, caret);
    }, 0);
  }

  const sentTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // What we last sent, and when — so we can recognise our OWN reply momentarily echoing on the "❯"
  // line (during the bridge's send_text→settle→Enter gap) and NOT treat it as a stranded draft. A
  // ref, not state: it feeds a render-time derivation but must not itself trigger re-renders.
  const lastSentRef = useRef<{ text: string; at: number } | null>(null);
  // Trailing-edge debounce for post-keypress revalidation: a burst of raw key sends (arrow-key
  // spam) coalesces into a single pane refetch instead of one per press.
  const keyRevalidateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The pane's harness adapter, resolved HERE (this is where the agent is known) so the neutral
  // draft helpers below stay harness-free: they take the capability, never the grammar. Undefined for
  // any agent without an adapter, which is exactly the "no idea" case those helpers already handle.
  const adapter = adapterFor(agent ?? undefined);

  // Guard against a false stranded-draft: if the detected draft is what we JUST sent, it's our own
  // reply still echoing on the "❯" line before the bridge's pending Enter — suppress both the preview
  // AND the destructive clear-prefix on the next Send. Applied to the raw and the stabilised value
  // alike (during the echo both carry our text). Recomputed each render (each poll re-renders), so it
  // lapses on its own once the grace expires or the echo resolves; a genuinely stranded draft (never
  // matches a recent send) is untouched.
  const suppressEcho = (draft: string | null): string | null => {
    if (
      draft !== null &&
      lastSentRef.current !== null &&
      Date.now() - lastSentRef.current.at < SENT_ECHO_GRACE_MS &&
      isSelfEcho(draft, lastSentRef.current.text, adapter?.draftCarriesSend)
    ) {
      return null;
    }
    return draft;
  };
  // effectiveStable gates the preview's APPEARANCE (stabilised value); effectiveRaw is the live line
  // its text tracks and that the send()-time pre-clear sweeps.
  const effectiveStable = suppressEcho(terminalDraft);
  const effectiveRaw = suppressEcho(rawTerminalDraft);

  useImperativeHandle(ref, () => ({ focusInput: focusInputImmediately }), []);

  useEffect(
    () => () => {
      if (sentTimer.current) clearTimeout(sentTimer.current);
      if (lastSentTimerRef.current) clearTimeout(lastSentTimerRef.current);
      if (keyRevalidateTimer.current) clearTimeout(keyRevalidateTimer.current);
    },
    [],
  );

  // When the mirror delivers fresh output (text changed), the send has been echoed back — clear the
  // pending preview immediately regardless of the 6s fallback timer.
  useEffect(() => {
    setLastSent(null);
    if (lastSentTimerRef.current) {
      clearTimeout(lastSentTimerRef.current);
      lastSentTimerRef.current = null;
    }
  }, [text]);

  // Block a self-update reload while there's unsent work here: real typed text OR an upload in flight.
  // The composer input is phone-owned, so any non-empty value is genuine unsent work. A terminal draft
  // is SAFE on its own — it lives on the "❯" line and its preview re-derives after a reload — so it
  // never holds. When held, the self-updater shows the "tap to update" banner instead and updates once
  // the hold clears (see lib/self-update.ts). Keyed by pane so panes don't clobber each other's hold.
  useHoldReload(
    `composer:${paneId}`,
    input.trim() !== "" || direct.active || direct.value !== "" || direct.busy || uploading,
  );

  // Preview appearance latch. A STABLE, non-echo, not-already-handled draft flips the preview on —
  // this is the ONLY gate that waits for the 1.5s stability, so a blip or an in-flight send never
  // flashes it. Deliberately one-directional: once latched, rapid host typing (which keeps blanking
  // the stabilised value) can't turn it back off — the raw-tracking + unlatch effects own the hide
  // side. Skipped when the pane is gone.
  useEffect(() => {
    if (gone) return;
    if (effectiveStable !== null && normalizeDraft(effectiveStable) !== handledKey) {
      setPreviewLatched(true);
    }
  }, [effectiveStable, handledKey, gone]);

  // Unlatch when the host clears the "❯" line — the draft was submitted or wiped on the host, or our
  // own send echoed back and got suppressed to null. The preview unmounts on the next render. Also
  // forget the handled key: it exists only to stop the JUST-handled text re-latching before the line
  // clears — once the line has actually emptied, a later re-strand of the same text is a fresh draft
  // and must surface again (without this, taking over "continue" once muted every future "continue"
  // in the pane until you navigated away).
  useEffect(() => {
    if (effectiveRaw === null) {
      setPreviewLatched(false);
      setHandledKey(null);
    }
  }, [effectiveRaw]);

  // Show the preview while it's latched, the host line still carries a (non-echo) draft, and the user
  // hasn't already handled this exact text. Its displayed text is the LIVE raw line — host typing
  // streams straight into it (display-only; it can never write back into the phone-owned input). There
  // is no dismiss action — this is the ONLY way the preview hides short of the host line itself
  // clearing, since a draft that still normalises to `handledKey` is the one the user just took over
  // or sent, not a fresh one to re-show. Not gated on `locked`: read-only devices get the preview +
  // Take over (a local text copy); only the actual Send stays gated.
  const showPreview =
    !gone && previewLatched && effectiveRaw !== null && normalizeDraft(effectiveRaw) !== handledKey;

  // Take over: the explicit "I'll handle this on mobile now" action. One-shot COPY of the current raw
  // draft into the composer (set on an empty input, else appended on a new line so mobile-typed work
  // survives), mark that exact text handled (so it can't instantly re-latch the preview — the raw line
  // still holds it until the host clears it), and hide the preview. No keys touch the terminal here —
  // the stranded line is only ever swept by the send()-time pre-clear. If the host keeps typing and
  // produces a DIFFERENT draft afterwards, the preview honestly reappears with the new text.
  function takeOverDraft() {
    if (effectiveRaw === null) return;
    const draft = effectiveRaw;
    direct.deactivateSilently();
    updateInputFrom((prev) => (prev.trim() ? `${prev.trimEnd()}\n${draft}` : draft));
    setHandledKey(normalizeDraft(draft));
    setPreviewLatched(false);
    focusInputEnd();
  }

  // The operator's own palette rows, resolved against the shipped catalog for both the button's
  // visibility test here and the palette's own list below (same call, same arguments).
  const operatorCommands = useOperatorCommands();
  const commands = commandsFor(agent, operatorCommands);
  // The Keys tray's preset row, resolved the same way from the same one-shot read of /api/config.
  const keyPresets = ctrlPresetsFor(agent, useOperatorKeys());
  // Empty on every adapter that refuses nothing, and empty for Herdr's six as far as this tray is
  // concerned — it offers none of the paging/edit keys Herdr rejects, so nothing greys out there.
  const unsupportedKeys = useMuxUnsupportedKeys();

  function focusInputImmediately() {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }

  function focusInputEnd() {
    setTimeout(focusInputImmediately, 0);
  }

  // Resolves true only on a VERIFIED send (the text was seen in the pane's input box before the
  // submit key went out). The quick-reply grid consumes the verdict to drive its own ✓ and to decide
  // whether to close its dock, so every early return below has to answer honestly.
  async function send(value: string, isDraft: boolean, force = false): Promise<boolean> {
    const t = value.trim();
    if (!t || locked || sending) return false;
    // A dialog on screen owns the TUI's keyboard: our text is swallowed and the submit key ANSWERS
    // the dialog, approving whatever option was highlighted (#34). Refuse BEFORE the destructive
    // pre-clear sweep below — those ctrl+k/Backspaces would land in the dialog too. The input is
    // kept: the user answers the dialog with its own buttons, then taps Send again. We never
    // queue-and-auto-send, because the text may be a reaction to state the dialog just changed —
    // sending is consent, and the conditions moved.
    if (dialogPresent) {
      setStatus(translate("composer.status.dialogWaiting"), "error");
      return false;
    }
    setSending(true);
    try {
      // Guarded: types the text, verifies it reached the input box, and only THEN sends the submit
      // key. A "stalled" outcome means nothing was submitted and the draft must survive (#34).
      const res = await sendGuardedReply({
        paneId,
        text: t,
        agent,
        scope,
        force,
        // Clear a stranded draft on the terminal's "❯" line before pane.send_text appends at cursor —
        // ctrl+k kills cursor→end, Backspace sweep kills the head (preview-action.ts pattern). Skip
        // when there's no draft: a blind sweep races the TUI and Enter can fire before the PTY
        // settles. Keys on effectiveRaw (the actual current line, echo-suppressed), so our own
        // in-flight echo never triggers a (destructive) clear of a message that's already on its way,
        // and a live host draft is swept exactly once whether or not the user took it over first.
        //
        // Handed to the guard rather than run out here, because these are the most destructive keys
        // the composer sends and everything deciding to send them is a SNAPSHOT. `effectiveRaw` and
        // `dialogPresent` are both derived from the mirror's `display`, which lags the live pane by a
        // poll while following and is frozen outright while the user has scrolled back or opened
        // find. A dialog that went up in that gap leaves `dialogPresent` false and a draft still
        // visible, and the sweep lands in the dialog — the #34 failure one step upstream of where
        // #34 was fixed. The guard runs this ONLY after a live read has positively seen the composer,
        // which is why it is named for that and not for its position: `force` included, since a
        // forced retry is armed by a `blocked` outcome, i.e. by the app having just PROVEN a dialog
        // owns the keyboard. A forced send therefore types without sweeping and stalls if the line
        // really did hold a draft — which is what it did anyway, since the same detector that could
        // not see the box cannot read our text back out of it either.
        onComposerSeen: async ({ promptRegion }) => {
          if (effectiveRaw === null) return { ok: true as const, keysSent: false };
          // The props that lock this composer are a SNAPSHOT too, and `send()` read them before the
          // pre-flight's round-trip. A pane that died or a device that lost write access inside that
          // window leaves the composer rendered locked while this burst is still queued behind an
          // await — and unlike every other key this component sends, the burst does not go through
          // `pressKeys`, which refuses when locked. Re-read the live value instead of the closure's.
          if (lockedRef.current) {
            return { ok: false as const, error: translate("composer.status.paneNotWritable") };
          }
          // Overshoot well past the snapshotted length: the count comes from the LAST-POLLED line, so
          // anything the host typed inside the poll gap (~1.5s) isn't counted. Extra Backspace on an
          // already-empty input is a no-op, so a generous margin costs nothing and shrinks the window
          // where a mid-gap host burst leaves a remnant that corrupts the send.
          const clearCount = [...effectiveRaw].length + 32;
          // BOUND to the prompt row the pre-flight's read actually saw. Ordering is not a freshness
          // bound: the read's answer describes the pane at the moment the BRIDGE snapshotted it, and
          // these keys go out when the answer arrives — a whole network round-trip later, capped only
          // by GET_TIMEOUT_MS. `expected_prompt` hands the last word to the bridge, which re-reads the
          // pane immediately before send_keys and 409s (`prompt_changed`) when that row has gone, so
          // the window shrinks to two local RPCs. Same mitigation every dialog tap gets from
          // lib/dialog-guard.ts, which is the one place in this app that could already refuse a key on
          // exactly the evidence this burst used to accept.
          const clearRes = await api.sendKeys(
            paneId,
            ["ctrl+k", ...Array(clearCount).fill("Backspace")],
            scope,
            promptRegion ?? undefined,
          );
          if (!clearRes.ok) {
            // A refused binding is the guard doing its job, not a transport failure — say so, because
            // the user's next move is to look at the pane rather than to retry into whatever is now
            // on it. Nothing was typed either way: this aborts the send before the reply text.
            if (clearRes.code === "prompt_changed") {
              return {
                ok: false as const,
                error: translate("composer.status.inputChanged"),
              };
            }
            return {
              ok: false as const,
              error: describeApiError(clearRes, translate("composer.status.clearFailed")),
            };
          }
          scheduleKeyRevalidate();
          await new Promise((resolve) => setTimeout(resolve, TUI_SETTLE_MS));
          // `keysSent` — the burst plus this settle is exactly the window the guard re-reads across
          // before it types, so the message doesn't follow the keys into a dialog that opened inside
          // it.
          return { ok: true as const, keysSent: true };
        },
      });
      if (res.status === "sent") {
        // Phone-owned input — cleared once the reply is on its way. Via updateInput, so the stored
        // draft goes with it (an empty value removes the key).
        if (isDraft) updateInput("");
        // Remember what/when we sent, so the next few polls recognise this text echoing on the "❯"
        // line as our own in-flight reply rather than a stranded draft (suppressEcho above).
        lastSentRef.current = { text: t, at: Date.now() };
        // The stranded line was just swept and our text sent — mark it handled and drop the preview so
        // it can't flash back before the mirror echoes the cleared line.
        if (effectiveRaw !== null) {
          setHandledKey(normalizeDraft(effectiveRaw));
          setPreviewLatched(false);
        }
        // ✓ flash on the send button + status line acknowledge a VERIFIED send (the text was seen in
        // the input box before the submit key went out), so this lands slightly later than the old
        // fire-and-forget ✓ but is now actually true. The "You sent: …" pending preview keeps the
        // typed text visible until the mirror catches up (cleared by the next text update or a 6s
        // safety timeout).
        setJustSent(true);
        if (sentTimer.current) clearTimeout(sentTimer.current);
        sentTimer.current = setTimeout(() => setJustSent(false), 1500);
        setStatus(translate("composer.status.sent"), "success");
        const preview = t.length > 60 ? `${t.slice(0, 57)}…` : t;
        setLastSent(preview);
        if (lastSentTimerRef.current) clearTimeout(lastSentTimerRef.current);
        lastSentTimerRef.current = setTimeout(() => setLastSent(null), 6000);
        forceConfirm.reset(); // a clean send disarms any leftover override
        noticeNoEcho(null); // whatever prompt it described, the pane has moved past it
        onSent(); // you just acted — snap the mirror back to the live tail to see the result
        return true;
      } else if (res.status === "blocked") {
        // The pre-flight refused: NOTHING was typed. That is usually right (a menu owns the keyboard),
        // but the adapter can only report what it can see, so the user gets a deliberate override —
        // the same two-tap shape as the destructive-send confirm. The second tap skips the pre-flight
        // ONLY; the type-then-verify guard still runs, so Enter is never fired blind either way.
        forceConfirm.confirm("force");
        // A password prompt gets the notice AND keeps the override: the notice explains the screen and
        // offers the control that works, the override stays for the case where the detection is wrong.
        noticeNoEcho(res.noEcho !== undefined ? { prompt: res.noEcho, typed: false } : null);
        setStatus(translate("composer.status.tapAgainToType", { error: res.error }), "error");
        return false;
      } else {
        // "stalled" = the text never reached the input box, so NO submit key was sent (a dialog was
        // probably holding focus). "error" with textDelivered = the text is in the pane but the
        // submit failed. Either way the draft stays put: the user checks the pane rather than
        // double-sending, and on a stall their message is still here to re-send once the dialog is
        // answered.
        //
        // Except at a password prompt, where the draft staying put is the wrong call and the notice
        // says so: the text is already IN the pane (unsubmitted), so a re-send types a second copy of
        // a secret rather than recovering a lost message. The notice's handoff is what clears it.
        noticeNoEcho(
          res.status === "stalled" && res.noEcho !== undefined
            ? { prompt: res.noEcho, typed: true }
            : null,
        );
        setStatus(res.error, "error");
        return false;
      }
    } catch (e) {
      setStatus(describeThrownError(e), "error");
      return false;
    } finally {
      setSending(false);
    }
  }

  // Gate the composer's Send through the destructive-input confirm: a matching command arms the
  // "Really send?" state instead of sending; the confirming second tap goes through. Non-destructive
  // input sends immediately (and any stray armed state is cleared).
  function onSendClick() {
    // An armed override takes precedence: this tap IS the deliberate "type anyway", so it skips the
    // destructive re-confirm (already answered on the tap that got blocked) and the pre-flight.
    if (forceConfirm.pending === "force") {
      forceConfirm.reset();
      send(input, true, true);
      return;
    }
    const reason = isDestructiveInput(input);
    if (reason && !sendConfirm.confirm("send")) {
      // On a pack the confirm names the machine as well as the pattern: "rm -r" is a different
      // sentence depending on whose disk it runs on, and this line is the last thing read before the
      // second tap. Solo copy is unchanged, byte for byte.
      setStatus(
        writeHostLabel
          ? translate("composer.destructive.confirmOnHost", { reason, host: writeHostLabel })
          : translate("composer.destructive.confirm", { reason }),
        "info",
      );
      return;
    }
    sendConfirm.reset();
    send(input, true);
  }
  const confirmingSend = sendConfirm.pending === "send";
  const forcingSend = forceConfirm.pending === "force";

  // Coalesce revalidations from a burst of key presses, LEADING edge first: the first press in a
  // burst refetches immediately, and only presses that arrive inside the window collapse into one
  // trailing refetch. It used to be trailing-only, which meant a lone press — the common case — sat
  // out the full window before its fetch even *started*, and if that fetch then beat the TUI's
  // repaint you waited a whole 1.5s poll to see anything. Arrow-key spam still coalesces exactly as
  // before: presses 2..n only ever schedule the one trailing refetch.
  function scheduleKeyRevalidate() {
    if (keyRevalidateTimer.current === null) {
      revalidator.revalidate(); // leading edge
      // Cooldown only — it fires nothing itself; a press landing before it expires replaces it with
      // the trailing refetch below.
      keyRevalidateTimer.current = setTimeout(() => {
        keyRevalidateTimer.current = null;
      }, KEY_REVALIDATE_MS);
      return;
    }
    clearTimeout(keyRevalidateTimer.current);
    keyRevalidateTimer.current = setTimeout(() => {
      keyRevalidateTimer.current = null;
      revalidator.revalidate(); // trailing edge — one refetch for the whole burst
    }, KEY_REVALIDATE_MS);
  }

  // Raw key send (nav tray). Resolves the bridge's verdict so the pressed button can echo it — the
  // mirror is still the source of truth for what the key DID, but it can be ~2s behind, and this
  // path used to be silent on success, so a press looked like it went nowhere. Errors still go to
  // the status channel; the echo just falls back to idle.
  async function pressKeys(k: string[]): Promise<boolean> {
    if (locked) return false;
    try {
      const res = await api.sendKeys(paneId, k, scope);
      if (!res.ok) {
        setStatus(describeApiError(res), "error");
        return false;
      }
      scheduleKeyRevalidate();
      return true;
    } catch (e) {
      setStatus(describeThrownError(e), "error");
      return false;
    }
  }

  // Insert "/cmd " into the composer (arg-taking commands) and focus it. Appends to any draft already
  // typed (with a separating space) rather than clobbering it; an empty draft just gets set.
  function insertCommand(value: string) {
    direct.deactivateSilently();
    updateInputFrom((prev) => (prev.trim() ? `${prev.trimEnd()} ${value}` : value));
    focusInputEnd();
  }

  // Upload an image; on success append its host path to the composer so the user can add context.
  // Shared by the file picker and clipboard paste.
  async function uploadImage(file: File) {
    if (locked) return;
    setUploading(true);
    try {
      const res = await api.uploadImage(paneId, file, scope);
      if (res.ok) {
        const path = res.path;
        direct.deactivateSilently();
        updateInputFrom((prev) => (prev.trim() ? `${prev.trimEnd()} ${path}` : path));
        focusInputEnd();
        setStatus(translate("composer.upload.success"), "success");
      } else {
        setStatus(describeApiError(res), "error");
      }
    } catch (err) {
      setStatus(describeThrownError(err), "error");
    } finally {
      setUploading(false);
    }
  }

  async function onPickImage(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file
    if (!file) return;
    await uploadImage(file);
  }

  // Paste an image straight from the clipboard (e.g. a screenshot) the same way the picker does.
  // Only intercepts when the clipboard actually carries an image file — a plain text paste (the
  // common case) falls through untouched.
  function onPasteImage(e: ClipboardEvent<HTMLTextAreaElement>) {
    if (locked || direct.active) return;
    const items = e.clipboardData.items;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) {
          e.preventDefault();
          void uploadImage(file);
          return;
        }
      }
    }
  }

  return (
    <>
      <div className="bg-chrome px-3 pb-[calc(env(safe-area-inset-bottom)_+_0.5rem)]">
        {/* Pending-send preview: visible from send until the mirror echoes back (or 6s). Shows the
            user what landed so they don't double-tap while waiting for the terminal to update. */}
        {lastSent && (
          <div className="mb-2 flex items-center gap-1.5 rounded-md bg-muted/40 px-2.5 py-1.5 text-xs text-muted-foreground">
            <Loader2 className="size-3 shrink-0 animate-spin" />
            <span className="truncate">
              <span className="font-medium">{translate("composer.sentPreview.label")}</span> {lastSent}
            </span>
          </div>
        )}

        {/* File input stays mounted here (not inside the keyboard-only key row) so the picker
            callback survives the keyboard collapsing. Attach-image fires it from the reply-input row
            below (always visible, not gated behind the keyboard-open quick keys); structural commands
            (New tab/space, Kill) and Stop (Esc, in the Keys dock) live elsewhere. */}
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={onPickImage} />
        {/* Keys / Quick / Display dock — a single in-flow site ABOVE the Controls row (so the toggle
            you tapped stays put and the panel grows over the mirror, not the input). Whichever of the
            mutually exclusive drawers is active renders here via the shared ComposerDock chrome. Keys
            mounts the NavTray (unmounts on close, so tab/queue reset each open); Quick mounts the two
            one-tap reply grids; Display mounts the labelled mirror prefs. Agent stays a covering
            BottomSheet below (it's a palette, not a pad). */}
        {drawer === "keys" && (
          <ComposerDock
            title={translate("composer.controls.keys")}
            host={writeHost}
            onClose={closeDrawer}
          >
            <NavTray
              // The chords THIS multiplexer refuses (M10/06). A key is not a capability: the Keys
              // door is `sendKeys` (the lock above), and this is the list of holes behind it, so a
              // refused chord greys its own button instead of being discovered by a failed send.
              unsupportedKeys={unsupportedKeys}
              onSend={pressKeys}
              presets={keyPresets}
              onQueueChange={setQueuedKeys}
              disabled={locked}
            />
          </ComposerDock>
        )}
        {drawer === "quick" && (
          <ComposerDock title={translate("composer.controls.quick")} onClose={closeDrawer}>
            <QuickActionsContent
              onSend={(t) => send(t, false)}
              onClose={closeDrawer}
              agent={agent}
              isShell={isShell}
              disabled={locked || sending}
            />
          </ComposerDock>
        )}
        {drawer === "display" && (
          <ComposerDock title={translate("composer.controls.display")} onClose={closeDrawer}>
            <DisplayPrefsContent
              prefs={prefs}
              setWrap={setWrap}
              stepFontSize={stepFontSize}
              setRawTerminal={setRawTerminal}
              setTapToFocus={setTapToFocus}
            />
          </ComposerDock>
        )}
        {/* The one action row: Keys · Quick · Agent · ⚙ (Agent only when the pane's agent has
            commands). Display prefs used to sit on a second, permanent icon-only "View" row above
            this one; folding them behind the ⚙ gives the mirror that row back. The gear is icon-only
            and NOT flex-1 — it's a settings affordance, not a peer of the three action toggles, and
            keeping it to one square (44px, its tap target and nothing more) leaves the labelled
            buttons the rest of a 390px phone. */}
        {/* THE STATUS BAND — A STATUS LINE, NOT A HEADING, AND NOW A REGION OF ITS OWN.

            It used to be 12px of `pt-3` reserved at the top of the controls row, with its two runs
            lifted out of the flex flow into one `absolute` box. It is now a real box, a sibling
            above the row, because the operator asked for a bottom rule, and a rule cannot be drawn
            on padding. What it SAYS is unchanged: it reads as ONE SENTENCE —
            the machine every button on the row (and the field below) writes to, and what that
            machine's pane is doing. It replaced the word "Controls", which named a row whose five
            buttons already carry their own labels.

            WHY HERE AND NOT IN THE FIELD. The host was docked inside the text box for one round.
            The reasoning survives ("which machine will this land on" is asked while writing, not
            while reading) but the price does not: docked, it took 60px out of the typing area, the
            widest and most contested part of the composer. This band is at the same write surface
            and costs the typing area nothing.

            WHY THE STATUS WORD CAME DOWN HERE. It was the pane header's caption line, and once the
            host left that line it was ONE word holding a whole line of a 60px row — the operator
            asked for the top back. It could not simply be deleted: on the app's own `--status-*`
            tokens a deuteranope reads blocked / working / done as one colour in light theme, and
            "needs you" against "done" collapses in both, so the DOT alone cannot carry the range
            (status-badge.tsx holds the measurement). The dot stays badged on the agent's tile in the
            header, welded to its subject; the word stands here, where the same question is being
            asked about the same machine.

            NOTHING HERE CAN MOVE ANYTHING. Both runs state the same 12px line box (`text-[10px]/3`,
            one utility — tailwind-merge deletes an earlier `leading-*` when a later `text-<size>`
            follows it in the same cn()). `h-[14px]` then STATES the band's height rather than
            letting it be the sum of whatever stands in it, so a solo install (where HostChip renders
            null, its hide rule unchanged, leaving the word alone), a pack, and a gone pane (no word
            at all) are identical BY CONSTRUCTION and not by three occupants happening to agree.
            `text-[10px]/3` is stated on the BAND as
            well as on both runs, and that is load-bearing rather than decorative: a block layer
            inside the slot takes its line box from its OWN inherited strut, so without it the 14px
            page strut won and the band measured 25px instead of 14px.
            The WORD's own width is the case padding cannot reserve — "needs you" is 54.6px and
            "done" 27.9px — so it stands in a slot sized to every word it can hold, which is what
            `StatusWordSlot` is for; the machine's name truncates into what is left, always the same
            amount of it. DESIGN.md §2: reserve, never reflow.

            THE GROUND IS THE PAGE COLOUR, PER DESIGN.md §4: CHROME SEPARATES WITH A RULE, NOT A
            FILL. A fill was tried here and measured — 1.19:1 against the dock below, 1.09:1 /
            1.10:1 against the terminal mirror above, both themes, against a `border-b border-rule`
            doing 1.45:1 light and 2.19:1 dark — and the rule was doing between 1.2x and 2x more of
            the separating in light, and all of it in dark, where the fill read as a continuation of
            the terminal rather than as a band of chrome. It is gone; the band is unpainted, and the
            two rules are what tell it apart from what stands either side of it.

            IT IS BOUNDED ON BOTH EDGES NOW — `border-y`, and that is the round's actual fix. The
            band had a rule below it and 10px of the dock's own `pt-2.5` above it, which is why it
            read as uncentred no matter what the numbers said: the box the EYE draws ran from the
            dock's top rule to the band's bottom rule, ~23px of one unbroken ground, and the words
            sat at the bottom of it. Measured on the page (390px, DPR 3, dark) the geometry inside
            the 13px band was already right to half a pixel — caps 3.0 → 10.0 in a 0 → 13 box — so
            there was nothing to centre BETTER. There was a box to state. The band now states it:
            a rule above, a rule below, nothing between them but the two runs.

            The 10px did not vanish, it moved BELOW the band, onto the controls row as `mt-2.5`,
            where it separates the band from the buttons instead of pretending to be part of it.
            The dock therefore takes NO top padding at all, and its top rule and fill moved out to
            the chrome block in `agent-chat.tsx` — the swipe handle stands on that same ground, so
            the boundary against the terminal is drawn once, above everything the thumb operates.
            Two components drawing one boundary is a fault this codebase has already fixed twice
            (`space-strip.tsx` / `tab-strip.tsx`).

            THE STACK GOT 9px SHORTER: −10px of dock padding, +1px for the band's new top rule.

            AND THE 1px NUDGE IS GONE WITH IT. The band used to carry `pt-px`, which existed to pay
            for a rule on ONE edge: `items-center` centres in the CONTENT box, the band the eye read
            was the border box, and with a hairline below and none above the two centres were half a
            pixel apart. `border-y` makes the box symmetric by construction, so there is nothing left
            to compensate for and a compensation still applied would tip it the other way. Both
            spellings were measured on the page, 390px at DPR 3, as ink rows in the band's own 14px
            border box (rules at 0 → 1 and 13 → 14):

              with `pt-px`   caps 4.00 → 11.00, centroid 7.33 · all ink centroid 7.83
              without        caps 3.00 → 10.00, centroid 6.33 · all ink centroid 6.83

            against a border-box centre of 7.00. The eye centres the CLUSTER, not the capital
            letters — the host's glyph is part of the line — so the all-ink number is the one that
            decides, and it goes from 0.83px low to 0.17px high. The height is simply stated
            (14px = 1 + 12 + 1) and `items-center` does the rest. The host's glyph stays `size-2.5`
            in this variant (host-chip.tsx states why at the line): 10px in a 12px content box
            clears both rules instead of touching one.

            Nothing about the reserve changes: the slot still stacks every word (§2), and the height
            is the same 14px solo, on a pack, and on a gone pane.

            FULL-BLEED, and the content still at 10px. `-mx-3` cancels the dock's `px-3` so both
            rules run edge to edge — one that stopped short would not separate the regions it
            sits between. `px-2.5` then puts the content back at the 10px inset the controls row
            asked for, so nothing on this line moved by a pixel: the band is what absorbs the old
            `-mx-0.5`, a 2px overhang that was invisible on this unpainted strip either way. */}
        <div
          data-slot="composer-status"
          className="-mx-3 flex h-[14px] items-center justify-end gap-1.5 border-y border-rule px-2.5 text-[10px]/3"
        >
          <HostChip host={writeHost} variant="caption" className="min-w-0" />
          <StatusWordSlot status={statusWord} stale={stale} />
        </div>
        {/* `gap-1.5` rather than `gap-2`: four gaps at 8px is 32px of a 366px row, and 6px reads the
            same. The group still carries `aria-labelledby` to the word "Controls" — the word is now
            `sr-only` rather than deleted, because it was doing TWO jobs and only one of them was
            visual. Sighted, it labelled a row of five self-labelling buttons and earned nothing. In
            the accessibility tree it is the only thing that names the group at all, and dropping it
            would leave a bare `role="group"` wrapping Keys/Type/Quick/Agent/⚙ with no name for a
            screen reader to announce on entry. The host does NOT inherit that job: it names a
            machine, not a run of controls, and it is absent on every solo install — which is also
            why it now stands OUTSIDE this group, in the band above, where it belongs to the line it
            completes rather than to five buttons it does not describe. */}
        <div
          data-slot="composer-controls"
          role="group"
          aria-labelledby="composer-controls-label"
          className="-mx-0.5 mb-2 mt-2.5 flex items-center gap-1.5"
        >
          <SectionLabel id="composer-controls-label" className="sr-only">
            {translate("composer.controls.label")}
          </SectionLabel>
          {/* Keys and Quick are TOGGLES for the in-flow dock above (not overlays): tap to open, tap
              again to close. aria-expanded ties each to the dock; secondary variant marks it pressed
              while open. Both share the single-valued `drawer`, so opening one closes the other. */}
          <Button
            variant="ghost"
            size="sm"
            className={cn(CONTROL_BUTTON, drawer === "keys" ? CONTROL_ON : CONTROL_OFF)}
            disabled={locked}
            aria-expanded={drawer === "keys"}
            aria-label={translate("composer.controls.keys")}
            onClick={() => requestDrawer(drawer === "keys" ? null : "keys")}
          >
            <Keyboard className="size-4" />
            <span className={CONTROL_LABEL}>{translate("composer.controls.keys")}</span>
          </Button>
          {/* "Type into terminal" lives HERE, beside Keys, rather than on the Send button.
              It is the same problem split in half: Keys exists because the phone keyboard cannot
              send Esc/Tab/arrows/chords, this exists because it cannot send bare printable letters —
              so someone who wants to press `b` looks in this row first. It is also used in bursts
              (a picker, a y/n prompt) and then not for days, which is the wrong shape for a
              permanent fixture on the app's most-used control: a split Send button cost a third of
              the primary action's width every day to serve a mode used on a few of them.
              Unlike its neighbours this toggles state instead of opening a dock — the armed strip
              above the input is what makes that visible. Arming is still an explicit NAMED choice,
              which is what keeps an accidental touch from quietly wiring the keyboard to a live
              terminal; see use-direct-typing.ts for the rest of that argument. */}
          <Button
            variant="ghost"
            size="sm"
            className={cn(CONTROL_BUTTON, direct.active ? CONTROL_ON : CONTROL_OFF)}
            disabled={locked || sending}
            aria-pressed={direct.active}
            aria-label={translate("composer.controls.typeAria")}
            onClick={() => {
              if (direct.active) {
                direct.deactivate();
                return;
              }
              // Close whatever dock is open first: the mode needs the phone keyboard, and a dock
              // holding half the viewport is the thing in its way. Routed through requestDrawer so a
              // staged key queue still gets its discard confirm (ADR 0005).
              requestDrawer(null);
              direct.activate();
            }}
          >
            <Terminal className="size-4" />
            <span className={CONTROL_LABEL}>{translate("composer.controls.type")}</span>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className={cn(CONTROL_BUTTON, drawer === "quick" ? CONTROL_ON : CONTROL_OFF)}
            disabled={locked}
            aria-expanded={drawer === "quick"}
            aria-label={translate("composer.controls.quick")}
            onClick={() => requestDrawer(drawer === "quick" ? null : "quick")}
          >
            <Zap className="size-4" />
            <span className={CONTROL_LABEL}>{translate("composer.controls.quick")}</span>
          </Button>
          {commands.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className={cn(CONTROL_BUTTON, "text-muted-foreground")}
              disabled={locked}
              aria-label={translate("composer.controls.agent")}
              onClick={() => requestDrawer("cmd")}
            >
              <Slash className="size-4" />
              <span className={CONTROL_LABEL}>{translate("composer.controls.agent")}</span>
            </Button>
          )}
          {/* Display prefs. Not gated on `locked`: wrap/font/raw-terminal are local view state, so a
              read-only device or a gone pane can still make its mirror readable. */}
          <Button
            variant="ghost"
            size="icon"
            className={cn("size-11 shrink-0", drawer === "display" ? CONTROL_ON : CONTROL_OFF)}
            aria-label={translate("composer.controls.displayAria")}
            aria-expanded={drawer === "display"}
            onClick={() => requestDrawer(drawer === "display" ? null : "display")}
          >
            <Settings2 className="size-4" />
          </Button>
        </div>
        {/* Terminal-draft preview: a read-only view of a stranded "❯"-line draft (a message queued
            then recalled on the HOST, which stripChrome hides from the mirror). It appears only after
            the draft stabilises (never a blip/self-echo), then its text tracks the live line — host
            typing streams straight in. It NEVER writes into the phone-owned input; only the explicit
            Take over copies the text here. No dismiss — it's honest state and persists until the user
            takes over, sends, or the host line clears. Same zinc/text-xs chrome as the "You sent:"
            strip above. */}
        {showPreview && effectiveRaw !== null && (
          <TerminalDraftPreview
            text={effectiveRaw}
            // No Take over when the line is only the harness's own opaque token (Claude's
            // `[Pasted text #N +M lines]`): pulling that into the composer would send the literal
            // string. The preview keeps showing it — the screen really does say that.
            onTakeOver={adapter?.draftIsOpaque?.(effectiveRaw) ? null : takeOverDraft}
          />
        )}
        {/* The password-prompt notice (#103). Sits here, in the same in-flow slot as the other two
            strips, because that is where the eye already is when a send is refused — and it is a
            NOTICE beside the unchanged "Type anyway?" override, never a replacement for it. */}
        {noEcho !== null && !direct.active && (
          <NoEchoNotice
            prompt={noEcho.prompt}
            typed={noEcho.typed}
            // Withdrawn, not disabled, when the mode can't be armed at all: a gone pane, a read-only
            // device, the idle pause. Offering a control that would refuse is worse than offering none.
            onUseType={
              locked
                ? null
                : () => {
                    // The draft is a password we know the pane never accepted, and it is already in
                    // localStorage. Clear it BEFORE arming — both because leaving a secret in a 48h
                    // store is the leak this issue asked about, and because `activate` refuses while
                    // any draft is present, which would make the offered remedy fail on the spot.
                    updateInput("");
                    requestDrawer(null);
                    direct.activate();
                  }
            }
            onDismiss={() => noticeNoEcho(null)}
          />
        )}
        {/* Armed indicator for direct typing. In the same in-flow slot as the "You sent:" strip,
            deliberately NOT only on the button and textarea — see the component. */}
        {direct.active && <DirectTypingStrip onStop={() => direct.deactivate()} />}
        {/* The microphone's armed strip, in the same in-flow slot and for the same reason. Stop and
            ✕ are different actions: one transcribes the clip, the other throws it away. */}
        {recorder.busy && recorder.phase !== "requesting" && (
          <RecordingStrip
            elapsed={recorder.elapsedLabel}
            transcribing={recorder.phase === "transcribing"}
            handsFree={handsFree && input.trim() === "" && noEcho === null}
            onStop={recorder.stopAndSend}
            onDiscard={recorder.discard}
          />
        )}
        {/* A draft too large for the disk tier (lib/drafts.ts). It survives a pane switch — the
            memory tier holds it whole — but not the app closing, and that difference is invisible
            without saying so: the old behaviour silently restored an OLDER, SHORTER draft instead.
            Derived at render rather than pushed through setStatus, because this is a CONDITION that
            lasts as long as the text does, and a status auto-clears in 2.5s and would re-fire on
            every keystroke. Self-clearing: trim the draft or send it and the row is simply gone. */}
        {!direct.active && !fitsDraftStore(input) && (
          <p className="px-1 pb-1 text-xs leading-snug text-muted-foreground">
            {translate("composer.draft.tooLong")}
          </p>
        )}
        {/* gap-3, not gap-2: with the attach button moved inside the field this row is only the
            field and Send, and the old spacing left them looking joined. */}
        <div className="flex items-end gap-3">
          {/* The input and its attach button share one box: the button is positioned INSIDE the
              field, messenger-style, rather than sitting beside it as a third control in the row.
              It used to occupy a full-height slot to the left, which spent the widest part of the
              composer on the least-used action; inside the field it costs nothing but a strip of
              padding the text was not using anyway. `pr-11` on the textarea reserves that strip so a
              long line can never run underneath the icon.

              The machine this write lands on is NOT in here. It was, for one round, docked at the
              field's right edge — and it cost 60px of typing width on a pack, out of the widest part
              of the composer. It answers the same question from the controls row above (the status
              strip there), which is equally at the write surface and costs the draft nothing. */}
          <div className="relative min-w-0 flex-1">
          <ChatInput
            ref={inputRef}
            value={direct.active ? direct.value : input}
            onChange={direct.active ? direct.onChange : (e) => updateInput(e.target.value)}
            onCompositionStart={direct.active ? direct.onCompositionStart : undefined}
            onCompositionEnd={direct.active ? direct.onCompositionEnd : undefined}
            onKeyDown={
              direct.active
                ? direct.onKeyDown
                : (e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      onSendClick();
                    }
                  }
            }
            onPaste={onPasteImage}
            placeholder={
              gone
                ? translate("composer.placeholder.gone")
                : readOnly
                  ? translate("composer.placeholder.readOnly")
                  : // Names the machine, because on a pack "why can't I type?" has two possible
                    // answers and only one of them is about this device.
                    hostBlock
                    ? hostBlock
                    : // The multiplexer cannot type here at all — its own words where it gave any, so
                      // the placeholder says what is true of THIS terminal rather than blaming the app.
                      missingSend !== null
                      ? missingSend.note || translate("composer.placeholder.noMuxSend")
                    : direct.active
                      ? translate("composer.placeholder.direct")
                      : isShell
                        ? translate("composer.placeholder.shell")
                        : translate("composer.placeholder.reply")
            }
            autoCorrect={direct.active ? "off" : undefined}
            spellCheck={direct.active ? false : undefined}
            className={cn(
              // Room for the attach button tucked into the bottom-right of the field. `block`
              // matters: a textarea is inline-level by default, so the wrapper inherits a few px of
              // baseline gap beneath it and the absolutely-positioned button hangs past the field's
              // bottom edge.
              //
              // ONE `pr-*` here, unconditionally, and it is the attach button's alone. MEASURED in
              // the playground at a true 390px content width: the field is 310px, so the typing area
              // is 254px — on a pack and on a solo install alike. At 320px it is 184px, again both.
              // For one round a pack paid 60px of that to a chip docked at the field's right edge
              // (194px and 124px); the host answers the same question from the status strip above
              // now, and the width came back. A second, conditional `pr-*` in this same cn() would
              // not stack — tailwind-merge keeps only the last padding-right (DESIGN.md §7) — which
              // is why nothing else may reserve space by adding one here.
              "block pr-11",
              direct.active &&
                "border-primary focus-visible:border-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
            )}
            disabled={locked}
            rows={1}
          />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              // bottom-1, not centred: the field grows upward as the draft wraps, and a vertically
              // centred button would drift up with it, away from the thumb and away from the send
              // button it pairs with. Pinned to the bottom it stays put at any height.
              className="absolute bottom-1 right-1 size-9 rounded-full text-muted-foreground"
              disabled={uploading || locked || direct.active}
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => fileRef.current?.click()}
              aria-label={translate("composer.attach.aria")}
            >
              {uploading ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <ImagePlus className="size-4" />
              )}
            </Button>
          </div>
          {!direct.active && forcingSend ? (
            // The pre-flight refused and the user is being offered the override. Labelled for what it
            // actually does — TYPE the text into whatever is on screen — not "send", because the
            // submit key is still conditional on the verify step behind it.
            <Button
              variant="destructive"
              className="h-11 shrink-0 rounded-md px-4 text-sm font-semibold"
              onClick={onSendClick}
              disabled={locked || !input.trim() || sending}
              aria-label={translate("composer.send.typeAnyway")}
            >
              {translate("composer.send.typeAnyway")}
            </Button>
          ) : !direct.active && confirmingSend ? (
            <Button
              variant="destructive"
              className="h-11 shrink-0 rounded-md px-4 text-sm font-semibold"
              onClick={onSendClick}
              disabled={locked || !input.trim() || sending}
              aria-label={translate("composer.send.reallySend")}
            >
              {translate("composer.send.reallySend")}
            </Button>
          ) : micIsPrimary ? (
            // THE MICROPHONE IS THE PRIMARY ACTION WHILE THE BOX IS EMPTY, and becomes Send the
            // moment there is anything to send. It used to be a second, permanent control tucked
            // inside the field beside the attach button — deliberately, to avoid a split primary
            // action. The v1 beta said that reads the workflow wrong: you either dictate a message
            // or you type one, and nobody dictates into the middle of a draft. So the field paid
            // 36px of its width, on every render, for a control that is only ever wanted on an empty
            // box. An empty box has no Send either (`send` refuses a blank value), so this branch
            // takes over a button that could do nothing anyway — it replaces no capability.
            <Button
              size="icon"
              variant={recorder.busy ? "destructive" : "default"}
              className="size-11 shrink-0 rounded-full"
              disabled={!stt.available || locked || sending || recorder.phase === "transcribing"}
              aria-pressed={recorder.busy}
              // The bridge's own words when it cannot serve — the operator's next move is on the
              // host, so the button says what is wrong rather than just refusing.
              aria-label={
                !stt.available
                  ? (stt.reason ?? translate("composer.mic.unavailable"))
                  : recorder.phase === "recording"
                    ? translate("composer.mic.stopAria")
                    : translate("composer.mic.recordAria")
              }
              title={stt.available ? undefined : stt.reason}
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => (recorder.phase === "recording" ? recorder.stopAndSend() : recorder.start())}
            >
              {recorder.phase === "transcribing" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : recorder.phase === "recording" ? (
                <Square className="size-4 fill-current" />
              ) : (
                <Mic className="size-4" />
              )}
            </Button>
          ) : (
            <Button
              size="icon"
              className="size-11 shrink-0 rounded-full"
              onClick={direct.active ? () => direct.deactivate() : onSendClick}
              disabled={locked || sending}
              aria-label={
                direct.active
                  ? translate("composer.send.stopTypingAria")
                  : translate("composer.send.sendAria")
              }
              aria-pressed={direct.active}
            >
              {direct.active ? (
                <Keyboard className="size-4" />
              ) : sending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : justSent ? (
                <Check className="size-4" />
              ) : (
                <Send className="size-4" />
              )}
            </Button>
          )}
        </div>
      </div>

      {/* Slash-command palette */}
      <CommandPalette
        open={drawer === "cmd"}
        onClose={closeDrawer}
        agent={agent}
        mine={operatorCommands}
        onInsert={insertCommand}
        onSubmit={(t) => send(t, false)}
      />
    </>
  );
});
