import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it } from "vitest";

import { isPageId, SETTINGS, settingById, type Condition } from "@/lib/settings";
import type { OfficialTricksReply, TricksReply, WireTrickInfo } from "@/lib/tricks/schema";
import { createTricksStore } from "@/lib/tricks/store";
import { body, defaultRow, FOUND_ALT, serveAccounts, workRow } from "@/test/accounts-fixtures";
import { withHeaderHost } from "@/test/header-host";
import { renderTricksPages } from "@/test/tricks-pages";
import { SettingsAccountAddRoute, SettingsAccountRoute, SettingsAccountsRoute } from "./settings-accounts";
import { SettingsChangeLoginRoute } from "./settings-change-login";
import {
  SettingsCharacterRoute,
  SettingsChatRoute,
  SettingsDashboardRoute,
  SettingsDevicesRoute,
  SettingsInstallCountRoute,
  SettingsKeysRoute,
  SettingsLookRoute,
  SettingsNotificationsRoute,
  SettingsPrivacyRoute,
  SettingsTricksRoute,
  SettingsVoiceHostRoute,
  SettingsVoiceModelRoute,
  SettingsVoiceRoute,
} from "./settings-sections";
import { UpdatesRoute } from "./updates";

// EVERY SETTINGS ROW HAS A MARKED PLACE ON A PAGE, AND EVERY CONTROL SITS IN ONE (ADR 0170). Each page wraps the
// control that draws a row in a `SettingSlot` naming its registry ids. This renders every Settings page, the Profiles
// pages and a trick's details page, and reads them twice:
//
//   - the marks: an id no row has fails, and a row of a Settings page that no page marks fails;
//   - the controls: a button, switch, field or link of a page that sits in no slot fails. That is the control of a row
//     nobody declared, which the marks alone never see (a trick's Remove section had no row and no slot until
//     2026-11-21, and nothing failed).

const PAGES = {
  "/settings/look": <SettingsLookRoute />,
  "/settings/look/character": <SettingsCharacterRoute />,
  "/settings/chat": <SettingsChatRoute />,
  "/settings/keys": <SettingsKeysRoute />,
  "/settings/notifications": <SettingsNotificationsRoute />,
  "/settings/voice": <SettingsVoiceRoute />,
  "/settings/voice/host": <SettingsVoiceHostRoute />,
  "/settings/voice/model": <SettingsVoiceModelRoute />,
  "/settings/dashboard": <SettingsDashboardRoute />,
  "/settings/tricks": <SettingsTricksRoute />,
  "/settings/devices": <SettingsDevicesRoute />,
  "/settings/privacy": <SettingsPrivacyRoute />,
  "/settings/privacy/install-count": <SettingsInstallCountRoute />,
  "/settings/updates": <UpdatesRoute />,
} satisfies Record<string, ReactNode>;

/** Profiles, with a default and an added profile and a folder found in use: the state where every row of it shows. */
const ACCOUNT_PAGES = [
  { route: "/settings/accounts", entry: "/settings/accounts", page: <SettingsAccountsRoute /> },
  { route: "/settings/accounts/add", entry: "/settings/accounts/add", page: <SettingsAccountAddRoute /> },
  { route: "/settings/accounts/:id", entry: `/settings/accounts/${workRow().id}`, page: <SettingsAccountRoute /> },
  { route: "/settings/accounts/:id/login", entry: `/settings/accounts/${workRow().id}/login`, page: <SettingsChangeLoginRoute /> },
] as const;

/**
 * Each state a row shows only in (types.ts `Condition`), and how this test reaches the controls it shows. A page draws a
 * row's slot whether or not its state holds, around the component that decides (checked below: every `when` row is
 * marked in a render where its state does not hold). So a control the state shows lands in that slot. Where the test
 * also draws the state itself, it says so. A new condition fails typecheck here until it has its line.
 */
const CONDITIONS = {
  "accounts-offered": "drawn: the Profiles pages, with the accounts route answering",
  "has-profile": "drawn: one added profile's page and its Change login page",
  "can-vibrate": "slot drawn while off: keys.haptics wraps HapticsControl, which reads navigator.vibrate itself",
  "keyboard-seen": "slot drawn while off: keys.shortcuts wraps ShortcutSettingsRow (its own test draws the seen state)",
  "install-offered": "slot drawn while off: updates.installApp wraps InstallControl (install-control.test.tsx)",
  crew: "slot drawn while off: devices.crew and updates.crew wrap their cards (e2e machines.spec.ts draws a crew)",
  "push-server": "slot drawn while off: the notification rows wrap PushControl and NotifyPrefsControl (their own tests)",
  "tricks-on": "slot drawn while off: tricks.list wraps the list card (tricks-settings-card.test.tsx draws it on)",
  "zen-on": "no Settings page: pane.zen lives in a pane",
  "update-waiting": "slot drawn while off: the Updates rows wrap the Updates card (updates.test.tsx draws an offer)",
  "release-line-skew": "slot drawn while off: updates.releaseLine wraps the release line card (release-line-card.test.tsx)",
  "math-ready": "slot drawn while off: look.math wraps MathControl, which draws Remove once the engine is in",
  "hands-free-offered": "slot drawn while off: voice.handsFree wraps SpeechControl's hands-free part (speech-control.test.tsx)",
  "official-newer": "slot drawn while off: tricks.official wraps the official list (tricks-settings-official.test.tsx)",
} satisfies Record<Condition, string>;

