import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type Page, type TestInfo } from "@playwright/test";

import type { TranscriptEntry } from "@/lib/types";
import { en } from "@/lib/i18n/messages/en";
import { fixtureKiroDenialLog, fixtureKiroSnapshot, KIRO_PANE_ID, kiroJournalResponses } from "@/test/kiro-fixtures";
import { installApiStub, pinLocale } from "./fixtures/api";

// Real installed-CLI captures (kiro/APPROVAL_NOTES.md) drive the built UI. The saved-session
// fixture is synthetic source-schema data, parsed by the shipped journal, not invented bubbles.
test.use({ serviceWorkers: "block" });

const sourceLog = readFileSync(fileURLToPath(new URL("../../bridge/journal/fixtures/kiro/messages.jsonl", import.meta.url)), "utf8");
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
// Bun owns the journal source. Keep its global fetch types out of the browser TS project,
// and parse in its real runtime without opening a bridge listener or reading any user session.
// SAFETY: only the local shipped parser produces these JSON entries, from the synthetic log on stdin.
const entries = JSON.parse(execFileSync("bun", ["--eval",
  'import { kiroJournal } from "./bridge/journal/kiro.ts"; process.stdout.write(JSON.stringify(kiroJournal([]).parse(await Bun.stdin.text())));',
], { cwd: ROOT, input: sourceLog + fixtureKiroDenialLog, encoding: "utf8" })) as TranscriptEntry[];
// The bridge's binding check reads the send profiles through JSON imports that Playwright's Node
// loader refuses, so it runs in Bun as well, on the screen and the binding the app sent.
// SAFETY: the shipped verifier writes only its own verdict object to stdout.
const verifyPromptBinding = (screen: string, expected: string, styled: string | undefined): { readonly ok: boolean } => JSON.parse(execFileSync("bun", ["--eval",
  'import { verifyPromptBinding } from "./bridge/prompt-binding.ts"; const a = JSON.parse(await Bun.stdin.text()); process.stdout.write(JSON.stringify(verifyPromptBinding(a.screen, a.expected, a.styled)));',
], { cwd: ROOT, input: JSON.stringify({ screen, expected, styled }), encoding: "utf8" })) as { readonly ok: boolean };
const journal = kiroJournalResponses(entries);
const PANE_URL = `/pane/${encodeURIComponent(KIRO_PANE_ID)}`;
const PANE_PATH = `/api/pane/${encodeURIComponent(KIRO_PANE_ID)}`;
const capture = (name: string): string => readFileSync(fileURLToPath(new URL(`../src/fixtures/panes/kiro--v3-${name}.txt`, import.meta.url)), "utf8");

interface SentKeys {
  readonly keys: readonly string[];
  readonly expected_prompt?: string;
  readonly expected_styled?: string;
}

interface Step {
  readonly on: string;
  readonly keys: readonly string[];
  readonly to: string;
}

/** Each emitted key changes the capture the next read returns, including pointer verification. */
async function paneWorld(page: Page, options: {
  screens: Readonly<Record<string, string>>;
  start: string;
  steps?: readonly Step[];
}) {
  let showing = options.start;
  const sent: SentKeys[] = [];
  const events: string[] = [];
  const writes: string[] = [];
  await page.route((url) => url.pathname === "/api/snapshot", (route) => route.fulfill({ json: fixtureKiroSnapshot }));
  await page.route((url) => url.pathname === `${PANE_PATH}/history`, (route) => route.fulfill({ json: journal.history }));
  await page.route((url) => url.pathname === `${PANE_PATH}/chat`, (route) => {
    const after = new URL(route.request().url()).searchParams.has("after");
    return route.fulfill({ json: { ...journal.chat, upserts: after ? [] : journal.chat.upserts } });
  });
  await page.route((url) => url.pathname === PANE_PATH, (route) => {
    events.push(`read:${showing}`);
    return route.fulfill({ json: { paneId: KIRO_PANE_ID, text: options.screens[showing], truncated: false, revision: 1 } });
  });
  await page.route((url) => url.pathname.startsWith(`${PANE_PATH}/`), async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "GET") return route.fallback();
    writes.push(path);
    if (path !== `${PANE_PATH}/keys`) return route.fulfill({ status: 409, json: { ok: false, error: "Unexpected pane mutation" } });
    // SAFETY: this is lib/api's emitted keys body from the built app under test.
    const body = request.postDataJSON() as SentKeys;
    const screen = options.screens[showing];
    if (screen === undefined) throw new Error(`Missing capture ${showing}`);
    // Keep the bridge's real last-read binding check in the fixture transport too. An unbound
    // approval is refused rather than made successful by a permissive browser stub.
    const bound = body.expected_prompt === undefined ? { ok: false } : verifyPromptBinding(screen, body.expected_prompt, body.expected_styled);
    expect(bound.ok).toBe(true);
    if (!bound.ok) return route.fulfill({ status: 409, json: { ok: false, code: "prompt_changed", error: "prompt changed" } });
    sent.push(body);
    events.push(`keys:${showing}:${body.keys.join("+")}`);
    const step = options.steps?.find((candidate) => candidate.on === showing && candidate.keys.join("+") === body.keys.join("+"));
    if (step !== undefined) showing = step.to;
    await route.fulfill({ json: { ok: true } });
  });
  return { sent, events, writes, show: (name: string) => { showing = name; } };
}

