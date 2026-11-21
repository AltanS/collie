import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import { en } from "@/lib/i18n/messages/en";
import { ALIASES, currentRowId, groupHeading, isPageId, NOT_SETTINGS, PLACES, OLD_FRAGMENTS, PAGES, pageDef, searchSettings, settingById, settingOfFragment, SETTINGS, settingPath } from "./index";
import { OLD_FRAGMENT_ROWS } from "./pages";
import { BLOB_FIELDS, NOT_SETTING_FIELDS } from "./registry";
import type { Store } from "./types";

// THE REGISTRY IS COMPLETE AND TRUE (ADR 0170). A saved key of the app that no setting stores into and no line of
// `NOT_SETTINGS` explains fails here, so whoever adds a preference also declares it. The marks on the pages are
// pinned in `settings-marks.test.tsx`.

const SRC = join(import.meta.dirname, "../..");
const KEY_LITERAL = /["'`](collie[:.][A-Za-z][^"'`\s$]*)/g;

/** Literals of the key's shape that are no saved key at all (lib/storage-keys.test.ts lists the same). */
const NOT_STORAGE = new Set(["collie:open", "collie:herd", "collie:herd@<host>", "collie.json", "collie.toml"]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const rel = relative(SRC, full);
    if (entry.isDirectory()) {
      if (rel === "playground" || rel === "test" || rel === "fixtures" || rel === join("lib", "settings")) continue;
      out.push(...sourceFiles(full));
      continue;
    }
    if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

function savedKeys(): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of sourceFiles(SRC)) {
    for (const match of readFileSync(file, "utf8").matchAll(KEY_LITERAL)) {
      const literal = match[1];
      if (literal !== undefined && !NOT_STORAGE.has(literal) && !found.has(literal)) found.set(literal, relative(SRC, file));
    }
  }
  return found;
}

function keyOf(store: Store): string | null {
  if (store.kind === "local" || store.kind === "blob") return store.key;
  if (store.kind === "per-key") return store.prefix;
  return null;
}

const STORED = new Set(SETTINGS.map((s) => keyOf(s.store)).filter((k): k is string => k !== null));

describe("the settings registry", () => {
  it("reads the app's saved keys (guard against a broken scan)", () => {
    const keys = savedKeys();
    expect(keys.has("collie:display-prefs:v4")).toBe(true);
    expect(keys.has("collie:device-token")).toBe(true);
  });

  it("declares every saved key: a setting stores into it, or NOT_SETTINGS says why it is none", () => {
    const loose = [...savedKeys()].filter(([key]) => !STORED.has(key) && !NOT_SETTINGS.has(key)).map(([key, file]) => `${key} (${file})`);
    expect(loose).toEqual([]);
  });

  // A blob is one storage key holding many values, so the check above passes a new field of it undeclared.
  // BLOB_FIELDS lists each blob's fields from its type (a field added to the type fails typecheck there).
  it("declares every field of a typed blob: a row stores into it, or NOT_SETTING_FIELDS says why it is none", () => {
    const declared = new Set(SETTINGS.flatMap((s) => (s.store.kind === "blob" ? [`${s.store.key}#${s.store.field}`] : [])));
    const listed = Object.entries(BLOB_FIELDS).flatMap(([key, fields]) => Object.keys(fields).map((field) => `${key}#${field}`));
    expect(listed.filter((f) => !declared.has(f) && !NOT_SETTING_FIELDS.has(f))).toEqual([]);
    expect(listed.filter((f) => declared.has(f) && NOT_SETTING_FIELDS.has(f))).toEqual([]);
    expect([...declared, ...NOT_SETTING_FIELDS.keys()].filter((f) => !listed.includes(f))).toEqual([]);
    const blobKeys = new Set(SETTINGS.flatMap((s) => (s.store.kind === "blob" ? [s.store.key] : [])));
    expect([...blobKeys].filter((key) => !Object.hasOwn(BLOB_FIELDS, key))).toEqual([]);
  });

  it("names only keys the app still has", () => {
    const keys = savedKeys();
    expect([...STORED].filter((k) => !keys.has(k))).toEqual([]);
    expect([...NOT_SETTINGS.keys()].filter((k) => !keys.has(k))).toEqual([]);
    expect([...NOT_SETTINGS.keys()].filter((k) => STORED.has(k))).toEqual([]);
  });

  // The first segment of an id is a namespace, not the page (types.ts `SettingId`): a row that moves keeps its id
  // and changes its `page`. So the rules are the id's own, and the page is a declared one.
  it("gives every row a unique dotted id, lower camel after its namespace, and a page or place that exists", () => {
    const ids = SETTINGS.map((s) => s.id);
    expect(ids.length).toBe(new Set(ids).size);
    expect(ids.filter((id) => !/^[a-z][a-z0-9-]*(\.[a-z][a-zA-Z0-9]*)+$/.test(id))).toEqual([]);
    expect(SETTINGS.filter((s) => !isPageId(s.page) && !Object.hasOwn(PLACES, s.page)).map((s) => s.id)).toEqual([]);
  });

  it("puts every row in a group its page has, and every page's groups are used", () => {
    for (const s of SETTINGS) expect(() => groupHeading(s), s.id).not.toThrow();
    for (const page of PAGES) {
      for (const group of page.groups) {
        expect(SETTINGS.some((s) => s.page === page.id && s.group === group.id), `${page.id}/${group.id}`).toBe(true);
      }
    }
  });

  it("words every row with keys the English catalog has", () => {
    const keys = new Set(Object.keys(en));
    for (const s of SETTINGS) {
      for (const key of [s.label, s.hint, ...(s.words ?? [])]) {
        if (key !== undefined) expect(keys.has(key), `${s.id}: ${key}`).toBe(true);
      }
    }
    for (const page of PAGES) {
      expect(keys.has(page.title)).toBe(true);
      if (page.blurb !== null) expect(keys.has(page.blurb)).toBe(true);
    }
  });

  it("names routes the app calls", () => {
    const source = sourceFiles(SRC).map((f) => readFileSync(f, "utf8")).join("\n");
    const missing = SETTINGS.flatMap((s) => (s.store.kind === "route" ? [s.store.route] : [])).filter((r) => !source.includes(`"${r}`) && !source.includes(`\`${r}`));
    expect([...new Set(missing)]).toEqual([]);
  });

  it("marks the experiments, and only they say so", () => {
    expect(SETTINGS.filter((s) => s.experiment === true).map((s) => s.id)).toEqual(["tricks.enabled", "tricks.hill"]);
  });

  it("opens a row on its page with its id as the fragment; a place has no address", () => {
    expect(settingPath(SETTINGS.find((s) => s.id === "look.math")!)).toBe("/settings/look#look.math");
    expect(settingPath(SETTINGS.find((s) => s.id === "look.character")!)).toBe("/settings/look/character#look.character");
    expect(settingPath(SETTINGS.find((s) => s.id === "tricks.trick.autoUpdate")!)).toBe("/settings/tricks#tricks.trick.autoUpdate");
    expect(settingPath(SETTINGS.find((s) => s.id === "pane.ownColours")!)).toBeNull();
  });

  it("finds the diff layout of Files by its words, says where it is and has no address", () => {
    const row = SETTINGS.find((s) => s.id === "files.diffLayout")!;
    expect(row.store).toEqual({ kind: "local", key: "collie:diff-layout:v1" });
    expect(en[groupHeading(row)]).toBe("In Files: on a changed file's row");
    expect(settingPath(row)).toBeNull();
    expect(searchSettings("side by side").map((h) => h.setting.id)).toContain("files.diffLayout");
  });

  it("has the eleven pages in the table's order", () => {
    expect(PAGES.map((p) => p.id)).toEqual(["look", "chat", "keys", "notifications", "voice", "dashboard", "accounts", "tricks", "devices", "privacy", "updates"]);
    expect(PAGES.every((p) => isPageId(p.id) && pageDef(p.id) === p)).toBe(true);
  });
});

