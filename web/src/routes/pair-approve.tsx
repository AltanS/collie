import { useCallback, useEffect, useId, useState } from "react";
import { useSearchParams } from "react-router";

import { Icon } from "@/components/icons/icon";
import { SettingsPage } from "@/components/settings-page";
import { clockOf } from "@/components/pair-with-phone";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { useLocale } from "@/hooks/use-locale";
import { useNav } from "@/hooks/use-nav";
import { answerPairApproval, fetchPairApproval, type PairApproval, type PairApproveResult, type PairRoute } from "@/lib/api";
import { t, type MessageKey } from "@/lib/i18n";
import { homePath } from "@/lib/nav";
import { dateTime } from "@/lib/format";
import { usePairing } from "@/lib/pairing";
import { useScope } from "@/lib/session";

// THE APPROVER'S PAGE (ADR 0139), `/pair/approve?r=<public id>`: the one way in is the QR the new
// device shows. It reads the request, says what the bridge knows of the asker (browser and system
// family, the network class), and asks the person to tap the code the other screen shows, one of
// three. There is no plain Yes: picking the right code is the proof that the person holding this
// paired device can see the other screen, which a link sent by a stranger cannot give. A wrong tap and
// "Not my device" end the request for good.
//
// A browser that is not paired is told so and offered nothing; the bridge would refuse it anyway.
// Back goes to the Dashboard.

const NAME_MAX = 48;

export type PairApproveState =
  | { kind: "not-paired" }
  | { kind: "loading" }
  | {
      kind: "open";
      asker: string;
      /** The socket's class: the fact. */
      route: PairRoute;
      /** What a front door on this machine passed on: a claim, shown as one. */
      claimed: PairRoute | null;
      choices: readonly string[];
      remainingMs: number;
      /** The approver's own end, which the new device inherits; null for none. */
      endsAt: number | null;
      name: string;
      nameError: boolean;
      busy: boolean;
    }
  | { kind: "approved"; label: string }
  | { kind: "wrong-code" }
  | { kind: "declined" }
  | { kind: "gone" }
  | { kind: "answered" }
  | { kind: "forbidden" }
  | { kind: "error" };

// THE NETWORK LINE STATES ONLY WHAT THE SOCKET SAYS. A request through a front door on this machine
// (`tailscale serve`, Caddy) reaches the bridge from loopback, and the class the door passed on is a
// header a local program can write too, so it is shown as the door's word, never as fact. An internet
// or unknown class, said either way, adds a warning.
const ROUTE_LINE = {
  loopback: "pairApprove.route.loopback",
  tailnet: "pairApprove.route.tailnet",
  lan: "pairApprove.route.lan",
  internet: "pairApprove.route.internet",
  unknown: "pairApprove.route.unknown",
} as const satisfies Record<PairRoute, MessageKey>;

const WHERE = {
  loopback: "pairApprove.where.loopback",
  tailnet: "pairApprove.where.tailnet",
  lan: "pairApprove.where.lan",
  internet: "pairApprove.where.internet",
  unknown: "pairApprove.where.unknown",
} as const satisfies Record<PairRoute, MessageKey>;

/** The network lines for a request: the fact, the front door's claim if any, and whether to warn. */
export interface RouteLines {
  readonly line: string;
  readonly claim: string | null;
  readonly outside: boolean;
}

export function routeLines(route: PairRoute, claimed: PairRoute | null): RouteLines {
  const throughDoor = route === "loopback" && claimed !== null;
  const outside = [route, claimed].some((r) => r === "internet" || r === "unknown");
  return {
    line: t(throughDoor ? "pairApprove.route.frontDoor" : ROUTE_LINE[route]),
    claim: throughDoor ? t("pairApprove.claim", { where: t(WHERE[claimed]) }) : null,
    outside,
  };
}

/** "Chrome on Linux", or whichever half the bridge knew. */
export function askerName(browser: string | null, os: string | null): string | null {
  if (browser !== null && os !== null) return t("pairApprove.asker", { browser, os });
  return browser ?? os;
}

export interface PairApproveActions {
  onPick: (code: string) => void;
  onRefuse: () => void;
  onName: (name: string) => void;
  onRetry: () => void;
  onDone: () => void;
}

export function PairApproveView({ state, actions }: { state: PairApproveState; actions: PairApproveActions }) {
  useLocale();
  return (
    <div data-slot="pair-approve" data-state={state.kind} className="flex flex-col gap-4">
      <ApproveBody state={state} actions={actions} />
    </div>
  );
}

