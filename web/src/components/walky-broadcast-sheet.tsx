import { useEffect, useId, useRef, useState, type Ref } from "react";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { BottomSheet } from "@/components/ui/sheet";
import { useLocale } from "@/hooks/use-locale";
import { useWalkySend } from "@/hooks/use-walky-send";
import { fetchWalkyWho } from "@/lib/api";
import { t, tn } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import {
  bareAddress,
  isReachable,
  stateWord,
  targetWord,
  verifiedWord,
  WALKY_BODY_MAX,
  wasTaken,
  type WalkyReceipt,
  type WalkyRefusals,
  type WalkySkipped,
  type WalkyTarget,
} from "@/lib/walky";

// "Message all agents" on the Crew page (M62 spec 05): one text to every agent pane in the crew, or to
// every agent pane on one machine, from the operator. The sheet sends nothing by itself; the Send
// button posts `to: "all"` or `<memberId>/all` through `POST /api/walky`, and the bridge answers one
// receipt per target, which are listed below the field so the person sees where it landed and where
// it did not.
//
// ── THE CONFIRM STEP ──────────────────────────────────────────────────────────
// One text to every agent is the widest write the phone makes, so "Send message" does not post. It
// swaps itself for a question that names the count ("Message 3 agents on 2 machines?") with Send and
// Back; only Send posts. The count is the `who` list's own, for the target chosen, and when `who`
// could not be read the question says it does not know and still asks. The skipped shell panes and
// the bridge's refusal counts sit BELOW that control, so a late `who` answer never moves the button
// a thumb is about to press (DESIGN.md §2).
//
// The request id is minted once per attempt and a retry of the same attempt reuses it
// (hooks/use-walky-send.ts): a lost answer followed by a second tap returns the receipts the bridge
// already wrote and types nothing twice.

const ALL = "all";

/** A receipt's target as a row names it: `repo#branch (address)` when `who` knows the pane, else its {@link targetWord}. */
function labelOf(listed: readonly WalkyTarget[] | null, address: string): string {
  // A receipt's target never carries a token, and a `who` address may, so the two meet on the bare form.
  const known = listed?.find((r) => bareAddress(r.address) === address);
  return known === undefined ? targetWord(address) : `${known.label} (${address})`;
}

/** `reason count` pairs joined by ", ": the reasons are the bridge's own words, in its order, never translated. */
function refusalList(refusals: WalkyRefusals | null): string {
  if (refusals === null) return "";
  return Object.entries(refusals.counts)
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => `${reason} ${count}`)
    .join(", ");
}

/**
 * The question the confirm step asks: how many agents on how many machines the chosen target covers,
 * or that the count is not known when `who` could not be read. Exported for the states playground.
 */
export function confirmQuestion(covered: readonly WalkyTarget[] | null): string {
  if (covered === null) return t("walky.crew.confirmUnknown");
  return t("walky.crew.confirm", {
    agents: tn("walky.crew.confirm.agents", covered.length),
    machines: tn("walky.crew.confirm.machines", new Set(covered.map((r) => r.memberId)).size),
  });
}

