import type { MessageKey } from "@/lib/i18n";

import type { PageDef, PageId, PlaceId } from "./types";

// THE ELEVEN SETTINGS PAGES, in the order of the index (ADR 0170). They come from the readers' own groups in the
// card sort of 2026-11-21: all four open readers made Look and feel, Notifications, Keys, Chat and terminal, Voice,
// a projects page and an app-and-help page. The order is the order of how standing a choice is, as the old index's
// was: what the app looks like first, what goes wrong last. Updates and about is drawn FIRST on the index all the
// same, because its line changes without you (a release lands); the index puts it there, not this list.
//
// A group is a heading on its page and the second line of a search result. The groups are in page order.

export const PAGES: readonly PageDef[] = [
  {
    id: "look",
    title: "settings.page.look.title",
    blurb: "settings.page.look.blurb",
    icon: "theme",
    groups: [
      { id: "theme", heading: "settings.group.look.theme" },
      { id: "character", heading: "settings.character.title" },
      { id: "text", heading: "settings.group.look.text" },
      { id: "math", heading: "settings.math.title" },
      { id: "layout", heading: "settings.group.look.layout" },
    ],
  },
  {
    id: "chat",
    title: "settings.page.chat.title",
    blurb: "settings.page.chat.blurb",
    icon: "view-chat",
    groups: [
      { id: "both", heading: "settings.group.chat.both" },
      { id: "chat", heading: "settings.group.chat.chat" },
      { id: "terminal", heading: "settings.group.chat.terminal" },
      { id: "status", heading: "settings.group.chat.status" },
    ],
  },
  {
    id: "keys",
    title: "settings.page.keys.title",
    blurb: "settings.page.keys.blurb",
    icon: "keys-drawer",
    groups: [
      { id: "typing", heading: "settings.group.keys.typing" },
      { id: "pad", heading: "settings.group.keys.pad" },
      { id: "touch", heading: "settings.group.keys.touch" },
      { id: "zen", heading: "settings.zen.title" },
    ],
  },
  {
    id: "notifications",
    title: "settings.page.notifications.title",
    blurb: "settings.page.notifications.blurb",
    icon: "notifications",
    groups: [
      { id: "device", heading: "settings.group.notifications.device" },
      { id: "when", heading: "settings.group.notifications.when" },
      { id: "cache", heading: "settings.group.notifications.cache" },
      { id: "load", heading: "settings.group.notifications.load" },
      { id: "quiet", heading: "settings.group.notifications.quiet" },
    ],
  },
  {
    id: "voice",
    title: "settings.section.voice.title",
    blurb: "settings.section.voice.blurb",
    icon: "mic",
    groups: [
      { id: "mic", heading: "settings.voice.status.label" },
      { id: "phone", heading: "settings.voice.phoneSpeech.label" },
      { id: "after", heading: "settings.voice.after.label" },
      { id: "host", heading: "settings.voice.host.label" },
      { id: "model", heading: "settings.voice.model.title" },
      { id: "hostPage", heading: "settings.voice.hostPage.title" },
    ],
  },
  {
    id: "dashboard",
    title: "settings.page.dashboard.title",
    blurb: "settings.page.dashboard.blurb",
    icon: "tab-dashboard",
    groups: [
      { id: "dashboard", heading: "settings.group.dashboard.dashboard" },
      { id: "projects", heading: "settings.group.dashboard.projects" },
      { id: "changes", heading: "settings.changes.title" },
    ],
  },
  {
    id: "accounts",
    title: "accounts.title",
    blurb: null,
    icon: "mod-icon-user",
    groups: [
      { id: "profiles", heading: "accounts.title" },
      { id: "found", heading: "settings.group.accounts.found" },
      { id: "add", heading: "settings.group.accounts.add" },
      { id: "profile", heading: "settings.group.accounts.profile" },
      { id: "login", heading: "accounts.changeLogin.action" },
    ],
  },
  {
    id: "tricks",
    title: "settings.page.tricks.title",
    blurb: "settings.page.tricks.blurb",
    icon: "mods",
    groups: [
      { id: "tricks", heading: "settings.section.tricks.title" },
      { id: "hill", heading: "settings.hill.label" },
      { id: "trick", heading: "settings.group.tricks.trick" },
    ],
  },
  {
    id: "devices",
    title: "settings.page.devices.title",
    blurb: "settings.page.devices.blurb",
    icon: "machine",
    groups: [
      { id: "device", heading: "settings.group.devices.device" },
      { id: "paired", heading: "settings.devices.title" },
      { id: "machines", heading: "machines.entry.title" },
      { id: "connection", heading: "settings.connection.title" },
    ],
  },
  {
    id: "privacy",
    title: "settings.page.privacy.title",
    blurb: "settings.page.privacy.blurb",
    icon: "masked",
    groups: [
      { id: "phone", heading: "settings.group.privacy.phone" },
      { id: "leaves", heading: "settings.group.privacy.leaves" },
      { id: "installCount", heading: "telemetry.card.title" },
    ],
  },
  {
    id: "updates",
    title: "settings.page.updates.title",
    blurb: null,
    icon: "update-available",
    groups: [
      { id: "updates", heading: "updates.entry.title" },
      { id: "line", heading: "updates.line.title" },
      { id: "app", heading: "settings.group.updates.app" },
      { id: "help", heading: "settings.group.updates.help" },
    ],
  },
];

