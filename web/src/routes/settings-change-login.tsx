import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useParams } from "react-router";

import { AgentIcon } from "@/components/agent-icon";
import { SettingsPage } from "@/components/settings-page";
import { BottomBar } from "@/components/ui/bottom-bar";
import { Button } from "@/components/ui/button";
import { ListGroup, LIST_ROW_CORNERS } from "@/components/ui/list-group";
import { Notice } from "@/components/ui/notice";
import { SettingSlot } from "@/components/setting-slot";
import { useLocale } from "@/hooks/use-locale";
import { useNav } from "@/hooks/use-nav";
import { useSpaceActions } from "@/hooks/use-spaces";
import { accountName, harnessLabel, planWords, useAccounts, type AccountHarness, type AccountIdentity, type AccountRow } from "@/lib/accounts";
import { closePane, fetchAccounts } from "@/lib/api";
import {
  cameFromSession,
  flowOf,
  forgetFlow,
  hasOtherProfiles,
  loginChanged,
  reachOf,
  reachedSessions,
  rememberFlow,
  resultOf,
  type ChangeLoginFlow,
  type ChangeLoginResult,
  type Reach,
  type ReachedSession,
} from "@/lib/change-login";
import { t, tn } from "@/lib/i18n";
import type { JsonValue } from "@/lib/json";
import { accountPath, panePath, readFrom } from "@/lib/nav";
import { useOptionalRootData } from "@/lib/route-data";
import { useScope } from "@/lib/session";
import { cn } from "@/lib/utils";
import { mintRequestId } from "@/lib/worktree-name";

import { SignedInRow } from "./settings-accounts";

// CHANGE LOGIN (M101): `/settings/accounts/:id/login`, below the account's page. One page with three
// screens, and the agent's own sign-in session between the first two:
//
//   1. Before: who is signed in now, what happens to the sessions that run, one button.
//   2. The sign-in session: the button starts it exactly as "Sign in again" does (the same launch, gate
//      and audit line) and the phone moves to it, where the agent's own sign-in screens are cards. Back
//      on this page while it runs, the page says so and offers Open sign-in and Finish. While it runs the
//      page reads the list every 5 s and finishes on its own once the agent names a new email.
//   3. Finish ends the sign-in session (the pane's own close), reads who is signed in now, and says it.
//
// THE LEAD'S OWN MACHINE, as every Accounts page (settings-accounts.tsx): an account is a folder on the
// machine that holds it, and a sign-in start over the crew link is refused on the member on purpose.
// The code and the address never pass through this page: the code goes in the session's framed field.

/** How often the page reads the list while a sign-in session runs. The bridge re-reads the agent's answer at this pace too. */
const WATCH_MS = 5_000;
/** How many list reads Finish makes at most for an answer, and the pause between them. */
const READS = 4;
const READ_PAUSE_MS = 1_500;

type Phase = { kind: "before" } | { kind: "running" } | { kind: "ending" } | { kind: "result"; result: ChangeLoginResult; stillOpen: boolean; from: string | null };

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The pathname and query of the entry behind this one, or null. */
function fromOf(state: JsonValue | undefined): string | null {
  return readFrom(state) ?? null;
}

