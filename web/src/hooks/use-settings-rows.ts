import { useEffect, useState } from "react";

import type { IconKey } from "@/components/icons/keys";
import { addedCount, useAccounts } from "@/lib/accounts";
import { t } from "@/lib/i18n";
import { settingsSectionPath } from "@/lib/nav";
import { useRememberedAnswer } from "@/lib/remembered-shape";
import { useScope } from "@/lib/session";
import { PAGES } from "@/lib/settings/pages";
import type { PageDef } from "@/lib/settings/types";

// THE ROWS OF SETTINGS, read once for both of its drawings: the index on a phone (routes/settings.tsx) and the section
// list on a large screen (components/settings-shell.tsx). The order and the reasons for it are written here, where the
// list is; the two drawings own only how a row looks.

// The rows are the registry's pages (lib/settings/pages.ts, ADR 0170), in its order, after Updates and about, which
// both drawings put first because its line changes without you (a release lands). Every page is always offered, with
// one exception: Profiles, only while the machine answers the accounts route. Tricks and the Hill is always there now
// (2026-11-21): the Tricks switch is on that page, so a row that went away with the switch took the switch with it.
// Machines is no row of its own any more: it is a row of Devices and machines, whose line names it.

/** The pages the list draws after Updates and about, in order. Profiles is among them only while it is offered. */
export const INDEX_PAGES: readonly PageDef[] = PAGES.filter((page) => page.id !== "updates");

/** The pages that are always on the list: the quiet stand-in counts these. */
export const STEADY_PAGES: readonly PageDef[] = INDEX_PAGES.filter((page) => page.id !== "accounts");

/** Profiles' live line: how many were added, or what the page is for. */
export function accountsLine(added: number): string {
  return added > 0 ? t("accounts.row.added", { n: added }) : t("accounts.row.none");
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
}

/** The rows of Settings after Updates, and whether the list should hold its place for a moment. */
export function useSettingsRows(): SettingsRows {
  const scope = useScope();
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
    rows: INDEX_PAGES.filter((page) => page.id !== "accounts" || withAccounts === true).map((page) => ({
      id: page.id,
      to: settingsSectionPath(page.id, scope),
      icon: page.icon,
      title: t(page.title),
      caption: page.blurb === null ? accountsLine(accountsCount) : t(page.blurb),
    })),
  };
}
