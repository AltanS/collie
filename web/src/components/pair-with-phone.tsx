import { useEffect, useId, useRef, useState } from "react";

import { Icon } from "@/components/icons/icon";
import { QrCode } from "@/components/qr-code";
import { Button } from "@/components/ui/button";
import { useLocale } from "@/hooks/use-locale";
import { cancelPairRequest, pollPairRequest, startPairRequest } from "@/lib/api";
import { mounted } from "@/lib/base-path";
import { t } from "@/lib/i18n";
import { setDeviceToken } from "@/lib/pairing";

// PAIR THIS DEVICE WITH YOUR PHONE (ADR 0139). The block an unpaired browser shows beside the
// `collie pair` form: it asks the bridge for a pairing request, draws a QR code to the approver page
// and the code to tap there, then polls until a paired phone answers or the two minutes run out.
//
// The poll secret lives in a ref of this component and nowhere else: not in state a devtools panel
// shows, not in storage, not in a URL. Cancel, an unmount or an answer forgets it; Cancel and an
// unmount first end the request on the bridge with it (`DELETE`), so it frees its place at once. The token the
// approved poll hands over is stored the way the code form stores it (`setDeviceToken`), and the page
// then reloads so every loader reads with it.
//
// The view is pure (`PairWithPhoneView`), so the playground and the tests draw each state without a
// bridge; the container owns the request, the poll and the clock.

/** How often the new device asks whether it was let in. */
export const PAIR_POLL_MS = 1500;

/** Past the countdown, how long a poll that cannot reach the bridge waits before it gives up. */
const OFFLINE_GRACE_MS = 10_000;

export type PairPhoneState =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "waiting"; code: string; link: string; remainingMs: number }
  | { kind: "approved"; label: string }
  | { kind: "refused" }
  | { kind: "expired" }
  | { kind: "rate-limited"; retryAfterSeconds: number }
  | { kind: "no-approver" }
  | { kind: "refused-before" }
  | { kind: "error" };

/** `m:ss`, the countdown's and the rate limit's one spelling. */
export function clockOf(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** The approver page's address for a request, at this origin and under this app's mount (ADR 0052). */
export function approveLink(publicId: string): string {
  return `${window.location.origin}${mounted(`/pair/approve?r=${encodeURIComponent(publicId)}`)}`;
}

/** The sentence around a literal `collie pair`, which is never translated. */
function NoApproverLine() {
  const command = "collie pair";
  const text = t("pairPhone.noApprover", { command });
  const at = text.indexOf(command);
  if (at < 0) return <p className="text-sm text-muted-foreground">{text}</p>;
  return (
    <p className="text-sm text-muted-foreground">
      {text.slice(0, at)}
      <code className="font-mono text-[13px]">{command}</code>
      {text.slice(at + command.length)}
    </p>
  );
}

export function PairWithPhoneView({
  state,
  onStart,
  onCancel,
}: {
  state: PairPhoneState;
  onStart: () => void;
  onCancel: () => void;
}) {
  useLocale();
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} data-slot="pair-with-phone" data-state={state.kind} className="flex flex-col gap-3">
      <div>
        <h2 id={titleId} className="font-medium">
          {t("pairPhone.title")}
        </h2>
        {(state.kind === "idle" || state.kind === "starting") && <p className="text-sm text-muted-foreground">{t("pairPhone.body")}</p>}
      </div>
      <PairPhoneBody state={state} onStart={onStart} onCancel={onCancel} />
    </section>
  );
}

function PairPhoneBody({ state, onStart, onCancel }: { state: PairPhoneState; onStart: () => void; onCancel: () => void }) {
  switch (state.kind) {
    case "idle":
    case "starting":
      return (
        <Button className="h-11" disabled={state.kind === "starting"} onClick={onStart}>
          {state.kind === "starting" ? <Icon name="busy" className="size-4 animate-spin" /> : <Icon name="phone" className="size-4" />}
          {t("pairPhone.start")}
        </Button>
      );
    case "waiting":
      return (
        <div className="flex flex-col items-center gap-3">
          <p className="self-start text-sm text-muted-foreground">{t("pairPhone.scan")}</p>
          <QrCode value={state.link} label={t("pairPhone.qrLabel")} />
          <p className="text-xs font-medium text-muted-foreground">{t("pairPhone.codeLabel")}</p>
          {/* Large and spaced, so it reads across a desk. Each letter is its own glyph for a screen
              reader too: the label above names it, and the code is the text. */}
          <p data-slot="pair-code" className="font-mono text-4xl font-semibold tracking-[0.3em] text-foreground">
            {state.code}
          </p>
          {/* `timer` is a live region that is polite by default and never reads every second. */}
          <p role="timer" className="text-sm tabular-nums text-muted-foreground">
            {t("pair.endsIn", { time: clockOf(state.remainingMs) })}
          </p>
          <Button variant="outline" className="h-11 w-full" onClick={onCancel}>
            {t("pairPhone.cancel")}
          </Button>
        </div>
      );
    case "approved":
      return (
        <p role="status" className="flex items-center gap-2 text-sm text-status-done">
          <Icon name="busy" className="size-4 animate-spin" />
          {t("pairPhone.approved", { label: state.label })}
        </p>
      );
    case "refused":
      return <Ended line={t("pairPhone.refused")} action={t("pairPhone.again")} onStart={onStart} />;
    case "expired":
      return <Ended line={t("pairPhone.expired")} action={t("pairPhone.again")} onStart={onStart} />;
    case "rate-limited":
      return <Ended line={t("pairPhone.rateLimited", { time: clockOf(state.retryAfterSeconds * 1000) })} action={t("pairPhone.retry")} onStart={onStart} />;
    case "error":
      return <Ended line={t("pairPhone.error")} action={t("pairPhone.retry")} onStart={onStart} />;
    case "no-approver":
      return <NoApproverLine />;
    case "refused-before":
      return <p className="text-sm text-muted-foreground">{t("pairPhone.refusedBefore")}</p>;
  }
}

