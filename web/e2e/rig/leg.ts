// The browser leg's harness: the phone, the rig client, the tap recorder and the ledger.
//
// THE PHONE. A Playwright Chromium context with the Pixel 7 descriptor (touch, mobile user agent,
// 412x839), English forced and the pairing token and the spent first-run tour put in localStorage
// before the app boots, as live.ts does for Tier 2. Every context is fresh, so the phone holds no
// local history of any session: scenario 5 depends on that.
//
// SELECTORS ARE THE APP'S OWN STRINGS (src/lib/i18n/messages/en.ts) or the harness's own words on the
// card (a Claude menu action label). No CSS class, no new data-testid.
//
// A TAP AND ITS RECEIPT. Every POST the page makes to /api/ask, /api/send or /api/pane/*/keys|reply
// is recorded with the bridge's answer. A tap's receipts are the answers that came in between the
// tap and the end of its settle window. A tap WORKED when every answer accepted it.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test as base, type Browser, type BrowserContext, type Locator, type Page, type Response as PageResponse } from "@playwright/test";

import { en } from "../../src/lib/i18n/messages/en";
import { asJsonNumber, asJsonObject, asJsonString, parseJson, type JsonObject, type JsonValue } from "../../src/lib/json";
import { TOKEN_STORAGE_KEY } from "../../src/lib/pairing";
import { readSendReceipts, readSurface } from "../../src/lib/send-protocol";
import { askOf, isFree, type Surface } from "../../src/lib/surface/surface";
import { TOUR_STORAGE_KEY, TOUR_VERSION } from "../../src/lib/tour";
import { SETUPS, prepareHarness, type HarnessId } from "./harnesses";
import { P, STATE_ROOT, memGuard, newWorkspacePane, paneRun, readRun, readToken, sleep } from "./rig-lib";

export { expect };

/** The storage key `src/lib/i18n/index.ts` reads the locale from. */
const LOCALE_STORAGE_KEY = "collie:locale:v1";
/** The phone. The descriptor is the device a person holds: touch, mobile UA, its own viewport. */
export const PHONE_DEVICE = "Pixel 7";

/** The English string for a key, filled as `t()` fills it. */
export function message(key: keyof typeof en, vars: Record<string, string | number> = {}): string {
  let out: string = en[key];
  for (const [slot, value] of Object.entries(vars)) out = out.replaceAll(`{${slot}}`, String(value));
  return out;
}

// ── the run ──────────────────────────────────────────────────────────────────────────────────────

/** The run folder: STATE_ROOT/results/<run id>. The global setup names the run. */
export function runDir(): string {
  const id = process.env.COLLIE_RIG_RUN_ID ?? "adhoc";
  const dir = join(P.results, id);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export const SCENARIOS = [
  { id: "picker", title: "1 model picker" },
  { id: "permission", title: "2 permission card" },
  { id: "pick-many", title: "3 pick-many question" },
  { id: "stream-send", title: "4 send while streaming" },
  { id: "load-older", title: "5 load older, empty cache" },
] as const;
export type ScenarioId = (typeof SCENARIOS)[number]["id"];

export type Verdict = "pass" | "fail" | "n/a" | "not reached";

export interface LedgerRow {
  readonly harness: HarnessId;
  readonly scenario: ScenarioId;
  readonly verdict: Verdict;
  /** Taps the scenario's deciding action needed; null when no tap was made. */
  readonly taps: number | null;
  /** The taps the action needs when every tap works; the table prints `taps/minTaps`. */
  readonly minTaps?: number;
  readonly note: string;
  readonly taps_log?: readonly TapLog[];
  readonly captures?: readonly string[];
}

export function record(row: LedgerRow): void {
  appendFileSync(join(runDir(), "ledger.jsonl"), `${JSON.stringify(row)}\n`);
}

// ── model turns ──────────────────────────────────────────────────────────────────────────────────

/** Model turns one full run may spend on one harness. */
export const TURN_CAP = 15;

/**
 * Count one model turn (a prompt the agent answers with the model). Throws when the harness has no
 * working provider or the run's cap is reached; the scenario then reports "not reached". Every turn
 * is also appended to STATE_ROOT/turns.log, the running total across development.
 */
export function spendTurn(harness: HarnessId, what: string): void {
  const setup = SETUPS[harness];
  if (!setup.turns) throw new NotReached(setup.noTurnsReason);
  const file = join(runDir(), `turns-${harness}`);
  let used = 0;
  try {
    used = Number(readFileSync(file, "utf8")) || 0;
  } catch {
    /* first turn */
  }
  if (used >= TURN_CAP) throw new NotReached(`turn cap: ${String(used)} of ${String(TURN_CAP)} used`);
  writeFileSync(file, String(used + 1));
  appendFileSync(join(STATE_ROOT, "turns.log"), `${new Date().toISOString()} ${process.env.COLLIE_RIG_RUN_ID ?? "adhoc"} ${harness} ${what}\n`);
}

export function turnsUsed(harness: HarnessId): number {
  try {
    return Number(readFileSync(join(runDir(), `turns-${harness}`), "utf8")) || 0;
  } catch {
    return 0;
  }
}

/** A scenario that cannot run on this harness here and now (no provider, the cap, no start). */
export class NotReached extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "NotReached";
  }
}

