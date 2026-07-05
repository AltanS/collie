import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { useRevalidator } from "react-router";
import { AArrowDown, AArrowUp, Check, ImagePlus, Keyboard, Loader2, Send, Slash, Terminal, WrapText, Zap } from "lucide-react";

import { useKeyboardOpen } from "@/hooks/use-keyboard";
import type { DisplayPrefs } from "@/hooks/use-display-prefs";
import { usePendingConfirm } from "@/hooks/use-pending-confirm";
import { setStatus } from "@/lib/status";
import { Button } from "@/components/ui/button";
import { ChatInput } from "@/components/ui/chat/chat-input";
import { BottomSheet } from "@/components/ui/sheet";
import { NavTray } from "@/components/nav-tray";
import { CommandPalette } from "@/components/command-palette";
import { QuickActions } from "@/components/quick-actions";
import { SectionLabel } from "@/components/ui/section-label";
import * as api from "@/lib/api";
import { commandsFor } from "@/lib/agent-commands";
import { isDestructiveInput } from "@/lib/destructive";

export interface ComposerHandle {
  /** Focus the input and put the caret at the end — used by the mirror-tap-to-focus in AgentChat. */
  focusInput: () => void;
}

interface ComposerProps {
  paneId: string;
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
type ComposerDrawer = "quick" | "cmd" | "keys" | null;

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(
  { paneId, agent, isShell, gone, readOnly, text, prefs, setWrap, stepFontSize, setRawTerminal, onSent },
  ref,
) {
  const revalidator = useRevalidator();
  // Show the quick-key row (1–5 / Esc / Enter) only while the composer is focused AND the soft
  // keyboard is actually up. Focus alone isn't enough: collapsing the Android keyboard leaves the
  // textarea focused (no blur fires), so we also watch the viewport via useKeyboardOpen — which
  // catches the collapse — and hide the row the moment the keyboard goes down.
  const keyboardOpen = useKeyboardOpen();
  // Every write affordance is off when the pane is gone OR this device is read-only.
  const locked = gone || readOnly;

  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  // Pending-send preview: set on a successful send, cleared when the mirror catches up (next text
  // update) or after a 6s safety timeout. Shows "You sent: …" so the user knows the message landed.
  const [lastSent, setLastSent] = useState<string | null>(null);
  const [composerFocused, setComposerFocused] = useState(false);
  const [justSent, setJustSent] = useState(false); // brief ✓ on the send button after a send
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
  // Trailing-edge debounce for post-keypress revalidation: a burst of raw key sends (arrow-key
  // spam) coalesces into a single pane refetch instead of one per press.
  const keyRevalidateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
      const res = await api.sendReply(paneId, t, true);
      if (res.ok) {
        if (isDraft) setInput("");
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
      .sendKeys(paneId, k)
      .then((res) => {
        if (!res.ok) setStatus(res.error ?? "Key send failed", "error");
        else scheduleKeyRevalidate();
      })
      .catch((e) => setStatus(e instanceof Error ? e.message : String(e), "error"));
  }

  // Insert "/cmd " into the composer (arg-taking commands) and focus it. Appends to any draft already
  // typed (with a separating space) rather than clobbering it; an empty draft just gets set.
  function insertCommand(value: string) {
    setInput((prev) => (prev.trim() ? `${prev.trimEnd()} ${value}` : value));
    focusInputEnd();
  }

  // Upload an image; on success append its host path to the composer so the user can add context.
  async function onPickImage(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file
    if (!file || locked) return;
    setUploading(true);
    try {
      const res = await api.uploadImage(paneId, file);
      if (res.ok) {
        const path = res.path;
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
      <div className="border-t border-border/60 bg-background/95 px-3 pb-[calc(env(safe-area-inset-bottom)_+_0.5rem)] pt-2.5 backdrop-blur-md">
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

        {/* Quick keys — shown only while the composer is focused and the keyboard is actually up.
            Row 1: navigation (← ↑ ↓ → Tab Esc ⏎ 📷) — drive selection menus while watching the
            mirror; Row 2: digit shortcuts (1–5). All fire on pointer-down + preventDefault so the
            textarea keeps focus and the soft keyboard stays up. Key names match the verified
            HERDR_API.md grammar (Left/Right/Up/Down/Tab/Escape/Enter). */}
        {composerFocused && keyboardOpen && !locked && (
          <div className="mb-2 space-y-1">
            {/* Row 1: navigation keys — arrows + Tab + Esc + Enter + image attach */}
            <div className="grid grid-cols-8 gap-1">
              {(
                [
                  { label: "←", keys: ["Left"], aria: "Left" },
                  { label: "↑", keys: ["Up"], aria: "Up" },
                  { label: "↓", keys: ["Down"], aria: "Down" },
                  { label: "→", keys: ["Right"], aria: "Right" },
                  { label: "Tab", keys: ["Tab"], aria: "Tab" },
                  { label: "Esc", keys: ["Escape"], aria: "Escape" },
                  { label: "⏎", keys: ["Enter"], aria: "Enter" },
                ] as const
              ).map(({ label, keys, aria }) => (
                <Button
                  key={aria}
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-9 px-0 text-xs font-medium"
                  onPointerDown={(e) => e.preventDefault()}
                  onClick={() => pressKeys([...keys])}
                  aria-label={aria}
                >
                  {label}
                </Button>
              ))}
              {/* Attach image — only while the keyboard is up (used rarely; grouped with the keys
                  row rather than taking permanent space). preventDefault keeps the textarea focused
                  so the row doesn't unmount before the picker opens. */}
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-9 px-0"
                disabled={uploading}
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => fileRef.current?.click()}
                aria-label="Attach image"
              >
                {uploading ? <Loader2 className="size-4 animate-spin" /> : <ImagePlus className="size-4" />}
              </Button>
            </div>
            {/* Row 2: digit shortcuts for numbered agent menus */}
            <div className="grid grid-cols-5 gap-1">
              {["1", "2", "3", "4", "5"].map((d) => (
                <Button
                  key={d}
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-9 px-0 font-mono text-sm"
                  onPointerDown={(e) => e.preventDefault()}
                  onClick={() => pressKeys([d])}
                >
                  {d}
                </Button>
              ))}
            </div>
          </div>
        )}

        {/* File input stays mounted here (not inside the keyboard-only key row) so the picker
            callback survives the keyboard collapsing. Attach-image fires it from the key row above;
            structural commands (New tab/space, Kill) and Stop (Esc, in the Keys sheet) live elsewhere. */}
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={onPickImage} />
        {/* Display prefs (wrap + font size) on their own compact, right-aligned row. Kept off the
            Keys/Quick/Agent action row below — three extra buttons there overflowed a narrow phone
            and broke the layout. */}
        <div className="mb-2 flex items-center gap-1">
          <SectionLabel>View</SectionLabel>
          <div className="ml-auto flex items-center gap-1">
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
        {/* Action row: Keys · Quick · Agent (Agent only when the pane's agent has commands). */}
        <div className="mb-2 flex items-center gap-2">
          <SectionLabel>Controls</SectionLabel>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 flex-1 gap-1.5 text-muted-foreground"
            disabled={locked}
            onClick={() => setDrawer("keys")}
          >
            <Keyboard className="size-4" />
            Keys
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 flex-1 gap-1.5 text-muted-foreground"
            disabled={locked}
            onClick={() => setDrawer("quick")}
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
        <div className="flex items-end gap-2">
          <ChatInput
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onFocus={() => setComposerFocused(true)}
            onBlur={() => setComposerFocused(false)}
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
                    : "Type or dictate a reply…"
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

      {/* Quick actions */}
      <QuickActions
        open={drawer === "quick"}
        onClose={closeDrawer}
        onSend={(t) => send(t, false)}
        disabled={locked || sending}
      />

      {/* Keys — same bottom-sheet behaviour as Quick; stays open so you can press several keys */}
      <BottomSheet open={drawer === "keys"} onClose={closeDrawer} title="Keys">
        <NavTray onSend={pressKeys} disabled={locked} />
      </BottomSheet>

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
