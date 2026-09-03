import { createHash } from "node:crypto";

import { bearerToken } from "../pairing.ts";
import { STANDBY_HEALTH_PATH } from "./deposed.ts";
import { silentForMs, type LeadContactFacts } from "./lead-contact.ts";
import { resolveSyncedToken, type SyncedDevice } from "./standby-devices.ts";
import type { TrustStoreData } from "./trust-store.ts";
import { verifyWarrantSignature, warrantExpired } from "./warrant.ts";
import type { PackMode } from "../types.ts";
import type { UpdateRun } from "../update-run.ts";

// The standby door: a SECOND HTTP listener a deputy binds, and the one narrow exception to ADR 0013's
// "a peer publishes nothing" (RFC §6, PACK_PROTOCOL.md §18.15).
//
// ── WHY IT CANNOT RIDE THE PACK LISTENER ─────────────────────────────────────
// §8.1's amendment states it plainly: `COLLIE_PEER_BROWSER=1` and a pinned listener are mutually
// exclusive, because a browser cannot present the lead's client certificate. That is BoringSSL
// refusing a handshake, not a policy anything here could relax. A phone is a browser, so the choice
// was a second listener or no feature.
//
// ── WHAT IT IS, AND WHAT IT IS NOT ───────────────────────────────────────────
// Three routes, no more. No PWA, no `/api/*`, no SPA fallback, no `/auth` placeholder — **a route
// that does not exist cannot be mis-gated** (ADR 0013's own words). Collie BINDS it and publishes
// nothing: no `tailscale serve`, never `funnel`, no ownership record (ADR 0001 is untouched — we
// still manage only what we run and can test). Plain HTTP behind the operator's own failover proxy,
// which is RFC §14.2's deployment and docs/deployment.md Variant C/E's posture already.
//
// ── PAIRING ONLY, AND THAT IS A DELIBERATE NARROWING ─────────────────────────
// `COLLIE_DEVICE_HEADER` composes by AND with pairing on `/api/*` and that stays true everywhere
// else. **It is not applied here** (RFC §16, decision 2), because the failover path is precisely when
// an ingress is misbehaving: a header the *broken* proxy should have injected is not a second factor
// there, it is a dependency on the component that just failed. The pairing credential has no such
// failure mode — the phone holds it and the deputy checks it against a registry on its own disk
// (`standby-devices.ts`). Written here as well as in the RFC, or a future reader takes it for a bug.

/** The page. `GET`, ungated — it reads state and grants nothing. */
export const STANDBY_PATH = "/standby";
/** The confirm. `POST`, gated by a pairing bearer credential from `standby-devices.json` ONLY. */
export const STANDBY_TAKEOVER_PATH = "/standby/takeover";
/**
 * The update record, served while the MAIN PORT IS DOWN (M15/04). `GET`, ungated — it reads
 * `<state dir>/update.json` and grants nothing, exactly as {@link STANDBY_PATH} does.
 *
 * This is the window the operator most wants to see and the one in which the front door cannot
 * answer: an update restarts the bridge, so the phone loses `/api/update/check` for precisely as
 * long as the thing it is waiting on. The standby listener is a separate `Bun.serve` that the
 * restart does not touch on a machine that is not the one restarting, and on the machine that IS,
 * this is what comes back first.
 */
export const STANDBY_UPDATE_PATH = "/standby/update";

/**
 * The namespace this door owns. Reserved on the FRONT DOOR too (`bridge/server.ts`) and denylisted in
 * the service worker (`web/src/lib/sw-routes.ts`): in the same-origin failover deployment the phone
 * first hits an installed service worker minted from the *lead's* origin, so this reservation is the
 * difference between reaching the door and being served a cached app shell.
 */
export const STANDBY_PREFIX = "/standby";

export { STANDBY_HEALTH_PATH };

// ── Configuration (pack keys, so they live here and never on `Config`) ───────

