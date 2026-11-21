import { useEffect, useState } from "react";

import type { IconKey } from "@/components/icons/keys";
import { addedCount, useAccounts } from "@/lib/accounts";
import { hasExperiments } from "@/lib/experiments";
import { t, type MessageKey } from "@/lib/i18n";
import { machinesPath, settingsSectionPath } from "@/lib/nav";
import { useRememberedAnswer } from "@/lib/remembered-shape";
import { useOptionalRootData } from "@/lib/route-data";
import type { Scope } from "@/lib/scope";
import { useScope } from "@/lib/session";

// THE ROWS OF SETTINGS, read once for both of its drawings: the index on a phone (routes/settings.tsx) and the section
// list on a large screen (components/settings-shell.tsx). The order and the reasons for it are written here, where the
// list is; the two drawings own only how a row looks.

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
export const ROWS: Row[] = [
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
export const TRICKS_ROW: Row = {
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

/** One row as both drawings take it: words already in the reader's language, the address already scoped. */
export interface SettingsRow {
  id: string;
  to: string;
  icon: IconKey;
  title: string;
  caption: string;
}

export interface SettingsRows {
  /** The rows after Updates, in order. */
  rows: SettingsRow[];
  /** A first visit with no answer yet about a row that may be added: the list waits, bounded by {@link LIST_HOLD_MS}. */
  hold: boolean;
  /** The Tricks row is offered (the switch for tricks as a whole is on). */
  withTricks: boolean;
}

/** The rows of Settings after Updates, and whether the list should hold its place for a moment. */
export function useSettingsRows(): SettingsRows {
  const scope = useScope();
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
  return {
    hold: !waited && withAccounts === undefined,
    withTricks,
    rows: rows(withAccounts === true, withTricks).map((row) => ({
      id: row.id,
      to: row.to(scope),
      icon: row.icon,
      title: t(row.title),
      caption: row.id === "accounts" && accountsCount > 0 ? t("accounts.row.added", { n: accountsCount }) : t(row.blurb),
    })),
  };
}
