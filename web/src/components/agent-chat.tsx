import { useEffect, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { useNavigate, useRevalidator } from "react-router-dom";
import { Check, ImagePlus, Keyboard, Layers, Loader2, Send, Slash, Zap } from "lucide-react";
import { useSwipeUp } from "@/hooks/use-swipe";
import { useSpaceActions } from "@/hooks/use-spaces";
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
import { SpaceList } from "@/components/space-list";
import { TabStrip } from "@/components/tab-strip";
import { NavCommands } from "@/components/nav-commands";
import { StatusArea } from "@/components/status-area";
import { StatusBadge } from "@/components/status-badge";
import * as api from "@/lib/api";
import { commandsFor } from "@/lib/agent-commands";
import { shortCwd } from "@/lib/format";
import type { AgentView, TabView, WorkspaceView } from "@/lib/types";

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
  onBack: () => void;
  onSelect: (paneId: string) => void;
}

// The detail view mirrors a terminal pane, NOT a chat thread. The pane's output comes from the
// route loader (`text`); polling revalidates it. Replies/keys are confirmed via the header status
// line (`setStatus`), then a revalidation pulls the fresh output.
//
// The composer offers what a phone keyboard can't: quick actions, an agent-aware slash-command
// palette, an inline key tray (via `pane.send_keys`), one-tap Stop, and image upload. Navigation
// (spaces + panes) and structural commands (New tab/space, Kill) live in the nav hub (the left
// drawer); the swipe-up handle is a quick pane switcher.
export function AgentChat({
  paneId,
  agent,
  agents,
  shellPanes,
  workspaces,
  tabs,
  tabLabel,
  text,
  onBack,
  onSelect,
}: AgentChatProps) {
  const revalidator = useRevalidator();
  const navigate = useNavigate();
  const { newTab, newSpace } = useSpaceActions();
  const isShell = agent?.kind === "shell";

  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [killing, setKilling] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  const [cmdOpen, setCmdOpen] = useState(false);
  const [keysOpen, setKeysOpen] = useState(false);
  // Show the quick-key row (1–5 / Esc / Enter) only while the composer is focused — i.e. the soft
  // keyboard is up. Focus is the reliable signal here; visualViewport height-deltas read ~0 because
  // the viewport meta uses interactive-widget=resizes-content (layout + visual shrink together).
  const [composerFocused, setComposerFocused] = useState(false);
  const [justSent, setJustSent] = useState(false); // brief ✓ on the send button after a send
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<ChatMessageListHandle>(null);
  const sentTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (sentTimer.current && clearTimeout(sentTimer.current)), []);
  const gone = !agent;

  // Swipe up (or just tap) the handle above the composer to bring up the pane switcher. A lowish
  // threshold + a taller hit area (below) make the gesture easy to land with a thumb; tapping is the
  // reliable fallback. "Up" naturally reveals a bottom sheet without fighting the mirror's scroll.
  const swipe = useSwipeUp(() => setSwitcherOpen(true), 24);

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
    setNavOpen(false);
    setSwitcherOpen(false);
    if (id !== paneId) onSelect(id);
  }

  // Jump to another tab in this space by opening one of its panes (the in-pane tab bar).
  function goToTab(tabId: string) {
    if (!agent || tabId === agent.tabId) return;
    const target = [...agents, ...shellPanes].find((p) => p.tabId === tabId);
    if (target) switchTo(target.paneId);
  }

  // Open a space from the nav hub — go to its home view (its tabs + panes, incl. shells).
  function openSpace(workspaceId: string) {
    setNavOpen(false);
    navigate("/", { state: { space: workspaceId } });
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
    if (!t || gone || sending) return;
    setSending(true);
    try {
      const res = await api.sendReply(paneId, t, true);
      if (res.ok) {
        if (isDraft) setInput("");
        // No success toast: the composer clears and the mirror updates on revalidate. A brief ✓ on
        // the send button is the only tap-site acknowledgment (errors still surface via setStatus).
        setJustSent(true);
        if (sentTimer.current) clearTimeout(sentTimer.current);
        sentTimer.current = setTimeout(() => setJustSent(false), 1500);
        setFollowing(true); // you just acted — snap back to the live tail to see the result
        revalidator.revalidate();
        listRef.current?.scrollToBottom();
      } else {
        setStatus(res.error ?? "Send failed", "error");
      }
    } catch (e) {
      setStatus((e as Error).message, "error");
    } finally {
      setSending(false);
    }
  }

  // Raw key send (nav tray). Silent on success — the mirror is the source of truth; only show errors.
  function pressKeys(k: string[]) {
    if (gone) return;
    api
      .sendKeys(paneId, k)
      .then((res) => {
        if (!res.ok) setStatus(res.error ?? "Key send failed", "error");
        else revalidator.revalidate();
      })
      .catch((e) => setStatus((e as Error).message, "error"));
  }

  // Kill the agent by closing its pane, then return Home (the pane is gone).
  async function killAgent() {
    if (gone || killing) return;
    setKilling(true);
    try {
      const res = await api.closePane(paneId);
      if (res.ok) {
        onBack(); // returning Home (the pane is gone) is the confirmation — no toast needed
      } else {
        setStatus(res.error ?? "Kill failed", "error");
      }
    } catch (e) {
      setStatus((e as Error).message, "error");
    } finally {
      setKilling(false);
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
    if (!file || gone) return;
    setUploading(true);
    try {
      const res = await api.uploadImage(paneId, file);
      if (res.ok && res.path) {
        const path = res.path;
        setInput((prev) => (prev.trim() ? `${prev.trimEnd()} ${path}` : path));
        focusInputEnd();
        setStatus("Image added — path in message", "success");
      } else {
        setStatus(res.error ?? "Upload failed", "error");
      }
    } catch (err) {
      setStatus((err as Error).message, "error");
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="flex h-[100dvh] flex-col">
      {/* Header */}
      <header className="sticky top-0 z-20 flex items-center gap-2 border-b border-border/60 bg-background/85 px-2 py-2 backdrop-blur-md [padding-top:calc(env(safe-area-inset-top)_+_0.5rem)]">
        <Button variant="ghost" size="icon" onClick={() => setNavOpen(true)} aria-label="Navigate">
          <Layers className="size-5" />
        </Button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate font-semibold">
              {isShell ? "shell" : (agent?.agent ?? "(agent gone)")}
            </span>
            {agent && (
              <span className="truncate text-xs text-muted-foreground">
                · {agent.workspaceLabel}
                {tabLabel ? ` › ${tabLabel}` : ""}
              </span>
            )}
          </div>
          {agent && (
            <div className="truncate font-mono text-[11px] text-muted-foreground">
              {shortCwd(agent.cwd)}
            </div>
          )}
        </div>
        {/* The status pill is the live indicator — polling refreshes the mirror on its own, so
            there's no manual refresh button. A bare shell shows a muted "shell" tag instead. */}
        {agent &&
          (isShell ? (
            <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              shell
            </span>
          ) : (
            <StatusBadge status={agent.status} />
          ))}
      </header>

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
            <AnsiOutput text={display} />
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
            onClick={() => setSwitcherOpen(true)}
            className="flex w-full touch-none items-center justify-center py-3.5 transition-colors active:bg-muted/50"
          >
            <span className="h-1.5 w-12 rounded-full bg-muted-foreground/50" />
          </button>
        )}

        {/* Composer */}
        <div className="border-t border-border/60 bg-background/95 px-3 pb-[calc(env(safe-area-inset-bottom)_+_0.5rem)] pt-2.5 backdrop-blur-md">
        {/* Quick keys (1–5 · Esc · Enter) — shown only while the composer is focused (keyboard up),
            so you can drive an agent's numbered/confirm prompt without opening the Keys sheet. Fire
            on pointer-down + preventDefault so the textarea keeps focus and the keyboard stays up. */}
        {composerFocused && !gone && (
          <div className="mb-2 grid grid-cols-7 gap-1">
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
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-9 px-0 text-xs font-medium"
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => pressKeys(["Escape"])}
              aria-label="Escape"
            >
              Esc
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-9 px-0 text-sm"
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => pressKeys(["Enter"])}
              aria-label="Enter"
            >
              ⏎
            </Button>
          </div>
        )}

        {/* Action row: Quick · Keys · Agent (Agent only when the pane's agent has commands). All
            open a bottom sheet, so they behave consistently. Structural commands (New tab/space,
            Kill) and Stop (Esc, in the Keys sheet) live elsewhere. Sits above the input. */}
        <div className="mb-2 flex gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="h-8 flex-1 gap-1.5 text-muted-foreground"
            disabled={gone}
            onClick={() => setQuickOpen(true)}
          >
            <Zap className="size-4" />
            Quick
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 flex-1 gap-1.5 text-muted-foreground"
            disabled={gone}
            onClick={() => setKeysOpen(true)}
          >
            <Keyboard className="size-4" />
            Keys
          </Button>
          {commands.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 flex-1 gap-1.5 text-muted-foreground"
              disabled={gone}
              onClick={() => setCmdOpen(true)}
            >
              <Slash className="size-4" />
              Agent
            </Button>
          )}
        </div>
        <div className="flex items-end gap-2">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-11 shrink-0"
            disabled={gone || uploading}
            onClick={() => fileRef.current?.click()}
            aria-label="Attach image"
          >
            {uploading ? <Loader2 className="size-4 animate-spin" /> : <ImagePlus className="size-5" />}
          </Button>
          <input ref={fileRef} type="file" accept="image/*" hidden onChange={onPickImage} />
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
              gone ? "Pane is gone" : isShell ? "Type a shell command…" : "Type or dictate a reply…"
            }
            disabled={gone}
            rows={1}
          />
          <Button
            size="icon"
            className="size-11 shrink-0 rounded-full"
            onClick={() => send(input, true)}
            disabled={gone || !input.trim() || sending}
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

      {/* Nav hub (left drawer): the Herdr-style two lists — SPACES over PANES (agents + shells) —
          with pane-level commands (Home / New tab / Kill) in the sticky footer. */}
      <SideSheet
        open={navOpen}
        onClose={() => setNavOpen(false)}
        title="Navigate"
        footer={
          <NavCommands
            onHome={onBack}
            onNewTab={
              agent
                ? () => {
                    setNavOpen(false);
                    newTab(agent.workspaceId);
                  }
                : undefined
            }
            onKill={killAgent}
            killDisabled={gone || killing}
          />
        }
      >
        <SpaceList
          workspaces={workspaces}
          agents={agents}
          currentWorkspaceId={agent?.workspaceId}
          onSelect={openSpace}
          onNewSpace={() => {
            setNavOpen(false);
            newSpace();
          }}
        />
        <ThreadSidebar
          agents={agents}
          shellPanes={shellPanes}
          currentPaneId={paneId}
          onSelect={switchTo}
        />
      </SideSheet>

      {/* Swipe-up quick switcher — just the panes (agents + shells), reached by the thumb gesture */}
      <BottomSheet open={switcherOpen} onClose={() => setSwitcherOpen(false)} title="Switch pane">
        <ThreadSidebar
          agents={agents}
          shellPanes={shellPanes}
          currentPaneId={paneId}
          onSelect={switchTo}
          className="px-0 py-1"
        />
      </BottomSheet>

      {/* Quick actions */}
      <QuickActions
        open={quickOpen}
        onClose={() => setQuickOpen(false)}
        onSend={(t) => send(t, false)}
        disabled={gone || sending}
      />

      {/* Keys — same bottom-sheet behaviour as Quick; stays open so you can press several keys */}
      <BottomSheet open={keysOpen} onClose={() => setKeysOpen(false)} title="Keys">
        <NavTray onSend={pressKeys} disabled={gone} />
      </BottomSheet>

      {/* Slash-command palette */}
      <CommandPalette
        open={cmdOpen}
        onClose={() => setCmdOpen(false)}
        agent={agent?.agent}
        onInsert={insertCommand}
        onSubmit={(t) => send(t, false)}
      />
    </div>
  );
}