export function SettingsChangeLoginRoute() {
  useLocale();
  const { id = "" } = useParams();
  const nav = useNav();
  const scope = useScope();
  const location = useLocation();
  const accounts = useAccounts();
  const { start } = useSpaceActions();
  // The names of the sessions come from the snapshot the app already reads (the root route's data).
  const root = useOptionalRootData();
  const body = accounts.body;
  const row = body?.accounts.find((a) => a.id === id);
  const harness = body?.harnesses.find((h) => h.id === row?.harness);
  const [phase, setPhase] = useState<Phase>(() => (flowOf(id) === undefined ? { kind: "before" } : { kind: "running" }));
  const [busy, setBusy] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const accountPage = accountPath(id, scope);
  // SAFETY: React Router's location state is the JSON the app's own nav moves wrote (lib/nav.ts).
  const from = fromOf(location.state as JsonValue | undefined);
  const reload = accounts.reload;

  const finish = useCallback(
    async (flow: ChangeLoginFlow) => {
      setPhase({ kind: "ending" });
      let stillOpen = false;
      try {
        stillOpen = !(await closePane(flow.paneId)).ok;
      } catch {
        stillOpen = true;
      }
      // The bridge drops the account's answer when the session closes; the first read may come back
      // before the agent's status command has answered, so a few reads wait for it.
      let after: AccountIdentity | undefined;
      for (let i = 0; i < READS && after === undefined; i++) {
        if (i > 0) await pause(READ_PAUSE_MS);
        try {
          after = (await fetchAccounts()).accounts.find((a) => a.id === flow.account)?.identity;
        } catch {
          after = undefined;
        }
      }
      forgetFlow(flow.account);
      if (!live.current) return;
      setPhase({ kind: "result", result: resultOf(flow.before, after), stillOpen, from: flow.from });
      reload();
    },
    [reload],
  );

  // While the sign-in session runs: read the list on a timer, and finish once the agent names a new email.
  const running = phase.kind === "running";
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(reload, WATCH_MS);
    return () => clearInterval(timer);
  }, [running, reload]);
  useEffect(() => {
    const flow = flowOf(id);
    if (!running || flow === undefined || row === undefined) return;
    if (loginChanged(flow.before, row.identity)) void finish(flow);
  }, [running, id, row, finish]);

  async function begin(target: AccountRow) {
    if (busy) return;
    setBusy(true);
    setStartError(null);
    // The same ask as "Sign in again" on the account's page: the bridge picks the login-menu words for an
    // account that reads signed in (bridge/accounts-routes.ts `startLine`), never this page.
    const outcome = await start(
      { what: { kind: "harness", id: target.harness }, account: target.kind === "default" ? undefined : target.id, signIn: true, requestId: mintRequestId() },
      {},
    );
    if (live.current) setBusy(false);
    if (outcome.kind === "done") {
      if (outcome.paneId !== undefined) rememberFlow({ account: target.id, paneId: outcome.paneId, before: target.identity, from });
      if (live.current) setPhase({ kind: "running" });
      return;
    }
    if (live.current) setStartError(outcome.kind === "refused" && outcome.message !== "" ? outcome.message : t("accounts.signIn.unknown"));
  }

  // The large screen's header path: Profiles / <the account> / Change login.
  const crumbs = row === undefined ? undefined : [accountName(row), t("accounts.changeLogin.action")];

  if (phase.kind === "result") {
    const toSession = cameFromSession(phase.from);
    return (
      <SettingsPage title="accounts.changeLogin.action" heading={row === undefined ? undefined : accountName(row)} parent={accountPage} crumbs={crumbs}>
        <ChangeLoginResultView
          result={phase.result}
          reach={row === undefined ? { kind: "newOnly" } : reachOf(harness, row)}
          stillOpen={phase.stillOpen}
          backTo={toSession ? "session" : "account"}
          onBack={() => nav.up(toSession && phase.from !== null ? phase.from : accountPage)}
        />
      </SettingsPage>
    );
  }

  if (row === undefined) {
    return (
      <SettingsPage title="accounts.changeLogin.action" parent={accountPage}>
        {accounts.status === "unavailable" && (
          <Notice tone="neutral" variant="box">
            {t("apiError.accounts.unavailable")}
          </Notice>
        )}
        {accounts.status === "failed" && (
          <Notice tone="danger" variant="box" announce="alert">
            {t("accounts.loadFailed")}
          </Notice>
        )}
        {accounts.status === "ready" && (
          <Notice tone="neutral" variant="box">
            {t("accounts.gone")}
          </Notice>
        )}
      </SettingsPage>
    );
  }

  const flow = flowOf(id);
  if ((phase.kind === "running" || phase.kind === "ending") && flow !== undefined) {
    return (
      <SettingsPage title="accounts.changeLogin.action" heading={accountName(row)} parent={accountPage} crumbs={crumbs}>
        <ChangeLoginRunningView
          row={row}
          body={harness}
          ending={phase.kind === "ending"}
          onOpen={() => nav.down(panePath(flow.paneId))}
          onFinish={() => void finish(flow)}
        />
      </SettingsPage>
    );
  }

  return (
    <SettingsPage
      title="accounts.changeLogin.action"
      heading={accountName(row)}
      parent={accountPage}
      crumbs={crumbs}
      foot={
        <BottomBar className="px-4">
          <SettingSlot ids={["accounts.login.start"]} className="w-full">
            <Button className="h-11 w-full" disabled={busy} aria-busy={busy || undefined} onClick={() => void begin(row)}>
              {t("accounts.changeLogin.action")}
            </Button>
          </SettingSlot>
        </BottomBar>
      }
    >
      <ChangeLoginBeforeView
        row={row}
        harness={harness}
        agentLabel={harnessLabel(body, row.harness)}
        others={hasOtherProfiles(body?.accounts ?? [], row)}
        sessions={root === undefined ? [] : reachedSessions(row, root)}
        onOpenSession={(paneId) => nav.down(panePath(paneId))}
        error={startError}
      />
    </SettingsPage>
  );
}

