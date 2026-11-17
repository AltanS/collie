import { useEffect, useState } from "react";

import { Icon } from "@/components/icons/icon";
import type { IconKey } from "@/components/icons/keys";

import { RouteHeader } from "@/components/app-header";
import { Button } from "@/components/ui/button";
import { BuildStamp } from "@/components/build-stamp";
import { Card } from "@/components/ui/card";
import { SettingsNavRow } from "@/components/settings-nav-row";
import { InstallControl } from "@/components/install-control";
import { useUpdatesStatus } from "@/components/updates-settings-card";
import { addedCount, useAccounts } from "@/lib/accounts";
import { hasExperiments } from "@/lib/experiments";
import { useRememberedAnswer } from "@/lib/remembered-shape";
import { useOptionalRootData } from "@/lib/route-data";
import { useLocale } from "@/hooks/use-locale";
import { useNav } from "@/hooks/use-nav";
import { t, type MessageKey } from "@/lib/i18n";
import { homePath, machinesPath, settingsSectionPath, updatesPath } from "@/lib/nav";
import type { Scope } from "@/lib/scope";
import { useScope } from "@/lib/session";
import { BandMain } from "@/components/ui/strip-host";

// ── THE SETTINGS INDEX ──────────────────────────────────────────────────────────────────────────
//
// Updates first, then five rows, each opening a section (routes/settings-sections.tsx, which explains the split), then
// Machines (a page, not a section) and, while Experiments holds anything, Experiments.
//
// This page used to BE the settings: seventeen cards in one column, over a thousand pixels of
// scroll on a phone, with no headings to skim by — the file argued for that, on the grounds that
// the first heading would imply four more. It implied four more. The cost was that finding one
// switch meant reading every card on the way to it, and the page grew every time anything shipped.
//
// The index does not remove a setting or move one between devices. It changes how many you are
// asked to read at once, and that is the whole of it.
//
// ── WHAT STAYS ON THIS PAGE, AND WHY ─────────────────────────────────────────
// `InstallControl` is not a setting: it is a one-shot offer the browser makes and then stops
// making, and it renders NOTHING unless that offer is actually on the table (lib/install.ts). On a
// phone that can install, it must not be filed under a heading nobody opens.
//
// `BuildStamp` stays because it is the answer to "what am I running", which is the question you ask
// before you go looking for anything else. It costs one line and it is also on the System page,
// where it sits with the rest of the diagnostics.

interface Row {
  /** The row's own key, and for a section the word in its path. */
  id: string;
  /** Where the row opens. A section is `/settings/<section>`; Machines is a page of its own. */
  to: (scope: Scope | undefined) => string;
  icon: IconKey;
  title: MessageKey;
  blurb: MessageKey;
}

// The order is the order of how standing a choice is. Appearance is changed most and changed first;
// System is the page you open when something is wrong, which is rarely and deliberately. Voice sits
// between Device and Alerts and, unlike Experiments, is never hidden: a host that offers no speech
// gets a page that says so, because a row that comes and goes teaches nobody where dictation lives.
//
// Experiments trails all four, and it is the only row that can be absent: it renders while
// `lib/experiments.ts` holds something, because a row that opens an empty page is noise. It is last
// rather than beside Appearance because its members are not a subject, they are a CONTRACT — read
// `routes/settings-sections.tsx` for the whole argument, including why Chat's switch is not a card
// on Appearance.
//
// Machines sits between System and Experiments and is the one row that is not a section: it opens
// `/machines`, a page with a list and a detail of its own, and it is always offered, solo included
// (a solo collie is one machine with a load worth watching).
const ROWS: Row[] = [
  {
    id: "appearance",
    to: (scope) => settingsSectionPath("appearance", scope),
    icon: "theme",
    title: "settings.section.appearance.title",
    blurb: "settings.section.appearance.blurb",
  },
  {
    id: "harnesses",
    to: (scope) => settingsSectionPath("harnesses", scope),
    icon: "harnesses",
    title: "settings.section.harnesses.title",
    blurb: "settings.section.harnesses.blurb",
  },
  {
    id: "device",
    to: (scope) => settingsSectionPath("device", scope),
    icon: "section-device",
    title: "settings.section.device.title",
    blurb: "settings.section.device.blurb",
  },
  {
    id: "voice",
    to: (scope) => settingsSectionPath("voice", scope),
    icon: "mic",
    title: "settings.section.voice.title",
    blurb: "settings.section.voice.blurb",
  },
  {
    id: "alerts",
    to: (scope) => settingsSectionPath("alerts", scope),
    icon: "notifications",
    title: "settings.section.alerts.title",
    blurb: "settings.section.alerts.blurb",
  },
  {
    id: "system",
    to: (scope) => settingsSectionPath("system", scope),
    icon: "machine",
    title: "settings.section.system.title",
    blurb: "settings.section.system.blurb",
  },
  {
    id: "machines",
    to: (scope) => machinesPath(scope),
    icon: "machine-activity",
    title: "settings.section.machines.title",
    blurb: "settings.section.machines.blurb",
  },
  ...(hasExperiments()
    ? [
        {
          id: "experiments",
          to: (scope) => settingsSectionPath("experiments", scope),
          icon: "experiments",
          title: "settings.section.experiments.title",
          blurb: "settings.section.experiments.blurb",
        } satisfies Row,
      ]
    : []),
];

