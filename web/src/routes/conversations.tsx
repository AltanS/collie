import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useParams } from "react-router";
import { ArrowLeft, Loader2, RotateCcw } from "lucide-react";

import { RouteHeader } from "@/components/app-header";
import { useAmbientHost, useHostWriteBlock } from "@/components/crew-provider";
import { TranscriptView } from "@/components/transcript-view";
import { Button } from "@/components/ui/button";
import { BandMain } from "@/components/ui/strip-host";
import { useLocale } from "@/hooks/use-locale";
import { useNav } from "@/hooks/use-nav";
import { mirrorFont, useDisplayPrefs } from "@/hooks/use-display-prefs";
import {
  DURABLE_CONVERSATIONS_PAGE,
  DURABLE_ITEMS_PAGE,
  fetchDurableConversationItems,
  fetchDurableConversations,
  reopenDurableConversation,
} from "@/lib/api";
import { describeApiError, describeThrownError } from "@/lib/api-error-message";
import { cachedProgramList } from "@/lib/conversation-list";
import { t, tn, getLocaleSnapshot } from "@/lib/i18n";
import { useMuxDeclared } from "@/lib/mux-capability";
import {
  conversationPath,
  homePath,
  panePath,
  readConversationState,
  readConversationsPane,
} from "@/lib/nav";
import { usePairing } from "@/lib/pairing";
import { useOptionalRootData } from "@/lib/route-data";
import { scopeKey } from "@/lib/scope";
import { useScope } from "@/lib/session";
import { setStatus } from "@/lib/status";
import { isReadOnly, type DurableConversationRow, type TranscriptEntry } from "@/lib/types";
import { cn } from "@/lib/utils";

// ── A DURABLE PROGRAM'S OWN HISTORY (M53 spec 11) ───────────────────────────────────────────────
//
// History is the program's: the list of conversations and the items of one come from the program
// itself (`/api/durable/conversations`), not from an agent session log on this machine. Two pages:
//
//   /conversations       the list, newest first, a page at a time ("Load more" follows `next`)
//   /conversations/:id   one conversation, read only, oldest first, newer items on "Load more"
//
// Neither has a loader. Each reads on open and on a Load more tap, so the poll loop fetches nothing
// for them (`shouldRevalidate: () => false` in router.tsx states the same). A program that does not
// serve its history, or does not answer, is plain text on the page and never an error screen.
//
// The item page is a READING view: no composer, no belt, no ask to answer. The one write on it is
// Reopen, drawn only for a closed conversation on a machine whose program takes a reopen.

/** A moment as a person reads it, in the app's language rather than the browser's. */
function when(iso: string): string {
  const d = new Date(iso);
  if (iso === "" || Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat(getLocaleSnapshot().locale, { dateStyle: "medium", timeStyle: "short" }).format(d);
}

/** The date line of one row: when it began, and for a closed one when it ended. */
function dates(row: DurableConversationRow): string {
  const start = when(row.startedAt);
  const end = row.endedAt === undefined ? "" : when(row.endedAt);
  if (end === "" || end === start) return start;
  if (start === "") return end;
  return t("conversations.range", { start, end });
}

/** Why the page has no rows or items, in the user's terms. Each is an ordinary state. */
function unavailableCopy(reason: "unsupported" | "unreachable" | "gone"): string {
  if (reason === "unsupported") return t("conversations.unsupported");
  if (reason === "gone") return t("conversations.gone");
  return t("conversations.unreachable");
}

/** The back arrow and title every page of this family wears, the shape Updates and Crew use. */
function PageHeader({ onBack, title, trail }: { onBack: () => void; title: string; trail?: React.ReactNode }) {
  return (
    <RouteHeader
      width="column"
      override={
        <>
          <Button
            variant="ghost"
            size="icon"
            // 44px, the tap floor every control in this row shares. size="icon" alone is 36px.
            className="size-11"
            onClick={onBack}
            aria-label={t("conversations.back")}
          >
            <ArrowLeft className="size-5" />
          </Button>
          <h1 className="min-w-0 flex-1 truncate text-lg font-semibold tracking-tight">{title}</h1>
          {trail}
        </>
      }
    />
  );
}

function StateChip({ state }: { state: DurableConversationRow["state"] }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-none",
        state === "open" ? "border-primary/40 text-primary" : "border-border text-muted-foreground",
      )}
    >
      {state === "open" ? t("conversations.state.open") : t("conversations.state.closed")}
    </span>
  );
}

