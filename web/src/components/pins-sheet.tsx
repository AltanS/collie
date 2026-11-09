import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/icons/icon";
import type { IconKey } from "@/components/icons/keys";

import { ItemView } from "@/components/chat-cards";
import { Button } from "@/components/ui/button";
import { BottomSheet, TALL_SHEET_CLEARANCE } from "@/components/ui/sheet";
import { useLocale } from "@/hooks/use-locale";
import { fetchPanePin } from "@/lib/api";
import { timeAgoShort } from "@/lib/format";
import { t } from "@/lib/i18n";
import { newestFirst, pinAsItem, pinFailure, pinTitle } from "@/lib/message-pins";
import type { Scope } from "@/lib/scope";
import { setStatus } from "@/lib/status";
import type { PinFull, PinKind, PinRow } from "@/lib/types";
import { cn } from "@/lib/utils";

// THE PINNED MESSAGES OF A PANE'S SESSION, as a tall sheet over the page (M90 spec 03). The Pins mark on the belt
// opens it. The list is newest first: a glyph for who spoke (a person, the agent, a tool), the first lines of the
// text, how long ago, and an Unpin at the row's end. A tap on the row opens the detail, a second sheet over the
// list that holds the whole pinned text, drawn the way Chat draws it, with Unpin and Show in Chat in its footer.
//
// Both sheets hear Escape on the window, so the list ignores a close while the detail is open: one Escape closes
// the detail, the next closes the list (the pattern of composer.tsx's subagent transcript). The list's own state
// is the pane view's (hooks/use-message-pins.ts); this file holds nothing but which pin is open in the detail.
// Unpin does not wait on the network there. The row leaves at once and comes back with a notice on a refusal.

const KIND_GLYPH = {
  user: "user-turn",
  reply: "message-agent",
  thinking: "message-agent",
  notice: "message-agent",
  tool: "message-tool",
} as const satisfies Record<PinKind, IconKey>;

interface PinsSheetProps {
  open: boolean;
  /** Closes the list (and with it the detail). */
  onClose: () => void;
  scope: Scope | undefined;
  paneId: string;
  /** The session's pins. Newest first is decided here. */
  rows: readonly PinRow[];
  onUnpin: (pinId: string) => void;
  /** Reads the list again. Called each time the sheet opens, because the list is only as new as the last read. */
  onOpened: () => void;
  /** Scrolls Chat to the pin's block. False when the block is not loaded (the sheet says so). */
  onShow: (pin: PinRow) => boolean;
}

