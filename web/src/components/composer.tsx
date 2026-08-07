import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { ChangeEvent, ClipboardEvent, ReactNode } from "react";
import { useRevalidator } from "react-router";
import { Check, ImagePlus, Keyboard, Loader2, Send, Settings2, Slash, X, Zap } from "lucide-react";

import type { DisplayPrefs } from "@/hooks/use-display-prefs";
import { usePendingConfirm } from "@/hooks/use-pending-confirm";
import { setStatus } from "@/lib/status";
import { Button } from "@/components/ui/button";
import { ChatInput } from "@/components/ui/chat/chat-input";
import { NavTray } from "@/components/nav-tray";
import { CommandPalette } from "@/components/command-palette";
import { QuickActionsContent } from "@/components/quick-actions";
import { DisplayPrefsContent } from "@/components/display-prefs";
import { SectionLabel } from "@/components/ui/section-label";
import * as api from "@/lib/api";
import { commandsFor } from "@/lib/agent-commands";
import { isDestructiveInput } from "@/lib/destructive";
import { HostChip } from "@/components/host-chip";
import { useAmbientHost, useHostLabel } from "@/components/pack-provider";
import { loadDraft, saveDraft } from "@/lib/drafts";
import { useHoldReload } from "@/lib/reload-guard";
import { isSelfEcho, normalizeDraft } from "@/hooks/use-terminal-draft";
import { adapterFor } from "@/lib/harness";
import { sendGuardedReply } from "@/lib/reply-action";
import { TerminalDraftPreview } from "@/components/terminal-draft-preview";
import { scopeKey, type Scope } from "@/lib/scope";

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
  /** True for a bare shell pane (tweaks the placeholder copy). */
  isShell: boolean;
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
          aria-label={`Close ${title}`}
        >
          <X className="size-4" />
        </Button>
      </div>
      <div className="max-h-[45dvh] min-h-0 overflow-y-auto">{children}</div>
    </div>
  );
}

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(
  { paneId, scope, agent, isShell, gone, readOnly, hostBlock, dialogPresent, text, terminalDraft, rawTerminalDraft, prefs, setWrap, stepFontSize, setRawTerminal, onSent },
  ref,
) {
  const revalidator = useRevalidator();
  // Every write affordance is off when the pane is gone, this device is read-only, OR the pane's
  // machine is unreachable from the lead. All three are "the write cannot land"; only the copy below
  // differs, because only the copy tells you what to do about it.
  const locked = gone || readOnly || hostBlock !== undefined;
  // The machine every write on this row lands on. The pane view addresses one host (the pane's own,
  // carried in `?h=` since the row was opened), so the ambient scope IS the target here. Undefined on
  // a solo install, which renders no chip and leaves every confirm string unchanged.
  const writeHost = useAmbientHost(scope?.host);
  // Its display name, or undefined when there is no pack — the copy-level half of the hide rule.
  const writeHostLabel = useHostLabel(scope?.host);

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

  /** Set the draft AND persist it. Every write to `input` goes through here — an empty value removes
   *  the stored key, so the deliberate-clear paths (verified send, user emptying the box) need no
   *  special case. */
  function updateInput(next: string | ((prev: string) => string)) {
    const value = typeof next === "function" ? next(inputValueRef.current) : next;
    inputValueRef.current = value;
    setInput(value);
    saveDraft(scope, paneId, value);
  }

  useEffect(() => {
    const prev = draftPaneRef.current;
    if (prev.paneId === paneId && prev.scopeId === scopeId) return;
    saveDraft(prev.scope, prev.paneId, inputValueRef.current);
    draftPaneRef.current = { scope, scopeId, paneId };
    const restored = loadDraft(scope, paneId) ?? "";
    inputValueRef.current = restored;
    setInput(restored);
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
        `Tap again to discard ${queuedKeys} queued key${queuedKeys === 1 ? "" : "s"}`,
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

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
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
  useHoldReload(`composer:${paneId}`, input.trim() !== "" || uploading);

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
    updateInput((prev) => (prev.trim() ? `${prev.trimEnd()}\n${draft}` : draft));
    setHandledKey(normalizeDraft(draft));
    setPreviewLatched(false);
    focusInputEnd();
  }

  const commands = commandsFor(agent);

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
      setStatus("A dialog is waiting — answer it first, then send.", "error");
      return false;
    }
    setSending(true);
    try {
      // Clear a stranded draft on the terminal's "❯" line before pane.send_text appends at cursor —
      // ctrl+k kills cursor→end, Backspace sweep kills the head (preview-action.ts pattern). Skip when
      // there's no draft: a blind sweep races the TUI and Enter can fire before the PTY settles. Keys
      // on effectiveRaw (the actual current line, echo-suppressed), so our own in-flight echo never
      // triggers a (destructive) clear of a message that's already on its way, and a live host draft
      // is swept exactly once whether or not the user took it over first.
      if (effectiveRaw !== null) {
        // Overshoot well past the snapshotted length: the count comes from the LAST-POLLED line, so
        // anything the host typed inside the poll gap (~1.5s) isn't counted. Extra Backspace on an
        // already-empty input is a no-op, so a generous margin costs nothing and shrinks the window
        // where a mid-gap host burst leaves a remnant that corrupts the send.
        const clearCount = [...effectiveRaw].length + 32;
        const clearRes = await api.sendKeys(
          paneId,
          ["ctrl+k", ...Array(clearCount).fill("Backspace")],
          scope,
        );
        if (!clearRes.ok) {
          setStatus(clearRes.error ?? "Couldn't clear the terminal input", "error");
          return false;
        }
        scheduleKeyRevalidate();
        await new Promise((resolve) => setTimeout(resolve, TUI_SETTLE_MS));
      }

      // Guarded: types the text, verifies it reached the input box, and only THEN sends the submit
      // key. A "stalled" outcome means nothing was submitted and the draft must survive (#34).
      const res = await sendGuardedReply({ paneId, text: t, agent, scope, force });
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
        setStatus("Sent ✓", "success");
        const preview = t.length > 60 ? `${t.slice(0, 57)}…` : t;
        setLastSent(preview);
        if (lastSentTimerRef.current) clearTimeout(lastSentTimerRef.current);
        lastSentTimerRef.current = setTimeout(() => setLastSent(null), 6000);
        forceConfirm.reset(); // a clean send disarms any leftover override
        onSent(); // you just acted — snap the mirror back to the live tail to see the result
        return true;
      } else if (res.status === "blocked") {
        // The pre-flight refused: NOTHING was typed. That is usually right (a menu owns the keyboard),
        // but the adapter can only report what it can see, so the user gets a deliberate override —
        // the same two-tap shape as the destructive-send confirm. The second tap skips the pre-flight
        // ONLY; the type-then-verify guard still runs, so Enter is never fired blind either way.
        forceConfirm.confirm("force");
        setStatus(`${res.error} Tap Send again to type anyway.`, "error");
        return false;
      } else {
        // "stalled" = the text never reached the input box, so NO submit key was sent (a dialog was
        // probably holding focus). "error" with textDelivered = the text is in the pane but the
        // submit failed. Either way the draft stays put: the user checks the pane rather than
        // double-sending, and on a stall their message is still here to re-send once the dialog is
        // answered.
        setStatus(res.error, "error");
        return false;
      }
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e), "error");
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
      const where = writeHostLabel ? ` on ${writeHostLabel}` : "";
      setStatus(`Destructive: ${reason}${where} — tap Send again to confirm`, "info");
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
        setStatus(res.error ?? "Key send failed", "error");
        return false;
      }
      scheduleKeyRevalidate();
      return true;
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e), "error");
      return false;
    }
  }

  // Insert "/cmd " into the composer (arg-taking commands) and focus it. Appends to any draft already
  // typed (with a separating space) rather than clobbering it; an empty draft just gets set.
  function insertCommand(value: string) {
    updateInput((prev) => (prev.trim() ? `${prev.trimEnd()} ${value}` : value));
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
        updateInput((prev) => (prev.trim() ? `${prev.trimEnd()} ${path}` : path));
        focusInputEnd();
        setStatus("Image added — path in message", "success");
      } else {
        setStatus(res.error, "error");
      }
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err), "error");
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
    if (locked) return;
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
      <div className="border-t border-border/60 bg-muted px-3 pb-[calc(env(safe-area-inset-bottom)_+_0.5rem)] pt-2.5">
        {/* Pending-send preview: visible from send until the mirror echoes back (or 6s). Shows the
            user what landed so they don't double-tap while waiting for the terminal to update. */}
        {lastSent && (
          <div className="mb-2 flex items-center gap-1.5 rounded-md bg-muted/40 px-2.5 py-1.5 text-xs text-muted-foreground">
            <Loader2 className="size-3 shrink-0 animate-spin" />
            <span className="truncate">
              <span className="font-medium">You sent:</span> {lastSent}
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
          <ComposerDock title="Keys" host={writeHost} onClose={closeDrawer}>
            <NavTray onSend={pressKeys} onQueueChange={setQueuedKeys} disabled={locked} />
          </ComposerDock>
        )}
        {drawer === "quick" && (
          <ComposerDock title="Quick" onClose={closeDrawer}>
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
          <ComposerDock title="Display" onClose={closeDrawer}>
            <DisplayPrefsContent
              prefs={prefs}
              setWrap={setWrap}
              stepFontSize={stepFontSize}
              setRawTerminal={setRawTerminal}
            />
          </ComposerDock>
        )}
        {/* The one action row: Keys · Quick · Agent · ⚙ (Agent only when the pane's agent has
            commands). Display prefs used to sit on a second, permanent icon-only "View" row above
            this one; folding them behind the ⚙ gives the mirror that row back. The gear is icon-only
            and NOT flex-1 — it's a settings affordance, not a peer of the three action toggles, and
            keeping it narrow leaves the labelled buttons their width on a 390px phone. */}
        <div className="mb-2 flex items-center gap-2">
          <SectionLabel>Controls</SectionLabel>
          {/* Keys and Quick are TOGGLES for the in-flow dock above (not overlays): tap to open, tap
              again to close. aria-expanded ties each to the dock; secondary variant marks it pressed
              while open. Both share the single-valued `drawer`, so opening one closes the other. */}
          <Button
            variant={drawer === "keys" ? "secondary" : "ghost"}
            size="sm"
            className="h-8 flex-1 gap-1.5 text-muted-foreground"
            disabled={locked}
            aria-expanded={drawer === "keys"}
            onClick={() => requestDrawer(drawer === "keys" ? null : "keys")}
          >
            <Keyboard className="size-4" />
            Keys
          </Button>
          <Button
            variant={drawer === "quick" ? "secondary" : "ghost"}
            size="sm"
            className="h-8 flex-1 gap-1.5 text-muted-foreground"
            disabled={locked}
            aria-expanded={drawer === "quick"}
            onClick={() => requestDrawer(drawer === "quick" ? null : "quick")}
          >
            <Zap className="size-4" />
            Quick
          </Button>
          {commands.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 flex-1 gap-1.5 text-muted-foreground"
              disabled={locked}
              onClick={() => requestDrawer("cmd")}
            >
              <Slash className="size-4" />
              Agent
            </Button>
          )}
          {/* Display prefs. Not gated on `locked`: wrap/font/raw-terminal are local view state, so a
              read-only device or a gone pane can still make its mirror readable. */}
          <Button
            variant={drawer === "display" ? "secondary" : "ghost"}
            size="icon"
            className="size-8 shrink-0 text-muted-foreground"
            aria-label="Display settings"
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
        {/* Which machine this reply is about to be typed into, immediately above the input and Send.
            A host named only in a header read once at the top of a scroll is not named where the
            mistake happens (milestone constraint). Renders nothing unless the pack has >1 machine. */}
        <HostChip host={writeHost} variant="target" className="mb-1 self-start" />
        <div className="flex items-end gap-2">
          {/* Attach image — messenger-style, left of the input, always available (previously buried
              in the keyboard-only quick-key strip). preventDefault keeps the textarea focused so the
              picker opens without the soft keyboard collapsing first. */}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="rounded-full text-muted-foreground"
            disabled={uploading || locked}
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => fileRef.current?.click()}
            aria-label="Attach image"
          >
            {uploading ? <Loader2 className="size-4 animate-spin" /> : <ImagePlus className="size-4" />}
          </Button>
          <ChatInput
            ref={inputRef}
            value={input}
            onChange={(e) => updateInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                onSendClick();
              }
            }}
            onPaste={onPasteImage}
            placeholder={
              gone
                ? "Pane is gone"
                : readOnly
                  ? "Read-only — device not authorised"
                  : // Names the machine, because on a pack "why can't I type?" has two possible
                    // answers and only one of them is about this device.
                    hostBlock
                    ? hostBlock
                    : isShell
                      ? "Type a shell command…"
                      : "Type a reply…"
            }
            disabled={locked}
            rows={1}
          />
          {forcingSend ? (
            // The pre-flight refused and the user is being offered the override. Labelled for what it
            // actually does — TYPE the text into whatever is on screen — not "send", because the
            // submit key is still conditional on the verify step behind it.
            <Button
              variant="destructive"
              className="h-11 shrink-0 rounded-full px-4 text-sm font-semibold"
              onClick={onSendClick}
              disabled={locked || !input.trim() || sending}
              aria-label="Type anyway?"
            >
              Type anyway?
            </Button>
          ) : confirmingSend ? (
            <Button
              variant="destructive"
              className="h-11 shrink-0 rounded-full px-4 text-sm font-semibold"
              onClick={onSendClick}
              disabled={locked || !input.trim() || sending}
              aria-label="Really send?"
            >
              Really send?
            </Button>
          ) : (
            <Button
              size="icon"
              className="size-11 shrink-0 rounded-full"
              onClick={onSendClick}
              disabled={locked || !input.trim() || sending}
              aria-label="Send"
            >
              {sending ? (
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
        onInsert={insertCommand}
        onSubmit={(t) => send(t, false)}
      />
    </>
  );
});