// Tricks sits after Machines and before Experiments, and only while the switch for tricks as a whole is on
// (2026-11-18): that switch is a card in Settings, Experiments, and the row is the way into the list it
// switched on. Off, the row is gone. The value is the snapshot's `tricksOff`, there from the first frame.
const TRICKS_ROW: Row = {
  id: "tricks",
  to: (scope) => settingsSectionPath("tricks", scope),
  icon: "mods",
  title: "settings.section.tricks.title",
  blurb: "settings.section.tricks.blurb",
};

// Accounts (M101) sits right after Agents: it is about the logins of those agents. Like Tricks, it is
// offered only when it has something to say: GET /api/accounts answers 200. Its caption is live (how many
// accounts were added), so the row carries no fixed blurb key and the list below words it.
const ACCOUNTS_ROW: Row = {
  id: "accounts",
  to: (scope) => settingsSectionPath("accounts", scope),
  icon: "mod-icon-user",
  title: "accounts.title",
  blurb: "accounts.row.none",
};

function rows(withAccounts: boolean, withTricks: boolean): Row[] {
  const base = withAccounts ? withRow(ROWS, ACCOUNTS_ROW, "harnesses") : ROWS;
  if (!withTricks) return base;
  const at = base.findIndex((row) => row.id === "experiments");
  return at === -1 ? [...base, TRICKS_ROW] : [...base.slice(0, at), TRICKS_ROW, ...base.slice(at)];
}

/** `list` with `row` right after the row named `after`, or last when there is none. */
function withRow(list: Row[], row: Row, after: string): Row[] {
  const at = list.findIndex((r) => r.id === after);
  return at === -1 ? [...list, row] : [...list.slice(0, at + 1), row, ...list.slice(at + 1)];
}

/**
 * How long a first visit on a device waits for the Accounts read before it draws the
 * list with whatever it has. Short enough that nobody notices a wait, long enough for a bridge on the
 * same tailnet to answer.
 */
export const LIST_HOLD_MS = 400;

/**
 * The quiet stand-in for the list card, on a first visit with no remembered answer, until the two
 * read has landed or {@link LIST_HOLD_MS} has passed. It is the card's own box with the rows that
 * are always there, empty and of their exact height (the Updates row, `ROWS` and Tricks while it is on: 16px padding twice
 * around the 24px title line and the 20px caption line, so `box-content h-11 p-4`), inside the same
 * list group, so a theme's row edges and gaps come out as they will. No spinner and no words: a state
 * with nothing to say keeps its slot (DESIGN.md §2). The row that may be added (Accounts)
 * are not counted, so the card grows by it if it arrives late, which is the rare, accepted case.
 */
function ListHold({ withTricks }: { withTricks: boolean }) {
  return (
    <Card className="gap-0 py-0" data-slot="settings-list-hold" aria-hidden="true">
      <div data-slot="list-group">
        {[...ROWS.map((row) => row.id), ...(withTricks ? [TRICKS_ROW.id] : []), "updates"].map((id) => (
          <div key={id} className="box-content h-11 p-4" />
        ))}
      </div>
    </Card>
  );
}