function Row({ row, here, onOpen }: { row: DurableConversationRow; here: boolean; onOpen: () => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className={cn(
          "flex min-h-11 w-full items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors hover:bg-accent active:bg-muted",
          here ? "border-primary/40 bg-primary/5" : "border-border",
        )}
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{row.title === "" ? t("conversations.untitled") : row.title}</span>
          {row.subtitle !== undefined && row.subtitle !== "" && (
            <span className="block truncate text-xs text-muted-foreground">{row.subtitle}</span>
          )}
          <span className="block text-xs text-muted-foreground tabular-nums">
            {[dates(row), tn("conversations.items", row.items)].filter((part) => part !== "").join(" · ")}
          </span>
          {here && <span className="block text-xs font-medium text-primary">{t("conversations.here")}</span>}
        </span>
        <StateChip state={row.state} />
      </button>
    </li>
  );
}

type ListState =
  | { kind: "loading" }
  | { kind: "failed" }
  | { kind: "unavailable"; reason: "unsupported" | "unreachable" }
  | { kind: "ready"; rows: DurableConversationRow[]; next: string | undefined };

/** The program's conversations: newest first, the row shown in `?pane=` at the top. */
export function ConversationsRoute() {
  useLocale();
  const nav = useNav();
  const scope = useScope();
  const { search } = useLocation();
  const pane = readConversationsPane(search);
  const [list, setList] = useState<ListState>({ kind: "loading" });
  const [more, setMore] = useState(false);
  // A Load more in flight. A ref beside the state, so two quick taps cannot both pass the guard
  // before React has re-rendered the button disabled.
  const paging = useRef(false);

  useEffect(() => {
    const ctl = new AbortController();
    setList({ kind: "loading" });
    async function read() {
      try {
        const res = await fetchDurableConversations({ limit: DURABLE_CONVERSATIONS_PAGE }, scope, ctl.signal);
        if (ctl.signal.aborted) return;
        setList(res.available ? { kind: "ready", rows: res.items, next: res.next } : { kind: "unavailable", reason: res.reason });
      } catch {
        if (!ctl.signal.aborted) setList({ kind: "failed" });
      }
    }
    void read();
    return () => ctl.abort();
  }, [scope]);

  const loadMore = useCallback(async () => {
    if (list.kind !== "ready" || list.next === undefined || paging.current) return;
    paging.current = true;
    setMore(true);
    try {
      const res = await fetchDurableConversations({ after: list.next, limit: DURABLE_CONVERSATIONS_PAGE }, scope);
      if (!res.available) {
        setStatus(t("conversations.loadMoreFailed"), "error");
        return;
      }
      setList((prev) =>
        prev.kind === "ready" ? { kind: "ready", rows: [...prev.rows, ...res.items], next: res.next } : prev,
      );
    } catch {
      setStatus(t("conversations.loadMoreFailed"), "error");
    } finally {
      paging.current = false;
      setMore(false);
    }
  }, [list, scope]);

  // The pane's own conversation leads; everything else keeps the program's newest-first order.
  const rows = useMemo(() => {
    if (list.kind !== "ready") return [];
    if (pane === undefined) return list.rows;
    const mine = list.rows.filter((r) => r.paneId === pane);
    return mine.length === 0 ? list.rows : [...mine, ...list.rows.filter((r) => r.paneId !== pane)];
  }, [list, pane]);

  function open(row: DurableConversationRow) {
    // An open conversation in the live layout is a pane: go there in place of this list. Anything
    // else is read on its own page, one level below the list, so the back arrow lands back here.
    if (row.state === "open" && row.paneId !== undefined) nav.side(panePath(row.paneId, scope));
    else nav.down(conversationPath(row.id, scope, { state: row.state }));
  }

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-screen-sm flex-1 flex-col">
      <PageHeader
        title={t("conversations.title")}
        onBack={() => nav.up(pane === undefined ? homePath(scope) : panePath(pane, scope))}
      />
      <BandMain base={16} className="relative flex min-h-0 flex-1 flex-col overflow-y-auto p-4">
        {list.kind === "loading" ? (
          <p className="py-16 text-center text-sm text-muted-foreground">{t("conversations.loading")}</p>
        ) : list.kind === "failed" ? (
          <p className="py-16 text-center text-sm text-muted-foreground">{t("conversations.loadFailed")}</p>
        ) : list.kind === "unavailable" ? (
          <p className="py-16 text-center text-sm leading-relaxed text-muted-foreground">{unavailableCopy(list.reason)}</p>
        ) : rows.length === 0 ? (
          <p className="py-16 text-center text-sm text-muted-foreground">{t("conversations.empty")}</p>
        ) : (
          <>
            <ul className="flex flex-col gap-2">
              {rows.map((row) => (
                <Row key={row.id} row={row} here={pane !== undefined && row.paneId === pane} onOpen={() => open(row)} />
              ))}
            </ul>
            {list.next !== undefined && (
              <Button variant="ghost" className="mt-3 h-11 self-center" onClick={() => void loadMore()} disabled={more}>
                {more && <Loader2 className="animate-spin" />}
                {more ? t("conversations.loading") : t("conversations.loadMore")}
              </Button>
            )}
          </>
        )}
      </BandMain>
    </div>
  );
}

