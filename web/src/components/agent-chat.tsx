import { useEffect, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { useNavigate, useRevalidator } from "react-router";
import { AArrowDown, AArrowUp, Check, Home, ImagePlus, Keyboard, Layers, Loader2, Send, Slash, TerminalSquare, WrapText, Zap } from "lucide-react";
import { useSwipeUp } from "@/hooks/use-swipe";
import { useKeyboardOpen } from "@/hooks/use-keyboard";
import { useSpaceActions } from "@/hooks/use-spaces";
import { useDisplayPrefs } from "@/hooks/use-display-prefs";
import { setStatus } from "@/lib/status";
import { Button } from "@/components/ui/button";
import { ChatInput } from "@/components/ui/chat/chat-input";
import { ChatMessageList, type ChatMessageListHandle } from "@/components/ui/chat/chat-message-list";
import { BottomSheet, SideSheet } from "@/components/ui/sheet";
import { AnsiOutput } from "@/components/ansi-output";
import { NavTray } from "@/components/nav-tray";
import { CommandPalette } from "@/components/command-palette";
import { QuickActions } from "@/components/quick-actions";
import { ThreadSidebar } from "@/components/agent-sidebar";
import { AgentIcon } from "@/components/agent-icon";
import { SpaceList } from "@/components/space-list";
import { TabStrip } from "@/components/tab-strip";
import { PaneStrip } from "@/components/pane-strip";
import { ReadOnlyBanner } from "@/components/read-only-banner";
import { SectionLabel } from "@/components/ui/section-label";
import { StatusArea } from "@/components/status-area";
import { ShellBadge, StatusBadge } from "@/components/status-badge";
import * as api from "@/lib/api";
import { commandsFor } from "@/lib/agent-commands";
import { shortCwd } from "@/lib/format";
import { navigateWithTransition } from "@/lib/view-transition";
import { isReadOnly } from "@/lib/types";
import type { AgentView, DeviceAuth, TabView, WorkspaceView } from "@/lib/types";

interface AgentChatProps {
  paneId: string;
  agent: AgentView | undefined;
  agents: AgentView[];
  shellPanes: AgentView[];
  workspaces: WorkspaceView[];
  tabs: TabView[];
  /** Label of the pane's tab, shown in the header as "space › tab". */
  tabLabel?: string;
  /** Pane output from the route loader (refreshed by polling/revalidation). */
  text: string;
  /** Per-device auth from the snapshot; an unauthorised device drops the composer to read-only. */
  device?: DeviceAuth;
  onBack: () => void;
  onSelect: (paneId: string) => void;
}

// At most one drawer/sheet is open at a time; null = none.
type Drawer = "nav" | "switcher" | "quick" | "cmd" | "keys" | null;

// The detail view mirrors a terminal pane, NOT a chat thread. The pane's output comes from the
// route loader (`text`); polling revalidates it. Replies/keys are confirmed via the header status
// line (`setStatus`), then a revalidation pulls the fresh output.
//
// The composer offers what a phone keyboard can't: quick actions, an agent-aware slash-command
// palette, an inline key tray (via `pane.send_keys`), one-tap Stop, and image upload. Navigation
// (spaces + panes) lives in the nav hub (the left drawer) — Home sits in its header, each pane row
// carries its own ✕ to close it, and a new space/tab is created from the SPACES "+" or a pane's tab
// strip. The swipe-up handle is a quick pane switcher.
export function AgentChat({
  paneId,
  agent,
  agents,
  shellPanes,
  workspaces,
  tabs,
  tabLabel,
  text,
  device,
  onBack,
  onSelect,
}: AgentChatProps) {
  const revalidator = useRevalidator();
  const navigate = useNavigate();
  const { newTab, newSpace } = useSpaceActions();
  const { prefs, setWrap, stepFontSize } = useDisplayPrefs();
  const isShell = agent?.kind === "shell";
  // This device isn't allowlisted to type into agents: the backend rejects every write, so we drop
  // the composer + controls to read-only and show a banner. The mirror still polls (reading is fine).
  const readOnly = isReadOnly(device);

  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [closingId, setClosingId] = useState<string | null>(null);
  // Pending-send preview: set on a successful send, cleared when the mirror catches up (next text
  // update) or after a 6s safety timeout. Shows "You sent: …" above the composer so the user
  // knows the message landed while waiting for the mirror to echo it back.
  const [lastSent, setLastSent] = useState<string | null>(null);
  const lastSentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Drawers/sheets are mutually exclusive — at most one open. A single value makes that invariant
  // unrepresentable to violate (vs five independent booleans that must be hand-synced).
  const [drawer, setDrawer] = useState<Drawer>(null);
  const closeDrawer = () => setDrawer(null);
  // Show the quick-key row (1–5 / Esc / Enter) only while the composer is focused AND the soft
  // keyboard is actually up. Focus alone isn't enough: collapsing the Android keyboard leaves the
  // textarea focused (no blur fires), so we also watch the viewport via useKeyboardOpen — which
  // catches the collapse — and hide the row the moment the keyboard goes down.
  const [composerFocused, setComposerFocused] = useState(false);
  const keyboardOpen = useKeyboardOpen();
  const [justSent, setJustSent] = useState(false); // brief ✓ on the send button after a send
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<ChatMessageListHandle>(null);
  const sentTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (sentTimer.current) clearTimeout(sentTimer.current);
      if (lastSentTimerRef.current) clearTimeout(lastSentTimerRef.current);
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
  const gone = !agent;
  // Every write affordance (composer, keys, quick actions, create) is off when the pane is gone OR
  // this device is read-only. Pane-existence-only concerns (placeholder copy, the bounce-home
  // effect) keep using `gone`.
  const locked = gone || readOnly;

  // Swipe up (or just tap) the handle above the composer to bring up the pane switcher. A lowish
  // threshold + a taller hit area (below) make the gesture easy to land with a thumb; tapping is the
  // reliable fallback. "Up" naturally reveals a bottom sheet without fighting the mirror's scroll.
  const swipe = useSwipeUp(() => setDrawer("switcher"), 24);

  // Mirror freeze: at the bottom we follow live output; the moment you scroll up to read backscroll
  // we hold the text steady (no reflow / no re-pin) until you jump back to latest — so a long
  // message stays put long enough to read instead of sliding out of the rolling window.
  const [following, setFollowing] = useState(true);
  const [display, setDisplay] = useState(text);
  useEffect(() => {
    if (following) setDisplay(text);
  }, [text, following]);
  const hasNew = !following && display !== text;

  const commands = commandsFor(agent?.agent);

  // NOTE: the composer is deliberately NOT auto-focused on open/switch — that would pop the Android
  // keyboard and cover the output. You read the pane first, then tap the input to type. (Explicit
  // actions like picking a slash-command or uploading an image still focus it, via focusInputEnd.)

  // Switch to another thread from the sidebar or the swipe-up switcher (DetailRoute keys AgentChat
  // by pane, so this remounts fresh — composer resets — same as opening from home).
  function switchTo(id: string) {
    closeDrawer();
    if (id !== paneId) onSelect(id);
  }

  // Jump to another tab in this space by opening one of its panes (the in-pane tab bar).
  function goToTab(tabId: string) {
    if (!agent || tabId === agent.tabId) return;
    const target = [...agents, ...shellPanes].find((p) => p.tabId === tabId);
    if (target) switchTo(target.paneId);
  }

  // Open a space from the nav hub — go to its home view (its tabs + panes, incl. shells). A step
  // back up out of the pane, so it slides backward.
  function openSpace(workspaceId: string) {
    closeDrawer();
    navigateWithTransition(navigate, "/", "backward", { state: { space: workspaceId } });
  }

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
        // echoes in 1–3s; the "You sent: …" pending preview below the controls keeps the typed text
        // visible until it lands (cleared by the next text update or a 6s safety timeout).
        setJustSent(true);
        if (sentTimer.current) clearTimeout(sentTimer.current);
        sentTimer.current = setTimeout(() => setJustSent(false), 1500);
        setStatus("Sent ✓", "success");
        const preview = t.length > 60 ? `${t.slice(0, 57)}…` : t;
        setLastSent(preview);
        if (lastSentTimerRef.current) clearTimeout(lastSentTimerRef.current);
        lastSentTimerRef.current = setTimeout(() => setLastSent(null), 6000);
        setFollowing(true); // you just acted — snap back to the live tail to see the result
        revalidator.revalidate();
        listRef.current?.scrollToBottom();
      } else {
        setStatus(res.error ?? "Send failed", "error");
      }
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setSending(false);
    }
  }

  // Raw key send (nav tray). Silent on success — the mirror is the source of truth; only show errors.
  function pressKeys(k: string[]) {
    if (locked) return;
    api
      .sendKeys(paneId, k)
      .then((res) => {
        if (!res.ok) setStatus(res.error ?? "Key send failed", "error");
        else revalidator.revalidate();
      })
      .catch((e) => setStatus(e instanceof Error ? e.message : String(e), "error"));
  }

  // Close a pane from the nav drawer's per-row ✕. Closing the pane you're viewing returns Home (the
  // return is the confirmation, no toast); closing any other just revalidates so it drops out of the
  // list. One close at a time (closingId gates re-entry and drives the row spinner).
  async function closePane(id: string) {
    if (closingId) return;
    if (readOnly) {
      setStatus("Read-only — device not authorised", "error");
      return;
    }
    setClosingId(id);
    try {
      const res = await api.closePane(id);
      if (res.ok) {
        if (id === paneId) onBack();
        else revalidator.revalidate();
      } else {
        setStatus(res.error ?? "Close failed", "error");
      }
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setClosingId(null);
    }
  }

  // Insert "/cmd " into the composer (arg-taking commands) and focus it.
  function insertCommand(value: string) {
    setInput(value);
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
    <div className="flex h-[100dvh] flex-col">
      {/* Header */}
      <header className="sticky top-0 z-20 flex items-center gap-2 border-b border-border/60 bg-background/85 px-2 py-2 backdrop-blur-md [padding-top:calc(env(safe-area-inset-top)_+_0.5rem)] app-header">
        <Button variant="ghost" size="icon" onClick={() => setDrawer("nav")} aria-label="Navigate">
          <Layers className="size-5" />
        </Button>
        {/* Title block: the space › tab leads, with the agent's brand logo to its left (the agent
            name would just repeat the icon, so it's dropped), and the working directory on the
            subline. Tapping it leaves the pane for the space overview (all its tabs + panes). */}
        {agent ? (
          <button
            type="button"
            onClick={() => openSpace(agent.workspaceId)}
            aria-label={`Open ${agent.workspaceLabel} overview`}
            className="-mx-1 flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-1 py-0.5 text-left transition-colors active:bg-muted/60"
          >
            {isShell ? (
              <div className="flex size-8 shrink-0 items-center justify-center rounded-full border bg-muted">
                <TerminalSquare className="size-4 text-muted-foreground" />
              </div>
            ) : (
              <AgentIcon agent={agent.agent} className="size-8" />
            )}
            <div className="min-w-0 flex-1">
              <div className="truncate font-semibold leading-tight">
                {agent.workspaceLabel}
                {tabLabel ? ` › ${tabLabel}` : ""}
              </div>
              <div className="truncate font-mono text-xs leading-tight text-muted-foreground">
                {shortCwd(agent.cwd)}
              </div>
            </div>
          </button>
        ) : (
          <div className="min-w-0 flex-1">
            <span className="truncate font-semibold">(agent gone)</span>
          </div>
        )}
        {/* The status pill is the live indicator — polling refreshes the mirror on its own, so
            there's no manual refresh button. A bare shell shows a muted "shell" tag instead. */}
        {agent && (isShell ? <ShellBadge /> : <StatusBadge status={agent.status} />)}
      </header>

      {/* Read-only notice when this device isn't allowlisted (the composer below is disabled too). */}
      <ReadOnlyBanner device={device} />

      {/* In-pane tab bar: the current space's tabs above the mirror — switch tab without leaving the
          pane, or create one with +. No "All" here (you're always in a specific tab). */}
      {agent && (
        <TabStrip
          workspaceId={agent.workspaceId}
          tabs={tabs}
          agents={agents}
          selected={agent.tabId}
          onSelect={(id) => id && goToTab(id)}
          onNewTab={newTab}
          allowAll={false}
        />
      )}

      {/* Pane switcher: the panes that share this tab (space › tab › pane). Mobile shows them as a
          tabbed row rather than tiling the panes; only appears when the tab holds more than one. */}
      {agent && (
        <PaneStrip
          panes={[...agents, ...shellPanes]
            .filter((p) => p.workspaceId === agent.workspaceId && p.tabId === agent.tabId)
            .sort((a, b) => a.paneId.localeCompare(b.paneId))}
          currentPaneId={paneId}
          onSelect={switchTo}
        />
      )}

      {/* Terminal mirror — tapping it focuses the composer so you can start typing right away. */}
      <div className="min-h-0 flex-1" onClick={focusInputEnd}>
        <ChatMessageList
          ref={listRef}
          dep={display}
          onAtBottomChange={setFollowing}
          hasNew={hasNew}
          className="gap-0 px-2 py-3"
        >
          {display ? (
            <AnsiOutput text={display} wrap={prefs.wrap} fontSize={prefs.fontSize} />
          ) : (
            <div className="py-16 text-center text-sm text-muted-foreground">(no recent output)</div>
          )}
        </ChatMessageList>
      </div>

      {/* Bottom region: the status line floats as a slim overlay above the tray + composer, so it
          tells you what last happened then vanishes — never pushing or shifting content. */}
      <div className="relative">
        <div className="pointer-events-none absolute inset-x-0 bottom-full px-3 pb-1.5">
          <StatusArea />
        </div>

        {/* Swipe-up / tap handle for the quick pane switcher. A tall, full-width hit area so the
            swipe is easy to land (and a tap always works). Hidden when there's nothing to switch
            to. `touch-none` so the gesture is ours, not a browser scroll. */}
        {agents.length + shellPanes.length > 1 && (
          <button
            type="button"
            aria-label="Switch pane"
            {...swipe}
            onClick={() => setDrawer("switcher")}
            className="flex w-full touch-none items-center justify-center py-3.5 transition-colors active:bg-muted/50"
          >
            <span className="h-1.5 w-12 rounded-full bg-muted-foreground/50" />
          </button>
        )}

        {/* Composer */}
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
                send(input, true);
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
          <Button
            size="icon"
            className="size-11 shrink-0 rounded-full"
            onClick={() => send(input, true)}
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
        </div>
        </div>
      </div>

      {/* Nav hub (left drawer): the Herdr-style two lists — SPACES over PANES (agents + shells).
          Home lives in the header; each pane row has its own ✕ to close it (two-tap confirm). */}
      <SideSheet
        open={drawer === "nav"}
        onClose={closeDrawer}
        title="Navigate"
        headerAction={
          <Button
            variant="ghost"
            size="sm"
            className="h-8 gap-1.5 px-2 text-muted-foreground"
            onClick={() => {
              closeDrawer();
              onBack();
            }}
          >
            <Home className="size-4" />
            Home
          </Button>
        }
      >
        <SpaceList
          workspaces={workspaces}
          agents={agents}
          currentWorkspaceId={agent?.workspaceId}
          onSelect={openSpace}
          onNewSpace={() => {
            closeDrawer();
            newSpace();
          }}
        />
        <ThreadSidebar
          agents={agents}
          shellPanes={shellPanes}
          currentPaneId={paneId}
          onSelect={switchTo}
          onClose={closePane}
          closingId={closingId ?? undefined}
        />
      </SideSheet>

      {/* Swipe-up quick switcher — just the panes (agents + shells), reached by the thumb gesture */}
      <BottomSheet open={drawer === "switcher"} onClose={closeDrawer} title="Switch pane">
        <ThreadSidebar
          agents={agents}
          shellPanes={shellPanes}
          currentPaneId={paneId}
          onSelect={switchTo}
          onClose={closePane}
          closingId={closingId ?? undefined}
          className="px-0 py-1"
        />
      </BottomSheet>

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
        agent={agent?.agent}
        onInsert={insertCommand}
        onSubmit={(t) => send(t, false)}
      />
    </div>
  );
}
