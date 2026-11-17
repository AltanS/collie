// Profiles section of the design reference (M101 spec 04): who is signed in on a profile, as the list
// row's second line and as the details row; and Change login (M101): its three screens, the session
// sheet's row, and the sign-in card's one button. Every card mounts the REAL pieces the Settings pages draw
// (`AccountListRow`, `SignedInRow` in routes/settings-accounts.tsx) over fixtures, so the reference shows
// what ships. Made-up addresses only.
//
// DEV-ONLY, unreachable from the app entry: see ../app.tsx and web/design.html.

import type { ReactNode } from "react";

import { BoxTextBlock } from "@/components/box-text-block";
import { PaneSettingsView } from "@/components/pane-settings-sheet";
import { BottomBar } from "@/components/ui/bottom-bar";
import { Button } from "@/components/ui/button";
import { ListGroup } from "@/components/ui/list-group";
import { sameLoginLine, type AccountHarness, type AccountRow } from "@/lib/accounts";
import type { BoxTextModel } from "@/lib/blocks";
import { t } from "@/lib/i18n";
import { AccountListRow, IntroLines, SignedInRow } from "@/routes/settings-accounts";
import { ChangeLoginBeforeView, ChangeLoginResultView, ChangeLoginRunningView } from "@/routes/settings-change-login";

import { Card, Group, Section, type SectionDef } from "../layout";

export const DEF: SectionDef = {
  id: "accounts",
  title: "Profiles",
  intent:
    "Who is signed in on each profile, from the agent's own status command: the email under the profile's name in the list, its middle given up when it does not fit, and one row on the profile's page with the full address and the plan. A profile that is not signed in says so; an agent that cannot tell shows what it showed before. A profile row counts the sessions that run in it, two profiles with one login each name the other, the page opens with one line and a More, and Change login lists the sessions it reaches.",
};

const NOW = Date.parse("2026-11-16T09:41:00Z");

function row(over: Partial<AccountRow>): AccountRow {
  return {
    id: "claude:default",
    harness: "claude",
    label: "",
    kind: "default",
    folder: "~/.claude",
    startLine: "claude",
    windows: [
      { window: "5h", usedPct: 42, resetsAt: NOW + 2 * 3_600_000 },
      { window: "7d", usedPct: 18, resetsAt: NOW + 4 * 86_400_000 },
    ],
    seenAt: NOW - 120_000,
    live: false,
    ...over,
  };
}

const DEFAULT_ROW = row({ identity: { signedIn: true, email: "someone@example.com", plan: "max" }, live: true });
const WORK_ROW = row({
  id: "acc-work",
  label: "Work",
  kind: "shared",
  folder: "~/.claude-work",
  startLine: "CLAUDE_CONFIG_DIR=~/.claude-work claude",
  identity: { signedIn: true, email: "someone.with.a.long.name@engineering.example-company.com", plan: "team" },
});
const NEW_ROW = row({ id: "acc-new", label: "Spare", kind: "own", folder: "~/.claude-spare", startLine: "CLAUDE_CONFIG_DIR=~/.claude-spare claude", windows: [], seenAt: null, identity: { signedIn: false } });
const CODEX_ROW = row({ id: "codex:default", harness: "codex", folder: "~/.codex", startLine: "codex", windows: [], seenAt: null });

const CLAUDE: AccountHarness = {
  id: "claude",
  label: "Claude Code",
  select: "CLAUDE_CONFIG_DIR",
  kinds: ["shared", "own"],
  newFolder: "~/.claude-{slug}",
  binary: "claude",
  reachesRunningSessions: true,
  signInHosts: ["claude.com", "platform.claude.com"],
};
const CODEX: AccountHarness = { id: "codex", label: "Codex", select: "CODEX_HOME", kinds: ["own"], newFolder: "~/.codex-{slug}", binary: "codex" };
/** Two profiles of one agent signed in with one login, the second spelled in another letter case. */
const SHARED_LOGIN_ROWS = [DEFAULT_ROW, { ...WORK_ROW, identity: { signedIn: true, email: "Someone@Example.com", plan: "team" } }];
const SESSIONS = [
  { paneId: "w1:p1", name: "Fix the build", space: "lodge" },
  { paneId: "w2:p1", name: "Write the docs", space: "workshop" },
];
const CODEX_SIGNED_IN = { ...CODEX_ROW, identity: { signedIn: true, email: "someone@example.com" }, running: 1 };
const RUNNING_ROW = { ...DEFAULT_ROW, windows: [{ window: "5h", usedPct: 100, resetsAt: NOW + 3_600_000 }], running: 2 };

/** The sign-in card's model as the reader builds it from `/login` (made-up address, masked values). */
const SIGN_IN_CARD = (address: string): BoxTextModel => ({
  title: "Login",
  phase: "filled",
  text: [
    [{ kind: "plain", text: "Browser didn't open? Use the url below to sign in (c to copy)" }],
    [],
    [{ kind: "link", text: address, href: address }],
    [],
    [{ kind: "plain", text: "Paste code here if prompted >" }],
  ],
});
const CLAUDE_ADDRESS = "https://claude.com/cai/oauth/authorize?code=true&client_id=00000000-0000-0000-0000-000000000000&response_type=code&state=XXXXXXXX";

/** A phone-wide column on the page ground. */
function Column({ children }: { children: ReactNode }) {
  return (
    <div className="w-[360px] max-w-full rounded-sm bg-background ring-1 ring-rule">
      <div className="flex flex-col gap-4 p-4">{children}</div>
    </div>
  );
}

