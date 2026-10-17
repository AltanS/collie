import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { BottomSheet } from "@/components/ui/sheet";
import { useLocale } from "@/hooks/use-locale";
import { useWalkySend } from "@/hooks/use-walky-send";
import { fetchWalkyWho } from "@/lib/api";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import {
  stateWord,
  verifiedWord,
  WALKY_BODY_MAX,
  wasTaken,
  type WalkyReceipt,
  type WalkyTarget,
} from "@/lib/walky";

// "Message all agents" on the Crew page (M62 spec 05): one text to every agent pane in the crew, or to
// every agent pane on one machine, from the operator. The sheet sends nothing by itself; the Send
// button posts `to: "all"` or `<memberId>/all` through `POST /api/walky`, and the bridge answers one
// receipt per target, which are listed below the field so the person sees where it landed and where
// it did not.
//
// The request id is minted once per attempt and a retry of the same attempt reuses it
// (hooks/use-walky-send.ts): a lost answer followed by a second tap returns the receipts the bridge
// already wrote and types nothing twice.

const ALL = "all";

interface BroadcastMember {
  id: string;
  name: string;
}

export function WalkyBroadcastSheet({
  open,
  onClose,
  members,
}: {
  open: boolean;
  onClose: () => void;
  /** The crew's machines, lead first. */
  members: readonly BroadcastMember[];
}) {
  useLocale();
  const { send, sending } = useWalkySend();
  const [text, setText] = useState("");
  const [target, setTarget] = useState(ALL);
  const [receipts, setReceipts] = useState<WalkyReceipt[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reachable, setReachable] = useState<WalkyTarget[] | null>(null);

  // A fresh look every time the sheet opens, and nothing carried over from the last message.
  useEffect(() => {
    if (!open) return;
    setReceipts(null);
    setError(null);
    setReachable(null);
    const abort = new AbortController();
    fetchWalkyWho(abort.signal).then(setReachable, () => setReachable(null));
    return () => abort.abort();
  }, [open]);

  const reach =
    reachable === null ? null : target === ALL ? reachable.length : reachable.filter((r) => r.memberId === target).length;
  const body = text.trim();
  const tooLong = body.length > WALKY_BODY_MAX;
  const to = target === ALL ? ALL : `${target}/${ALL}`;

  async function submit() {
    if (body === "" || tooLong || sending) return;
    setError(null);
    const result = await send(to, body);
    if (result === null) return;
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setReceipts(result.receipts);
    // The text leaves with the message once the bridge took at least one target; a send nobody took stays for another go.
    if (result.receipts.some(wasTaken)) setText("");
  }

  return (
    <BottomSheet open={open} onClose={onClose} title={t("walky.crew.title")}>
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">{t("walky.crew.text")}</span>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={t("walky.crew.textPlaceholder")}
            rows={4}
            className="min-h-24 w-full resize-none rounded-lg border border-border bg-background p-3 text-base text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">{t("walky.crew.target")}</span>
          <Select value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value={ALL}>{t("walky.crew.targetAll")}</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name || m.id}
              </option>
            ))}
          </Select>
        </label>
        {/* The count is always drawn (an empty line when unknown), so learning it moves nothing (DESIGN.md §2). */}
        <p data-slot="walky-reach" className="min-h-4 text-xs text-muted-foreground">
          {reach === null ? "" : t("walky.crew.reach", { count: reach })}
        </p>
        <Button className="h-11" onClick={submit} disabled={body === "" || tooLong || sending}>
          {sending ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
          {sending ? t("walky.crew.sending") : t("walky.crew.send")}
        </Button>
        {error !== null && (
          <p role="alert" className="text-sm text-status-blocked">
            {t("walky.crew.failed", { error })}
          </p>
        )}
        {receipts !== null && (
          <div data-slot="walky-receipts" className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">{t("walky.crew.receipts")}</span>
            {receipts.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("walky.crew.noReceipts")}</p>
            ) : (
              <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
                {receipts.map((r, i) => (
                  <li key={`${r.to ?? r.by}:${i}`} data-slot="walky-receipt" className="flex flex-col gap-0.5 px-3 py-2 text-sm">
                    <span className="min-w-0 truncate font-medium">{r.to ?? r.by}</span>
                    <span className={cn("text-xs", wasTaken(r) ? "text-muted-foreground" : "text-status-blocked")}>
                      {`${stateWord(r)} · ${verifiedWord(r)}`}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </BottomSheet>
  );
}