function Final({ line, tone = "plain", action, onAction }: { line: string; tone?: "plain" | "done" | "blocked"; action?: string; onAction?: () => void }) {
  const colour = tone === "done" ? "text-status-done" : tone === "blocked" ? "text-status-blocked" : "";
  return (
    <>
      <p role="status" className={`text-sm ${colour}`}>
        {line}
      </p>
      {action !== undefined && onAction !== undefined && (
        <Button variant="outline" className="h-11" onClick={onAction}>
          {action}
        </Button>
      )}
    </>
  );
}

function ApproveBody({ state, actions }: { state: PairApproveState; actions: PairApproveActions }) {
  switch (state.kind) {
    case "not-paired":
      return <Final line={t("pairApprove.notPaired")} />;
    case "forbidden":
      return <Final line={t("pairApprove.forbidden")} />;
    case "loading":
      return <Icon name="busy" role="img" aria-label={t("pairApprove.pageTitle")} className="size-5 animate-spin text-muted-foreground" />;
    case "open":
      return <OpenRequest state={state} actions={actions} />;
    case "approved":
      return <Final line={t("pairApprove.approved", { label: state.label })} tone="done" action={t("pairApprove.done")} onAction={actions.onDone} />;
    case "wrong-code":
      return <Final line={t("pairApprove.wrongCode")} tone="blocked" action={t("pairApprove.done")} onAction={actions.onDone} />;
    case "declined":
      return <Final line={t("pairApprove.declined")} action={t("pairApprove.done")} onAction={actions.onDone} />;
    case "gone":
      return <Final line={t("pairApprove.gone")} action={t("pairApprove.done")} onAction={actions.onDone} />;
    case "answered":
      return <Final line={t("pairApprove.answered")} action={t("pairApprove.done")} onAction={actions.onDone} />;
    case "error":
      return <Final line={t("pairApprove.error")} action={t("pairApprove.retry")} onAction={actions.onRetry} />;
  }
}

function OpenRequest({ state, actions }: { state: Extract<PairApproveState, { kind: "open" }>; actions: PairApproveActions }) {
  const pickId = useId();
  const nameId = useId();
  const errorId = useId();
  const where = routeLines(state.route, state.claimed);
  return (
    <>
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-semibold">{t("pairApprove.question")}</h2>
        <p className="flex items-center gap-2 text-sm font-medium">
          <Icon name="phone" className="size-4 shrink-0 text-muted-foreground" />
          {state.asker}
        </p>
        <p className="text-sm text-muted-foreground">{where.line}</p>
        {where.claim !== null && <p className="text-xs text-muted-foreground">{where.claim}</p>}
        <p role="timer" className="text-sm tabular-nums text-muted-foreground">
          {t("pair.endsIn", { time: clockOf(state.remainingMs) })}
        </p>
      </div>
      {where.outside && (
        <Notice tone="caution" variant="box" icon={<Icon name="error" />}>
          {t("pairApprove.outside")}
        </Notice>
      )}
      {state.endsAt !== null && <p className="text-sm">{t("pairApprove.endsWithYours", { date: dateTime(state.endsAt) })}</p>}
      <label htmlFor={nameId} className="flex flex-col gap-1">
        <span className="text-xs font-medium text-muted-foreground">{t("pairApprove.nameLabel")}</span>
        <input
          id={nameId}
          value={state.name}
          maxLength={NAME_MAX}
          onChange={(e) => actions.onName(e.target.value)}
          autoCorrect="off"
          autoComplete="off"
          aria-invalid={state.nameError}
          aria-describedby={state.nameError ? errorId : undefined}
          className="h-11 rounded-md border border-border bg-background px-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        />
      </label>
      {state.nameError && (
        <p id={errorId} className="text-xs text-status-blocked">
          {t("pairApprove.nameBad")}
        </p>
      )}
      <div className="flex flex-col gap-0.5">
        <p id={pickId} className="text-sm font-medium">
          {t("pairApprove.pick")}
        </p>
        <p className="text-sm text-muted-foreground">{t("pairApprove.onlyYours")}</p>
      </div>
      <div role="group" aria-labelledby={pickId} className="grid grid-cols-1 gap-2">
        {state.choices.map((code) => (
          <Button
            key={code}
            variant="outline"
            disabled={state.busy}
            onClick={() => actions.onPick(code)}
            className="h-14 font-mono text-2xl font-semibold tracking-[0.3em]"
          >
            {code}
          </Button>
        ))}
      </div>
      <Button variant="ghost" className="h-11" disabled={state.busy} onClick={actions.onRefuse}>
        {t("pairApprove.notMine")}
      </Button>
    </>
  );
}

