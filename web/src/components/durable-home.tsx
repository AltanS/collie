import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TriangleAlert } from "lucide-react";

import { ConversationList, type ConversationListFoot } from "@/components/conversation-list";
import { Collapse } from "@/components/ui/collapse";
import { Notice } from "@/components/ui/notice";
import type { PaneOpen } from "@/hooks/use-pane-open";
import { useNav } from "@/hooks/use-nav";
import { DURABLE_CONVERSATIONS_PAGE, fetchDurableConversations } from "@/lib/api";
import { cachedProgramList, mergeConversations, rememberProgramList, type ConversationItem } from "@/lib/conversation-list";
import { t } from "@/lib/i18n";
import { useMuxDeclared } from "@/lib/mux-capability";
import { conversationPath } from "@/lib/nav";
import { scopeKey, type Scope } from "@/lib/scope";
import { useSessionCard } from "@/lib/session-cards";
import { setStatus } from "@/lib/status";
import type { AgentView, DurableConversationRow, WorkspaceView } from "@/lib/types";

// A DURABLE MACHINE'S HOME (M53 spec 12): the dashboard's body on a machine with no screen.
//
// Altan, hand test 2026-10-13: "history chats for durable muxes should be prominently implemented, this
// is the main workflow". So the card grid built for terminals gives way to the program's conversations,
// open and closed, and one tap opens one: a live pane in Chat, a closed one in the read-only view of spec 11.
// One list with no filter chips since durable-simple (2026-10-13): it orders itself (lib/conversation-list.ts).
//
// THE LIST DRAWS AT ONCE. The live panes are in the snapshot the dashboard already holds, so they are rows
// on the first frame, with their state. The program's own list (closed ones, item counts) is read once per
// visit and again when the set of live panes changes (a conversation opened or closed), never on the poll
// beat, and the last answer per machine is kept in memory so a trip into a conversation and back draws it
// whole on the first frame of the return.
//
// A REFUSED PROGRAM SAYS WHY (M55 spec 14). When the bridge refused the program for its wire version, the
// session card carries the one sentence that says so (`notice`). It sits above the list as a caution box,
// and the list's foot says it too in place of the plain "did not answer".

type ListRead =
  | { kind: "off" }
  | { kind: "loading" }
  | { kind: "failed" }
  | { kind: "unavailable"; reason: "unsupported" | "unreachable" }
  | { kind: "ready"; rows: DurableConversationRow[]; next: string | undefined };

export function DurableHome({
  scope,
  panes,
  workspaces,
  paneOpen,
  stale = false,
}: {
  /** The machine this home shows: the addressed one. */
  scope: Scope;
  /** That machine's live panes, from the snapshot. */
  panes: readonly AgentView[];
  workspaces: readonly WorkspaceView[];
  paneOpen: PaneOpen;
  /** The snapshot is the saved copy: its rows are dimmed and said in the past tense. */
  stale?: boolean;
}) {
  const nav = useNav();
  const notice = useSessionCard(scope)?.notice;
  // Asked of the machine on screen, and ABSENT until a bridge said yes: a program that keeps no list of its
  // own still has a home, its open conversations, and nothing is asked of it.
  const served = useMuxDeclared("programHistory", scope);
  const host = scope.host;
  const session = scope.session;
  const key = scopeKey(scope);
  const [list, setList] = useState<ListRead>(() => {
    const kept = cachedProgramList(key);
    return kept === undefined ? { kind: "loading" } : { kind: "ready", ...kept };
  });
  const [paging, setPaging] = useState(false);
  // A Load more in flight. A ref beside the state, so two quick taps cannot both pass the guard.
  const pagingRef = useRef(false);

  // The read's trigger: which panes are live, not how they are. A status change is on the snapshot already.
  const liveKey = useMemo(() => panes.map((pane) => pane.paneId).toSorted().join("\n"), [panes]);

  useEffect(() => {
    if (!served) {
      setList({ kind: "off" });
      return;
    }
    const ctl = new AbortController();
    const at: Scope = { host, session };
    async function read() {
      try {
        const res = await fetchDurableConversations({ limit: DURABLE_CONVERSATIONS_PAGE }, at, ctl.signal);
        if (ctl.signal.aborted) return;
        if (res.available) {
          const kept = { rows: res.items, next: res.next };
          rememberProgramList(scopeKey(at), kept);
          setList({ kind: "ready", ...kept });
          return;
        }
        // A list already drawn stays drawn when a later read is refused: older rows beat an empty page.
        setList((prev) => (prev.kind === "ready" ? prev : { kind: "unavailable", reason: res.reason }));
      } catch {
        if (!ctl.signal.aborted) setList((prev) => (prev.kind === "ready" ? prev : { kind: "failed" }));
      }
    }
    void read();
    return () => ctl.abort();
  }, [served, host, session, liveKey]);

  const loadMore = useCallback(async () => {
    if (list.kind !== "ready" || list.next === undefined || pagingRef.current) return;
    pagingRef.current = true;
    setPaging(true);
    try {
      const res = await fetchDurableConversations({ after: list.next, limit: DURABLE_CONVERSATIONS_PAGE }, { host, session });
      if (!res.available) {
        setStatus(t("conversations.loadMoreFailed"), "error");
        return;
      }
      setList((prev) => (prev.kind === "ready" ? { kind: "ready", rows: [...prev.rows, ...res.items], next: res.next } : prev));
    } catch {
      setStatus(t("conversations.loadMoreFailed"), "error");
    } finally {
      pagingRef.current = false;
      setPaging(false);
    }
  }, [list, host, session]);

  const items = useMemo(() => mergeConversations(panes, list.kind === "ready" ? list.rows : null), [panes, list]);

  const foot: ConversationListFoot =
    list.kind === "ready" && list.next !== undefined
      ? { kind: "more", busy: paging, onMore: () => void loadMore() }
      : list.kind === "failed"
        ? { kind: "note", text: t("conversations.loadFailed") }
        : list.kind === "unavailable"
          ? { kind: "note", text: list.reason === "unsupported" ? t("conversations.unsupported") : (notice ?? t("conversations.unreachable")) }
          : { kind: "none" };

  function open(item: ConversationItem, row: HTMLButtonElement) {
    // A live pane opens in Chat, the way a dashboard row opens a pane. Anything else is read on its own page.
    if (item.pane !== undefined) {
      paneOpen.open(item.pane, row);
      return;
    }
    if (item.id === undefined) return;
    nav.down(conversationPath(item.id, scope, { state: item.state === "closed" ? "closed" : "open" }));
  }

  return (
    <div className="flex flex-col">
      <Collapse open={notice !== undefined}>
        {notice !== undefined ? (
          <div className="px-4 pt-4">
            <Notice tone="caution" variant="box" announce="status" icon={<TriangleAlert />}>
              {notice}
            </Notice>
          </div>
        ) : null}
      </Collapse>
      <ConversationList
        items={items}
        workspaces={workspaces}
        onOpen={open}
        onPress={(item) => {
          if (item.pane !== undefined) paneOpen.press(item.pane);
        }}
        glideKeyOf={(item) => (item.pane === undefined ? undefined : paneOpen.glideKeyOf(item.pane))}
        foot={foot}
        stale={stale}
      />
    </div>
  );
}