function Ended({ line, action, onStart }: { line: string; action: string; onStart: () => void }) {
  return (
    <div className="flex flex-col gap-3">
      <p role="status" className="text-sm">
        {line}
      </p>
      <Button variant="outline" className="h-11" onClick={onStart}>
        {action}
      </Button>
    </div>
  );
}

/** After pairing: a full reload, so every loader reads with the new token. */
function reloadPage(): void {
  window.location.reload();
}

/** The one open request's private half: the id and the secret only this tab holds. */
interface OpenRequest {
  readonly publicId: string;
  readonly pollSecret: string;
}

/** The container's own state: what the view shows, with the countdown kept as a deadline. */
type Flow = Exclude<PairPhoneState, { kind: "waiting" }> | { kind: "waiting"; code: string; link: string; deadline: number };

export function PairWithPhone({
  onPaired = reloadPage,
  pollMs = PAIR_POLL_MS,
}: {
  /** After the token is stored. The app reloads, so every loader reads with it. */
  onPaired?: () => void;
  /** The poll's pace. A test shortens it; the app never passes it. */
  pollMs?: number;
}) {
  const [flow, setFlow] = useState<Flow>({ kind: "idle" });
  const open = useRef<OpenRequest | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const paired = useRef(onPaired);
  useEffect(() => {
    paired.current = onPaired;
  }, [onPaired]);

  // End the open request, if any, and forget its secret. Nothing waits on the bridge's answer.
  const drop = () => {
    const request = open.current;
    open.current = null;
    if (request !== null) void cancelPairRequest(request.publicId, request.pollSecret).catch(() => {});
  };
  const dropRef = useRef(drop);
  useEffect(() => {
    dropRef.current = drop;
  });

  // The block went away (the operator left the screen): end the request it showed.
  useEffect(() => () => dropRef.current(), []);

  async function start() {
    drop();
    setFlow({ kind: "starting" });
    try {
      const res = await startPairRequest();
      if (!res.ok) {
        if (res.reason === "rate-limited") setFlow({ kind: "rate-limited", retryAfterSeconds: res.retryAfterSeconds });
        else if (res.reason === "no-approver") setFlow({ kind: "no-approver" });
        else setFlow({ kind: "refused-before" });
        return;
      }
      const at = Date.now();
      open.current = { publicId: res.publicId, pollSecret: res.pollSecret };
      setNow(at);
      setFlow({ kind: "waiting", code: res.code, link: approveLink(res.publicId), deadline: at + res.expiresInMs });
    } catch {
      setFlow({ kind: "error" });
    }
  }

  function cancel() {
    drop();
    setFlow({ kind: "idle" });
  }

  // One poll chain per request, keyed by its deadline (a new request always has a new one).
  const deadline = flow.kind === "waiting" ? flow.deadline : null;

  // The countdown.
  useEffect(() => {
    if (deadline === null) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [deadline]);

  // The poll. One chain of timeouts, never two in flight; an unreachable bridge is retried until the
  // countdown (and a short grace) ran out.
  useEffect(() => {
    if (deadline === null) return;
    const request = open.current;
    if (request === null) return;
    const ctrl = new AbortController();
    let timer = 0;
    const settle = (next: Flow) => {
      if (ctrl.signal.aborted || open.current !== request) return;
      open.current = null;
      setFlow(next);
    };
    const tick = async () => {
      try {
        const answer = await pollPairRequest(request.publicId, request.pollSecret, ctrl.signal);
        if (ctrl.signal.aborted || open.current !== request) return;
        if (answer.state === "approved") {
          // The token exists once: store it before anything else, as the code form does.
          setDeviceToken(answer.token);
          settle({ kind: "approved", label: answer.label });
          paired.current();
          return;
        }
        if (answer.state === "refused") return settle({ kind: "refused" });
        if (answer.state === "expired" || answer.state === "gone") return settle({ kind: "expired" });
      } catch {
        if (ctrl.signal.aborted) return;
        if (Date.now() > deadline + OFFLINE_GRACE_MS) return settle({ kind: "expired" });
      }
      timer = window.setTimeout(() => void tick(), pollMs);
    };
    timer = window.setTimeout(() => void tick(), pollMs);
    return () => {
      ctrl.abort();
      window.clearTimeout(timer);
    };
  }, [deadline, pollMs]);

  const state: PairPhoneState =
    flow.kind === "waiting" ? { kind: "waiting", code: flow.code, link: flow.link, remainingMs: flow.deadline - now } : flow;
  return <PairWithPhoneView state={state} onStart={() => void start()} onCancel={cancel} />;
}
