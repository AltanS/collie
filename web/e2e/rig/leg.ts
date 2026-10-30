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
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test as base, type Browser, type BrowserContext, type Locator, type Page, type Response as PageResponse } from "@playwright/test";

import { en } from "../../src/lib/i18n/messages/en";
import { asJsonNumber, asJsonObject, asJsonString, parseJson, type JsonObject, type JsonValue } from "../../src/lib/json";
import { TOKEN_STORAGE_KEY } from "../../src/lib/pairing";
import { readSendReceipts, readSurface } from "../../src/lib/send-protocol";
import { askOf, isFree, type Surface } from "../../src/lib/surface/surface";
import { TOUR_STORAGE_KEY, TOUR_VERSION } from "../../src/lib/tour";
import { BIN } from "./bins";
import { SETUPS, harnessDirs, prepareHarness, type HarnessId } from "./harnesses";
import type { ScenarioId } from "./scenarios";
import { MEMBER_ID, P, STATE_ROOT, memGuard, readRun, readToken, sleep, startInPane, type Machine } from "./rig-lib";
import { STUB_HARNESSES, tiersFromEnv } from "./replay/tier";

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

export { SCENARIOS, legOf, scenarioApplies, type Leg, type ScenarioId } from "./scenarios";

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
export const TURN_CAP = 25;

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

/** A pane's host on the crew rig: `undefined` for the lead's own panes, the member's id for the member's. */
export type Host = string | undefined;

/** The `?host=` the lead forwards a member's pane read or write by; nothing for the lead's own pane. */
const hostQuery = (host: Host, sep: "?" | "&"): string => (host === undefined ? "" : `${sep}host=${encodeURIComponent(host)}`);

/** The host a machine's panes carry in the lead's API. */
export const hostOf = (machine: Machine): Host => (machine === "member" ? MEMBER_ID : undefined);

export class Rig {
  readonly base: string;
  private readonly token: string;
  /** The lead's member id on a crew rig; undefined on the solo rig. */
  readonly leadId: string | undefined;