/** The question with its two answers. Back is the first button and the one that takes focus (`backRef`). */
export function WalkyConfirm({
  question,
  backRef,
  onBack,
  onSend,
}: {
  question: string;
  backRef?: Ref<HTMLButtonElement>;
  onBack: () => void;
  onSend: () => void;
}) {
  useLocale();
  return (
    <div data-slot="walky-confirm" role="group" aria-label={question} className="flex flex-col gap-2">
      <p className="text-sm font-medium">{question}</p>
      <div className="grid grid-cols-2 gap-2">
        <Button ref={backRef} variant="outline" className="h-11" onClick={onBack}>
          {t("walky.crew.confirmBack")}
        </Button>
        <Button className="h-11" onClick={onSend}>
          {t("walky.crew.confirmSend")}
        </Button>
      </div>
    </div>
  );
}

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
  const [listed, setListed] = useState<WalkyTarget[] | null>(null);
  const [skipped, setSkipped] = useState<WalkySkipped[]>([]);
  const [refusals, setRefusals] = useState<WalkyRefusals | null>(null);
  const [confirming, setConfirming] = useState(false);
  const backRef = useRef<HTMLButtonElement>(null);
  // Where focus goes once the question is gone. Its two buttons leave the DOM with it, and a focused
  // node that leaves drops focus to the page behind the sheet, so the keyboard path would fall out:
  // Back hands focus to "Send message", and an answered Send to what came of it.
  const sendRef = useRef<HTMLButtonElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const receiptsRef = useRef<HTMLDivElement>(null);
  const [focusNext, setFocusNext] = useState<"send" | "outcome" | null>(null);

  // A fresh look every time the sheet opens, and nothing carried over from the last message.
  useEffect(() => {
    if (!open) return;
    setReceipts(null);
    setError(null);
    setListed(null);
    setSkipped([]);
    setRefusals(null);
    setConfirming(false);
    const abort = new AbortController();
    fetchWalkyWho(abort.signal).then(
      (who) => {
        setListed(who.targets);
        setSkipped(who.skipped);
        setRefusals(who.refusals);
        return who;
      },
      () => setListed(null),
    );
    return () => abort.abort();
  }, [open]);

  // The Send button is gone while the question stands, so focus moves to the safe answer.
  useEffect(() => {
    if (confirming) backRef.current?.focus();
  }, [confirming]);

  useEffect(() => {
    if (focusNext === null) return;
    const node = focusNext === "send" ? sendRef.current : error !== null ? errorRef.current : receiptsRef.current;
    node?.focus({ preventScroll: true });
    setFocusNext(null);
  }, [focusNext, error]);

  // A chosen machine that has left the crew (it is no longer in `members`) is not a target any more:
  // the picker has no row for it, and an armed question about it is put away, so it cannot be answered
  // for a target the picker no longer shows. The choice goes back to every machine, whose own count
  // the next question names.
  const gone = target !== ALL && !members.some((m) => m.id === target);
  useEffect(() => {
    if (!gone) return;
    setTarget(ALL);
    setConfirming(false);
  }, [gone]);

  const covers = (memberId: string) => target === ALL || memberId === target;
  // The count and the question name only the panes a message can reach now: a lead keeps an
  // unreachable member's last panes in `who`, and those do not take a message until it is back.
  const covered = listed === null ? null : listed.filter((r) => covers(r.memberId) && isReachable(r));
  const reach = covered === null ? null : covered.length;
  const coveredSkipped = skipped.filter((s) => covers(s.memberId));
  const refused = refusalList(refusals);

  const body = text.trim();
  const tooLong = body.length > WALKY_BODY_MAX;
  const to = target === ALL ? ALL : `${target}/${ALL}`;
  const tooLongId = useId();

  async function submit() {
    if (body === "" || tooLong || sending) return;
    setConfirming(false);
    setError(null);
    const result = await send(to, body);
    if (result === null) return;
    setFocusNext("outcome");
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
            onChange={(e) => {
              setText(e.target.value);
              setConfirming(false);
            }}
            placeholder={t("walky.crew.textPlaceholder")}
            aria-describedby={tooLong ? tooLongId : undefined}
            rows={4}
            className="min-h-24 w-full resize-none rounded-lg border border-border bg-background p-3 text-base text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          />
        </label>
        {/* Why Send is off: a disabled button says nothing by itself on a phone. Outside the label, so
            it describes the field and does not become part of its name. */}
        {tooLong && (
          <p id={tooLongId} className="text-xs text-status-blocked">
            {t("walky.composer.tooLong")}
          </p>
        )}
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">{t("walky.crew.target")}</span>
          <Select
            value={target}
            onChange={(e) => {
              setTarget(e.target.value);
              setConfirming(false);
            }}
          >
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
        {confirming ? (
          <WalkyConfirm
            question={confirmQuestion(covered)}
            backRef={backRef}
            onBack={() => {
              setConfirming(false);
              setFocusNext("send");
            }}
            onSend={submit}
          />
        ) : (
          <Button ref={sendRef} className="h-11" onClick={() => setConfirming(true)} disabled={body === "" || tooLong || sending}>
            {sending ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
            {sending ? t("walky.crew.sending") : t("walky.crew.send")}
          </Button>
        )}
        {coveredSkipped.length > 0 && (
          <div data-slot="walky-skipped" className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">{t("walky.crew.skippedTitle")}</span>
            <ul className="flex flex-col gap-0.5 text-xs text-muted-foreground">
              {coveredSkipped.map((s) => (
                <li key={s.address} className="min-w-0 truncate">
                  {t("walky.crew.skippedRow", { label: s.label, address: s.address })}
                </li>
              ))}
            </ul>
          </div>
        )}
        {refused !== "" && (
          <p data-slot="walky-refusals" className="text-xs text-muted-foreground">
            {t("walky.crew.refusals", { list: refused })}
          </p>
        )}
        {error !== null && (
          <p
            ref={errorRef}
            role="alert"
            tabIndex={-1}
            className="text-sm text-status-blocked outline-none"
          >
            {t("walky.crew.failed", { error })}
          </p>
        )}
        {receipts !== null && (
          <div
            ref={receiptsRef}
            data-slot="walky-receipts"
            tabIndex={-1}
            className="flex flex-col gap-1 outline-none"
          >
            <span className="text-xs font-medium text-muted-foreground">{t("walky.crew.receipts")}</span>
            {receipts.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("walky.crew.noReceipts")}</p>
            ) : (
              <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
                {receipts.map((r, i) => (
                  <li key={`${r.target}:${i}`} data-slot="walky-receipt" className="flex flex-col gap-0.5 px-3 py-2 text-sm">
                    {/* The target's own label (repo#branch) when the who list knows it, then its address. */}
                    <span className="min-w-0 truncate font-medium">{labelOf(listed, r.target)}</span>
                    <span className={cn("text-xs first-letter:uppercase", wasTaken(r) ? "text-muted-foreground" : "text-status-blocked")}>
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
