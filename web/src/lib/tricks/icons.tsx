// THE TRICK ICONS AS COMPONENTS (M94). One component per word of the schema's closed set: the Tree UI's
// 39 icon words and the tricks' additions (the session action words among them).
//
// The app draws every glyph through `<Icon name=...>` (components/icons/icon.tsx), named by what it
// means, so a theme's glyph set can restyle them. A trick word maps to an EXISTING icon key
// (`DRAWN`): the `mod-icon-<word>` key where the table has one (a trick's own icon, the word),
// else a general key that means the same and draws the same glyph (`back`, `copy`, `delete`...).
//
// A word with no key keeps drawing its lucide component directly (the end of `DRAWN`), so the look of
// that word does not change. Adding a key for one is a row in keys.ts, lucide.ts and each family map
// (components/icons/), then its entry in `DRAWN` becomes the key and its lucide import goes.
//
// `schema.test.ts` holds each word to a lucide export the phone imports, and `mark.test.tsx` holds a
// keyed word to the glyph the default set draws for its key, so neither can drift.

import { ArrowDown, ArrowUp, Camera, ChevronRight, Eye, GitPullRequest, KeyRound, Menu, Minus, Move, Share2, Tag, Upload, Users, type LucideIcon } from "lucide-react";
import type { ComponentType, SVGProps } from "react";

import { Icon } from "@/components/icons/icon";
import type { IconKey } from "@/components/icons/keys";

import { DEFAULT_TRICK_ICON, TRICK_ICONS, TRICK_ICON_LUCIDE, type TrickIcon } from "./schema";

/** What a trick glyph takes: an SVG's props, as `<Icon>` and a lucide component both do. */
export type TrickGlyph = ComponentType<Omit<SVGProps<SVGSVGElement>, "ref" | "name">>;

/**
 * What each trick word draws with: an icon key, or, where the table has no key yet, the lucide
 * component the schema names (`TRICK_ICON_LUCIDE`). The key words come first, the keyless ones last.
 */
const DRAWN = {
  archive: { key: "mod-icon-archive" },
  back: { key: "back" },
  bell: { key: "mod-icon-bell" },
  branch: { key: "mod-icon-branch" },
  chat: { key: "mod-icon-message" },
  check: { key: "mod-icon-check" },
  clock: { key: "mod-icon-clock" },
  close: { key: "close" },
  copy: { key: "copy" },
  delete: { key: "mod-icon-trash" },
  download: { key: "download" },
  edit: { key: "edit" },
  file: { key: "mod-icon-file" },
  flag: { key: "mod-icon-flag" },
  flask: { key: "mod-icon-flask" },
  folder: { key: "mod-icon-folder" },
  image: { key: "image" },
  info: { key: "mod-icon-info" },
  link: { key: "mod-icon-link" },
  lock: { key: "mod-icon-lock" },
  machine: { key: "mod-icon-server" },
  mic: { key: "mic" },
  more: { key: "mod-icon-more" },
  note: { key: "mod-icon-note" },
  pause: { key: "mod-icon-pause" },
  pin: { key: "pin" },
  play: { key: "mod-icon-play" },
  plug: { key: "mod-icon-plug" },
  plus: { key: "add" },
  refresh: { key: "mod-icon-refresh" },
  search: { key: "mod-icon-search" },
  send: { key: "mod-icon-send" },
  settings: { key: "mod-icon-settings" },
  star: { key: "mod-icon-star" },
  terminal: { key: "mod-icon-terminal" },
  warn: { key: "mod-icon-alert" },
  x: { key: "mod-icon-x" },
  // No icon key yet: these keep their lucide component.
  camera: { glyph: Camera },
  crew: { glyph: Users },
  down: { glyph: ArrowDown },
  eye: { glyph: Eye },
  "git-pull-request": { glyph: GitPullRequest },
  key: { glyph: KeyRound },
  menu: { glyph: Menu },
  minus: { glyph: Minus },
  move: { glyph: Move },
  next: { glyph: ChevronRight },
  share: { glyph: Share2 },
  tag: { glyph: Tag },
  up: { glyph: ArrowUp },
  upload: { glyph: Upload },
} as const satisfies { readonly [K in TrickIcon]: { readonly key: IconKey } | { readonly glyph: LucideIcon } };

/** The icon key a trick word draws with, or null where the table has no key for it yet. */
export function trickIconKey(word: TrickIcon): IconKey | null {
  const drawn = DRAWN[word];
  return "key" in drawn ? drawn.key : null;
}

const KEY_GLYPHS = new Map<IconKey, TrickGlyph>();

/**
 * A component for one icon key, made once per key so a glyph keeps its identity across renders. The
 * renderer's fixed glyphs (a chip's state, the fold chevron, the busy spinner) use it too.
 */
export function keyGlyph(name: IconKey): TrickGlyph {
  const known = KEY_GLYPHS.get(name);
  if (known !== undefined) return known;
  const made: TrickGlyph = function TrickIconGlyph(props) {
    return <Icon name={name} {...props} />;
  };
  KEY_GLYPHS.set(name, made);
  return made;
}

/** The component of a word of the closed set. */
export function trickGlyph(word: TrickIcon): TrickGlyph {
  const drawn = DRAWN[word];
  return "key" in drawn ? keyGlyph(drawn.key) : drawn.glyph;
}

/** The words that have no icon key, for the report and the tests. */
export const TRICK_ICONS_WITHOUT_KEY: readonly TrickIcon[] = TRICK_ICONS.filter((word) => trickIconKey(word) === null);

function isTrickIcon(word: string): word is TrickIcon {
  return Object.hasOwn(TRICK_ICON_LUCIDE, word);
}

/** The component of an icon word. A word this Collie does not know (a newer crew member's) draws the default. */
export function trickIconOf(word: string | undefined): TrickGlyph {
  return trickGlyph(word !== undefined && isTrickIcon(word) ? word : DEFAULT_TRICK_ICON);
}