/** Absent ⇒ **no standby door at all**: nothing is bound and the deputy is a plain peer (RFC §6.2). */
export const STANDBY_PORT_ENV = "COLLIE_STANDBY_PORT";
/** Where the door binds. Loopback by default — the failover proxy is normally co-located. */
export const STANDBY_HOST_ENV = "COLLIE_STANDBY_HOST";
/** The operator's override of the arming threshold. A formula by default; see {@link armThresholdMs}. */
export const STANDBY_ARM_ENV = "COLLIE_STANDBY_ARM_MS";
/** The idle poll interval the formula is derived from — read, never written, by this module. */
const POLL_IDLE_ENV = "COLLIE_POLL_IDLE_MS";
/** `bridge/config.ts`'s default for {@link POLL_IDLE_ENV}, mirrored so the formula is self-contained. */
const DEFAULT_POLL_IDLE_MS = 12_000;
/** The floor the formula never goes below, so a very tight poll cannot produce a hair-trigger door. */
export const ARM_FLOOR_MS = 30_000;

type Env = Record<string, string | undefined>;

function positiveInt(raw: string | undefined): number | null {
  const parsed = Number.parseInt(raw?.trim() ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * The port the standby door binds, or `null` — **and `null` is the whole feature switched off**
 * (RFC §6.2, "absent means closed"). Nothing is bound, nothing is served, and a deputy without it can
 * still be taken over from a keyboard by §14's promotion.
 */
export function standbyPortOf(env: Env = process.env): number | null {
  const port = positiveInt(env[STANDBY_PORT_ENV]);
  return port === null || port > 65_535 ? null : port;
}

/** The bind address. Loopback by default, exactly as the front door's own default is. */
export function standbyHostOf(env: Env = process.env): string {
  const host = env[STANDBY_HOST_ENV]?.trim();
  return host === undefined || host === "" ? "127.0.0.1" : host;
}

/**
 * The arming threshold — **a formula, not a constant** (RFC §6.3; RFC §16, decision 1).
 *
 * ```
 * max(30_000, 2.5 × COLLIE_POLL_IDLE_MS)
 * ```
 *
 * At today's defaults both terms are 30 s. An operator who relaxes the idle poll to save a laptop's
 * battery moves the threshold with it automatically, instead of discovering months later that their
 * idle pack arms its own standby door every night. The threshold MUST exceed `COLLIE_POLL_IDLE_MS` or
 * an idle pack arms itself, and the formula guarantees it.
 *
 * `COLLIE_STANDBY_ARM_MS` overrides it. An override below the idle poll is **warned about, not
 * refused** ({@link armThresholdWarning}) — §3's posture is that Collie tells the operator about
 * their own decision rather than vetoing it.
 */
export function armThresholdMs(env: Env = process.env): number {
  const override = positiveInt(env[STANDBY_ARM_ENV]);
  if (override !== null) return override;
  const idle = positiveInt(env[POLL_IDLE_ENV]) ?? DEFAULT_POLL_IDLE_MS;
  return Math.max(ARM_FLOOR_MS, Math.round(2.5 * idle));
}

/** The line to print when the operator's override is below the idle poll, or `null`. */
export function armThresholdWarning(env: Env = process.env): string | null {
  const override = positiveInt(env[STANDBY_ARM_ENV]);
  if (override === null) return null;
  const idle = positiveInt(env[POLL_IDLE_ENV]) ?? DEFAULT_POLL_IDLE_MS;
  if (override > idle) return null;
  return (
    `[pack] ${STANDBY_ARM_ENV}=${override} is at or below ${POLL_IDLE_ENV}=${idle}, so this deputy's ` +
    "standby door will arm itself on an idle pack. Raise it above the idle poll (the default formula " +
    `is max(${ARM_FLOOR_MS}, 2.5 × ${POLL_IDLE_ENV})).`
  );
}

// ── Armed ────────────────────────────────────────────────────────────────────

/**
 * Everything the door decides on, as plain data — so the arming matrix is a table test rather than a
 * test of a harness.
 */
export interface StandbyFacts {
  /**
   * This machine holds a **verified** stored warrant naming ITSELF: for this pack, issued by the
   * member it pins as its lead, signed by that lead's key, unexpired on this machine's own clock.
   * Resolved by the same reader the listener's second anchor is (`transport.ts`), never re-derived.
   */
  readonly warrantsSelf: boolean;
  /** Gap A's number, and there is only one of it (RFC §10.1) — `pack status` prints this same value. */
  readonly silentForMs: number;
  readonly armMs: number;
  /** How many devices the lead has synced. **Zero is a refusal to arm**, not a relaxed gate. */
  readonly deviceCount: number;
  /** Members other than this machine and its lead — the witnesses step (b) would ask. */
  readonly witnessCount: number;
  readonly leadMemberId: string | null;
  readonly selfMemberId: string;
  readonly packName: string | null;
}

/** Which factors are satisfied. Each is separately renderable, so the page can say what is missing. */
export interface ArmingReport {
  readonly armed: boolean;
  readonly hasWarrant: boolean;
  readonly silentEnough: boolean;
  readonly hasDevices: boolean;
}

/**
 * The arming rule, in one place (RFC §6.3).
 *
 * ```
 * armed ⇔ a verified warrant names this machine
 *       ∧ now - max(lastDialledAt, processStartedAt) >= COLLIE_STANDBY_ARM_MS
 *       ∧ the synced pairing registry is non-empty
 * ```
 *
 * All three, and none of them is a soft signal:
 *
 *   • **the warrant** is the operator's standing consent. Without it this machine is a peer that
 *     happens to have a port open;
 *   • **the silence** is measured from the LATER of the last landed call and this process's start, so
 *     a deputy that just rebooted does not arm instantly — the lead gets one full window to call;
 *   • **the registry** is the credential the confirm is checked against. With an empty one there is
 *     nothing to check, and an ungated takeover button on an unpublished port is a takeover button
 *     for anyone who reaches the port. So an empty registry refuses to ARM rather than arming
 *     ungated (RFC §6.4).
 *
 * Arming is reversible and instantaneous: the lead's next landed call disarms it, nothing is
 * persisted and no state machine survives it. A door that flaps with the lead's connectivity is
 * correct, because it grants nothing.
 */
export function armingReport(facts: StandbyFacts): ArmingReport {
  const hasWarrant = facts.warrantsSelf;
  const silentEnough = facts.silentForMs >= facts.armMs;
  const hasDevices = facts.deviceCount > 0;
  return { armed: hasWarrant && silentEnough && hasDevices, hasWarrant, silentEnough, hasDevices };
}

/** {@link armingReport}'s verdict alone, for the callers that only need the bit. */
export function isArmed(facts: StandbyFacts): boolean {
  return armingReport(facts).armed;
}

/**
 * Does a **verified** warrant on this machine's own disk name this machine as deputy?
 *
 * The mirror image of `transport.ts`'s `deputyAnchorOf`, clause for clause, and deliberately so: that
 * one answers "may I anchor somebody else's certificate?" and refuses a warrant naming this collie;
 * this one answers "am I the one named?" and is the only case that one refuses. Between them every
 * warrant a peer can hold is accounted for, and both read the same five questions off the same store:
 *
 *   • for THIS pack, and issued by the member this collie pins as its lead;
 *   • naming a deputy at all — a revocation names nobody and arms nobody (§18.3);
 *   • naming THIS collie;
 *   • unexpired on THIS machine's own clock (§18.4) — a dark pack disarms itself here as well as at
 *     the transport;
 *   • signed by that lead's key, checked against the certificate already pinned.
 *
 * A refusal at any clause is total and silent: no warrant, no door.
 */
export function warrantNamesSelf(mode: PackMode, data: TrustStoreData | null, now: number = Date.now()): boolean {
  if (mode !== "peer" || data === null || data.pack === null) return false;
  const lead = data.lead;
  if (lead === null || lead.status !== "enrolled" || lead.certPem === "") return false;
  const stored = data.warrant ?? null;
  if (stored === null) return false;
  const w = stored.warrant;
  if (w.packId !== data.pack.packId || w.leadMemberId !== lead.memberId) return false;
  if (w.deputyMemberId === null || w.deputyMemberId !== data.self.memberId) return false;
  if (warrantExpired(w, now)) return false;
  return verifyWarrantSignature(w, lead.certPem);
}

/** Gap A's silence, from the one holder, so the door and `pack status` can never read two clocks. */
export function silenceOf(contact: LeadContactFacts, now: number): number {
  return silentForMs(contact, now);
}

// ── The page ─────────────────────────────────────────────────────────────────

/** Seconds, the way a person reads them under stress. Never milliseconds; never a bare integer. */
export function humanSilence(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 120) return `${s} second${s === 1 ? "" : "s"}`;
  const m = Math.round(s / 60);
  if (m < 120) return `${m} minute${m === 1 ? "" : "s"}`;
  const h = Math.round(m / 60);
  return `${h} hour${h === 1 ? "" : "s"}`;
}

/**
 * HTML-escape. **Every** interpolation on the page goes through it, without exception.
 *
 * A member id is slugified at `join` and a pack name is operator-typed, so neither is plausibly
 * hostile — but this page is rendered on a machine that is already in a degraded state, by a
 * listener with no framework behind it, and "that value happens to be safe today" is not a property
 * anyone can re-check at 23:00. The deposed page sidesteps the question entirely by being
 * `text/plain`; this one cannot, because it needs a button.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * The only script on the page, and it exists for exactly one reason: the pairing credential lives in
 * this origin's `localStorage` (`web/src/lib/pairing.ts` → `collie:device-token`), and an HTML form
 * post cannot carry an `Authorization` header.
 *
 * It is inlined rather than served from a fourth route, and the CSP admits it by **hash** — so the
 * policy stays `script-src 'sha256-…'` with no `unsafe-inline` and no nonce to get wrong. Nothing
 * else is on this page: no framework, no fetch of anything but the confirm, no external asset.
 */
const CONFIRM_SCRIPT = `
document.getElementById('go').addEventListener('click', async function () {
  var btn = this;
  var out = document.getElementById('out');
  var token = null;
  try { token = localStorage.getItem('collie:device-token'); } catch (e) { token = null; }
  if (!token) { out.textContent = 'This phone is not paired with your lead. Pair it there first, then reload.'; return; }
  btn.disabled = true;
  out.textContent = 'Asking your lead, then every other machine…';
  try {
    var res = await fetch('/standby/takeover', { method: 'POST', headers: { authorization: 'Bearer ' + token } });
    var body = await res.json();
    out.textContent = body.message || ('HTTP ' + res.status);
    if (body.ok) { setTimeout(function () { location.replace('/'); }, 1500); return; }
  } catch (e) {
    out.textContent = 'The takeover could not be sent: ' + e;
  }
  btn.disabled = false;
});
`.trim();

/** The CSP the page is served under. Computed from the script's own bytes, so the two cannot drift. */
export function standbyCsp(): string {
  const hash = createHash("sha256").update(CONFIRM_SCRIPT, "utf8").digest("base64");
  return [
    "default-src 'none'",
    `script-src 'sha256-${hash}'`,
    "style-src 'unsafe-inline'",
    "connect-src 'self'",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

const PAGE_STYLE =
  "body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:2rem 1.25rem;background:#111;color:#eee}" +
  "main{max-width:34rem;margin:0 auto}h1{font-size:1.4rem;margin:0 0 1rem}" +
  "p{margin:0 0 1rem}code{background:#222;padding:.1em .35em;border-radius:.25em}" +
  ".warn{color:#f5c451}.out{margin-top:1rem;min-height:1.5rem}" +
  "button{width:100%;padding:1rem;font-size:1.1rem;border:0;border-radius:.5rem;background:#c0392b;color:#fff}" +
  "button[disabled]{opacity:.5}";

/**
 * The page, server-rendered from the bridge (RFC §6.2, §14.3 step 3).
 *
 * **One page, one sentence, one button.** No options, no roster editor, no address fields — a page
 * with choices on it is a page nobody can use one-handed at 23:00. While cold it is a bare statement
 * of fact with no action on it at all; while armed it is that statement plus the button.
 *
 * A **two-machine pack says the quiet part above the button** (RFC §16, decision 8): there is nobody
 * else to ask, so the operator is the entire evidence base — which is ADR 0026's thesis rather than a
 * shortfall against it, and it is stated rather than hidden because taking over against a lead that
 * is merely unreachable splits the pack.
 */
export function standbyPage(facts: StandbyFacts): string {
  const report = armingReport(facts);
  const self = escapeHtml(facts.selfMemberId);
  const lead = facts.leadMemberId === null ? "your lead" : `<code>${escapeHtml(facts.leadMemberId)}</code>`;
  const pack = facts.packName === null ? "this pack" : `&ldquo;${escapeHtml(facts.packName)}&rdquo;`;
  const body: string[] = [];

  if (report.armed) {
    body.push(
      `<h1>Take over</h1>`,
      `<p>Your lead ${lead} has not called this machine for ${humanSilence(facts.silentForMs)}. ` +
        `This machine (<code>${self}</code>) is the deputy of pack ${pack}.</p>`,
    );
    if (facts.witnessCount === 0) {
      body.push(
        `<p class="warn">There are no other machines to ask. If your lead is up and you simply cannot ` +
          `reach it, taking over will split your pack.</p>`,
      );
    } else {
      body.push(
        `<p>Before anything changes, this machine will ask your lead, and then ask ` +
          `${facts.witnessCount} other machine${facts.witnessCount === 1 ? "" : "s"} whether it has called ` +
          `them. Any &ldquo;yes&rdquo; stops the takeover.</p>`,
      );
    }
    body.push(`<button id="go" type="button">Take over</button>`, `<p class="out" id="out"></p>`);
  } else {
    body.push(
      `<h1>Standby</h1>`,
      `<p>This machine (<code>${self}</code>) is the deputy of pack ${pack}. Nothing here is live.</p>`,
      `<p>${escapeHtml(coldReason(facts, report))}</p>`,
    );
  }
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    "<title>Collie standby</title>",
    `<style>${PAGE_STYLE}</style></head><body><main>`,
    ...body,
    "</main>",
    report.armed ? `<script>${CONFIRM_SCRIPT}</script>` : "",
    "</body></html>",
  ].join("\n");
}

/**
 * Why the door is cold, in the operator's words. Ordered by what they can act on: a missing warrant
 * or an empty registry is a setup step, where a lead that is simply answering is good news.
 */
export function coldReason(facts: StandbyFacts, report: ArmingReport): string {
  if (!report.hasWarrant) {
    return "No warrant here names this machine, so it cannot take over. Run `collie pack deputy` on your lead — and restart this machine afterwards.";
  }
  if (!report.hasDevices) {
    return "Your lead has not synced a paired device to this machine, so there is no credential to check a takeover against. Run `collie pair` on the lead.";
  }
  const lead = facts.leadMemberId ?? "your lead";
  return `Your lead ${lead} called this machine ${humanSilence(facts.silentForMs)} ago; it is alive. This page arms itself after ${humanSilence(facts.armMs)} of silence.`;
}

// ── The door ─────────────────────────────────────────────────────────────────

/** What the confirm answers with. `ok:false` is an ANSWER, not an error — see RFC §14.3 step 5. */
export interface TakeoverAnswer {
  readonly ok: boolean;
  /** The sentence the page prints verbatim. Never paraphrased and never re-derived client-side. */
  readonly message: string;
}

export interface StandbyDoorDeps {
  /** Re-read per request: arming is instantaneous in both directions and nothing caches it. */
  readonly facts: () => StandbyFacts;
  /**
   * This process's `<semver>+<short sha>` — the same string `/api/health` answers with, and the
   * value this port's `X-Collie-Version` header carries. See {@link STANDBY_VERSION_HEADER}.
   */
  readonly version: string;
  /** The on-disk bundle's build id, as `/api/config` reports it. `"unknown"` where none is stamped. */
  readonly build: () => Promise<string>;
  /** The synced registry's devices, per request, for the bearer check. Empty ⇒ nothing can pass. */
  readonly devices: () => readonly SyncedDevice[];
  /** Run RFC §7. Called at most once per admitted confirm; the door does not retry it. */
  readonly takeover: (device: string) => Promise<TakeoverAnswer>;
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" } as const;

/**
 * The header EVERY response from the standby listener carries, whatever its path, its status or
 * whether the door is armed: this collie's `<semver>+<short sha>`.
 *
 * ── WHY IT IS ON THIS PORT AT ALL (M15/05) ───────────────────────────────────
 * The detached updater's health gate asks one question after a restart — *which build came back?* —
 * and on the LEAD it asks it at `GET /api/health`. On a PEER that pins its lead it cannot: the main
 * port is behind mutual TLS there, so a plain-HTTP probe gets an empty reply, and a wide-bound
 * instance is not on loopback for it to dial either. The standby listener is plain HTTP on its own
 * address in every one of those states, so this header is where the runner reads the answer.
 *
 * ── A DIFFERENT HEADER FROM THE FRONT DOOR'S, ON PURPOSE ─────────────────────
 * `X-Collie-Build` on the FRONT DOOR carries the on-disk web bundle's id (`bridge/server.ts`'s
 * `BUILD_HEADER`), which is what a stale PWA needs. This door carries the VERSION instead, under
 * its own header name, because the question this port is asked is the health gate's, and the health
 * gate compares versions. The two ports answer two different questions, so they now carry two
 * different header names; that is stated here rather than left for someone to discover, and
 * `/standby/health`'s body carries BOTH facts under their own names so nothing has to be inferred
 * from a header either way.
 */
export const STANDBY_VERSION_HEADER = "x-collie-version";

/**
 * Stamp `res` with {@link STANDBY_VERSION_HEADER}. Applied at the LISTENER, once, so it covers every
 * answer this port can make — the door's three routes, a deposed collie's page, a lead's health
 * answer, `/standby/update`, and the bare 404 for everything else. A header applied per route is a
 * header a new route forgets.
 */
export function withStandbyVersion(res: Response, version: string): Response {
  res.headers.set(STANDBY_VERSION_HEADER, version);
  return res;
}

/** Every body this door emits. A closed union, so no route can answer with a shape nobody reviewed. */
type StandbyBody =
  | { readonly state: "armed"; readonly silentForMs: number; readonly version: string; readonly build: string }
  | { readonly state: "cold"; readonly version: string; readonly build: string }
  | { readonly state: "leading" }
  | { readonly error: string }
  | TakeoverAnswer;

function json(body: StandbyBody, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS } });
}