// ── the rig, over HTTP ───────────────────────────────────────────────────────────────────────────

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}(?:\\[[0-9;?]*[ -/]*[@-~]|\\][^${String.fromCharCode(7)}]*(?:${String.fromCharCode(7)}|${ESC}\\\\)|[()][A-Za-z0-9]|[=>])`, "g");
export const stripAnsi = (text: string): string => text.replace(ANSI, "");

/** The objects of a JSON list, in order; anything that is not an object is left out. */
export function jsonRows(value: JsonValue | undefined): JsonObject[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const row = asJsonObject(entry);
    return row === undefined ? [] : [row];
  });
}

/**
 * Whether a cold chat read (no `after`) leaves older turns to load, worked out as the phone does
 * (`olderExists` in web/src/lib/chat-window.ts). The body's own `hasOlder` speaks of the WINDOW's
 * front, and a cold read sends only the newest page of that window, so a page that starts above the
 * window's `oldest` has older turns behind it even when `hasOlder` is false.
 */
export function coldPageHasOlder(body: JsonObject | undefined): boolean {
  if (body === undefined) return false;
  const seqs = jsonRows(body.upserts).flatMap((row) => {
    const seq = asJsonNumber(row.seq);
    return seq === undefined ? [] : [seq];
  });
  const front = asJsonNumber(body.oldest);
  if (seqs.length > 0 && front !== undefined && Math.min(...seqs) > front) return true;
  return body.hasOlder === true;
}

export interface RigPane {
  readonly paneId: string;
  readonly agent: string;
  readonly status: string;
  readonly surface: Surface | null;
}

export class Rig {
  readonly base: string;
  private readonly token: string;

  constructor() {
    const run = readRun();
    if (run?.ready !== true) throw new Error("the rig is not up: the global setup starts it (bun e2e/rig/rig.ts up)");
    this.base = `http://127.0.0.1:${run.port}`;
    this.token = readToken();
  }

  /** The device token the rig paired, for the phone's localStorage. */
  deviceToken(): string {
    return this.token;
  }

  async get(path: string): Promise<JsonValue> {
    const res = await fetch(`${this.base}${path}`, {
      headers: { authorization: `Bearer ${this.token}`, "x-requested-with": "XMLHttpRequest" },
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status !== 200) throw new Error(`GET ${path.split("?")[0] ?? path} answered ${String(res.status)}`);
    const json = parseJson(await res.text());
    if (json === undefined) throw new Error(`GET ${path.split("?")[0] ?? path} answered text that is not JSON`);
    return json;
  }

  async post(path: string, body: JsonObject): Promise<{ status: number; json: JsonValue }> {
    const res = await fetch(`${this.base}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "x-requested-with": "XMLHttpRequest", "content-type": "application/json", origin: this.base },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    return { status: res.status, json: parseJson(await res.text().catch(() => "")) ?? null };
  }

  async pane(paneId: string): Promise<RigPane | null> {
    const snap = asJsonObject(await this.get("/api/snapshot"));
    for (const row of [...jsonRows(snap?.agents), ...jsonRows(snap?.shellPanes)]) {
      if (row.paneId !== paneId) continue;
      return { paneId, agent: String(row.agent ?? "shell"), status: String(row.status ?? "unknown"), surface: readSurface(row.surface) };
    }
    return null;
  }

  /** The pane's text as the bridge reads it, ANSI stripped. */
  async screen(paneId: string, lines = 80): Promise<string> {
    return stripAnsi(await this.rawScreen(paneId, lines));
  }

  async rawScreen(paneId: string, lines = 80): Promise<string> {
    const doc = asJsonObject(await this.get(`/api/pane/${encodeURIComponent(paneId)}?lines=${String(lines)}`));
    return asJsonString(doc?.text) ?? "";
  }

  /** Wait until `ok` holds; returns the last value, or null on timeout. */
  async until<T>(read: () => Promise<T>, ok: (value: T) => boolean, ms: number, pollMs = 400): Promise<T | null> {
    const end = Date.now() + ms;
    for (;;) {
      const value = await read().catch(() => null);
      if (value !== null && ok(value)) return value;
      if (Date.now() > end) return null;
      await sleep(pollMs);
    }
  }

  async screenUntil(paneId: string, pattern: RegExp, ms: number, lines = 80): Promise<string | null> {
    return this.until(() => this.screen(paneId, lines), (text) => pattern.test(text), ms);
  }

  /** The bottom `rows` rows of the screen: a dialog or the input box, never the scrollback. */
  async tail(paneId: string, rows = 30): Promise<string> {
    return (await this.screen(paneId, 80)).split("\n").slice(-rows).join("\n");
  }

  /** Keys outside the phone, for clean-up only (Escape out of a stuck dialog). Never a scenario's tap. */
  async keys(paneId: string, keys: readonly string[]): Promise<void> {
    await this.post(`/api/pane/${encodeURIComponent(paneId)}/keys`, { keys: [...keys] });
  }
}

export const freeSurface = (pane: RigPane | null): boolean => pane !== null && pane.surface !== null && isFree(pane.surface);
export const askOn = (pane: RigPane | null) => (pane?.surface === null || pane?.surface === undefined ? null : askOf(pane.surface.modal));

/**
 * Start a harness in a fresh pane of the rig's Herdr, and wait until the bridge names it and reads
 * its box free. Throws NotReached when it never comes up.
 */
export async function startHarness(rig: Rig, id: HarnessId): Promise<string> {
  memGuard(`harness ${id}`);
  const { line } = prepareHarness(id);
  const paneId = newWorkspacePane(join(P.harness, id, "project"), `leg-${id}`);
  await sleep(800); // the shell's prompt first
  paneRun(paneId, line);
  const up = await rig.until(() => rig.pane(paneId), (pane) => pane !== null && pane.agent === SETUPS[id].agent && (freeSurface(pane) || (pane.surface === null && pane.status === "idle")), 90_000, 700);
  if (up === null) {
    const last = await rig.pane(paneId).catch(() => null);
    throw new NotReached(`${id} did not come up idle in 90 s (agent ${last?.agent ?? "?"}, status ${last?.status ?? "?"})`);
  }
  return paneId;
}

// ── the phone ────────────────────────────────────────────────────────────────────────────────────

/** A Playwright device descriptor (`devices["Pixel 7"]`), as `browser.newContext` takes it. */
export type Device = Parameters<Browser["newContext"]>[0];

export async function phoneContext(browser: Browser, rig: Rig, device: Device): Promise<BrowserContext> {
  memGuard("a browser context");
  const context = await browser.newContext({ ...device, baseURL: rig.base });
  await context.addInitScript(
    ([localeKey, tokenKey, token, tourKey, tour]) => {
      window.localStorage.setItem(localeKey, "en");
      window.localStorage.setItem(tokenKey, token);
      window.localStorage.setItem(tourKey, tour);
    },
    [LOCALE_STORAGE_KEY, TOKEN_STORAGE_KEY, rig.deviceToken(), TOUR_STORAGE_KEY, String(TOUR_VERSION)],
  );
  return context;
}

export async function openPane(page: Page, paneId: string): Promise<void> {
  await page.goto(`/pane/${encodeURIComponent(paneId)}`);
  await expect(page.getByRole("button", { name: message("composer.send.sendAria"), exact: true })).toBeVisible({ timeout: 20_000 });
}

/** One answer of the bridge to a POST the page made. */
export interface Answer {
  readonly at: number;
  readonly path: string;
  readonly status: number;
  readonly outcome: string | null;
  readonly reason: string | null;
  readonly detail: string | null;
  readonly requestId: string | null;
  /** The bridge's receipt as it came (an ask or send receipt carries hashes and keys, never a secret). */
  readonly receipt: string;
}

export interface TapLog {
  readonly label: string;
  readonly at: string;
  readonly answers: readonly Answer[];
  readonly worked: boolean;
  /** ms since the screen last changed before this tap; null when not measured. */
  readonly screenStillMs: number | null;
}

const WATCHED = /\/api\/(ask\/|send$|pane\/[^/]+\/(keys|reply)$)/;

/** Records the bridge's answer to every write the page makes, and the ask ids its snapshots carried. */
export class TapRecorder {
  readonly answers: Answer[] = [];
  /** Every ask id the page's own snapshot reads carried for the watched pane, when it first arrived. */
  readonly askSeen: { at: number; askId: string | null }[] = [];
  private watchPane: string | null = null;

  /** Note when the phone's snapshot reads start carrying a new ask id for this pane. */
  watchAsks(paneId: string): void {
    this.watchPane = paneId;
  }

  /** The ask id the phone held at `at`, and when it got it. */
  askAt(at: number): { at: number; askId: string | null } | null {
    return this.askSeen.findLast((row) => row.at <= at) ?? null;
  }

  constructor(page: Page) {
    page.on("response", (response) => {
      const request = response.request();
      if (request.method() === "GET" && this.watchPane !== null && new URL(response.url()).pathname === "/api/snapshot" && response.status() === 200) {
        void this.noteSnapshot(response, Date.now(), this.watchPane).catch(() => undefined);
        return;
      }
      if (request.method() !== "POST") return;
      const path = new URL(response.url()).pathname;
      if (!WATCHED.test(path)) return;
      const at = Date.now();
      const body = asJsonObject(parseJson(request.postData() ?? "{}"));
      // A `prepare` send is a read: the bridge reads the screen and types nothing. The phone makes one
      // before a menu commit whose card is newer than its ask (lib/dialog-ask.ts), so it is not a tap.
      if (path === "/api/send" && asJsonString(body?.mode) === "prepare") return;
      const requestId = asJsonString(body?.id) ?? null;
      void this.noteAnswer(response, at, path, requestId);
    });
  }

  /** The ask id the snapshot carries for `pane`, noted when it differs from the last one seen. */
  private async noteSnapshot(response: PageResponse, at: number, pane: string): Promise<void> {
    const doc = asJsonObject(parseJson(await response.text()));
    if (doc === undefined) return;
    const row = jsonRows(doc.agents).find((agent) => agent.paneId === pane);
    const ask = asJsonObject(asJsonObject(asJsonObject(row?.surface)?.modal)?.ask);
    const askId = ask?.id === undefined ? null : String(ask.id);
    if (this.askSeen.at(-1)?.askId !== askId) this.askSeen.push({ at, askId });
  }

  /** The bridge's answer to one watched POST, read field by field and recorded. */
  private async noteAnswer(response: PageResponse, at: number, path: string, requestId: string | null): Promise<void> {
    const text = await response.text().catch(() => "");
    const doc = asJsonObject(parseJson(text)) ?? {};
    const receipt = asJsonObject(doc.receipt) ?? doc;
    const outcome = asJsonString(receipt.outcome) ?? (doc.ok === true ? "ok" : null);
    this.answers.push({
      at,
      path,
      status: response.status(),
      outcome: outcome ?? null,
      reason: asJsonString(receipt.reason) ?? asJsonString(doc.error) ?? null,
      detail: (asJsonString(doc.detail) ?? asJsonString(receipt.detail) ?? (response.status() === 200 ? null : text.slice(0, 200))) || null,
      requestId,
      receipt: text.slice(0, 2000),
    });
  }

  since(at: number): Answer[] {
    return this.answers.filter((answer) => answer.at >= at);
  }
}

/** True when the bridge took the write: an ask or send that went in, a key press it pressed. */
export function accepted(answer: Answer): boolean {
  if (answer.status !== 200) return false;
  if (answer.path.startsWith("/api/send")) return answer.outcome === "sent" || answer.outcome === "effective" || answer.outcome === "held";
  if (answer.path.startsWith("/api/ask/")) return answer.outcome === "sent" || answer.outcome === "effective";
  return answer.outcome === "ok";
}

export function answerWords(answer: Answer): string {
  const where = answer.path.startsWith("/api/ask/") ? "ask" : answer.path.startsWith("/api/send") ? "send" : answer.path.endsWith("/keys") ? "keys" : "reply";
  return `${where} ${String(answer.status)} ${answer.outcome ?? "-"}${answer.reason === null ? "" : ` (${answer.reason})`}`;
}

/**
 * Tap once and collect the bridge's answers: wait up to `answerMs` for the first answer, then until
 * no new answer came for `quietMs`. A tap that sends nothing (a local toggle) returns no answers.
 */
export async function tap(recorder: TapRecorder, target: Locator, label: string, opts: { answerMs?: number; quietMs?: number; expectAnswer?: boolean; screenStillMs?: number | null } = {}): Promise<TapLog> {
  const t0 = Date.now();
  await target.tap();
  const answerMs = opts.answerMs ?? (opts.expectAnswer === false ? 800 : 10_000);
  const quietMs = opts.quietMs ?? 900;
  const end = t0 + answerMs;
  while (recorder.since(t0).length === 0 && Date.now() < end) await sleep(100);
  let count = recorder.since(t0).length;
  let quietSince = Date.now();
  while (Date.now() - quietSince < quietMs) {
    await sleep(100);
    const now = recorder.since(t0).length;
    if (now !== count) {
      count = now;
      quietSince = Date.now();
    }
  }
  const answers = recorder.since(t0);
  return { label, at: new Date(t0).toISOString(), answers, worked: answers.every(accepted) && (opts.expectAnswer === false || answers.length > 0), screenStillMs: opts.screenStillMs ?? null };
}

export function tapWords(log: TapLog): string {
  return `${log.label}: ${log.answers.length === 0 ? "no request" : log.answers.map(answerWords).join(", ")}`;
}

/** Save a phone screenshot into the run folder; returns its path. */
export async function capture(page: Page, name: string): Promise<string> {
  const path = join(runDir(), `${name}.png`);
  await page.screenshot({ path, fullPage: false });
  return path;
}

/** Save the pane's text (with colours) into the run folder; returns its path. */
export async function captureScreen(rig: Rig, paneId: string, name: string): Promise<string> {
  const path = join(runDir(), `${name}.ansi`);
  writeFileSync(path, await rig.rawScreen(paneId, 200).catch((err) => `(no read: ${String(err)})`));
  return path;
}

/** Tracks when the pane's screen last changed, so a refusal can be judged against a still screen. */
export class ScreenWatch {
  private last = "";
  private changedAt = Date.now();
  private timer: ReturnType<typeof setInterval> | null = null;

  private readonly rig: Rig;
  private readonly paneId: string;

  constructor(rig: Rig, paneId: string) {
    this.rig = rig;
    this.paneId = paneId;
  }

  start(): this {
    this.timer = setInterval(() => {
      void this.poll().catch(() => undefined);
    }, 250);
    return this;
  }

  private async poll(): Promise<void> {
    const text = await this.rig.tail(this.paneId, 40);
    if (text !== this.last) {
      this.last = text;
      this.changedAt = Date.now();
    }
  }

  stillMs(): number {
    return Date.now() - this.changedAt;
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
  }
}

// ── one scenario ─────────────────────────────────────────────────────────────────────────────────

export interface ScenarioResult {
  readonly verdict: Verdict;
  readonly taps: number | null;
  readonly minTaps?: number;
  readonly note: string;
  readonly taps_log?: readonly TapLog[];
  readonly captures?: readonly string[];
}

/** The harness's session for a spec file: the pane, or why there is none. */
export interface Session {
  paneId: string | null;
  startNote: string;
}

/**
 * Start the harness once per spec file. `COLLIE_RIG_PANE_<HARNESS>` names a pane that already runs
 * it (a rerun during development against a rig kept up with COLLIE_RIG_KEEP=1).
 */
export async function openSession(id: HarnessId): Promise<Session> {
  const reuse = process.env[`COLLIE_RIG_PANE_${id.toUpperCase()}`];
  if (reuse !== undefined && reuse !== "") return { paneId: reuse, startNote: "" };
  // Playwright restarts its worker after a failed case and runs beforeAll again. The run's session
  // file keeps that from starting a second agent: the pane that runs it is taken again.
  const file = join(runDir(), `session-${id}.json`);
  const rig = new Rig();
  try {
    const kept: Session = JSON.parse(readFileSync(file, "utf8"));
    if (kept.paneId === null) return kept;
    const pane = await rig.pane(kept.paneId);
    if (pane !== null && pane.agent === SETUPS[id].agent) return kept;
  } catch {
    /* no session yet */
  }
  let session: Session;
  try {
    session = { paneId: await startHarness(rig, id), startNote: "" };
  } catch (err) {
    session = { paneId: null, startNote: err instanceof Error ? err.message : String(err) };
  }
  writeFileSync(file, JSON.stringify(session));
  return session;
}

/**
 * Run one scenario and write its ledger row whatever happens: the body's verdict, "not reached" for a
 * NotReached (or no session), "fail" when the body throws. A "fail" verdict fails the Playwright case.
 */
/** What a scenario has done so far: kept when it throws, so the ledger still shows every tap. */
export interface Trail {
  readonly log: TapLog[];
  readonly notes: string[];
  readonly captures: string[];
}

export async function runScenario(harness: HarnessId, id: ScenarioId, session: Session, body: (paneId: string, trail: Trail) => Promise<ScenarioResult>): Promise<void> {
  if (session.paneId === null) {
    record({ harness, scenario: id, verdict: "not reached", taps: null, note: `no session: ${session.startNote}` });
    test.skip(true, session.startNote);
    return;
  }
  const trail: Trail = { log: [], notes: [], captures: [] };
  let row: ScenarioResult;
  try {
    const reset = await resetBox(new Rig(), session.paneId);
    if (reset !== null) trail.notes.push(reset);
    row = await body(session.paneId, trail);
  } catch (err) {
    const kept = [...trail.notes, ...trail.log.map(tapWords)].join("; ");
    if (err instanceof NotReached) {
      record({ harness, scenario: id, verdict: "not reached", taps: null, note: [err.message, kept].filter((x) => x !== "").join("; "), taps_log: trail.log, captures: trail.captures });
      test.skip(true, err.message);
      return;
    }
    const why = err instanceof Error ? (err.message.split("\n")[0] ?? "") : String(err);
    record({ harness, scenario: id, verdict: "fail", taps: null, note: [`the case stopped: ${why}`, kept].filter((x) => x !== "").join("; "), taps_log: trail.log, captures: trail.captures });
    throw err;
  }
  record({ harness, scenario: id, ...row });
  expect(row.verdict, row.note).not.toBe("fail");
}

/** A phone on the pane: a fresh context, the recorder on it, the pane open. Close it when done. */
export async function phoneOn(browser: Browser, rig: Rig, paneId: string, device: Device): Promise<{ context: BrowserContext; page: Page; recorder: TapRecorder }> {
  const context = await phoneContext(browser, rig, device);
  const page = await context.newPage();
  const recorder = new TapRecorder(page);
  await openPane(page, paneId);
  return { context, page, recorder };
}

/** Type into the composer and tap Send, as a person does. */
export async function sendFromComposer(page: Page, recorder: TapRecorder, text: string, label: string): Promise<TapLog> {
  const box = page.getByRole("textbox").last();
  await box.fill(text);
  return tap(recorder, page.getByRole("button", { name: message("composer.send.sendAria"), exact: true }), label);
}

/**
 * Leave the input box empty before a scenario: close an open menu or dialog with Escape and clear a
 * draft with ctrl+u. Clean-up outside the phone, so it is noted and never counted as a tap.
 */
export async function resetBox(rig: Rig, paneId: string): Promise<string | null> {
  const pane = await rig.pane(paneId).catch(() => null);
  if (pane === null || freeSurface(pane)) return null;
  const surface = pane.surface;
  if (surface !== null && surface.turn === "running") return null;
  const steps: string[] = [];
  if (surface !== null && surface.modal !== "none") {
    await rig.keys(paneId, ["Escape"]);
    steps.push("Escape");
    await sleep(600);
  }
  const after = await rig.pane(paneId).catch(() => null);
  if (after?.surface?.composer === "draft") {
    await rig.keys(paneId, ["ctrl+u"]);
    steps.push("ctrl+u");
  }
  await rig.until(() => rig.pane(paneId), freeSurface, 5000);
  return steps.length === 0 ? null : `box reset outside the phone (${steps.join(", ")})`;
}

/** Wait until the agent's turn is over and its box reads free. */
export async function waitIdle(rig: Rig, paneId: string, ms: number): Promise<boolean> {
  return (await rig.until(() => rig.pane(paneId), (pane) => freeSurface(pane) || (pane?.surface === null && pane.status !== "working"), ms, 700)) !== null;
}

/** The receipt row of one send request, once it settled. */
export async function settledReceipt(rig: Rig, paneId: string, requestId: string, ms: number): Promise<{ outcome: string; reason?: string; detail?: string } | null> {
  return rig.until(
    async () => {
      const doc = readSendReceipts(await rig.get(`/api/send/receipts?pane=${encodeURIComponent(paneId)}`));
      return doc.receipts.find((row) => row.requestId === requestId) ?? null;
    },
    (row) => row !== null && row.outcome !== "held",
    ms,
    1000,
  );
}

// ── the fixture ──────────────────────────────────────────────────────────────────────────────────

export const test = base.extend<{ rig: Rig }>({
  rig: async ({ browserName }, use) => {
    void browserName; // Playwright needs a destructured first argument; the rig needs no other fixture.
    await use(new Rig());
  },
});
