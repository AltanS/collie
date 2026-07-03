import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useNavigate, useRevalidator } from "react-router";
import { ArrowUpToLine, Home, Layers, Loader2, Search, TerminalSquare } from "lucide-react";
import { useSwipeUp } from "@/hooks/use-swipe";
import { useSpaceActions } from "@/hooks/use-spaces";
import { useDisplayPrefs } from "@/hooks/use-display-prefs";
import { setStatus } from "@/lib/status";
import { Button } from "@/components/ui/button";
import { ChatMessageList, type ChatMessageListHandle } from "@/components/ui/chat/chat-message-list";
import { BottomSheet, SideSheet } from "@/components/ui/sheet";
import { AnsiOutput } from "@/components/ansi-output";
import { FindBar } from "@/components/find-bar";
import { Composer, type ComposerHandle } from "@/components/composer";
import { ThreadSidebar } from "@/components/agent-sidebar";
import { AgentIcon } from "@/components/agent-icon";
import { SpaceList } from "@/components/space-list";
import { TabStrip } from "@/components/tab-strip";
import { PaneStrip } from "@/components/pane-strip";
import { ReadOnlyBanner } from "@/components/read-only-banner";
import { StatusArea } from "@/components/status-area";
import { ShellBadge, StatusBadge } from "@/components/status-badge";
import * as api from "@/lib/api";
import { canGrowRequestedLines, growRequestedLines } from "@/lib/loaders";
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
  /** True when the pane buffer was cut off at the requested line count — older scrollback exists. */
  truncated?: boolean;
  /** The scrollback window `text` was fetched with — tells a grown fetch from a stale in-flight poll. */
  requestedLines?: number;
  /** Per-device auth from the snapshot; an unauthorised device drops the composer to read-only. */
  device?: DeviceAuth;
  onBack: () => void;
  onSelect: (paneId: string) => void;
}

// At most one drawer/sheet is open at a time; null = none. (The composer's own Keys/Quick/Agent
// sheets are separate and live inside <Composer>.)
type Drawer = "nav" | "switcher" | null;