const NO_SESSIONS: readonly ReachedSession[] = [];
const NO_OPEN = (): void => {};

/** The account's icon, name and agent, as the account's page draws them. */
function AccountLine({ row, agentLabel }: { row: AccountRow; agentLabel: string }) {
  return (
    <div className="flex items-center gap-3">
      <AgentIcon agent={row.harness} className="size-9 rounded-md" />
      <div className="min-w-0 flex-1">
        <p className="truncate font-semibold">{accountName(row)}</p>
        <p className="text-xs text-muted-foreground">{agentLabel}</p>
      </div>
    </div>
  );
}

function Hint({ text }: { text: string }) {
  return <p className="text-xs leading-5 text-muted-foreground">{text}</p>;
}

/**
 * What happens to the sessions that run: they follow (with their count when some run), or only new ones.
 * For an agent whose sessions follow, under the count: one row per session that runs in the profile, and
 * the line for the sessions Collie does not list. An agent whose sessions do not follow lists none.
 */
function ReachLines({ reach, sessions, onOpenSession }: { reach: Reach; sessions: readonly ReachedSession[]; onOpenSession: (paneId: string) => void }) {
  const follows = reach.kind === "running";
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5">
        <p className="text-sm">{follows ? t("accounts.changeLogin.reach") : t("accounts.changeLogin.newOnly")}</p>
        {follows && reach.count > 0 && <Hint text={tn("accounts.changeLogin.running", reach.count)} />}
      </div>
      {follows && sessions.length > 0 && (
        <>
          <SessionList sessions={sessions} onOpen={onOpenSession} />
          <Hint text={t("accounts.changeLogin.outside")} />
        </>
      )}
    </div>
  );
}

/** The sessions of the profile: name on line 1, the space under it, a tap goes to the session. */
function SessionList({ sessions, onOpen }: { sessions: readonly ReachedSession[]; onOpen: (paneId: string) => void }) {
  return (
    <ListGroup as="ul" className="divide-y divide-border">
      {sessions.map((session) => (
        <li key={session.paneId}>
          <button
            type="button"
            onClick={() => onOpen(session.paneId)}
            className={cn(
              "flex min-h-11 w-full min-w-0 flex-col justify-center px-3.5 py-2 text-left active:bg-muted/60 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring",
              LIST_ROW_CORNERS,
            )}
          >
            <span className="truncate text-sm font-medium">{session.name}</span>
            <span className="truncate text-[11px] leading-4 text-muted-foreground">{session.space}</span>
          </button>
        </li>
      ))}
    </ListGroup>
  );
}

/**
 * Screen 1, before the start: who is signed in now and what happens to the sessions that run. The
 * button is the page's foot. Exported for the design reference (playground/sections/accounts.tsx).
 */