/** A name the bridge would take: not blank, not longer than its limit. Hidden characters are its call. */
function nameFits(name: string): boolean {
  const trimmed = name.trim();
  return trimmed !== "" && trimmed.length <= NAME_MAX;
}

type Phase = Exclude<PairApproveState, { kind: "not-paired" } | { kind: "open" }> | (Omit<Extract<PairApproveState, { kind: "open" }>, "remainingMs"> & { deadline: number });

function phaseOf(result: PairApproveResult): Phase | null {
  switch (result.state) {
    case "approved":
      return { kind: "approved", label: result.label };
    case "refused":
      return result.reason === "wrong-code" ? { kind: "wrong-code" } : { kind: "declined" };
    case "gone":
      return { kind: "gone" };
    case "answered":
      return { kind: "answered" };
    case "forbidden":
      return { kind: "forbidden" };
    case "bad-label":
      return null;
  }
}

export function PairApproveRoute() {
  useLocale();
  const nav = useNav();
  const scope = useScope();
  const [params] = useSearchParams();
  const publicId = params.get("r") ?? "";
  const { token, refused } = usePairing();
  const notPaired = token === null || refused;
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [now, setNow] = useState(() => Date.now());
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (notPaired) return;
    if (publicId === "") {
      setPhase({ kind: "gone" });
      return;
    }
    const ctrl = new AbortController();
    setPhase({ kind: "loading" });
    const read = async () => {
      let view: PairApproval;
      try {
        view = await fetchPairApproval(publicId, ctrl.signal);
      } catch {
        if (!ctrl.signal.aborted) setPhase({ kind: "error" });
        return;
      }
      if (ctrl.signal.aborted) return;
      if (view.state !== "open") {
        setPhase({ kind: view.state });
        return;
      }
      const at = Date.now();
      setNow(at);
      setPhase({
        kind: "open",
        asker: askerName(view.browser, view.os) ?? t("pairApprove.askerUnknown"),
        route: view.route,
        claimed: view.claimed,
        endsAt: view.endsAt,
        choices: view.choices,
        deadline: at + view.expiresInMs,
        name: askerName(view.browser, view.os) ?? t("pairApprove.nameDefault"),
        nameError: false,
        busy: false,
      });
    };
    void read();
    return () => ctrl.abort();
  }, [publicId, notPaired, attempt]);

  const deadline = phase.kind === "open" ? phase.deadline : null;
  useEffect(() => {
    if (deadline === null) return;
    const id = window.setInterval(() => {
      const at = Date.now();
      setNow(at);
      if (at >= deadline) setPhase((p) => (p.kind === "open" && !p.busy ? { kind: "gone" } : p));
    }, 1000);
    return () => window.clearInterval(id);
  }, [deadline]);

  const send = useCallback(
    async (answer: { code: string; label: string } | { refuse: true }) => {
      setPhase((p) => (p.kind === "open" ? { ...p, busy: true, nameError: false } : p));
      try {
        const result = await answerPairApproval(publicId, answer);
        const next = phaseOf(result);
        setPhase((p) => next ?? (p.kind === "open" ? { ...p, busy: false, nameError: true } : p));
      } catch {
        setPhase({ kind: "error" });
      }
    },
    [publicId],
  );

  const actions: PairApproveActions = {
    onPick: (code) => {
      if (phase.kind !== "open") return;
      if (!nameFits(phase.name)) {
        setPhase({ ...phase, nameError: true });
        return;
      }
      void send({ code, label: phase.name.trim() });
    },
    onRefuse: () => void send({ refuse: true }),
    onName: (name) => setPhase((p) => (p.kind === "open" ? { ...p, name, nameError: false } : p)),
    onRetry: () => setAttempt((n) => n + 1),
    onDone: () => nav.up(homePath(scope)),
  };

  const state: PairApproveState = notPaired
    ? { kind: "not-paired" }
    : phase.kind === "open"
      ? {
          kind: "open",
          asker: phase.asker,
          route: phase.route,
          claimed: phase.claimed,
          endsAt: phase.endsAt,
          choices: phase.choices,
          remainingMs: phase.deadline - now,
          name: phase.name,
          nameError: phase.nameError,
          busy: phase.busy,
        }
      : phase;

  return (
    <SettingsPage title="pairApprove.pageTitle" parent={homePath(scope)}>
      <PairApproveView state={state} actions={actions} />
    </SettingsPage>
  );
}