/** The page with this id. Throws on an id no page has: a registry row naming a page nobody built is a defect. */
export function pageDef(id: PageId): PageDef {
  const page = PAGES.find((p) => p.id === id);
  if (page === undefined) throw new Error(`no Settings page "${id}"`);
  return page;
}

/**
 * Old Settings addresses and where they went. A redirect, never a page: the router answers each with a `replace`
 * to the page that holds most of what the old page held, the query string and a fragment carried along.
 */
export const OLD_PAGES = {
  appearance: "look",
  harnesses: "chat",
  device: "keys",
  alerts: "notifications",
  system: "devices",
  experiments: "tricks",
} as const satisfies Record<string, PageId>;

/** Pages below an old page and where they went. */
export const OLD_BELOW = {
  "appearance/character": "look/character",
  "system/install-count": "privacy/install-count",
} as const satisfies Record<string, string>;

/** Fragments the app linked to before the registry, and the page that holds their row now. */
export const OLD_FRAGMENTS = {
  changes: "dashboard",
  "paired-devices": "devices",
  "install-count": "privacy",
} as const satisfies Record<string, PageId>;

/** The row each old fragment pointed at, so the page it opens scrolls to that row and marks it as a search result does. */
export const OLD_FRAGMENT_ROWS = {
  changes: "dashboard.changes.nested",
  "paired-devices": "devices.paired",
  "install-count": "privacy.telemetry",
} as const satisfies Record<keyof typeof OLD_FRAGMENTS, string>;

/**
 * Ids that a shipped Collie used and the id that holds the value now (ADR 0170, "an id survives a move"). A row
 * that is renamed or retired leaves its old id here, so an old address, a search result in an old tab and, later, a
 * settings file still find it. A key here is never declared again; `shipped-ids.test.ts` checks both. Empty today.
 */
export const ALIASES = {} as const satisfies Record<string, string>;

/** The id a fragment or an old id names today: through the old fragments, then through `ALIASES`. */
export function currentRowId(id: string): string {
  const old = new Map<string, string>(Object.entries(OLD_FRAGMENT_ROWS)).get(id) ?? id;
  return new Map<string, string>(Object.entries(ALIASES)).get(old) ?? old;
}

/**
 * The places a row lives in when it has no Settings row: one pane's own sheets and menu, a view, the New page. Per
 * group, the words that say where, which the search shows in place of a page and a link.
 */
export const PLACES = {
  pane: {
    settings: "settings.where.paneSettings",
    display: "settings.where.paneDisplay",
    menu: "settings.where.paneMenu",
    messages: "settings.where.paneMessages",
  },
  files: { view: "settings.where.files", diff: "settings.where.filesDiff" },
  new: { page: "settings.where.newPage" },
  "dashboard-bar": { bar: "settings.where.dashboardBar", machines: "settings.where.machinesSheet" },
} as const satisfies Record<PlaceId, Readonly<Record<string, MessageKey>>>;

/**
 * The row id a page's fragment names, without reading the registry: an old fragment's row, or a fragment of a row id's
 * shape (`look.math`). The page looks for that id's slot; a fragment of another shape (`#theme=…`) names no row.
 */
export function fragmentRowId(hash: string): string | undefined {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  let id: string;
  try {
    id = decodeURIComponent(raw);
  } catch {
    return undefined;
  }
  const current = currentRowId(id);
  if (current !== id) return current;
  return /^[a-z][A-Za-z-]*(\.[A-Za-z][A-Za-z0-9-]*)+$/.test(id) ? id : undefined;
}