/** The title the program gave a conversation in its list, or undefined when the list does not hold it. */
function titleIn(rows: readonly DurableConversationRow[] | undefined, id: string): string | undefined {
  const row = rows?.find((r) => r.id === id);
  if (row === undefined) return undefined;
  return row.title === "" ? t("conversations.untitled") : row.title;
}

type ItemsState =
  | { kind: "loading" }
  | { kind: "failed" }
  | { kind: "unavailable"; reason: "unsupported" | "unreachable" | "gone" }
  | { kind: "ready"; entries: TranscriptEntry[]; next: string | undefined; more: boolean };

/** One conversation, read only, oldest first. No composer, no belt, no ask to answer. */
export function ConversationRoute() {
  useLocale();
  const nav = useNav();
  const scope = useScope();
  const { search } = useLocation();
  const { id = "" } = useParams();
  const state = readConversationState(search);
  const [items, setItems] = useState<ItemsState>({ kind: "loading" });
  const [more, setMore] = useState(false);
  const paging = useRef(false);
  const { prefs } = useDisplayPrefs();
  const mirrorFace = mirrorFont(prefs.fontFamily);
  // THE HEADER NAMES THE CONVERSATION (durable-simple, 2026-10-13), as an open one's pane header does. The
  // home's list read it a moment ago, so it is in hand on the first frame; a page opened by its address
  // asks the program's first page once for it. Until then, and for a row the program no longer lists,
  // the header says "Conversation".
  const [title, setTitle] = useState<string | undefined>(() => titleIn(cachedProgramList(scopeKey(scope))?.rows, id));
  useEffect(() => {
    if (title !== undefined) return;
    const ctl = new AbortController();
    async function name() {
      try {
        const res = await fetchDurableConversations({ limit: DURABLE_CONVERSATIONS_PAGE }, scope, ctl.signal);
        if (!ctl.signal.aborted && res.available) setTitle(titleIn(res.items, id));
      } catch {
        // No name: the header keeps saying "Conversation".
      }
    }
    void name();
    return () => ctl.abort();
  }, [id, scope, title]);

  useEffect(() => {
    const ctl = new AbortController();
    setItems({ kind: "loading" });
    async function read() {
      try {
        const res = await fetchDurableConversationItems(id, { limit: DURABLE_ITEMS_PAGE }, scope, ctl.signal);
        if (ctl.signal.aborted) return;
        setItems(
          res.available
            ? { kind: "ready", entries: res.entries, next: res.next, more: res.more }
            : { kind: "unavailable", reason: res.reason },
        );
      } catch {
        if (!ctl.signal.aborted) setItems({ kind: "failed" });
      }
    }
    void read();
    return () => ctl.abort();
  }, [id, scope]);

  const loadMore = useCallback(async () => {
    if (items.kind !== "ready" || !items.more || items.next === undefined || paging.current) return;
    paging.current = true;
    setMore(true);
    try {
      const res = await fetchDurableConversationItems(id, { after: items.next, limit: DURABLE_ITEMS_PAGE }, scope);
      if (!res.available) {
        setStatus(t("conversations.loadMoreFailed"), "error");
        return;
      }
      setItems((prev) =>
        prev.kind === "ready"
          ? { kind: "ready", entries: [...prev.entries, ...res.entries], next: res.next, more: res.more }
          : prev,
      );
    } catch {
      setStatus(t("conversations.loadMoreFailed"), "error");
    } finally {
      paging.current = false;
      setMore(false);
    }
  }, [id, items, scope]);

  // REOPEN: the one write on this page. Drawn only for a closed conversation on a machine whose program
  // declared it takes a reopen (absent until a bridge said yes), and not to a device that may not write.
  const declared = useMuxDeclared("reopenConversation", scope);
  const root = useOptionalRootData();
  const { refused: notPaired } = usePairing();
  const host = useAmbientHost(scope.host);
  const hostBlock = useHostWriteBlock(host);
  const canReopen = declared && state === "closed" && !isReadOnly(root?.device) && !notPaired && hostBlock === undefined;
  const [reopened, setReopened] = useState(false);
  const [reopening, setReopening] = useState(false);
  // One POST per conversation, however fast the taps come: the ref flips in the handler itself, before
  // any re-render could disable the button.
  const sent = useRef(false);

  async function reopen() {
    if (sent.current) return;
    sent.current = true;
    setReopening(true);
    try {
      const res = await reopenDurableConversation(id, scope);
      if (res.ok) {
        setReopened(true);
        if (res.paneId !== undefined) nav.side(panePath(res.paneId, scope));
        else nav.up(homePath(scope));
        return;
      }
      setStatus(describeApiError(res, t("conversations.reopenFailed")), "error");
      sent.current = false;
    } catch (e) {
      setStatus(describeThrownError(e), "error");
      sent.current = false;
    } finally {
      setReopening(false);
    }
  }

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-screen-sm flex-1 flex-col md:max-w-screen-md lg:max-w-screen-lg">
      <PageHeader
        title={title ?? t("conversations.fallbackTitle")}
        // The program's conversation list is the machine's home since M53 spec 12, so the way back is there.
        onBack={() => nav.up(homePath(scope))}
        trail={
          <>
            {state !== undefined && <StateChip state={state} />}
            {canReopen && (
              <Button
                variant="outline"
                size="sm"
                // 44px, the tap floor the back arrow in this row keeps too.
                className="h-11"
                onClick={() => void reopen()}
                disabled={reopening || reopened}
              >
                {reopening ? <Loader2 className="animate-spin" /> : <RotateCcw />}
                {reopening ? t("conversations.reopening") : t("conversations.reopen")}
              </Button>
            )}
          </>
        }
      />
      <BandMain
        base={12}
        className={cn("relative min-h-0 min-w-0 flex-1 overflow-y-auto px-3 py-3", mirrorFace.className)}
        style={mirrorFace.style}
      >
        {items.kind === "loading" ? (
          <p className="py-16 text-center text-sm text-muted-foreground">{t("conversations.loading")}</p>
        ) : items.kind === "failed" ? (
          <p className="py-16 text-center text-sm text-muted-foreground">{t("conversations.loadFailed")}</p>
        ) : items.kind === "unavailable" ? (
          <p className="py-16 text-center text-sm leading-relaxed text-muted-foreground">{unavailableCopy(items.reason)}</p>
        ) : items.entries.length === 0 ? (
          <p className="py-16 text-center text-sm text-muted-foreground">{t("conversations.noItems")}</p>
        ) : (
          <>
            <TranscriptView entries={items.entries} scope={scope} />
            {items.more && (
              <Button variant="ghost" className="mt-3 h-11 w-full" onClick={() => void loadMore()} disabled={more}>
                {more && <Loader2 className="animate-spin" />}
                {more ? t("conversations.loading") : t("conversations.loadMore")}
              </Button>
            )}
          </>
        )}
      </BandMain>
    </div>
  );
}