/**
 * Rows of a Settings page that the renders here do not reach, by why: each is a state of one item or of a flow, and each
 * is marked where its component draws it. A row named here is not a row a person cannot reach.
 */
const NOT_IN_THIS_RENDER = {
  "accounts.add.folder": "the Add form shows the folder field only for the own-folder kind; the render opens on shared",
  "accounts.changeLogin": "a profile that reads signed in shows Change login in place of Sign in again; the render's is not",
  "accounts.login.open": "the Change login page shows Open and Finish only while a sign-in runs",
  "accounts.login.finish": "the Change login page shows Open and Finish only while a sign-in runs",
  "tricks.trick.autoUpdate": "a trick that is on and gives no rules shows its update switch; the render's trick is off",
  "tricks.trick.rules": "a trick that gives agents rules shows them; the render's trick gives none",
  "tricks.trick.undo": "Undo shows on the list for a trick that updated itself a moment ago",
} satisfies Record<string, string>;

const CONTROLS = 'button, [role="switch"], [role="radio"], [role="slider"], [role="checkbox"], input, select, textarea, a[href]';

interface Read {
  marks: string[];
  /** Controls outside every slot, by what a person reads on them. The app header (Back, the mark) is the shell's. */
  loose: string[];
}

function readPage(root: ParentNode, where: string): Read {
  const marks = [...root.querySelectorAll("[data-setting]")].flatMap((el) => (el.getAttribute("data-setting") ?? "").split(" "));
  const loose = [...root.querySelectorAll(CONTROLS)]
    .filter((el) => el.closest("[data-setting]") === null && el.closest('[data-slot="app-header"]') === null)
    .map((el) => `${where}: ${el.tagName.toLowerCase()} "${el.getAttribute("aria-label") ?? el.textContent?.trim() ?? ""}"`);
  return { marks, loose };
}

async function readRoute(route: string, entry: string, page: ReactNode): Promise<Read> {
  const router = createMemoryRouter([{ path: route, element: withHeaderHost(page) }], { initialEntries: [entry] });
  const { container, unmount } = render(<RouterProvider router={router} />);
  await waitFor(() => expect(container.querySelector("[data-setting]")).not.toBeNull());
  // A page that reads the machine first (Profiles) draws its rows a beat later: wait for them to settle.
  await new Promise((resolve) => setTimeout(resolve, 50));
  const read = readPage(container, entry);
  unmount();
  return read;
}

const LEGS: WireTrickInfo = { host: "lodge", id: "legs", name: "Browser leg", icon: "flask", on: false, state: "off", places: ["belt"], description: "Which release checks are green.", provenance: { via: "agent" } };

/** A trick's details page, for a trick that is off: every section of it shows, its Remove last. */
async function readTrickPage(): Promise<Read> {
  const reply: TricksReply = { rev: 5, tricks: [LEGS], parts: [], present: [] };
  const store = createTricksStore({ fetchTricks: async () => reply, tapTrick: async () => Promise.reject(new Error("no tap")), mintRequestId: () => "r" });
  await store.syncTricks(5);
  const noOfficial = async (): Promise<OfficialTricksReply> => ({ tricks: [] });
  renderTricksPages({ store, page: { onOfficialList: noOfficial }, entries: ["/settings/tricks/lodge%3Alegs"] });
  await screen.findByRole("heading", { name: "Browser leg" });
  const read = readPage(document.body, "/settings/tricks/lodge:legs");
  cleanup();
  return read;
}

async function readAll(): Promise<Read> {
  const all: Read = { marks: [], loose: [] };
  const add = (read: Read) => {
    all.marks.push(...read.marks);
    all.loose.push(...read.loose);
  };
  for (const [path, page] of Object.entries(PAGES)) add(await readRoute(path, path, page));
  serveAccounts(body({ accounts: [defaultRow(), workRow()], found: [FOUND_ALT] }));
  for (const each of ACCOUNT_PAGES) add(await readRoute(each.route, each.entry, each.page));
  add(await readTrickPage());
  return all;
}

afterEach(() => cleanup());

describe("the marks on the Settings pages", () => {
  it("name only registry rows, every row of a Settings page has one, and every control sits in a slot", async () => {
    const { marks, loose } = await readAll();
    const marked = new Set(marks);
    expect([...marked].filter((id) => settingById(id) === undefined)).toEqual([]);
    const unmarked = SETTINGS.filter((s) => isPageId(s.page) && !marked.has(s.id)).map((s) => s.id);
    expect(unmarked.toSorted()).toEqual(Object.keys(NOT_IN_THIS_RENDER).toSorted());
    expect(loose).toEqual([]);
  });

  it("draw each row that shows only in a state while the state does not hold, so its controls land in that slot", async () => {
    const { marks } = await readAll();
    const marked = new Set(marks);
    const drawnTrue = new Set<Condition>(["accounts-offered", "has-profile"]);
    const hidden = SETTINGS.filter((s) => s.when !== undefined && isPageId(s.page) && !drawnTrue.has(s.when) && !marked.has(s.id)).map((s) => `${s.id} (${String(s.when)})`);
    expect(hidden.filter((line) => !/^tricks\.(list|addRepo|official\.)/.test(line))).toEqual([]);
    expect(Object.keys(CONDITIONS).length).toBe(14);
  });
});
