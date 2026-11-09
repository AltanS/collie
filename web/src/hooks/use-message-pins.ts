import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { pinItem, unpinItem } from "@/lib/api";
import type { ChatItem } from "@/lib/chat-items";
import { heldPins, readPins } from "@/lib/loaders";
import { newestFirst, pinFailure, pinnedByItem, rowOf } from "@/lib/message-pins";
import type { Scope } from "@/lib/scope";
import { setStatus } from "@/lib/status";
import type { PinRow } from "@/lib/types";

// THE PINNED MESSAGES OF ONE PANE, as state of the pane view (M90).
//
// ── WHERE THE COUNT COMES FROM ───────────────────────────────────────────────
// The bridge reports `pins` on the pane's wire row once it has read the session, which a pane whose session
// is only discovered (never reported) lacks until a pins route has touched it. So the list is read ONCE when
// the pane opens (excerpts only, so it is cheap), and then the wire count drives: a change in it is a pin
// made or dropped somewhere else (another phone, the desk), and reads the list again. A pin or an unpin
// from this phone reads it again too, and so does the sheet when it opens (`refresh`).
//
// ── OPTIMISTIC, AND HONEST ABOUT A REFUSAL ───────────────────────────────────
// A pin shows its mark at once (the block's item id is `pending`), and an unpin takes its row out at once. A
// refusal puts both back and says why in the status line, in the machine's own reason (lib/message-pins.ts
// `pinFailure`). Nothing is kept on the phone: the machine owns the copy.
//
// `enabled` is false where nothing can be asked: a pane with no session to keep pins for, a machine whose
// Collie is older, a saved copy. The list then stays as it was last read and nothing goes out.

export interface MessagePins {
  /** The pins, newest first. Empty until the first read lands, or when the session has none. */
  readonly rows: readonly PinRow[];
  /** How many pins the session holds: this phone's own list once read and while it can be read, else the wire count. */
  readonly count: number;
  /** Chat item id to pin id; `""` while a pin is on its way. */
  readonly pinned: ReadonlyMap<string, string>;
  pin(item: ChatItem): Promise<void>;
  unpin(pinId: string): Promise<void>;
  /** Read the list again. */
  refresh(): void;
}

const NO_ROWS: readonly PinRow[] = [];

export function useMessagePins({
  paneId,
  scope,
  enabled,
  wireCount,
}: {
  paneId: string;
  scope: Scope | undefined;
  enabled: boolean;
  /** `AgentView.pins` of the pane, 0 when absent. */
  wireCount: number;
}): MessagePins {
  const [list, setList] = useState<PinRow[] | null>(() => heldPins(paneId, scope));
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  // A read that finishes after a newer one started is dropped, so an old list never replaces a newer one.
  const reads = useRef(0);

  const refresh = useCallback(() => {
    if (!enabled) return;
    reads.current += 1;
    const mine = reads.current;
    void readPins(paneId, scope).then((rows) => rows !== null && mine === reads.current && setList(rows));
  }, [enabled, paneId, scope]);

  // Once when the pane opens, and again whenever the wire's count moves.
  useEffect(() => {
    refresh();
    // The read must not land after the pane view is gone.
    return () => {
      reads.current += 1;
    };
  }, [refresh, wireCount]);

  const pin = useCallback(
    async (item: ChatItem) => {
      if (!enabled) return;
      setPending((held) => new Set(held).add(item.id));
      try {
        const made = await pinItem(scope, paneId, item.id);
        // The answer is the pin itself, so the row stands before the list is read again.
        setList((rows) => newestFirst([...(rows ?? []).filter((row) => row.itemId !== made.itemId), rowOf(made)]));
        refresh();
      } catch (thrown) {
        setStatus(pinFailure(thrown), "warn");
      } finally {
        setPending((held) => {
          const next = new Set(held);
          next.delete(item.id);
          return next;
        });
      }
    },
    [enabled, paneId, scope, refresh],
  );

  const unpin = useCallback(
    async (pinId: string) => {
      if (!enabled) return;
      const removed = list?.find((row) => row.id === pinId);
      setList((rows) => (rows ?? []).filter((row) => row.id !== pinId));
      try {
        await unpinItem(scope, paneId, pinId);
        refresh();
      } catch (thrown) {
        // Put the row back where the list had it, then read the list: a refusal can mean the pin is gone already (another
        // phone dropped it), and the machine's list is the truth either way.
        if (removed !== undefined) setList((rows) => newestFirst([...(rows ?? []).filter((row) => row.id !== pinId), removed]));
        setStatus(pinFailure(thrown), "warn");
        refresh();
      }
    },
    [enabled, list, paneId, scope, refresh],
  );

  const rows = list ?? NO_ROWS;
  const pinned = useMemo(() => pinnedByItem(rows, pending), [rows, pending]);
  // The list counts while it can be kept fresh. Where nothing can be asked (`enabled` false: connecting, a saved copy) the
  // wire's own count stands, the one every column's belt draws (components/strip-column.tsx), so the two never disagree.
  return { rows, count: enabled && list !== null ? list.length : wireCount, pinned, pin, unpin, refresh };
}