export function ChangeLoginBeforeView({
  row,
  harness,
  agentLabel,
  others = false,
  sessions = NO_SESSIONS,
  onOpenSession = NO_OPEN,
  error = null,
}: {
  row: AccountRow;
  harness: AccountHarness | undefined;
  agentLabel: string;
  /** Another profile of this agent exists ({@link hasOtherProfiles}), so the page says they keep their login. */
  others?: boolean;
  /** The sessions that run in the profile ({@link reachedSessions}); none draws no list. */
  sessions?: readonly ReachedSession[];
  onOpenSession?: (paneId: string) => void;
  error?: string | null;
}) {
  useLocale();
  return (
    <div className="flex flex-col gap-4" data-slot="change-login-before">
      <AccountLine row={row} agentLabel={agentLabel} />
      <SignedInRow identity={row.identity} />
      {/* The page's first sentence, under who is signed in: what this page changes. */}
      <p className="text-sm" data-slot="change-login-what">
        {t("accounts.changeLogin.what")}
      </p>
      <ReachLines reach={reachOf(harness, row)} sessions={sessions} onOpenSession={onOpenSession} />
      {others && <Hint text={t("accounts.changeLogin.othersKeep")} />}
      <Hint text={t("accounts.changeLogin.oldStays")} />
      {error !== null && (
        <Notice tone="danger" variant="box" announce="alert">
          {t("accounts.signIn.failed", { reason: error })}
        </Notice>
      )}
    </div>
  );
}

/**
 * Screen 2, back on this page while the sign-in session runs: Open sign-in goes to it, Finish ends it and
 * reads who is signed in. Exported for the design reference.
 */
export function ChangeLoginRunningView({
  row,
  body,
  ending,
  onOpen,
  onFinish,
}: {
  row: AccountRow;
  body: AccountHarness | undefined;
  ending: boolean;
  onOpen: () => void;
  onFinish: () => void;
}) {
  useLocale();
  return (
    <div className="flex flex-col gap-4" data-slot="change-login-running">
      <AccountLine row={row} agentLabel={body?.label ?? row.harness} />
      <p className="text-sm">{t("accounts.changeLogin.runs")}</p>
      <Hint text={t("accounts.changeLogin.finishHint")} />
      <SettingSlot ids={["accounts.login.open", "accounts.login.finish"]} className="flex flex-col gap-2">
        <Button className="h-11 w-full" disabled={ending} onClick={onOpen}>
          {t("accounts.changeLogin.open")}
        </Button>
        <Button variant="outline" className="h-11 w-full" disabled={ending} aria-busy={ending || undefined} onClick={onFinish}>
          {t("accounts.changeLogin.finish")}
        </Button>
      </SettingSlot>
    </div>
  );
}

/** Screen 3, the result: who is signed in now, what the sessions do, and one way back. Exported for the design reference. */
export function ChangeLoginResultView({
  result,
  reach,
  stillOpen,
  backTo,
  onBack,
}: {
  result: ChangeLoginResult;
  reach: Reach;
  stillOpen: boolean;
  backTo: "session" | "account";
  onBack: () => void;
}) {
  useLocale();
  return (
    <div className="flex flex-col gap-4" data-slot="change-login-result">
      <ResultLines result={result} reach={reach} />
      {stillOpen && (
        <Notice tone="caution" variant="box">
          {t("accounts.changeLogin.stillOpen")}
        </Notice>
      )}
      <Button className="h-11 w-full" onClick={onBack}>
        {backTo === "session" ? t("accounts.changeLogin.backToSession") : t("accounts.changeLogin.backToAccount")}
      </Button>
    </div>
  );
}

function ResultLines({ result, reach }: { result: ChangeLoginResult; reach: Reach }) {
  if (result.kind === "unknown") return <p className="text-sm">{t("accounts.changeLogin.result.unknown")}</p>;
  if (result.kind === "signedOut") {
    return (
      <div className="flex flex-col gap-1">
        <p className="text-base font-semibold">{t("accounts.identity.notSignedIn")}</p>
        <Hint text={t("accounts.changeLogin.result.notFinished")} />
      </div>
    );
  }
  const plan = result.plan === undefined ? "" : planWords(result.plan);
  return (
    <div className="flex flex-col gap-1">
      <p className="break-all text-base font-semibold">
        {result.kind === "changed" ? t("accounts.changeLogin.result.signedInAs", { email: result.email }) : t("accounts.changeLogin.result.still", { email: result.email })}
      </p>
      {plan !== "" && <Hint text={t("accounts.changeLogin.plan", { plan })} />}
      {result.kind === "changed" && (
        <p className="text-sm">{reach.kind === "running" ? t("accounts.changeLogin.result.reach") : t("accounts.changeLogin.newOnly")}</p>
      )}
    </div>
  );
}