describe("the old fragments", () => {
  it("each name a row on the page their redirect opens", () => {
    for (const [fragment, page] of Object.entries(OLD_FRAGMENTS)) {
      const row = settingOfFragment(`#${fragment}`);
      expect(row?.page, fragment).toBe(page);
      expect(row?.id).toBe(new Map<string, string>(Object.entries(OLD_FRAGMENT_ROWS)).get(fragment));
    }
  });

  it("reads an alias as the id it names now (none today, so an id reads as itself)", () => {
    expect(Object.keys(ALIASES)).toEqual([]);
    expect(currentRowId("look.math")).toBe("look.math");
    expect(currentRowId("changes")).toBe("dashboard.changes.nested");
  });

  it("reads a row's own id, and nothing for an empty or unknown fragment", () => {
    expect(settingOfFragment("#look.math")?.id).toBe("look.math");
    expect(settingOfFragment("")).toBeUndefined();
    expect(settingOfFragment("#no-such-row")).toBeUndefined();
  });
});

describe("searchSettings", () => {
  it("finds a row by its label, with its page and group, best first", () => {
    const [first] = searchSettings("enter sends");
    expect(first?.setting.id).toBe(settingById("keys.enterSends")?.id);
    expect(first?.page).toBe("Keys and touch");
  });

  it("finds a pane's own row and gives it no path", () => {
    const hit = searchSettings("pin").find((each) => each.setting.page === "pane");
    expect(hit).toBeDefined();
    expect(settingPath(hit!.setting)).toBeNull();
  });

  // What a person types to undo or tidy (counsel of 2026-11-21): each verb finds the rows that do it.
  it.each([
    ["delete", ["look.theme.remove", "look.math.remove", "voice.model.removePhone", "accounts.remove", "tricks.trick.remove", "privacy.keepChat.clear"]],
    ["remove", ["look.theme.remove", "look.math.remove", "voice.model.removePhone", "accounts.remove", "tricks.trick.remove"]],
    ["sign out", ["devices.unpair"]],
    ["log out", ["devices.unpair"]],
    ["forget", ["devices.unpair", "accounts.remove"]],
    ["unpair", ["devices.unpair", "devices.paired"]],
    ["sign in", ["accounts.signInAgain"]],
    ["storage", ["voice.model.removePhone", "look.math.remove", "privacy.keepChat"]],
    ["free space", ["voice.model.removePhone", "look.math.remove", "privacy.keepChat.clear"]],
    ["clear", ["notifications.clear", "privacy.keepChat.clear"]],
    ["smaller", ["look.textSize.chat"]],
    ["zoom", ["keys.pinchZoom"]],
    ["version", ["updates.version"]],
    ["help", ["updates.firstScreen", "updates.report"]],
    ["bug", ["updates.report"]],
    ["feedback", ["updates.report", "updates.reportOffer"]],
    ["light mode", ["look.lightDark"]],
    ["dark mode", ["look.lightDark"]],
  ])("finds %s", (query, ids) => {
    const found = new Set<string>(searchSettings(query, 40).map((h) => h.setting.id));
    expect(ids.filter((id) => !found.has(id))).toEqual([]);
  });

  it("finds nothing for words no row has", () => {
    expect(searchSettings("zzqxv")).toEqual([]);
  });
});
