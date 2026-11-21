import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { FakeIDBFactory, uninstallFakeIndexedDB } from "@/test/fake-indexeddb";
import { dropLegacyLastSeen } from "./last-seen";
import { dropLegacySendAgain } from "./send-again";
import { __resetStore, getRecord, putRecord, STORE_NAME } from "./store";
import { wipeDevice } from "./wipe";
// Registers its wipe cleaner at load, as it does in the app, where every pane row imports it.
import "./project-picture";

// EVERY STORAGE KEY THE APP WRITES HAS A DECIDED FATE AT UNPAIR (M46 spec 02).
//
// The wipe (lib/wipe.ts) is only as good as its list. A new key added under web/src with no line in
// the table below fails the first test here, so whoever adds it has to decide: is it session content
// the wipe must clear, or a preference that may stay? The second test then proves the table true by
// seeding each key and running the wipe.
//
// The scan reads app source for a quoted literal shaped like a Collie key (`collie:` or `collie.`),
// templates included, so `collie:auto-reloaded-for=${id}` reads as its prefix. Tests, the playground
// and fixtures are out of scope: none of them ships.

const SRC = join(import.meta.dirname, "..");
const KEY_LITERAL = /["'`](collie[:.][A-Za-z][^"'`\s$]*)/g;

/** Literals of that shape that are not storage keys at all. */
const NOT_STORAGE = new Map<string, string>([
  ["collie:open", "a service-worker postMessage type (lib/notification-open.ts)"],
  ["collie:herd", "a notification tag (lib/push-decision.ts)"],
  ["collie:herd@<host>", "the per-host notification tag, named in a comment"],
  ["collie.json", "a theme file name in the theme catalogue (lib/theme/catalogue.ts), not a storage key"],
  ["collie.toml", "a repository's project file name, named in comments (lib/project-picture.ts), not a storage key"],
]);

type Area = "local" | "session";

interface KeyFate {
  area: Area;
  /** True when the key is a prefix and real keys carry a suffix after it. */
  prefix: boolean;
  /** `dropped`: a key from an older build that nothing writes any more; its module deletes it at boot. */
  fate: "wiped" | "kept" | "dropped";
  why: string;
}

const KEYS = new Map<string, KeyFate>([
  // ── Wiped: what a pairing leaves behind ──
  ["collie:draft:", { area: "local", prefix: true, fate: "wiped", why: "unsent words typed under the pairing" }],
  // The draft store's second version (lib/drafts.ts, PR 560); under the first one's prefix, so its wipe covers both.
  ["collie:draft:v2:", { area: "local", prefix: true, fate: "wiped", why: "unsent words typed under the pairing" }],
  ["collie:draft:back~", { area: "local", prefix: true, fate: "wiped", why: "unsent words waiting on Put back, stored with the draft" }],
  // The token and the push endpoint are named by constants, so the scan sees them through those.
  ["collie:device-token", { area: "local", prefix: false, fate: "wiped", why: "the credential itself" }],
  ["collie:push-endpoint", { area: "local", prefix: false, fate: "wiped", why: "names this phone's push endpoint" }],
  // Cleared with the token (lib/pairing.ts `clearDeviceToken`): it caps the store at this pairing's expiry.
  ["collie:pairing-expires", { area: "local", prefix: false, fate: "wiped", why: "the ended pairing's expiry" }],
  ["collie:shape:", { area: "local", prefix: true, fate: "wiped", why: "remembered shape facts: a flag, a small number or a fixed word per page part (lib/remembered-shape.ts)" }],
  // Decision ids of trick proposals closed with "Not now" in their session (lib/hill/session-later.ts, 2026-11-17): they name this pairing's bridge decisions, so they go with it.
  ["collie:session-later", { area: "local", prefix: false, fate: "wiped", why: "decision ids of this pairing's trick proposals, closed in their session" }],
  ["collie:recent-panes:v1", { area: "local", prefix: false, fate: "wiped", why: "the panes this device opened last: pane addresses and workspace names (lib/recent-panes.ts)" }],
  ["collie:slot:v1:", { area: "local", prefix: true, fate: "wiped", why: "the last pane address and workspace name of each browser tile" }],
  // Written first by the wipe and removed last; present only while a wipe is unfinished (lib/wipe.ts).
  ["collie:wipe-pending", { area: "local", prefix: false, fate: "wiped", why: "a wipe's resume mark" }],
  // The project pictures (lib/project-picture.ts, ADR 0160): the page's own small copies, and which pane shows which.
  ["collie:project-picture-copies:v1", { area: "local", prefix: false, fate: "wiped", why: "small copies of pictures this pairing's repositories named" }],
  ["collie:project-picture-panes:v1", { area: "local", prefix: false, fate: "wiped", why: "which picture version each pane of this pairing shows" }],
  // ── Kept: how this phone likes to look and behave, never what a session said ──
  ["collie:theme:v1", { area: "local", prefix: false, fate: "kept", why: "preference" }],
  ["collie:design:v1", { area: "local", prefix: false, fate: "kept", why: "preference" }],
  ["collie:themes:v1", { area: "local", prefix: false, fate: "kept", why: "preference, the imported colour themes (M57)" }],
  // The fate of the theme it was derived from (collie:design:v1 names it, collie:themes:v1 holds it), so the two never
  // disagree after an unpair. theme-init.js uses it only for the applied theme, matched by id and the hash of its halves.
  ["collie:derived:v1", { area: "local", prefix: false, fate: "kept", why: "cache, the derived colours of the applied theme (ADR 0172)" }],
  ["collie:key-board:v1", { area: "local", prefix: false, fate: "kept", why: "preference, this phone's key layout" }],
  ["collie:display-prefs:v4", { area: "local", prefix: false, fate: "kept", why: "preference" }],
  ["collie:dash-prefs:v1", { area: "local", prefix: false, fate: "kept", why: "preference" }],
  ["collie:locale:v1", { area: "local", prefix: false, fate: "kept", why: "preference" }],
  ["collie:haptics:v1", { area: "local", prefix: false, fate: "kept", why: "preference" }],
  ["collie:harness-bar:v1", { area: "local", prefix: false, fate: "kept", why: "preference" }],
  ["collie:harness-prefs:v1", { area: "local", prefix: false, fate: "kept", why: "preference, per harness (status line shown)" }],
  ["collie:strips-collapsed:v1", { area: "local", prefix: false, fate: "kept", why: "preference" }],
  ["collie:stt-hands-free:v1", { area: "local", prefix: false, fate: "kept", why: "preference" }],
  ["collie:stt-engine:v1", { area: "local", prefix: false, fate: "kept", why: "preference, Host or This phone for speech (ADR 0096)" }],
  ["collie:zen-enabled:v1", { area: "local", prefix: false, fate: "kept", why: "preference" }],
  ["collie:auto-zen-enabled:v1", { area: "local", prefix: false, fate: "kept", why: "preference" }],
  ["collie:pins:v1", { area: "local", prefix: false, fate: "kept", why: "pinned pane ids, no content" }],
  ["collie:report-episodes:v1", { area: "local", prefix: false, fate: "kept", why: "failed-send episodes for a report: pane ids, request ids, outcome and reason codes, no content (ADR 0123)" }],
  ["collie:trouble-signalled:v1", { area: "local", prefix: false, fate: "wiped", why: "which trouble cards already signalled today: kind, crew host, pane id and day, no content (lib/report/once.ts)" }],
  ["collie:wide-layout:v1", { area: "local", prefix: false, fate: "kept", why: "large-screen columns per space: pane addresses and widths, no content (ADR 0120)" }],
  ["collie:wide-sidebar:v1", { area: "local", prefix: false, fate: "kept", why: "preference" }],
  ["collie:project-pictures:v1", { area: "local", prefix: false, fate: "kept", why: "preference: project pictures on or off on this device (ADR 0160)" }],
  ["collie:enter-sends:v1", { area: "local", prefix: false, fate: "kept", why: "preference: whether Enter from a physical keyboard sends (ADR 0157)" }],
  ["collie:diff-layout:v1", { area: "local", prefix: false, fate: "kept", why: "preference: a diff in one column or side by side on a large screen (ADR 0158)" }],
  ["collie:wide-layout-mode:v1", { area: "local", prefix: false, fate: "kept", why: "preference: Auto or Off for the large-screen layout (ADR 0120)" }],
  ["collie:enter-sends:v1", { area: "local", prefix: false, fate: "kept", why: "preference: whether Enter sends or adds a line on this device (lib/enter-sends-store.ts)" }],
  ["collie:pin-hint:v1", { area: "local", prefix: false, fate: "kept", why: "a dismissed hint" }],
  ["collie:masked-hint:v1", { area: "local", prefix: false, fate: "kept", why: "a dismissed hint" }],
  ["collie:pane-nav-hint:v1", { area: "local", prefix: false, fate: "kept", why: "the Two fingers first-arm hint was shown (ADR 0121)" }],
  ["collie.telemetryNotice.v1", { area: "local", prefix: false, fate: "kept", why: "a dismissed notice, stored as a revision: 1 the 1.27.0 notice, 2 the update notice (M86 spec 02, ADR 0134)" }],
  ["collie:hidden-machines:v1", { area: "local", prefix: false, fate: "kept", why: "machine names hidden here" }],
  ["collie:mirror-native:", { area: "local", prefix: true, fate: "kept", why: "a per-pane colour choice" }],
  ["collie:tour:v1", { area: "local", prefix: false, fate: "kept", why: "the tour was seen" }],
  // A fact about this device, never a person (lib/hardware-keyboard.ts, M108): a hardware key was pressed here. It holds no private data and decides only whether the Settings row "Keyboard shortcuts" is drawn.
  ["collie:hardware-keyboard-seen:v2", { area: "local", prefix: false, fate: "kept", why: "device fact: a hardware key was pressed here, a bare value, no content" }],
  // The one-time keyboard hint is done on this device (lib/keyboard-hint.ts, M108): closed, opened the list, or the prefix was pressed. A device fact with no private data.
  ["collie:keyboard-hint-done:v1", { area: "local", prefix: false, fate: "kept", why: "device fact: the one-time keyboard hint is done here, a bare value, no content" }],
  ["collie:diff-comments:v1:", { area: "session", prefix: true, fate: "wiped", why: "the Changes batch of diff comments: quoted lines and the notes on them" }],
  ["collie:tab-pane:v1:", { area: "session", prefix: true, fate: "wiped", why: "the pane id each tab was last open on, per machine, session and tab (lib/tab-pane-memory.ts)" }],
  ["collie:chat-silhouette:v1:", { area: "session", prefix: true, fate: "wiped", why: "the silhouette of each pane's Chat page: row kinds, heights and line counts, never a word (lib/chat-silhouette.ts)" }],
  ["collie:send-intent:", { area: "session", prefix: true, fate: "wiped", why: "the request id of a send with no answer, and the text of the draft it carried (lib/send-intent.ts)" }],
  ["collie:create-intent:", { area: "session", prefix: true, fate: "wiped", why: "the request id of a quick launch, tab or space create with no answer, kept 30 seconds, and the folder it names (lib/create-intent.ts)" }],
  ["collie:new-sheet:again:v1", { area: "local", prefix: false, fate: "wiped", why: "the last start per machine names its folders" }],
  ["collie:no-prompts-confirmed:v1", { area: "local", prefix: false, fate: "wiped", why: "the per-device No prompts confirms name machines and command lines" }],
  ["collie:new-page:kind:v1", { area: "local", prefix: false, fate: "kept", why: "Agent or Command per machine, one word, no folder" }],
  ["collie:push-disabled", { area: "local", prefix: false, fate: "kept", why: "the operator's push choice" }],
  // Written BY the wipe, so it outlives it: the cause the pair screen names once, then clears.
  ["collie:wipe-last", { area: "local", prefix: false, fate: "kept", why: "a wipe reason word, no content" }],
  ["collie:update-mode:closed:v1", { area: "local", prefix: false, fate: "kept", why: "update screen state" }],
  ["collie:update-mode:v1", { area: "session", prefix: false, fate: "kept", why: "update screen state" }],
  ["collie:auto-reloaded-for=", { area: "session", prefix: true, fate: "kept", why: "reload guard, a build id" }],
  ["collie:pwa:guardReload:v1", { area: "session", prefix: false, fate: "kept", why: "reload guard" }],
  ["collie:math-reload:v1", { area: "session", prefix: false, fate: "kept", why: "reload guard, the one reload when the math pack arrives" }],
  ["collie.slot.tab", { area: "session", prefix: false, fate: "kept", why: "navigation state, one slot number" }],
  ["collie:theme-trial:v1", { area: "session", prefix: false, fate: "kept", why: "a theme being tried in this tab (M59 spec 08): a preference that lasts the tab, like the theme library" }],
  ["collie:preload-reload", { area: "session", prefix: false, fate: "kept", why: "reload guard, a timestamp" }],
  ["collie.nav.booted", { area: "session", prefix: false, fate: "kept", why: "navigation state" }],
  ["collie.nav.seeded", { area: "session", prefix: false, fate: "kept", why: "navigation state, an app path" }],
  ["collie.nav.pendingOpen", { area: "session", prefix: false, fate: "kept", why: "navigation state, an app path" }],
  ["collie.nav.trail", { area: "session", prefix: false, fate: "kept", why: "navigation state, the app paths this tab visited" }],
  // ── Dropped: the 1.17 last-seen mirror, moved into the on-device store (ADR 0087) ──
  ["collie:last-snapshot:", { area: "session", prefix: true, fate: "dropped", why: "lib/last-seen.ts deletes it at boot" }],
  ["collie:last-pane:", { area: "session", prefix: true, fate: "dropped", why: "lib/last-seen.ts deletes it at boot" }],
  ["collie:send-again:", { area: "session", prefix: true, fate: "dropped", why: "an earlier build stored a fingerprint of an unknown send's text here; lib/send-again.ts deletes it at boot" }],
]);

/**
 * Every IndexedDB database the app opens, and its fate at unpair. One today: the on-device store
 * (lib/store.ts, ADR 0087), which holds the herd and the pane text as last seen, and the Chat tail.
 */
const DATABASES = new Map<string, "wiped" | "kept">([[STORE_NAME, "wiped"]]);

/** The one module allowed to open IndexedDB. A second store is a second thing to wipe. */
const IDB_OWNER = "lib/store.ts";

function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const rel = relative(SRC, full);
    if (entry.isDirectory()) {
      if (rel === "playground" || rel === "test" || rel === "fixtures") continue;
      out.push(...collectSourceFiles(full));
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function keyLiterals(): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of collectSourceFiles(SRC)) {
    for (const match of readFileSync(file, "utf8").matchAll(KEY_LITERAL)) {
      const literal = match[1];
      if (literal !== undefined && !found.has(literal)) found.set(literal, relative(SRC, file));
    }
  }
  return found;
}