/** A Settings page's column, with the page's foot button where the screen has one. */
function Screen({ children, foot = false }: { children: ReactNode; foot?: boolean }) {
  return (
    <Column>
      {children}
      {foot && (
        <BottomBar className="px-0">
          <Button className="h-11 w-full">{t("accounts.changeLogin.action")}</Button>
        </BottomBar>
      )}
    </Column>
  );
}

function ListOf({ rows }: { rows: AccountRow[] }) {
  return (
    <Column>
      <ListGroup as="ul" className="divide-y divide-border">
        {rows.map((r) => (
          <li key={r.id}>
            <AccountListRow row={r} sameLogin={sameLoginLine(rows, r)} onOpen={() => {}} />
          </li>
        ))}
      </ListGroup>
    </Column>
  );
}

export function AccountsSection() {
  return (
    <Section def={DEF}>
      <Group title="The page's first words">
        <Card state="accounts-intro-closed" label="1 Intro, closed">
          <Column>
            <IntroLines />
          </Column>
        </Card>
        <Card state="accounts-intro-open" label="2 Intro, open">
          <Column>
            <IntroLines startOpen />
          </Column>
        </Card>
      </Group>
      <Group title="The list">
        <Card state="accounts-list-identity" label="3 Email under each name">
          <ListOf rows={[DEFAULT_ROW, WORK_ROW, NEW_ROW]} />
        </Card>
        <Card state="accounts-list-sessions" label="4 Session count">
          <ListOf rows={[{ ...DEFAULT_ROW, running: 1 }, { ...WORK_ROW, live: true, running: 3 }, { ...NEW_ROW, live: true, running: 0 }]} />
        </Card>
        <Card state="accounts-list-same-login" label="5 Same login twice">
          <ListOf rows={SHARED_LOGIN_ROWS} />
        </Card>
        <Card state="accounts-list-no-status" label="6 An agent that cannot tell">
          <ListOf rows={[CODEX_ROW]} />
        </Card>
      </Group>
      <Group title="The profile's page">
        <Card state="accounts-detail-signed-in" label="7 Signed in, with the plan">
          <Column>
            <SignedInRow identity={WORK_ROW.identity} />
          </Column>
        </Card>
        <Card state="accounts-detail-same-login" label="8 Same login as another profile">
          <Column>
            <SignedInRow identity={SHARED_LOGIN_ROWS[1]!.identity} sameLogin={sameLoginLine(SHARED_LOGIN_ROWS, SHARED_LOGIN_ROWS[1]!)} />
          </Column>
        </Card>
        <Card state="accounts-detail-signed-out" label="9 Not signed in">
          <Column>
            <SignedInRow identity={NEW_ROW.identity} />
          </Column>
        </Card>
      </Group>
      <Group title="Change login">
        <Card state="accounts-change-login-before" label="10 Before, two sessions listed">
          <Screen foot>
            <ChangeLoginBeforeView row={RUNNING_ROW} harness={CLAUDE} agentLabel="Claude Code" others sessions={SESSIONS} />
          </Screen>
        </Card>
        <Card state="accounts-change-login-before-idle" label="11 Before, no session runs">
          <Screen foot>
            <ChangeLoginBeforeView row={WORK_ROW} harness={CLAUDE} agentLabel="Claude Code" others />
          </Screen>
        </Card>
        <Card state="accounts-change-login-new-only" label="12 Before, new sessions only">
          <Screen foot>
            <ChangeLoginBeforeView row={CODEX_SIGNED_IN} harness={CODEX} agentLabel="Codex" />
          </Screen>
        </Card>
        <Card state="accounts-change-login-running" label="13 Back while it runs">
          <Screen>
            <ChangeLoginRunningView row={RUNNING_ROW} body={CLAUDE} ending={false} onOpen={() => {}} onFinish={() => {}} />
          </Screen>
        </Card>
        <Card state="accounts-change-login-changed" label="14 Signed in as new">
          <Screen>
            <ChangeLoginResultView result={{ kind: "changed", email: "spare@example.com", plan: "max" }} reach={{ kind: "running", count: 3 }} stillOpen={false} backTo="session" onBack={() => {}} />
          </Screen>
        </Card>
        <Card state="accounts-change-login-same" label="15 Still the same login">
          <Screen>
            <ChangeLoginResultView result={{ kind: "same", email: "someone@example.com", plan: "max" }} reach={{ kind: "running", count: 3 }} stillOpen={false} backTo="account" onBack={() => {}} />
          </Screen>
        </Card>
        <Card state="accounts-change-login-not-finished" label="16 Sign-in did not finish">
          <Screen>
            <ChangeLoginResultView result={{ kind: "signedOut" }} reach={{ kind: "running", count: 0 }} stillOpen={false} backTo="account" onBack={() => {}} />
          </Screen>
        </Card>
        <Card state="accounts-change-login-session-row" label="17 Row in the session sheet">
          <Column>
            <PaneSettingsView
              state={{ on: false, global: false, watchable: true, warnSeconds: 300 }}
              busy={false}
              pushOff={false}
              onToggle={() => {}}
              onRename={() => {}}
              changeLogin={{ account: DEFAULT_ROW, onOpen: () => {} }}
            />
          </Column>
        </Card>
        <Card state="accounts-sign-in-card-open" label="18 Sign-in card, open button">
          <Column>
            <BoxTextBlock boxText={SIGN_IN_CARD(CLAUDE_ADDRESS)} signInHosts={CLAUDE.signInHosts} />
          </Column>
        </Card>
        <Card state="accounts-sign-in-card-copy" label="19 Sign-in card, copy only">
          <Column>
            <BoxTextBlock boxText={SIGN_IN_CARD("https://example.com/oauth/authorize?state=XXXXXXXX")} signInHosts={CLAUDE.signInHosts} />
          </Column>
        </Card>
      </Group>
    </Section>
  );
}