  constructor() {
    const run = readRun();
    if (run?.ready !== true) throw new Error("the rig is not up: the global setup starts it (bun e2e/rig/rig.ts up)");
    this.base = `http://127.0.0.1:${run.port}`;
    this.token = readToken();
    this.leadId = run.leadId;
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

  /** One pane of the merged snapshot. On a crew rig the lead's panes may carry its own id or none, a member's carry the member's. */
  async pane(paneId: string, host?: Host): Promise<RigPane | null> {
    const snap = asJsonObject(await this.get("/api/snapshot"));
    for (const row of [...jsonRows(snap?.agents), ...jsonRows(snap?.shellPanes)]) {
      if (row.paneId !== paneId) continue;
      const rowHost = asJsonString(row.host);
      if (host === undefined ? rowHost !== undefined && rowHost !== this.leadId : rowHost !== host) continue;
      return { paneId, agent: String(row.agent ?? "shell"), status: String(row.status ?? "unknown"), surface: readSurface(row.surface) };
    }
    return null;
  }

  /** The pane's text as the bridge reads it, ANSI stripped. A member's pane is read through the lead. */
  async screen(paneId: string, lines = 80, host?: Host): Promise<string> {
    return stripAnsi(await this.rawScreen(paneId, lines, host));
  }

  async rawScreen(paneId: string, lines = 80, host?: Host): Promise<string> {
    const doc = asJsonObject(await this.get(`/api/pane/${encodeURIComponent(paneId)}?lines=${String(lines)}${hostQuery(host, "&")}`));
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

  async screenUntil(paneId: string, pattern: RegExp, ms: number, lines = 80, host?: Host): Promise<string | null> {
    return this.until(() => this.screen(paneId, lines, host), (text) => pattern.test(text), ms);
  }

  /** The bottom `rows` rows of the screen: a dialog or the input box, never the scrollback. */
  async tail(paneId: string, rows = 30, host?: Host): Promise<string> {
    return (await this.screen(paneId, 80, host)).split("\n").slice(-rows).join("\n");
  }

  /** Keys outside the phone, for clean-up only (Escape out of a stuck dialog). Never a scenario's tap. */
  async keys(paneId: string, keys: readonly string[], host?: Host): Promise<void> {
    await this.post(`/api/pane/${encodeURIComponent(paneId)}/keys${hostQuery(host, "?")}`, { keys: [...keys] });
  }
}

export const freeSurface = (pane: RigPane | null): boolean => pane !== null && pane.surface !== null && isFree(pane.surface);
export const askOn = (pane: RigPane | null) => (pane?.surface === null || pane?.surface === undefined ? null : askOf(pane.surface.modal));

/**
 * Start a harness in a fresh pane of a machine's Herdr, and wait until the lead's bridge names it and
 * reads its box free (a member's pane through the lead's merged snapshot). Throws NotReached when it
 * never comes up.
 */
export async function startHarness(rig: Rig, id: HarnessId, machine: Machine = "lead"): Promise<{ paneId: string; notes: readonly string[] }> {
  memGuard(`harness ${id}`);
  // A binary that is not there would only show as the 90 s timeout below: say what is missing instead.
  if (!existsSync(BIN[id])) throw new NotReached(`${id} binary not found at ${BIN[id]}; set COLLIE_RIG_${id.toUpperCase()}_BIN`);
  const { line, notes } = prepareHarness(id, machine);
  const host = hostOf(machine);
  const paneId = await startInPane(harnessDirs(id, machine).project, `leg-${id}`, line, machine);
  const up = await rig.until(() => rig.pane(paneId, host), (pane) => pane !== null && pane.agent === SETUPS[id].agent && (freeSurface(pane) || (pane.surface === null && pane.status === "idle")), 90_000, 700);
  if (up === null) {
    const last = await rig.pane(paneId, host).catch(() => null);
    throw new NotReached(`${id} did not come up idle on the ${machine} in 90 s (agent ${last?.agent ?? "?"}, status ${last?.status ?? "?"})`);
  }
  return { paneId, notes };
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

/** Open a pane on the phone. A member's pane opens through the lead with the `?h=` host address, as the app links it. */
export async function openPane(page: Page, paneId: string, host?: Host): Promise<void> {
  await page.goto(`/pane/${encodeURIComponent(paneId)}${host === undefined ? "" : `?h=${encodeURIComponent(host)}`}`);
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

// `update/line` is the Release line control's one write (crew case 15): its receipt says `ok`.
const WATCHED = /\/api\/(ask\/|send$|walky$|update\/line$|pane\/[^/]+\/(keys|reply|abort|clear)$)/;

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
      const requestId = asJsonString(body?.id) ?? asJsonString(body?.requestId) ?? null;
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
    // A walky talky fan-out (`to: all`) answers one receipt per target. The bridge took the message
    // when it took it for at least one target: the answer then stands for the first target it took,
    // and the reason names every target it did not (an unreachable machine's `<member>/all`, say).
    // When it took none, the answer stands for the first receipt, refusal and reason.
    const fanOut = jsonRows(doc.receipts);
    const taken = fanOut.filter((row) => WALKY_TAKEN.has(asJsonString(row.state) ?? ""));
    const left = fanOut.filter((row) => !WALKY_TAKEN.has(asJsonString(row.state) ?? ""));
    const receipt = asJsonObject(doc.receipt) ?? taken[0] ?? fanOut[0] ?? doc;
    const leftOut = taken.length === 0 || left.length === 0 ? null : `${String(left.length)} of ${String(fanOut.length)} not taken: ${left.map((row) => `${asJsonString(row.target) ?? "?"} ${asJsonString(row.state) ?? "?"} (${asJsonString(row.reason) ?? "no reason"})`).join(", ")}`;
    // A send or ask receipt says `outcome`; a walky talky receipt says `state`.
    const outcome = asJsonString(receipt.outcome) ?? asJsonString(receipt.state) ?? (doc.ok === true ? "ok" : null);
    this.answers.push({
      at,
      path,
      status: response.status(),
      outcome: outcome ?? null,
      reason: leftOut ?? asJsonString(receipt.reason) ?? asJsonString(doc.error) ?? null,
      detail: (asJsonString(doc.detail) ?? asJsonString(receipt.detail) ?? (response.status() === 200 ? null : text.slice(0, 200))) || null,
      requestId,
      receipt: text.slice(0, 2000),
    });
  }

  since(at: number): Answer[] {
    return this.answers.filter((answer) => answer.at >= at);
  }
}

/** The walky talky states of a message the bridge took (lib/walky.ts wasTaken). */
const WALKY_TAKEN: ReadonlySet<string> = new Set(["accepted", "delivered", "inbox-only"]);

/** True when the bridge took the write: an ask or send that went in, a key press it pressed. */
export function accepted(answer: Answer): boolean {
  if (answer.status !== 200) return false;
  if (answer.path.startsWith("/api/send")) return answer.outcome === "sent" || answer.outcome === "effective" || answer.outcome === "held" || answer.outcome === "steered";
  if (answer.path.startsWith("/api/ask/")) return answer.outcome === "sent" || answer.outcome === "effective";
  // A walky talky message the bridge took: logged, typed, or kept in the inbox (lib/walky.ts wasTaken).
  if (answer.path === "/api/walky") return answer.outcome !== null && WALKY_TAKEN.has(answer.outcome);
  // A Stop (ADR 0116) is taken when its receipt says `stopped`: `pressed` and every refusal are not a stop.
  if (answer.path.endsWith("/abort")) return answer.outcome === "stopped";
  // A Clear (ADR 0116) is taken when its receipt says `cleared`: every refusal leaves the box as it was.
  if (answer.path.endsWith("/clear")) return answer.outcome === "cleared";
  return answer.outcome === "ok";
}

export function answerWords(answer: Answer): string {
  const where = answer.path.startsWith("/api/ask/") ? "ask" : answer.path.startsWith("/api/send") ? "send" : answer.path === "/api/walky" ? "walky" : answer.path.endsWith("/keys") ? "keys" : answer.path.endsWith("/abort") ? "stop" : answer.path.endsWith("/clear") ? "clear" : "reply";
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

/**
 * Press and hold, as a thumb does: one touch down, `ms` still, one touch up, through the browser's own
 * touch input (CDP), so the app sees the pointer events a phone sends. Playwright's `tap()` lifts at
 * once and cannot hold. Returns a tap row with no answers: a hold opens something, it sends nothing.
 */
export async function hold(page: Page, target: Locator, label: string, ms = 800): Promise<TapLog> {
  const box = await target.boundingBox();
  if (box === null) throw new Error(`${label}: the target has no box to press`);
  const t0 = Date.now();
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
    await sleep(ms);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } finally {
    await cdp.detach().catch(() => undefined);
  }
  return { label, at: new Date(t0).toISOString(), answers: [], worked: true, screenStillMs: null };
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
export async function captureScreen(rig: Rig, paneId: string, name: string, host?: Host): Promise<string> {
  const path = join(runDir(), `${name}.ansi`);
  writeFileSync(path, await rig.rawScreen(paneId, 200, host).catch((err) => `(no read: ${String(err)})`));
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

/** The harness's session for a spec file: the pane, or why there is none, and on a crew rig its host. */
export interface Session {
  paneId: string | null;
  startNote: string;
  /** The member's id for a session on the crew rig's member; absent on the lead. */
  host?: string;
}

/** A session with its host set when it has one (a member's). */
function withHost(session: Session, host: Host): Session {
  if (host !== undefined) session.host = host;
  return session;
}

/**
 * Start the harness once per spec file, on the lead or (crew rig) on the member.
 * `COLLIE_RIG_PANE_<HARNESS>` (or `COLLIE_RIG_PANE_<HARNESS>_MEMBER`) names a pane that already runs
 * it (a rerun during development against a rig kept up with COLLIE_RIG_KEEP=1).
 */
export async function openSession(id: HarnessId, machine: Machine = "lead"): Promise<Session> {
  const host = hostOf(machine);
  const suffix = machine === "member" ? "_MEMBER" : "";
  const reuse = process.env[`COLLIE_RIG_PANE_${id.toUpperCase()}${suffix}`];
  if (reuse !== undefined && reuse !== "") return withHost({ paneId: reuse, startNote: "" }, host);
  // Playwright restarts its worker after a failed case and runs beforeAll again. The run's session
  // file keeps that from starting a second agent: the pane that runs it is taken again.
  const file = join(runDir(), `session-${id}${machine === "member" ? "-member" : ""}.json`);
  const rig = new Rig();
  try {
    const kept: Session = JSON.parse(readFileSync(file, "utf8"));
    if (kept.paneId === null) return kept;
    const pane = await rig.pane(kept.paneId, host);
    if (pane !== null && pane.agent === SETUPS[id].agent) return kept;
  } catch {
    /* no session yet */
  }
  let session: Session;
  try {
    const started = await startHarness(rig, id, machine);
    session = withHost({ paneId: started.paneId, startNote: started.notes.join("; ") }, host);
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

/**
 * Tell the rig's model stub which case runs now (M67, replay/stub.ts): pi's and omp's model calls are
 * filed under it, whichever harness the case belongs to (case 10's broadcast reaches pi and omp too).
 * Returns the stub's port, or null on a rig without one.
 */
async function stubCase(caseId: string | null): Promise<number | null> {
  const port = readRun()?.stub?.port;
  if (port === undefined) return null;
  await fetch(`http://127.0.0.1:${String(port)}/_rig/case`, { method: "POST", body: JSON.stringify({ case: caseId }) }).catch(() => undefined);
  return port;
}

/** Tell the stub how a case ended, so a recording made in a case that did not pass is marked (meta.json `failed`). */
async function stubVerdict(port: number | null, caseId: string, verdict: string): Promise<void> {
  if (port === null) return;
  await fetch(`http://127.0.0.1:${String(port)}/_rig/verdict`, { method: "POST", body: JSON.stringify({ case: caseId, verdict }) }).catch(() => undefined);
}

/**
 * The note for a case that did not pass on a replayed recording that was itself made in a case that
 * did not pass: the replay played that run back, so the fix is to record the case again, alone.
 */
function staleRecordingNotes(caseId: string, title: string): string[] {
  const tiers = tiersFromEnv();
  if (tiers === null) return [];
  return STUB_HARNESSES.flatMap((h) => {
    const plan = tiers[h];
    if (plan === undefined || plan.tier !== "replay" || !(plan.failed ?? []).includes(caseId)) return [];
    return [`${h}: this case replays a recording made in a live run where it did not pass; record it again: COLLIE_RIG_LIVE=${h} COLLIE_RIG_RECORD=1 COLLIE_RIG_KEY_FILE=... bunx playwright test -c e2e/rig/playwright.config.ts -g ${JSON.stringify(title)}`];
  });
}

/** The stub's cassette mismatches in one case, as one note each. */
async function stubMismatches(port: number | null, caseId: string): Promise<string[]> {
  if (port === null) return [];
  const stats = await fetch(`http://127.0.0.1:${String(port)}/_rig/stats`)
    .then(async (r) => asJsonObject(parseJson(await r.text())))
    .catch(() => undefined);
  return jsonRows(stats?.mismatches).flatMap((m) => (m.case === caseId ? [`${String(m.harness)}: ${String(m.message)}`] : []));
}

export async function runScenario(harness: HarnessId, id: ScenarioId, session: Session, body: (paneId: string, trail: Trail) => Promise<ScenarioResult>): Promise<void> {
  const caseId = `${harness}.${id}`;
  const stubPort = await stubCase(caseId);
  // Every end of the case writes its row and tells the stub the verdict (M67).
  const settle = async (r: Parameters<typeof record>[0]): Promise<void> => {
    const stale = r.verdict === "pass" ? [] : staleRecordingNotes(caseId, test.info().title);
    record(stale.length === 0 ? r : { ...r, note: [...stale, r.note].join("; ") });
    await stubVerdict(stubPort, caseId, r.verdict);
  };
  if (session.paneId === null) {
    await settle({ harness, scenario: id, verdict: "not reached", taps: null, note: `no session: ${session.startNote}` });
    test.skip(true, session.startNote);
    return;
  }
  const trail: Trail = { log: [], notes: [], captures: [] };
  let row: ScenarioResult;
  try {
    // A gap the start went ahead without (pi's example extensions) shows in the row of a case that stops.
    if (session.startNote !== "") trail.notes.push(session.startNote);
    const reset = await resetBox(new Rig(), session.paneId, session.host);
    if (reset !== null) trail.notes.push(reset);
    row = await body(session.paneId, trail);
  } catch (err) {
    // A cassette mismatch is the cause whatever the case saw after it: say so first, and fail.
    const mismatch = await stubMismatches(stubPort, caseId);
    if (mismatch.length > 0) {
      await settle({ harness, scenario: id, verdict: "fail", taps: null, note: [...mismatch, ...trail.notes].join("; "), taps_log: trail.log, captures: trail.captures });
      throw new Error(mismatch.join("; "), { cause: err });
    }
    const kept = [...trail.notes, ...trail.log.map(tapWords)].join("; ");
    if (err instanceof NotReached) {
      await settle({ harness, scenario: id, verdict: "not reached", taps: null, note: [err.message, kept].filter((x) => x !== "").join("; "), taps_log: trail.log, captures: trail.captures });
      test.skip(true, err.message);
      return;
    }
    const why = err instanceof Error ? (err.message.split("\n")[0] ?? "") : String(err);
    await settle({ harness, scenario: id, verdict: "fail", taps: null, note: [`the case stopped: ${why}`, kept].filter((x) => x !== "").join("; "), taps_log: trail.log, captures: trail.captures });
    throw err;
  }
  const mismatch = await stubMismatches(stubPort, caseId);
  if (mismatch.length > 0) row = { ...row, verdict: "fail", note: [...mismatch, row.note].join("; ") };
  await settle({ harness, scenario: id, ...row });
  expect(row.verdict, row.note).not.toBe("fail");
}

/** A phone on the pane: a fresh context, the recorder on it, the pane open. Close it when done. */
export async function phoneOn(browser: Browser, rig: Rig, paneId: string, device: Device, host?: Host): Promise<{ context: BrowserContext; page: Page; recorder: TapRecorder }> {
  const context = await phoneContext(browser, rig, device);
  const page = await context.newPage();
  const recorder = new TapRecorder(page);
  await openPane(page, paneId, host);
  return { context, page, recorder };
}

/** Type into the composer and tap Send, as a person does. */
export async function sendFromComposer(page: Page, recorder: TapRecorder, text: string, label: string): Promise<TapLog> {
  const box = page.getByRole("textbox").last();
  await box.fill(text);
  return tap(recorder, page.getByRole("button", { name: message("composer.send.sendAria"), exact: true }), label);
}

/** The most ctrl+u presses {@link resetBox} spends on one draft: one per line of the box. */
const RESET_LINES = 6;

/**
 * Leave the input box empty before a scenario: close an open menu or dialog with Escape and clear a
 * draft with ctrl+u. Clean-up outside the phone, so it is noted and never counted as a tap.
 *
 * ctrl+u clears one line of the box, so a draft of several lines (a walky talky header and its body,
 * typed and not submitted) takes one press per line. It presses again while the box reads a draft, at
 * most {@link RESET_LINES} times. Field case 2026-10-21: one press left a message header in Claude's
 * box, and the next case's broadcast was held behind it.
 */
export async function resetBox(rig: Rig, paneId: string, host?: Host): Promise<string | null> {
  const pane = await rig.pane(paneId, host).catch(() => null);
  if (pane === null || freeSurface(pane)) return null;
  const surface = pane.surface;
  if (surface !== null && surface.turn === "running") return null;
  const steps: string[] = [];
  if (surface !== null && surface.modal !== "none") {
    await rig.keys(paneId, ["Escape"], host);
    steps.push("Escape");
    await sleep(600);
  }
  let presses = 0;
  let after = await rig.pane(paneId, host).catch(() => null);
  while (after?.surface?.composer === "draft" && presses < RESET_LINES) {
    await rig.keys(paneId, ["ctrl+u"], host);
    presses += 1;
    await sleep(400);
    after = await rig.pane(paneId, host).catch(() => null);
  }
  if (presses > 0) steps.push(presses === 1 ? "ctrl+u" : `ctrl+u x${String(presses)}`);
  await rig.until(() => rig.pane(paneId, host), freeSurface, 5000);
  return steps.length === 0 ? null : `box reset outside the phone (${steps.join(", ")})`;
}

/** Wait until the agent's turn is over and its box reads free. */
export async function waitIdle(rig: Rig, paneId: string, ms: number, host?: Host): Promise<boolean> {
  return (await rig.until(() => rig.pane(paneId, host), (pane) => freeSurface(pane) || (pane?.surface === null && pane.status !== "working"), ms, 700)) !== null;
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