export function PinsSheet({ open, onClose, scope, paneId, rows, onUnpin, onOpened, onShow }: PinsSheetProps) {
  useLocale();
  const [detailId, setDetailId] = useState<string | null>(null);
  useEffect(() => {
    if (open) onOpened();
    else setDetailId(null);
    // `onOpened` is a fresh closure on every render; the read belongs to the opening, not to the closure.
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const sorted = newestFirst(rows);
  const detail = sorted.find((row) => row.id === detailId) ?? null;
  // A pin unpinned from the detail (or on another device) leaves the list: the detail goes with it.
  useEffect(() => {
    if (detailId !== null && detail === null) setDetailId(null);
  }, [detailId, detail]);

  // The row the detail was opened from leaves with its pin, and the detail's own button goes with it: focus would be
  // lost, so it goes to the list's title instead.
  const titleRef = useRef<HTMLSpanElement>(null);
  const [refocus, setRefocus] = useState(0);
  useEffect(() => {
    if (refocus > 0) titleRef.current?.focus();
  }, [refocus]);
  const unpin = (pin: PinRow) => {
    if (pin.id === detailId) {
      setDetailId(null);
      setRefocus((n) => n + 1);
    }
    onUnpin(pin.id);
  };
  const show = (pin: PinRow) => {
    const shown = onShow(pin);
    setDetailId(null);
    onClose();
    if (!shown) setStatus(t("pins.notice.notLoaded"), "warn");
  };

  return (
    <>
      <BottomSheet
        open={open}
        onClose={() => {
          if (detail === null) onClose();
        }}
        title={
          <span ref={titleRef} tabIndex={-1} className="outline-none">
            {t("pins.sheet.title")}
          </span>
        }
        className={cn("h-[85dvh] max-h-[85dvh]", TALL_SHEET_CLEARANCE)}
      >
        {sorted.length === 0 ? (
          <p data-slot="pins-empty" className="py-6 text-center text-sm text-muted-foreground">
            {t("pins.sheet.empty")}
          </p>
        ) : (
          <ul data-slot="pins-list" className="-mx-4 divide-y divide-border">
            {sorted.map((pin) => (
              <PinListRow key={pin.id} pin={pin} onOpen={() => setDetailId(pin.id)} onUnpin={() => unpin(pin)} />
            ))}
          </ul>
        )}
      </BottomSheet>
      {detail !== null && (
        <PinDetail
          key={detail.id}
          pin={detail}
          scope={scope}
          paneId={paneId}
          onBack={() => setDetailId(null)}
          onUnpin={() => unpin(detail)}
          onShow={() => show(detail)}
        />
      )}
    </>
  );
}

/** When the block was written, else when it was pinned, as a short "5m". */
function pinTime(pin: PinRow): string {
  const written = pin.ts === undefined ? Number.NaN : Date.parse(pin.ts);
  return timeAgoShort(Number.isFinite(written) ? written : pin.pinnedAt);
}

function PinListRow({ pin, onOpen, onUnpin }: { pin: PinRow; onOpen: () => void; onUnpin: () => void }) {
  return (
    <li data-slot="pin-row" className="flex items-stretch">
      <button
        type="button"
        onClick={onOpen}
        className="flex min-h-11 min-w-0 flex-1 items-start gap-2.5 py-2.5 pl-4 text-left text-sm leading-snug"
      >
        <Icon name={KIND_GLYPH[pin.kind]} aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">{pinTitle(pin)}</span>
          <span data-slot="pin-excerpt" className="font-content line-clamp-3 break-words whitespace-pre-line">
            {pin.excerpt}
          </span>
        </span>
        <span className="shrink-0 pt-0.5 text-xs tabular-nums text-muted-foreground">{pinTime(pin)}</span>
      </button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={t("pins.action.unpin")}
        onClick={onUnpin}
        className="relative my-1.5 mr-2 ml-1 size-9 shrink-0 before:absolute before:-inset-1 before:content-['']"
      >
        <Icon name="unpin" className="size-4 text-muted-foreground" />
      </Button>
    </li>
  );
}

type Whole = { readonly kind: "loading" } | { readonly kind: "ready"; readonly pin: PinFull };

/** The whole text of one pin, over the list. It shows the excerpt the list holds until the machine answers. */
function PinDetail({
  pin,
  scope,
  paneId,
  onBack,
  onUnpin,
  onShow,
}: {
  pin: PinRow;
  scope: Scope | undefined;
  paneId: string;
  onBack: () => void;
  onUnpin: () => void;
  onShow: () => void;
}) {
  const [whole, setWhole] = useState<Whole>({ kind: "loading" });
  useEffect(() => {
    const abort = new AbortController();
    fetchPanePin(scope, paneId, pin.id, abort.signal)
      .then((got) => setWhole({ kind: "ready", pin: got }))
      .catch(<TThrown,>(thrown: TThrown) => {
        if (abort.signal.aborted) return;
        // A pin another device removed, or a machine that stopped answering: say why and go back to the list.
        setStatus(pinFailure(thrown), "warn");
        onBack();
      });
    return () => abort.abort();
    // The pin is fetched once per opening; `onBack` is a fresh closure each render.
  }, [scope, paneId, pin.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const shown: PinFull = whole.kind === "ready" ? whole.pin : { ...pin, text: pin.excerpt };
  return (
    <BottomSheet
      open
      onClose={onBack}
      title={`${pinTitle(pin)} · ${pinTime(pin)}`}
      className={cn("h-[85dvh] max-h-[85dvh]", TALL_SHEET_CLEARANCE)}
    >
      <div data-slot="pin-detail" data-loading={whole.kind === "loading" ? "" : undefined} className="flex flex-col gap-3">
        <ItemView item={pinAsItem(shown)} />
        <div className="sticky bottom-0 -mx-4 flex gap-2 border-t border-border bg-card px-4 py-2">
          <Button type="button" variant="outline" size="lg" onClick={onUnpin} className="flex-1">
            <Icon name="unpin" />
            {t("pins.action.unpin")}
          </Button>
          <Button type="button" size="lg" onClick={onShow} className="flex-1">
            {t("pins.action.show")}
          </Button>
        </div>
      </div>
    </BottomSheet>
  );
}