/**
 * The standby door's whole request surface: three routes, and `null` for everything else — which the
 * listener turns into a bare 404, so this port has no discoverable surface beyond the three.
 *
 * **Health answers in both states, and the two answers are the point** (RFC §14.2): `503` while cold
 * keeps a failover proxy routing to the lead, and `200` once armed is what flips it over here. It is
 * the same path a deposed lead FAILS on its own front door (`deposed.ts`) — one name for one
 * question, *should anything route here?*, asked of both backends behind one hostname.
 */
export function createStandbyDoor(deps: StandbyDoorDeps) {
  return async (req: Request, url: URL): Promise<Response | null> => {
    const facts = deps.facts();
    const report = armingReport(facts);

    if (url.pathname === STANDBY_HEALTH_PATH) {
      if (req.method !== "GET" && req.method !== "HEAD") return json({ error: "method not allowed" }, 405);
      // Never a body a stranger can learn a member id from: a state word, how long the silence has
      // run when armed, and what this machine is running. No member ids, no pack name, no roster.
      //
      // The version and the build ride BOTH answers, cold included — the updater's health gate reads
      // them on a peer, and a peer whose door is cold is the ordinary case, not the exception
      // (M15/05). A 503 here means "do not route to me", never "I have nothing to tell you".
      const stamp = { version: deps.version, build: await deps.build() };
      return report.armed
        ? json({ state: "armed", silentForMs: facts.silentForMs, ...stamp }, 200)
        : json({ state: "cold", ...stamp }, 503);
    }

    if (url.pathname === STANDBY_PATH) {
      if (req.method !== "GET" && req.method !== "HEAD") return json({ error: "method not allowed" }, 405);
      // The PAGE is served in both states — while cold it is a statement with no action on it, which
      // is what lets an operator confirm the door exists before the bad day rather than during it.
      return new Response(standbyPage(facts), {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": standbyCsp(),
          "referrer-policy": "no-referrer",
          "x-content-type-options": "nosniff",
          "cache-control": "no-store",
        },
      });
    }

    if (url.pathname === STANDBY_TAKEOVER_PATH) {
      if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
      // §7's whole exchange refuses BEFORE the credential is checked when the door is cold: a cold
      // door has nothing to spend, and answering 409 rather than 401 tells the operator the truth
      // (their lead is fine) instead of making them doubt their phone.
      if (!report.armed) {
        return json({ ok: false, message: coldReason(facts, report) } satisfies TakeoverAnswer, 409);
      }
      // PAIRING ONLY. No device header is read here and none is consulted — see the module header.
      const device = resolveSyncedToken(deps.devices(), bearerToken(req.headers));
      if (device === null) {
        return json({ ok: false, message: "This device is not paired with your lead." } satisfies TakeoverAnswer, 401);
      }
      const answer = await deps.takeover(device.label);
      return json(answer, answer.ok ? 200 : 409);
    }

    return null;
  };
}