export function SettingsRoute() {
  const nav = useNav();
  const scope = useScope();
  const updates = useUpdatesStatus();
  // The Tricks row only while the switch for tricks as a whole is on: the snapshot's `tricksOff`, so the first frame is right.
  const withTricks = useOptionalRootData()?.tricksOff !== true;
  // Accounts (M101): a row only while the machine answers the accounts route, so an older bridge, Windows and an install with no account-capable agent are unchanged.
  const accounts = useAccounts();
  const accountsCount = addedCount(accounts.body);
  // CALM LOAD. The Accounts row depends on a read that ends after the first paint, and sits in the middle of
  // the list, so a row that arrived late pushed every row after it down. The first frame is drawn from what
  // this device last saw (lib/remembered-shape.ts); the fresh answer replaces it when it lands. A failed
  // accounts read says nothing about whether the feature exists, so it keeps the remembered answer.
  const accountsFresh = accounts.status === "loading" || accounts.status === "failed" ? undefined : accounts.status === "ready";
  const withAccounts = useRememberedAnswer("settings-accounts-row", accountsFresh);
  // With no answer at all for a row (a first visit here), the list card waits for it, bounded.
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setWaited(true), LIST_HOLD_MS);
    return () => clearTimeout(timer);
  }, []);
  const holdList = !waited && withAccounts === undefined;
  useLocale();

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-screen-sm flex-1 flex-col">
      {/* One header treatment app-wide, and it is a FACT rather than a claim: this route does not
          mount a header at all, it fills the one that is already there (RootLayout's
          <AppHeaderHost/>). The back button is `size-11` sitting at the row's `pl-4`, so its icon
          centre lands on the same 38px as the Collie mark it stands in for. */}
      <RouteHeader
        width="column"
        override={
          <>
            <Button
              variant="ghost"
              size="icon"
              // 44px — the tap floor every control in this row shares. size="icon" alone is 36px.
              className="size-11"
              onClick={() => nav.up(homePath(scope))}
              aria-label={t("settings.nav.back")}
            >
              <Icon name="back" className="size-5" />
            </Button>
            <h1 className="min-w-0 truncate text-lg font-semibold tracking-tight">{t("settings.title")}</h1>
          </>
        }
      />

      <BandMain base={16} className="relative flex min-h-0 flex-1 flex-col space-y-4 overflow-y-auto p-4">
        <InstallControl />

        {/* ONE card holding the rows, not one card per row. They are a single list of siblings, and
            separated cards would say they are unrelated subjects. The rows are a list group (M57 spec
            17): index.css draws the line between two rows, so the last has none, and a theme's
            `rows: cards` makes them cards inside this one card, like every other list. */}
        {holdList ? (
          <ListHold withTricks={withTricks} />
        ) : (
          <Card className="gap-0 py-0">
            <div data-slot="list-group">
              {/* FIRST, because it is the one row whose answer changes without you touching anything: a
                  release lands, a peer falls behind. The caption is the live status (the same words the
                  Updates page opens with); a release waiting leads it with a 6px dot in the primary
                  colour. The row is not in `ROWS`, whose captions are fixed strings. */}
              <SettingsNavRow
                icon="update-available"
                title={t("updates.entry.title")}
                caption={
                  <>
                    {updates.available && (
                      <span
                        aria-hidden="true"
                        data-slot="update-dot"
                        className="mr-1.5 inline-block size-1.5 rounded-full bg-primary align-middle"
                      />
                    )}
                    {updates.line}
                  </>
                }
                onOpen={() => nav.down(updatesPath(scope))}
              />
              {rows(withAccounts === true, withTricks).map((row) => (
                <SettingsNavRow
                  key={row.id}
                  icon={row.icon}
                  title={t(row.title)}
                  caption={row.id === "accounts" && accountsCount > 0 ? t("accounts.row.added", { n: accountsCount }) : t(row.blurb)}
                  onOpen={() => nav.down(row.to(scope))}
                />
              ))}
            </div>
          </Card>
        )}

        {/* Pinned to the bottom with `mt-auto`, exactly where it was before the split. */}
        <div className="mt-auto flex flex-col gap-2 pt-4">
          <BuildStamp />
        </div>
      </BandMain>
    </div>
  );
}
