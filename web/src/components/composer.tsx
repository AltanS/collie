import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { ChangeEvent, ReactNode } from "react";
import { useRevalidator } from "react-router";
import { AArrowDown, AArrowUp, Check, ImagePlus, Keyboard, Loader2, Search, Send, Slash, Terminal, WrapText, X, Zap } from "lucide-react";

import type { DisplayPrefs } from "@/hooks/use-display-prefs";
import { usePendingConfirm } from "@/hooks/use-pending-confirm";
import { setStatus } from "@/lib/status";
import { Button } from "@/components/ui/button";
import { ChatInput } from "@/components/ui/chat/chat-input";
import { NavTray } from "@/components/nav-tray";
import { CommandPalette } from "@/components/command-palette";
import { QuickActionsContent } from "@/components/quick-actions";
import { SectionLabel } from "@/components/ui/section-label";
import * as api from "@/lib/api";
import { commandsFor } from "@/lib/agent-commands";
import { isDestructiveInput } from "@/lib/destructive";
import { isSelfEcho } from "@/hooks/use-terminal-draft";

export interface ComposerHandle {
  /** Focus the input and put the caret at the end — used by the mirror-tap-to-focus in AgentChat. */
  focusInput: () => void;
}

interface ComposerProps {
  paneId: string;
  /** The session the pane lives in (undefined = primary) — scopes every write to the right Herdr. */
  session?: string;
  /** The pane's agent name — drives the slash-command palette and the reply-vs-shell placeholder. */
  agent: string | undefined | null;
  /** True for a bare shell pane (tweaks the placeholder copy). */
  isShell: boolean;
  /** Pane is gone (no agent) — locks the composer with a distinct placeholder. */
  gone: boolean;
  /** This device isn't authorised to type — locks the composer with a distinct placeholder. */
  readOnly: boolean;
  /** Latest pane text — clears the pending-send preview once the mirror echoes the send back. */
  text: string;
  /** A user draft stranded on the terminal's "❯" input line (extractInputDraft), or null. When set
   * and the composer is empty, it's auto-adopted (text-only) into the input; when the composer
   * already holds other text, a chip offers to recover it here instead. */
  terminalDraft: string | null;
  /** Mirror display prefs — the View row lives here, but the mirror (in AgentChat) reads the same
   * single instance, so they're threaded through rather than each calling useDisplayPrefs. */
  prefs: DisplayPrefs;
  setWrap: (wrap: boolean) => void;
  stepFontSize: (delta: number) => void;
  setRawTerminal: (raw: boolean) => void;
  /** Snap the mirror to the live tail (follow + revalidate + scroll) after a successful send. */
  onSent: () => void;
  /** Open find-in-output (freezes the tail in AgentChat). Undefined when there's no buffered output
   * to search — the View-row Find button hides in that case. */
  onOpenFind?: () => void;
}

// The composer cluster at the bottom of the pane view — everything a phone keyboard can't do on its
// own: quick actions, an agent-aware slash-command palette, an inline key tray (via
// `pane.send_keys`), image upload, display prefs, and the reply Send (with a destructive-command
// two-tap guard). Its state (draft, sending, upload, pending preview, its own Keys/Quick/Agent
// sheets) is entirely local; it reaches AgentChat only through `onSent` (to re-follow the tail) and
// exposes `focusInput` so the mirror tap can bring up the keyboard.
type ComposerDrawer = "quick" | "cmd" | "keys" | null;

// Pause after clearing a stranded terminal draft so the TUI settles before pane.send_text.
const TUI_SETTLE_MS = 350;

// Grace window after a send during which a terminal draft matching what we just sent is treated as
// our own in-flight reply (still on the "❯" line before the bridge's pending Enter lands), NOT a
// stranded draft. Wide enough to cover a slow tailnet round-trip; the parent's cross-poll
// stabilisation (useStableTerminalDraft) closes the other half of the same window.
const SENT_ECHO_GRACE_MS = 5_000;