async function evidence(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("states"), "Kiro cases exercise the shipped app only");
  await pinLocale(page, "en");
  // Keep the default paneView (Chat). Tool visibility makes the persisted denied card inspectable.
  await page.addInitScript(() => window.localStorage.setItem("collie:dash-prefs:v1", JSON.stringify({ showToolCalls: true })));
  await installApiStub(page);
});

test("Kiro defaults to web Chat and offers read-only saved History without model context", async ({ page }, testInfo) => {
  // Given: an installed-CLI idle frame and a journal parsed from saved-session source rows.
  const world = await paneWorld(page, { screens: { idle: capture("idle-w120") }, start: "idle" });
  // When: the phone opens the pane without a paneView preference.
  await page.goto(PANE_URL);
  // Then: the journal answer is visible, with denial intact and internal context hidden.
  await expect(page.getByText("The files are sample-a and sample-b.", { exact: true })).toBeVisible();
  await expect(page.getByText(en["chat.card.status.denied"], { exact: true })).toBeVisible();
  for (const privateText of ["Synthetic private system prompt.", "Synthetic context, not speech.", "Synthetic model-only context.", "Synthetic consumed steer envelope."]) {
    await expect(page.getByText(privateText, { exact: true })).toHaveCount(0);
  }
  await evidence(page, testInfo, "kiro-default-chat");
  await page.getByRole("button", { name: en["chat.paneMenu.aria"], exact: true }).click();
  await page.getByRole("button", { name: en["chat.history.label"], exact: true }).click();
  await expect(page).toHaveURL(`${PANE_URL}/history`);
  await expect(page.getByText("The files are sample-a and sample-b.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "execute_bash printf never_run", exact: true }).click();
  await expect(page.getByText("Permission refused.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /^(Allow|Deny|Send)$/ })).toHaveCount(0);
  await expect(page.getByPlaceholder(en["composer.placeholder.reply"])).toHaveCount(0);
  await page.getByRole("button", { name: en["history.findAria"], exact: true }).click();
  await evidence(page, testInfo, "kiro-read-only-history");
  expect(world.writes).toEqual([]);
});

const approvals = [
  { name: "shell", stem: "approval", rows: ["Down", "Down"], subject: "printf collie_approve_once_probe" },
  { name: "read", stem: "read", rows: ["Down"], subject: "read-once.txt" },
  { name: "write", stem: "write", rows: ["Down"], subject: "write-once.txt" },
  { name: "replace", stem: "replace", rows: ["Down"], subject: "collie_after_replace" },
] as const;

for (const approval of approvals) {
  test(`${approval.name} Allow once sends only Enter bound to its captured request`, async ({ page }, testInfo) => {
    // Given: the current capture has Allow selected.
    const world = await paneWorld(page, {
      screens: { allow: capture(`${approval.stem}-allow-w120`), idle: capture("idle-w120") }, start: "allow",
      steps: [{ on: "allow", keys: ["Enter"], to: "idle" }],
    });
    await page.goto(PANE_URL);
    // When: the user allows this one pending operation from Chat's live card.
    await expect(page.getByRole("button", { name: "Allow", exact: true })).toBeVisible();
    await evidence(page, testInfo, `kiro-${approval.name}-allow-card`);
    await page.getByRole("button", { name: "Allow", exact: true }).click();
    // Then: the exact subject and pointer frame bind one Enter, with no persistent choice.
    await expect.poll(() => world.sent.length).toBe(1);
    expect(world.sent[0]?.keys).toEqual(["Enter"]);
    expect(world.sent[0]?.expected_prompt).toContain(approval.subject);
    await expect(page.getByRole("button", { name: "Allow", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^(Always allow|Always deny)$/ })).toHaveCount(0);
  });

  test(`${approval.name} Deny walks ${approval.rows.length} actual rows and binds Enter only after pointer read-back`, async ({ page }) => {
    // Given: paired real captures of this request with Allow and Deny selected.
    const world = await paneWorld(page, {
      screens: { allow: capture(`${approval.stem}-allow-w120`), deny: capture(`${approval.stem}-deny-w120`), idle: capture("idle-w120") }, start: "allow",
      steps: [{ on: "allow", keys: approval.rows, to: "deny" }, { on: "deny", keys: ["Enter"], to: "idle" }],
    });
    await page.goto(PANE_URL);
    // When: Deny is tapped in the built UI.
    await page.getByRole("button", { name: "Deny", exact: true }).click();
    // Then: arrows, a read of the landed pointer, and its bound Enter occur in that order.
    await expect.poll(() => world.sent.length).toBe(2);
    expect(world.sent.map((write) => write.keys)).toEqual([approval.rows, ["Enter"]]);
    for (const write of world.sent) {
      expect(write.expected_prompt).toContain(approval.subject);
    }
    expect(world.sent[1]?.expected_prompt).not.toBe(world.sent[0]?.expected_prompt);
    const walk = world.events.indexOf(`keys:allow:${approval.rows.join("+")}`);
    const verification = world.events.indexOf("read:deny", walk + 1);
    const commit = world.events.indexOf("keys:deny:Enter");
    expect(walk).toBeGreaterThanOrEqual(0);
    expect(verification).toBeGreaterThan(walk);
    expect(commit).toBeGreaterThan(verification);
    await expect(page.getByRole("button", { name: "Deny", exact: true })).toHaveCount(0);
  });
}

for (const successor of [
  { name: "same-file successor diff", initial: "replace-allow-w120", after: "replace-denied-request-deny-w120", keys: ["Down"] },
  { name: "shell successor command", initial: "approval-allow-w120", after: "deny-request-deny-w120", keys: ["Down", "Down"] },
]) {
  test(`${successor.name} during a Deny walk emits no commit`, async ({ page }, testInfo) => {
    // Given: a real successor request replaces the original after its authorized arrow walk.
    const world = await paneWorld(page, {
      screens: { initial: capture(successor.initial), successor: capture(successor.after) }, start: "initial",
      steps: [{ on: "initial", keys: successor.keys, to: "successor" }],
    });
    await page.goto(PANE_URL);
    // When: the phone tries to deny the original request.
    await page.getByRole("button", { name: "Deny", exact: true }).click();
    // Then: the read-back fails identity and no Enter answers the successor.
    await expect(page.getByText(en["chat.status.menuChanged"], { exact: true })).toBeVisible();
    expect(world.sent.map((write) => write.keys)).toEqual([successor.keys]);
    expect(world.events).toContain("read:successor");
    await evidence(page, testInfo, "kiro-stale-walk-no-commit");
  });
}

test("a changed read range before Allow emits no key", async ({ page }) => {
  // Given: the visible card names a pending read, but the next terminal read has changed range.
  const initial = capture("read-allow-w120");
  const world = await paneWorld(page, { screens: { initial, changed: initial.replace("(L1-1)", "(L2-2)") }, start: "initial" });
  await page.goto(PANE_URL);
  const allow = page.getByRole("button", { name: "Allow", exact: true });
  await expect(allow).toBeVisible();
  world.show("changed");
  // When: the old card is tapped without waiting for the UI poll.
  await allow.click();
  // Then: its fresh request binding fails before even an arrow or Enter is emitted.
  await expect(page.getByText(en["chat.status.menuChanged"], { exact: true })).toBeVisible();
  expect(world.sent).toEqual([]);
  expect(world.writes).toEqual([]);
});

for (const unsafe of [
  { name: "generic MCP", capture: "mcp-allow-w120", terminalText: "collie_echo/echo" },
  { name: "wrapped MCP", capture: "mcp-wrapped-allow-w60", terminalText: "echo_harmless_printable_message_for_wrapped_approval_title" },
  { name: "clipped shell", capture: "approval-clipped-w40", terminalText: "collie_cancel_probe" },
  { name: "clipped file diff", capture: "write-viewport-allow-w120", terminalText: "viewport-deny.txt" },
]) {
  test(`${unsafe.name} stays terminal-only with no Allow or Deny action`, async ({ page }, testInfo) => {
    // Given: a real frame whose preview cannot prove the full pending operation.
    const world = await paneWorld(page, { screens: { unsafe: capture(unsafe.capture) }, start: "unsafe" });
    await page.goto(PANE_URL);
    // Then: no approval is offered from Chat; the original terminal remains available.
    await expect(page.getByText("The files are sample-a and sample-b.", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /^(Allow|Deny|Always allow|Always deny)$/ })).toHaveCount(0);
    await page.getByRole("button", { name: en["chat.paneMenu.aria"], exact: true }).click();
    await page.getByRole("button", { name: en["chat.mode.terminal"], exact: true }).click();
    await expect(page.getByText(unsafe.terminalText, { exact: false }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /^(Allow|Deny|Always allow|Always deny)$/ })).toHaveCount(0);
    await evidence(page, testInfo, "kiro-unsafe-terminal-only");
    expect(world.writes).toEqual([]);
  });
}
