import type { IconKey } from "@/components/icons/keys";
import type { MessageKey } from "@/lib/i18n";

// THE SHAPE OF ONE DECLARED LIST OF SETTINGS (ADR 0170). Every setting a person can see or set is declared once,
// in `registry.ts`: a stable dotted id, its words, its kind, who holds its value, where it is drawn and how its
// value is stored today. The Settings pages, the search, the completeness test and, later, a settings file all
// read this one list. Nothing here moves a value: a store is a declaration of the storage the value has always
// had, not an adapter. No code reads or writes a value through it.

/** The eleven Settings pages, by the word in their path (`/settings/<id>`). */
export const PAGE_IDS = [
  "look",
  "chat",
  "keys",
  "notifications",
  "voice",
  "dashboard",
  "accounts",
  "tricks",
  "devices",
  "privacy",
  "updates",
] as const;

export type PageId = (typeof PAGE_IDS)[number];

/** Rows that live only where they are used: in a pane, in a view, on the New page. The search says where. */
export type PlaceId = "pane" | "files" | "new" | "dashboard-bar";

/**
 * A stable dotted id: `<namespace>.<name>[.<part>]`, lower camel after the first segment. The first segment is a
 * NAMESPACE, not the page: today it reads like the page the row was declared on, and it stays when the row moves
 * (the row's `page` says where it is drawn). Once shipped an id is never reused for another value; a row that is
 * retired or renamed keeps its old id as a key of `ALIASES` (pages.ts), and `shipped-ids.json` is the checked list.
 * A row drawn once per item (a harness, a machine, a trick) keeps ONE id; the item is the value's key, not the id's.
 */
export type SettingId = `${string}.${string}`;

/** Who holds the value. `machine` is the bridge, for every device on it; `profile` is one profile on one machine. */
export type SettingScope = "device" | "machine" | "pane" | "profile";

export type SettingKind = "switch" | "choice" | "number" | "text" | "action" | "link" | "info" | "list";

/** A place outside Settings that draws the same value, under the same id. */
export type Surface =
  | "pane-display"
  | "pane-menu"
  | "pane-settings"
  | "pane-messages"
  | "keys-tray"
  | "dashboard"
  | "files"
  | "new"
  | "machine-page"
  | "settings-index";

/**
 * A state a row shows only in. The page keeps the row's own test (the component decides); the registry names the
 * condition so the search can say in one line why a row is not on this screen.
 */
export type Condition =
  | "can-vibrate"
  | "keyboard-seen"
  | "install-offered"
  | "accounts-offered"
  | "crew"
  | "push-server"
  | "tricks-on"
  | "zen-on"
  | "update-waiting"
  | "release-line-skew"
  | "has-profile"
  | "math-ready"
  | "hands-free-offered"
  | "official-newer";

/** Rows drawn once per item of a list that comes from data. No closed list of names lives in the registry. */
export type PerItem = "harness" | "trick" | "machine" | "profile" | "pane" | "device" | "theme";

/** A localStorage key, as the app writes it today. */
export type StorageKey = `collie:${string}` | `collie.${string}`;

/**
 * How a value is stored today: a declaration, not an adapter. The completeness test reads every saved key of the
 * app and fails one that no setting names and no entry of `NOT_SETTINGS` explains, and each field of a typed blob
 * (`BLOB_FIELDS` in registry.ts) that no setting names and `NOT_SETTING_FIELDS` does not explain.
 */
export type Store =
  /** A whole localStorage key holds this one value. */
  | { kind: "local"; key: StorageKey }
  /** One field of a JSON blob, read and written through the blob's own hook so its listeners still fire. */
  | { kind: "blob"; key: StorageKey; field: string }
  /** One key per pane, keyed through the pane's scope key (`lib/scope.ts`), never a bare pane id. */
  | { kind: "per-key"; prefix: StorageKey; keyOf: "pane-scope" }
  /** The machine, through the route the value has today. A write carries its request id as it always has. */
  | { kind: "route"; route: `/api/${string}`; per?: PerItem }
  /** What the browser itself holds: the push subscription, the install prompt, IndexedDB. */
  | { kind: "browser"; what: "push-subscription" | "install-prompt" | "indexeddb-model" | "chat-store" | "clipboard" }
  /** An action, a link or an info line: no value of its own. */
  | { kind: "none" };

export interface SettingDef {
  id: SettingId;
  /** The row's name. A plain key, so a word change is one line in `en.ts`. */
  label: MessageKey;
  hint?: MessageKey;
  kind: SettingKind;
  scope: SettingScope;
  /** The Settings page that holds it, or the place it lives in when it has no Settings row. */
  page: PageId | PlaceId;
  /** A page below the page: `character`, `host`, `model`, `install-count`, `add`, `:id`, `:id/login`, `:key`, `load/:machine`. */
  below?: string;
  /** The group on its page (see `pages.ts`). */
  group: string;
  /** Words a person may search for beyond the label and the hint: keys, so they are translated. */
  words?: readonly MessageKey[];
  when?: Condition;
  /** An experiment: its row says so, in its hint and with the Experimental badge. */
  experiment?: true;
  also?: readonly Surface[];
  each?: PerItem;
  /** Where its value is stored today: a declaration, not an adapter. */
  store: Store;
  /**
   * Left out of the search: a state of another row (Retry, Go back now), a part of a form, a line that only
   * reports. Still declared, so a page that draws it is complete.
   */
  find?: false;
}

export interface GroupDef {
  id: string;
  /** The heading a person reads; also the search result's second line. */
  heading: MessageKey;
}

export interface PageDef {
  id: PageId;
  title: MessageKey;
  /** The index's second line. Null: the page draws a live line of its own (Updates, Profiles). */
  blurb: MessageKey | null;
  icon: IconKey;
  groups: readonly GroupDef[];
}