// Shared in-flow dock chrome for Keys/Quick — an IN-FLOW panel (never an overlay), so the terminal
// mirror's flex-1 box shrinks and its tail stays visible while the dock is open (a covering sheet
// hid exactly the prompt you were driving). Full-bleed top border + capped height keep the mirror
// usable on a phone. The header (title + Close X) is a NON-scrolling child of a flex column; only the
// body below it scrolls (max-h + overflow), so the Close X can never scroll out of reach on a short
// viewport with a tall tray. One wrapper so Keys and Quick can't drift apart.
function ComposerDock({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div className="-mx-3 mb-2 flex flex-col border-t border-border bg-background">
      <div className="flex items-center justify-between px-3 pt-2">
        <SectionLabel>{title}</SectionLabel>
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
  { paneId, session, agent, isShell, gone, readOnly, text, terminalDraft, prefs, setWrap, stepFontSize, setRawTerminal, onSent, onOpenFind },
  ref,
) {
  const revalidator = useRevalidator();
  // Every write affordance is off when the pane is gone OR this device is read-only.
  const locked = gone || readOnly;

  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  // Pending-send preview: set on a successful send, cleared when the mirror catches up (next text
  // update) or after a 6s safety timeout. Shows "You sent: …" so the user knows the message landed.
  const [lastSent, setLastSent] = useState<string | null>(null);
  const [justSent, setJustSent] = useState(false); // brief ✓ on the send button after a send
  // Terminal-draft recovery: `dismissedDraft` holds the draft the user has handled (dismissed the
  // chip, cleared/edited it out of the composer, or sent it) — neither the chip nags about it nor
  // does it re-adopt while `terminalDraft` still equals it; a NEW distinct stranded draft is fair
  // game again. `recovering` disables the chip's Edit-here while its backspace-then-adopt round-trip
  // is in flight.
  const [dismissedDraft, setDismissedDraft] = useState<string | null>(null);
  const [recovering, setRecovering] = useState(false);
  // Auto-adoption provenance: the EXACT terminal-draft text we auto-filled into `input` (null = not
  // mirroring). While the input still equals this, we own it — a changed terminal draft updates the
  // input in place, a vanished one clears it back to empty. The moment the user edits (input ≠ this)
  // we detach: it's theirs, no more syncing. Adoption is TEXT-ONLY — no keys are sent to the terminal
  // at adopt time; the send()-time pre-clear handles the stranded line only when the user actually
  // sends. See the adopt/sync effect below for the full state machine.
  const [adoptedDraft, setAdoptedDraft] = useState<string | null>(null);
  // Composer sheets are mutually exclusive — at most one open (Keys / Quick / Agent).
  const [drawer, setDrawer] = useState<ComposerDrawer>(null);
  const closeDrawer = () => setDrawer(null);
  // Two-tap guard for destructive commands (rm -rf, force-push, …): the first tap arms a "Really
  // send?" state on the Send button (auto-disarms after 3 s), the second actually sends. Same shared
  // confirm the command palette uses for /clear.
  const sendConfirm = usePendingConfirm();

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

  // Second guard against a false stranded-draft (the parent already stabilises across polls): if the
  // detected draft is what we JUST sent, it's our own reply still echoing on the "❯" line before the
  // bridge's pending Enter — suppress the chip AND the destructive clear-prefix on the next Send.
  // Recomputed each render (each poll re-renders), so it lapses on its own once the grace expires or
  // the echo resolves. A genuinely stranded draft (never matches a recent send) is untouched.
  const isInFlightEcho =
    terminalDraft !== null &&
    lastSentRef.current !== null &&
    Date.now() - lastSentRef.current.at < SENT_ECHO_GRACE_MS &&
    isSelfEcho(terminalDraft, lastSentRef.current.text);
  const effectiveDraft = isInFlightEcho ? null : terminalDraft;

  useImperativeHandle(ref, () => ({ focusInput: focusInputEnd }), []);

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

  // Are we currently mirroring a terminal draft, unedited? (adoptedDraft is only ever set together
  // with input, so this is true exactly while the auto-filled text is untouched.)
  const mirroring = adoptedDraft !== null && input === adoptedDraft;

  // Auto-adopt + sync state machine. Two disjoint cases:
  //   A — MIRRORING (adoptedDraft set, input unedited): follow the terminal draft. It CHANGED →
  //       update the input in place; it VANISHED (submitted/cleared in the terminal) → clear the
  //       input back to empty. Either way keep input and adoptedDraft in lockstep.
  //   B — ADOPT (not mirroring, input empty, a fresh non-dismissed stranded draft exists): auto-fill
  //       it. Text only — no keys go to the terminal here (read-only devices can't, and an unprompted
  //       write is wrong); the send()-time pre-clear sweeps the stranded line when the user sends.
  // Skipped entirely when the pane is gone. Read-only is allowed: adoption is display-only text.
  // The user detaching (editing/clearing) is handled in onInputChange, not here — a programmatic
  // setInput below never triggers onChange, so it can't be mistaken for a user edit.
  useEffect(() => {
    if (gone) return;
    if (adoptedDraft !== null && input === adoptedDraft) {
      if (effectiveDraft === null) {
        setInput("");
        setAdoptedDraft(null);
      } else if (effectiveDraft !== adoptedDraft) {
        setInput(effectiveDraft);
        setAdoptedDraft(effectiveDraft);
      }
      return;
    }
    if (
      adoptedDraft === null &&
      input === "" &&
      effectiveDraft !== null &&
      effectiveDraft !== dismissedDraft
    ) {
      setInput(effectiveDraft);
      setAdoptedDraft(effectiveDraft);
    }
  }, [effectiveDraft, adoptedDraft, input, dismissedDraft, gone]);

  // The user changed the composer text. If we were mirroring a terminal draft they've now taken
  // ownership — detach (stop syncing) and mark that draft handled so it neither re-adopts nor
  // re-chips (whether they edited it or cleared it back to empty). A no-op when nothing was adopted.
  function onInputChange(next: string) {
    if (adoptedDraft !== null && next !== adoptedDraft) detachAdopted();
    setInput(next);
  }

  // Detach the auto-adopted draft (user typed over it, inserted a command, added an image path, …):
  // stop mirroring and remember it as handled. The stranded terminal line is untouched — the
  // send()-time pre-clear deals with it if/when the user sends.
  function detachAdopted() {
    if (adoptedDraft === null) return;
    setDismissedDraft(adoptedDraft);
    setAdoptedDraft(null);
  }

  const commands = commandsFor(agent);

  function focusInputEnd() {
    setTimeout(() => {
      const el = inputRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      }
    }, 0);
  }

  async function send(value: string, isDraft: boolean) {
    const t = value.trim();
    if (!t || locked || sending) return;
    setSending(true);
    try {
      // Clear a stranded draft on the terminal's "❯" line before pane.send_text appends at cursor —
      // ctrl+k kills cursor→end, Backspace sweep kills the head (preview-action.ts pattern). Skip when
      // there's no draft: a blind sweep races the TUI and Enter can fire before the PTY settles. Uses
      // effectiveDraft, so our own in-flight echo never triggers a (destructive) clear of a message
      // that's already on its way.
      if (effectiveDraft !== null) {
        const clearCount = [...effectiveDraft].length + 8;
        const clearRes = await api.sendKeys(
          paneId,
          ["ctrl+k", ...Array(clearCount).fill("Backspace")],
          session,
        );
        if (!clearRes.ok) {
          setStatus(clearRes.error ?? "Couldn't clear the terminal input", "error");
          return;
        }
        scheduleKeyRevalidate();
        await new Promise((resolve) => setTimeout(resolve, TUI_SETTLE_MS));
      }

      const res = await api.sendReply(paneId, t, true, session);
      if (res.ok) {
        if (isDraft) {
          setInput("");
          setAdoptedDraft(null); // sent — drop the mirror so a later stranded draft can re-adopt
        }
        // Remember what/when we sent, so the next few polls recognise this text echoing on the "❯"
        // line as our own in-flight reply rather than a stranded draft (isInFlightEcho above).
        lastSentRef.current = { text: t, at: Date.now() };
        if (effectiveDraft !== null) setDismissedDraft(effectiveDraft);
        // ✓ flash on the send button + status line acknowledge the send immediately. The mirror only
        // echoes in 1–3s; the "You sent: …" pending preview keeps the typed text visible until it
        // lands (cleared by the next text update or a 6s safety timeout).
        setJustSent(true);
        if (sentTimer.current) clearTimeout(sentTimer.current);
        sentTimer.current = setTimeout(() => setJustSent(false), 1500);
        setStatus("Sent ✓", "success");
        const preview = t.length > 60 ? `${t.slice(0, 57)}…` : t;
        setLastSent(preview);
        if (lastSentTimerRef.current) clearTimeout(lastSentTimerRef.current);
        lastSentTimerRef.current = setTimeout(() => setLastSent(null), 6000);
        onSent(); // you just acted — snap the mirror back to the live tail to see the result
      } else {
        // textDelivered: text landed but Enter failed — keep the draft and surface the bridge's
        // partial-failure message so the user checks the pane instead of double-sending.
        setStatus(res.error ?? "Send failed", "error");
      }
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setSending(false);
    }
  }

  // Gate the composer's Send through the destructive-input confirm: a matching command arms the
  // "Really send?" state instead of sending; the confirming second tap goes through. Non-destructive
  // input sends immediately (and any stray armed state is cleared).
  function onSendClick() {
    const reason = isDestructiveInput(input);
    if (reason && !sendConfirm.confirm("send")) {
      setStatus(`Destructive: ${reason} — tap Send again to confirm`, "info");
      return;
    }
    sendConfirm.reset();
    send(input, true);
  }
  const confirmingSend = sendConfirm.pending === "send";

  // Coalesce revalidations from a burst of key presses into one trailing-edge refetch (~300ms).
  // Single presses still feel instant; arrow-key spam no longer triggers a refetch per key.
  function scheduleKeyRevalidate() {
    if (keyRevalidateTimer.current) clearTimeout(keyRevalidateTimer.current);
    keyRevalidateTimer.current = setTimeout(() => {
      keyRevalidateTimer.current = null;
      revalidator.revalidate();
    }, 300);
  }

  // Raw key send (nav tray). Silent on success — the mirror is the source of truth; only show errors.
  function pressKeys(k: string[]) {
    if (locked) return;
    api
      .sendKeys(paneId, k, session)
      .then((res) => {
        if (!res.ok) setStatus(res.error ?? "Key send failed", "error");
        else scheduleKeyRevalidate();
      })
      .catch((e) => setStatus(e instanceof Error ? e.message : String(e), "error"));
  }

  // Insert "/cmd " into the composer (arg-taking commands) and focus it. Appends to any draft already
  // typed (with a separating space) rather than clobbering it; an empty draft just gets set.
  function insertCommand(value: string) {
    detachAdopted(); // the user is now composing by hand — stop mirroring the terminal draft
    setInput((prev) => (prev.trim() ? `${prev.trimEnd()} ${value}` : value));
    focusInputEnd();
  }

  // Recover a draft stranded on the terminal's "❯" line (extractInputDraft surfaced it as the chip).
  // Two moves, in order: (1) clear the terminal line so the next pane.send_text isn't corrupted —
  // one Backspace per code point plus a harmless overshoot (extra Backspace on an empty input is a
  // no-op); (2) only if that succeeds, adopt the text into the composer (set an empty draft, else
  // append on a new line, mirroring insertCommand's set-or-append). On failure we surface the error
  // and leave the composer alone — the text is still in the terminal, so we mustn't duplicate it.
  async function recoverDraft() {
    if (effectiveDraft === null || locked || recovering) return;
    const draft = effectiveDraft;
    setRecovering(true);
    try {
      const n = [...draft].length + 8;
      const res = await api.sendKeys(paneId, Array(n).fill("Backspace"), session);
      if (res.ok) {
        detachAdopted(); // recovering by hand — stop any stale mirror before we append the draft
        setInput((prev) => (prev.trim() ? `${prev.trimEnd()}\n${draft}` : draft));
        focusInputEnd();
        scheduleKeyRevalidate();
        // Mark it dismissed so the chip doesn't flash back before the mirror echoes the cleared line.
        setDismissedDraft(draft);
      } else {
        setStatus(res.error ?? "Couldn't clear the terminal draft", "error");
      }
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setRecovering(false);
    }
  }

  // The chip is the FALLBACK for when auto-adoption can't apply: the composer already holds other
  // text (input non-empty) so we can't quietly drop the draft into it. It shows only when there's a
  // live stranded draft, the composer can write, no send is in flight, the user hasn't dismissed this
  // exact draft, and we're not mirroring it (an adopted draft is already visible in the editor —
  // showing a chip too would be redundant). Preview truncates like the send preview.
  const showDraftChip =
    effectiveDraft !== null &&
    !locked &&
    !sending &&
    effectiveDraft !== dismissedDraft &&
    input !== "" &&
    !mirroring;
  const draftPreview =
    effectiveDraft && effectiveDraft.length > 60 ? `${effectiveDraft.slice(0, 57)}…` : effectiveDraft;

  // Upload an image; on success append its host path to the composer so the user can add context.
  async function onPickImage(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file
    if (!file || locked) return;
    setUploading(true);
    try {
      const res = await api.uploadImage(paneId, file, session);
      if (res.ok) {
        const path = res.path;
        detachAdopted(); // the user is now composing by hand — stop mirroring the terminal draft
        setInput((prev) => (prev.trim() ? `${prev.trimEnd()} ${path}` : path));
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

  return (
    <>
      <div className="border-t border-border/60 bg-zinc-800 px-3 pb-[calc(env(safe-area-inset-bottom)_+_0.5rem)] pt-2.5">
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
        {/* Display prefs (wrap + font size) on their own compact, right-aligned row. Kept off the
            Keys/Quick/Agent action row below — three extra buttons there overflowed a narrow phone
            and broke the layout. */}
        <div className="mb-2 flex items-center gap-1">
          <SectionLabel>View</SectionLabel>
          <div className="ml-auto flex items-center gap-1">
            {/* Find in output — search the already-fetched pane buffer without leaving the pane.
                Lives here (not the header) so search sits with the other view controls; only shown
                when AgentChat passes a handler (i.e. there's buffered output to search). */}
            {onOpenFind && (
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-muted-foreground"
                onClick={onOpenFind}
                aria-label="Find in output"
                title="Find in output"
              >
                <Search className="size-3.5" />
              </Button>
            )}
            {/* Raw-terminal escape hatch: turns off the block renderer (native prompt buttons, chrome
                strip, status strip) so a mis-parsed dialog can always be driven by hand with the keys
                pad. Highlighted when active so it's obvious the plain mirror is showing. */}
            <Button
              variant={prefs.rawTerminal ? "secondary" : "ghost"}
              size="icon"
              className="h-7 w-7 text-muted-foreground"
              onClick={() => setRawTerminal(!prefs.rawTerminal)}
              aria-label={
                prefs.rawTerminal
                  ? "Raw terminal on — tap for the enhanced view"
                  : "Raw terminal off — tap to show the plain terminal"
              }
              aria-pressed={prefs.rawTerminal}
              title="Toggle raw terminal (disable native prompt buttons)"
            >
              <Terminal className="size-3.5" />
            </Button>
            <Button
              variant={prefs.wrap ? "secondary" : "ghost"}
              size="icon"
              className="h-7 w-7 text-muted-foreground"
              onClick={() => setWrap(!prefs.wrap)}
              aria-label={prefs.wrap ? "Wrap on — tap to disable" : "Wrap off — tap to enable"}
              aria-pressed={prefs.wrap}
              title="Toggle line wrap"
            >
              <WrapText className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground"
              disabled={prefs.fontSize <= 9}
              onClick={() => stepFontSize(-1)}
              aria-label="Decrease font size"
              title="Smaller text"
            >
              <AArrowDown className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground"
              disabled={prefs.fontSize >= 16}
              onClick={() => stepFontSize(1)}
              aria-label="Increase font size"
              title="Larger text"
            >
              <AArrowUp className="size-3.5" />
            </Button>
          </div>
        </div>
        {/* Keys / Quick dock — a single in-flow site ABOVE the Controls row (so the toggle you tapped
            stays put and the panel grows over the mirror, not the input). Whichever of the mutually
            exclusive drawers is active renders here via the shared ComposerDock chrome. Keys mounts
            the NavTray (unmounts on close, so tab/queue reset each open); Quick mounts the two
            one-tap reply grids. Agent stays a covering BottomSheet below (it's a palette, not a pad). */}
        {drawer === "keys" && (
          <ComposerDock title="Keys" onClose={closeDrawer}>
            <NavTray onSend={pressKeys} disabled={locked} />
          </ComposerDock>
        )}
        {drawer === "quick" && (
          <ComposerDock title="Quick" onClose={closeDrawer}>
            <QuickActionsContent
              onSend={(t) => send(t, false)}
              onClose={closeDrawer}
              disabled={locked || sending}
            />
          </ComposerDock>
        )}
        {/* Action row: Keys · Quick · Agent (Agent only when the pane's agent has commands). */}
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
            onClick={() => setDrawer(drawer === "keys" ? null : "keys")}
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
            onClick={() => setDrawer(drawer === "quick" ? null : "quick")}
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
              onClick={() => setDrawer("cmd")}
            >
              <Slash className="size-4" />
              Agent
            </Button>
          )}
        </div>
        {/* Terminal-draft recovery chip (fallback path): a message queued-then-recalled lands on the
            terminal's "❯" line and stripChrome hides it from the mirror; worse, the next send appends
            to it. When the composer is empty we auto-adopt it into the input silently; but when you're
            already typing something else, this slim strip surfaces it instead with a one-tap "Edit
            here" (clear the line, append the text) and a dismiss. Same zinc/text-xs chrome as the
            "You sent:" strip above. */}
        {showDraftChip && (
          <div className="mb-2 flex items-center gap-1.5 rounded-md bg-muted/40 px-2.5 py-1.5 text-xs text-muted-foreground">
            <Terminal className="size-3 shrink-0" />
            <span className="min-w-0 flex-1 truncate">
              <span className="font-medium">Draft in terminal:</span> &ldquo;{draftPreview}&rdquo;
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 shrink-0 px-2 text-xs font-medium"
              onClick={recoverDraft}
              disabled={recovering}
            >
              {recovering ? <Loader2 className="size-3 animate-spin" /> : "Edit here"}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-6 shrink-0 text-muted-foreground"
              onClick={() => setDismissedDraft(effectiveDraft)}
              aria-label="Dismiss terminal draft"
            >
              <X className="size-3.5" />
            </Button>
          </div>
        )}
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
            onChange={(e) => onInputChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                onSendClick();
              }
            }}
            placeholder={
              gone
                ? "Pane is gone"
                : readOnly
                  ? "Read-only — device not authorised"
                  : isShell
                    ? "Type a shell command…"
                    : "Type a reply…"
            }
            disabled={locked}
            rows={1}
          />
          {confirmingSend ? (
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
