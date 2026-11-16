// Accounts section of the design reference (M101 specs 04 and 05): the compact list row in its states,
// and who is signed in on an account, as the row's second line and as the details row. Every card mounts the REAL pieces the Settings pages draw
// (`AccountListRow`, `SignedInRow` in routes/settings-accounts.tsx) over fixtures, so the reference shows
// what ships. Made-up addresses only.
//
// DEV-ONLY, unreachable from the app entry: see ../app.tsx and web/design.html.

import type { ReactNode } from "react";

import { ListGroup } from "@/components/ui/list-group";
import type { AccountRow } from "@/lib/accounts";
import { AccountListRow, SignedInRow } from "@/routes/settings-accounts";

import { Card, Group, Section, type SectionDef } from "../layout";

export const DEF: SectionDef = {
  id: "accounts",
  title: "Accounts",
  intent:
    "The list row is compact: the name with the last seen or \"In use now\" at the end of its line, the email under it, its middle given up when it does not fit, and the usage windows side by side, two to a line, each with its label, a thin bar and the percent. The folder and the reset times sit on the account's page, with one row for the full address and the plan. An account that is not signed in says so; an agent that cannot tell shows no second line.",
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
const THREE_ROW = row({
  id: "acc-team",
  label: "Team account for the long weekend",
  kind: "own",
  folder: "~/.claude-team",
  startLine: "CLAUDE_CONFIG_DIR=~/.claude-team claude",
  windows: [
    { window: "5h", usedPct: 96, resetsAt: NOW + 20 * 60_000 },
    { window: "7d", usedPct: 61, resetsAt: NOW + 3 * 86_400_000 },
    { window: "7d:opus", label: "Opus", usedPct: null, resetsAt: null },
  ],
  seenAt: NOW - 3 * 3_600_000,
  identity: { signedIn: true, email: "person@example.com", plan: "team" },
});
const CODEX_ROW = row({ id: "codex:default", harness: "codex", folder: "~/.codex", startLine: "codex", windows: [], seenAt: null });

/** A phone-wide column on the page ground. */
function Column({ children }: { children: ReactNode }) {
  return (
    <div className="w-[360px] max-w-full rounded-sm bg-background ring-1 ring-rule">
      <div className="flex flex-col gap-4 p-4">{children}</div>
    </div>
  );
}

function ListOf({ rows }: { rows: AccountRow[] }) {
  return (
    <Column>
      <ListGroup as="ul" className="divide-y divide-border">
        {rows.map((r) => (
          <li key={r.id}>
            <AccountListRow row={r} onOpen={() => {}} />
          </li>
        ))}
      </ListGroup>
    </Column>
  );
}

export function AccountsSection() {
  return (
    <Section def={DEF}>
      <Group title="The list">
        <Card state="accounts-list-identity" label="1 Email under each name">
          <ListOf rows={[DEFAULT_ROW, WORK_ROW, NEW_ROW]} />
        </Card>
        <Card state="accounts-list-three-windows" label="2 Three windows, one over">
          <ListOf rows={[THREE_ROW]} />
        </Card>
        <Card state="accounts-list-no-status" label="3 An agent that cannot tell">
          <ListOf rows={[CODEX_ROW]} />
        </Card>
      </Group>
      <Group title="The account's page">
        <Card state="accounts-detail-signed-in" label="4 Signed in, with the plan">
          <Column>
            <SignedInRow identity={WORK_ROW.identity} />
          </Column>
        </Card>
        <Card state="accounts-detail-signed-out" label="5 Not signed in">
          <Column>
            <SignedInRow identity={NEW_ROW.identity} />
          </Column>
        </Card>
      </Group>
    </Section>
  );
}