// The detail view mirrors a terminal pane, NOT a chat thread. The pane's output comes from the
// route loader (`text`); polling revalidates it. Replies/keys are confirmed via the header status
// line (`setStatus`), then a revalidation pulls the fresh output.
//
// This shell owns the pane frame: the header (with find-in-output), the terminal mirror (freeze,
// find highlighting, load-older scrollback), and navigation (the nav hub + swipe-up switcher). The
// composer cluster — draft, send, keys, quick actions, slash-commands, image upload, display prefs —
// lives in <Composer>; it reaches back here only to re-follow the tail after a send and to focus on
// a mirror tap.
export function AgentChat({
  paneId,
  agent,
  agents,
  shellPanes,
  workspaces,
  tabs,
  tabLabel,
  text,
  truncated,
  requestedLines = 0,
  device,
  onBack,
  onSelect,
}: AgentChatProps) {
  const revalidator = useRevalidator();
  const navigate = useNavigate();
  const { newTab, newSpace } = useSpaceActions();
  // Single display-prefs instance: the View controls (in <Composer>) write it, the mirror reads it.
  const { prefs, setWrap, stepFontSize } = useDisplayPrefs();
  const isShell = agent?.kind === "shell";
  // This device isn't allowlisted to type into agents: the backend rejects every write, so the
  // composer drops to read-only (and shows a banner). The mirror still polls (reading is fine).
  const readOnly = isReadOnly(device);

  const [closingId, setClosingId] = useState<string | null>(null);
  // Drawers/sheets are mutually exclusive — at most one open. A single value makes that invariant
  // unrepresentable to violate.
  const [drawer, setDrawer] = useState<Drawer>(null);
  const closeDrawer = () => setDrawer(null);
  const listRef = useRef<ChatMessageListHandle>(null);
  const composerRef = useRef<ComposerHandle>(null);

  const gone = !agent;

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

  // Find-in-output: search the already-fetched buffer. The bar takes over the header while open;
  // AnsiOutput highlights matches and reports the count back here; prev/next scrolls the focused
  // match into view. Opening freezes the tail so matches don't shift under you as polls land.
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [matchCount, setMatchCount] = useState(0);
  const [currentMatch, setCurrentMatch] = useState(0);
  useEffect(() => {
    setCurrentMatch(0); // a fresh query starts from the first match
  }, [findQuery]);
  const handleMatchCount = useCallback((n: number) => {
    setMatchCount(n);
    setCurrentMatch((c) => (n === 0 ? 0 : Math.min(c, n - 1)));
  }, []);
  function gotoMatch(delta: number) {
    if (matchCount === 0) return;
    setFollowing(false); // freeze the tail so scroll-into-view doesn't fight the live re-pin
    setCurrentMatch((c) => (c + delta + matchCount) % matchCount);
  }
  function openFind() {
    setFollowing(false); // freeze the buffer so the search target is stable while you type
    setFindOpen(true);
  }
  function closeFind() {
    setFindOpen(false);
    setFindQuery("");
  }

  // Load older scrollback: raise the per-pane requested line count and refetch. The enlarged buffer
  // prepends older lines at the top, so we adopt it into the frozen display and re-anchor the scroll
  // position (measure height before, restore after) to keep the content you were reading in place.
  const [loadingOlder, setLoadingOlder] = useState(false);
  const olderAnchor = useRef<{ height: number; top: number } | null>(null);
  const adoptTarget = useRef<number | null>(null); // the requestedLines a pending grow is waiting on
  const pendingRestore = useRef(false); // re-anchor scroll after the enlarged display paints
  function loadOlder() {
    if (loadingOlder || !canGrowRequestedLines(paneId)) return;
    const el = listRef.current?.getScrollElement();
    olderAnchor.current = el ? { height: el.scrollHeight, top: el.scrollTop } : null;
    setLoadingOlder(true);
    setFollowing(false); // stay put in history rather than snapping to the tail
    adoptTarget.current = growRequestedLines(paneId);
    revalidator.revalidate();
  }
  // Adopt the enlarged buffer into the frozen display once the *grown* fetch lands — keyed on the
  // requested line count so a stale in-flight poll (still on the old window) can't adopt early.
  useEffect(() => {
    const target = adoptTarget.current;
    if (target === null || requestedLines < target) return;
    adoptTarget.current = null;
    setLoadingOlder(false);
    if (text === display) {
      olderAnchor.current = null; // nothing new arrived (buffer shorter than the window)
      return;
    }
    pendingRestore.current = true;
    setDisplay(text);
  }, [requestedLines, text, display]);
  // After the enlarged display paints, keep the previously-visible content anchored (content grew at
  // the top, so push scrollTop down by the height delta).
  useLayoutEffect(() => {
    if (!pendingRestore.current) return;
    pendingRestore.current = false;
    const anchor = olderAnchor.current;
    const el = listRef.current?.getScrollElement();
    if (anchor && el) el.scrollTop = anchor.top + (el.scrollHeight - anchor.height);
    olderAnchor.current = null;
  }, [display]);

  // After a successful send, snap the mirror back to the live tail so the reply's result is visible.
  const onSent = () => {
    setFollowing(true);
    revalidator.revalidate();
    listRef.current?.scrollToBottom();
  };

  // NOTE: the composer is deliberately NOT auto-focused on open/switch — that would pop the Android
  // keyboard and cover the output. You read the pane first, then tap the input to type. (Explicit
  // actions inside the composer still focus it; the mirror tap focuses it via composerRef.)

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

  // Tapping the terminal mirror focuses the composer — but bail if the user is actually selecting
  // text (a long-press selection), so copy works instead of the tap collapsing the selection and
  // popping the keyboard.
  function focusFromMirror() {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    composerRef.current?.focusInput();
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

  return (
    <div className="flex h-[100dvh] flex-col">
      {/* Header — while find is open, the find bar takes over this row (one-handed, thumb-reachable). */}
      <header className="sticky top-0 z-20 flex items-center gap-2 border-b border-border/60 bg-background/85 px-2 py-2 backdrop-blur-md [padding-top:calc(env(safe-area-inset-top)_+_0.5rem)] app-header">
        {findOpen ? (
          <FindBar
            query={findQuery}
            onQueryChange={setFindQuery}
            count={matchCount}
            current={currentMatch}
            onPrev={() => gotoMatch(-1)}
            onNext={() => gotoMatch(1)}
            onClose={closeFind}
          />
        ) : (
          <>
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
            {/* Find-in-output — search the already-fetched pane buffer without leaving the pane.
                Shown only when there's output to search. */}
            {display && (
              <Button variant="ghost" size="icon" onClick={openFind} aria-label="Find in output">
                <Search className="size-5" />
              </Button>
            )}
            {/* The status pill is the live indicator — polling refreshes the mirror on its own, so
                there's no manual refresh button. A bare shell shows a muted "shell" tag instead. */}
            {agent && (isShell ? <ShellBadge /> : <StatusBadge status={agent.status} />)}
          </>
        )}
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

      {/* Terminal mirror — tapping it focuses the composer so you can start typing right away
          (unless you're selecting text to copy, which the tap must not collapse). */}
      <div className="min-h-0 flex-1" onClick={focusFromMirror}>
        <ChatMessageList
          ref={listRef}
          dep={display}
          onAtBottomChange={setFollowing}
          hasNew={hasNew}
          className="gap-0 px-2 py-3"
        >
          {display ? (
            <>
              {/* Load older scrollback — sits at the top of the buffer, so it's reached by scrolling
                  up. Shown while the buffer is still truncated (older lines exist) and below the cap. */}
              {truncated && canGrowRequestedLines(paneId) && (
                <button
                  type="button"
                  onClick={loadOlder}
                  disabled={loadingOlder}
                  className="mb-2 flex w-full items-center justify-center gap-1.5 rounded-md py-2 text-xs font-medium text-muted-foreground transition-colors active:bg-muted/50 disabled:opacity-60"
                >
                  {loadingOlder ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <ArrowUpToLine className="size-3.5" />
                  )}
                  {loadingOlder ? "Loading…" : "Load older"}
                </button>
              )}
              <AnsiOutput
                text={display}
                wrap={prefs.wrap}
                fontSize={prefs.fontSize}
                query={findOpen ? findQuery : ""}
                currentMatch={findOpen ? currentMatch : -1}
                onMatchCount={findOpen ? handleMatchCount : undefined}
              />
            </>
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

        <Composer
          ref={composerRef}
          paneId={paneId}
          agent={agent?.agent}
          isShell={isShell}
          gone={gone}
          readOnly={readOnly}
          text={text}
          prefs={prefs}
          setWrap={setWrap}
          stepFontSize={stepFontSize}
          onSent={onSent}
        />
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
    </div>
  );
}