function storageOf(area: Area): Storage {
  return area === "local" ? localStorage : sessionStorage;
}

describe("storage keys and the wipe", () => {
  it("finds the keys it should (guard against a broken scan)", () => {
    const found = keyLiterals();
    expect(found.has("collie:draft:")).toBe(true);
    expect(found.has("collie:device-token")).toBe(true);
  });

  it("every storage key written under web/src has a decided fate at unpair", () => {
    const undecided = [...keyLiterals()]
      .filter(([literal]) => !KEYS.has(literal) && !NOT_STORAGE.has(literal))
      .map(([literal, file]) => `${literal} (${file})`);
    expect(undecided).toEqual([]);
  });

  it("the table is true: the wipe clears every wiped key and leaves every kept one", async () => {
    sessionStorage.clear();
    const keyOf = (name: string, fate: KeyFate) => (fate.prefix ? `${name}probe` : name);
    for (const [name, fate] of KEYS) storageOf(fate.area).setItem(keyOf(name, fate), "1");

    await wipeDevice("unpair");

    const wrong = [...KEYS]
      .filter(([, fate]) => fate.fate !== "dropped")
      .filter(([name, fate]) => {
        const present = storageOf(fate.area).getItem(keyOf(name, fate)) !== null;
        return fate.fate === "wiped" ? present : !present;
      })
      .map(([name, fate]) => `${name} should be ${fate.fate}`);
    expect(wrong).toEqual([]);
  });
  it("a dropped key is deleted at boot, whatever the wipe does", () => {
    const keyOf = (name: string, fate: KeyFate) => (fate.prefix ? `${name}probe` : name);
    const dropped = [...KEYS].filter(([, fate]) => fate.fate === "dropped");
    for (const [name, fate] of dropped) storageOf(fate.area).setItem(keyOf(name, fate), "1");
    dropLegacyLastSeen();
    dropLegacySendAgain();
    const left = dropped.filter(([name, fate]) => storageOf(fate.area).getItem(keyOf(name, fate)) !== null);
    expect(left.map(([name]) => name)).toEqual([]);
  });

  it("only the store opens IndexedDB", () => {
    const openers = collectSourceFiles(SRC)
      .filter((file) => /\bindexedDB\b/.test(readFileSync(file, "utf8")))
      .map((file) => relative(SRC, file));
    expect(openers).toEqual([IDB_OWNER]);
  });

  it("every IndexedDB database has a decided fate, and the wipe deletes the wiped ones", async () => {
    const idb = new FakeIDBFactory().install();
    try {
      __resetStore();
      await putRecord("snapshot", "probe", 1);
      await wipeDevice("unpair");
      for (const [name, fate] of DATABASES) expect(idb.deleted.includes(name)).toBe(fate === "wiped");
      expect(await getRecord("snapshot", "probe")).toBeNull();
    } finally {
      __resetStore();
      uninstallFakeIndexedDB();
    }
  });
});