/**
 * `/standby/health` **on the front door**, which is a different question asked of the same name: the
 * failover proxy health-checks the LEAD here and expects `200` while it leads (RFC §14.2).
 *
 * Only a lead answers. A peer and a solo instance return `null` and the path falls through to
 * whatever an unknown path already gets — a peer is not a front door and a solo instance must gain no
 * route at all (§11's zero-tax contract). A **deposed** lead never reaches this: `deposed.ts` answers
 * the same path with `503` before this is consulted, which is exactly the flip the proxy needs.
 */
/**
 * `/standby/update` on the standby listener, in EVERY state that listener can be in — deposed, lead,
 * deputy or a plain peer that merely binds the port. It is mounted ahead of all of them in
 * `bridge/index.ts` for that reason: the question it answers ("what is this machine's update doing?")
 * has one answer whatever role the machine holds, and a deposed collie is exactly the machine whose
 * operator needs it.
 *
 * `null` for any other path, so this adds no surface: the listener turns that into its bare 404.
 */
export function standbyUpdateAnswer(
  req: Request,
  url: URL,
  read: () => UpdateRun | null,
): Response | null {
  if (url.pathname !== STANDBY_UPDATE_PATH) return null;
  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response(JSON.stringify({ error: "method not allowed" }), { status: 405, headers: { ...JSON_HEADERS } });
  }
  // An install that has never updated answers `idle` rather than 404: "nothing is happening" is a
  // fact the phone can render, and a missing route is not.
  const run = read() ?? { state: "idle" };
  return new Response(JSON.stringify(run), {
    status: 200,
    headers: { ...JSON_HEADERS, "cache-control": "no-store" },
  });
}

export function frontDoorHealth(mode: PackMode, url: URL): Response | null {
  if (mode !== "lead" || url.pathname !== STANDBY_HEALTH_PATH) return null;
  return json({ state: "leading" }, 200);
}
