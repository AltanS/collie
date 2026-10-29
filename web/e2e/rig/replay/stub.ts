// The rig's model stub (M67, ADR 0125): a local OpenRouter stand-in for pi and omp, and a local Anthropic
// stand-in for Claude Code (spec 07). The rig daemon starts it on 127.0.0.1 before the first harness and
// stops it with the rig. Every pi and omp of the rig sends its model calls here (a provider extension
// sets the base URL, harnesses.ts), and so does Claude (ANTHROPIC_BASE_URL), on a path that names the
// harness instance: `/pi-lead/api/v1/messages`, `/omp-member/api/v1/responses`, `/claude-lead/v1/messages`.
//
//   replay  the request is matched to its cassette (cassette.ts) and the recorded stream is sent back
//           with its recorded pacing. No upstream call can happen: this mode has no upstream code path.
//           A request with no matching entry gets HTTP 422 `cassette mismatch` (MISMATCH_STATUS), never a
//           canned answer.
//   live    the request goes on to OpenRouter (pi, omp) or Anthropic (Claude) as it came, with the
//           harness's own Authorization header, and the answer streams straight back. The header lives
//           in memory for that one request only. With `record`, the stream is also written into the
//           cassettes: no header, the volatile values replaced by placeholders.
//
// Claude's `HEAD /api/hello` (its reachability check) gets a 200 on every tier, here. Anything else (a
// catalog read, a key check) gets a 503 on every tier and never leaves the machine.
//
// The leg tells the stub which case runs (`POST /_rig/case`, leg.ts runScenario), and reads its
// counters and mismatches (`GET /_rig/stats`, global-teardown.ts). The stub never reads a key file
// and never logs a header.
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import {
  apiOf,
  caseFile,
  compactResponse,
  digestOf,
  formatCassette,
  kindOf,
  matchSide,
  matchTurnAcross,
  parseCassette,
  parseSseBlock,
  placeholdersFor,
  placeholdersIn,
  redactKeys,
  rewriteResponse,
  serializeSse,
  splitSse,
  summarize,
  valuesFor,
  versionDir,
  volatileValues,
  type CassetteMeta,
  type LegMeta,
  type Entry,
  type EntryKind,
  type Literal,
  type RecordedResponse,
  type SseEvent,
  type Vendor,
} from "./cassette";
import { STUB_HARNESSES, VENDOR, isStubHarness, type StubHarness, type TierPlan, type TierPlans } from "./tier";

export interface StubConfig {
  /** The cassette root (web/e2e/rig/cassettes). */
  readonly root: string;
  readonly leg: string;
  readonly plans: TierPlans;
  /** The rig's folders and their placeholders: never stored as they are. */
  readonly literals: readonly Literal[];
  /** OpenRouter's origin; a test points it at a local fake. */
  readonly upstream?: string;
  /** Anthropic's origin, for Claude; a test points it at a local fake. */
  readonly anthropic?: string;
  /** Replay pacing: recorded delays are divided by this (1: as recorded). Never below 1. */
  readonly speed?: number;
  readonly log?: (line: string) => void;
}

export interface Mismatch {
  readonly harness: string;
  readonly machine: string;
  readonly case: string;
  readonly kind: EntryKind;
  readonly message: string;
}

export interface HarnessCounts {
  tier: string;
  /** Requests answered from a cassette. */
  replayed: number;
  /** Requests passed on to OpenRouter. */
  proxied: number;
  /** Entries written into the cassettes. */
  recorded: number;
  mismatches: number;
}

export interface StubStats {
  /** Every request that left this machine, all harnesses: OpenRouter's and Anthropic's. */
  readonly upstream: number;
  readonly harnesses: Record<string, HarnessCounts>;
  readonly mismatches: readonly Mismatch[];
  /** Cassette files written in this run. */
  readonly written: readonly string[];
}

export interface Stub {
  readonly port: number;
  setCase(caseId: string | null): void;
  stats(): StubStats;
  close(): Promise<void>;
}

/**
 * The status of a cassette mismatch. Spec 03 named 599, but a 5xx is retried: omp 18.6.1 sent the
 * same request 30 times in 90 s against a 599 (probed 2026-10-26), so a mismatch hung its case to the
 * timeout. A 422 is retried by neither harness's client: the turn ends at once and the harness paints
 * the error with its `cassette mismatch` text. The body's `cassette_mismatch` type is the label.
 */
export const MISMATCH_STATUS = 422;

/** The case id of a request that comes before the leg named a case (a harness start). A valid case id. */
export const NO_CASE = "rig.before-first-case";
const INSTANCE = /^\/([a-z]+)-(lead|member)(\/[^#]*)$/u;
/** Claude Code's reachability check, before its first model call. */
const HELLO = /^\/api\/hello(?:\?|$)/u;
const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** `/api/v1/messages?beta=true` and `/api/responses` to OpenRouter's `/api/v1/...`; Claude's path as it came. */
export function upstreamUrl(origin: string, rest: string, vendor: Vendor = "openrouter"): string {
  if (vendor === "anthropic") return `${origin}${rest}`;
  const tail = rest.startsWith("/api/") ? rest.slice(4) : rest;
  return `${origin}/api${tail.startsWith("/v1/") ? tail : `/v1${tail}`}`;
}

/** The headers that go on to OpenRouter: the harness's own, minus the hop-by-hop ones. */
function forwardHeaders(req: IncomingMessage): Headers {
  const out = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || /^(host|content-length|connection|keep-alive|transfer-encoding|accept-encoding)$/iu.test(name)) continue;
    out.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  return out;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

/** What a case's files held before this run recorded into them: the way back when the case fails. */
interface Before {
  /** The case's cassette file as it was, or null when there was none. */
  readonly caseText: string | null;
  /** meta.json as it was, or null when there was none. */
  readonly metaText: string | null;
  /** True when the file was a recording this run would still replay (same model and skill) and not marked failed. */
  readonly good: boolean;
}

/** A case's entries, recorded in this run, in arrival order. */
interface Recording {
  readonly harness: StubHarness;
  readonly caseId: string;
  readonly slots: (Entry | null)[];
  readonly before: Before;
}

/**
 * Remove a case's recording: its cassette file, and its name from `cases` and `failed` of the leg in
 * meta.json. The stub calls it when a record run's case passes and the harness made no model call in
 * it (an empty recording is the truth). A case with no file and no meta entry changes nothing.
 * Returns true when it removed or edited anything.
 */
export function dropRecording(root: string, leg: string, harness: string, version: string, caseId: string): boolean {
  const dir = join(root, harness, versionDir(version));
  const file = join(dir, caseFile(caseId));
  let changed = false;
  if (existsSync(file)) {
    rmSync(file);
    changed = true;
  }
  const metaFile = join(dir, "meta.json");
  if (!existsSync(metaFile)) return changed;
  // SAFETY: meta.json is the stub's own output (writeMeta).
  const meta = JSON.parse(readFileSync(metaFile, "utf8")) as CassetteMeta;
  const old = meta.legs[leg];
  if (old === undefined || !(old.cases.includes(caseId) || (old.failed ?? []).includes(caseId))) return changed;
  const cases = old.cases.filter((c) => c !== caseId);
  const failed = (old.failed ?? []).filter((c) => c !== caseId);
  const legMeta: LegMeta = failed.length > 0 ? { model: old.model, skill: old.skill, recordedAt: old.recordedAt, cases, failed } : { model: old.model, skill: old.skill, recordedAt: old.recordedAt, cases };
  writeFileSync(metaFile, `${JSON.stringify({ ...meta, legs: { ...meta.legs, [leg]: legMeta } }, null, 2)}\n`);
  return true;
}

export async function startStub(config: StubConfig, port = 0, host = "127.0.0.1"): Promise<Stub> {
  const log = config.log ?? (() => undefined);
  const speed = Math.max(1, config.speed ?? 1);
  const origins = { openrouter: config.upstream ?? "https://openrouter.ai", anthropic: config.anthropic ?? "https://api.anthropic.com" } satisfies Record<Vendor, string>;
  let current: string | null = null;
  let upstream = 0;
  const mismatches: Mismatch[] = [];
  const written = new Set<string>();
  const counts: Record<string, HarnessCounts> = {};
  for (const h of STUB_HARNESSES) {
    const planned = config.plans[h];
    if (planned !== undefined) counts[h] = { tier: planned.tier, replayed: 0, proxied: 0, recorded: 0, mismatches: 0 };
  }

  // ── replay: every cassette of the leg, loaded once ───────────────────────────────────────────
  const cassettes = new Map<StubHarness, Map<string, Entry[]>>();
  const sidePool = new Map<StubHarness, Entry[]>();
  for (const h of STUB_HARNESSES) {
    const plan = config.plans[h];
    if (plan === undefined || plan.tier !== "replay" || plan.version === null) continue;
    const dir = join(config.root, h, versionDir(plan.version));
    // SAFETY: meta.json is this file's own output (writeMeta); tier.ts already read it to choose replay.
    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as CassetteMeta;
    const byCase = new Map<string, Entry[]>();
    for (const caseId of meta.legs[config.leg]?.cases ?? []) {
      const file = join(dir, caseFile(caseId));
      if (existsSync(file)) byCase.set(caseId, [...parseCassette(readFileSync(file, "utf8")).entries]);
    }
    cassettes.set(h, byCase);
    sidePool.set(
      h,
      [...byCase.values()].flat().filter((entry) => entry.kind === "side"),
    );
  }
  const used = new Map<string, Set<number>>();

  // ── record ───────────────────────────────────────────────────────────────────────────────────
  const recordings = new Map<string, Recording>();
  const ordinals = new Map<string, number>();
  const recordedCases = new Map<StubHarness, Set<string>>();
  /** Cases recorded in this run whose verdict was not `pass`, per harness. */
  const failedCases = new Map<StubHarness, Set<string>>();

  const writeMeta = (plan: TierPlan) => {
    if (plan.version === null) return;
    const dir = join(config.root, plan.harness, versionDir(plan.version));
    const file = join(dir, "meta.json");
    // SAFETY: as above, the file is this function's own earlier output.
    const before = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as CassetteMeta) : null;
    const old = before?.legs[config.leg];
    const same = old !== undefined && old.model === plan.model && old.skill === plan.skill;
    const now = recordedCases.get(plan.harness) ?? new Set<string>();
    const cases = [...new Set([...(same ? old.cases : []), ...now])].toSorted();
    // A case recorded again in this run keeps only this run's verdict; the others keep theirs.
    const failed = [...new Set([...(same ? (old.failed ?? []) : []).filter((c) => !now.has(c)), ...(failedCases.get(plan.harness) ?? [])])].toSorted();
    const legMeta: LegMeta = failed.length > 0 ? { model: plan.model, skill: plan.skill, recordedAt: new Date().toISOString(), cases, failed } : { model: plan.model, skill: plan.skill, recordedAt: new Date().toISOString(), cases };
    const meta: CassetteMeta = { v: 1, harness: plan.harness, version: plan.version, legs: { ...before?.legs, [config.leg]: legMeta } };
    writeFileSync(file, `${JSON.stringify(meta, null, 2)}\n`);
  };

  /** The case's files before this run touches them (see Before). */
  const snapshot = (plan: TierPlan, caseId: string): Before => {
    if (plan.version === null) return { caseText: null, metaText: null, good: false };
    const dir = join(config.root, plan.harness, versionDir(plan.version));
    const file = join(dir, caseFile(caseId));
    const metaFile = join(dir, "meta.json");
    const caseText = existsSync(file) ? readFileSync(file, "utf8") : null;
    const metaText = existsSync(metaFile) ? readFileSync(metaFile, "utf8") : null;
    // SAFETY: as in writeMeta, meta.json is this file's own earlier output.
    const old = metaText === null ? undefined : (JSON.parse(metaText) as CassetteMeta).legs[config.leg];
    const good = caseText !== null && old !== undefined && old.model === plan.model && old.skill === plan.skill && old.cases.includes(caseId) && !(old.failed ?? []).includes(caseId);
    return { caseText, metaText, good };
  };

  const writeCase = (plan: TierPlan, rec: Recording) => {
    if (plan.version === null) return;
    const dir = join(config.root, plan.harness, versionDir(plan.version));
    mkdirSync(dir, { recursive: true });
    const entries = rec.slots.filter((slot): slot is Entry => slot !== null);
    const file = join(dir, caseFile(rec.caseId));
    writeFileSync(file, formatCassette({ header: { v: 1, harness: plan.harness, version: plan.version, case: rec.caseId, leg: config.leg, recordedAt: new Date().toISOString() }, entries }));
    written.add(file);
    const set = recordedCases.get(plan.harness) ?? new Set<string>();
    set.add(rec.caseId);
    recordedCases.set(plan.harness, set);
    writeMeta(plan);
  };

  /**
   * The life-cycle of a recording, decided where the verdict arrives (the case ran under recording):
   *  - pass, no model call by this harness: its file and its meta entries are removed;
   *  - pass, with calls: the file is the new recording and the failed mark is cleared;
   *  - fail, and the file held a good recording (same model and skill, not marked failed): the old
   *    file and the old meta come back, and one log line says so;
   *  - fail otherwise: the new recording stays and the case is marked failed.
   */
  const settleRecording = (plan: TierPlan, caseId: string, verdict: string) => {
    const h = plan.harness;
    const key = `${h}|${caseId}`;
    const rec = recordings.get(key);
    const passed = verdict === "pass";
    if (rec === undefined) {
      if (passed && plan.version !== null && dropRecording(config.root, config.leg, h, plan.version, caseId)) log(`${h} ${caseId}: passed with no model call, recording removed`);
      return;
    }
    if (passed || !rec.before.good) {
      const set = failedCases.get(h) ?? new Set<string>();
      if (passed) set.delete(caseId);
      else set.add(caseId);
      failedCases.set(h, set);
      writeMeta(plan);
      if (!passed) log(`${h} ${caseId}: recorded in a case that did not pass (${verdict}), marked failed`);
      return;
    }
    if (plan.version === null) return;
    const dir = join(config.root, h, versionDir(plan.version));
    const file = join(dir, caseFile(caseId));
    // A good recording had both files.
    if (rec.before.caseText !== null) writeFileSync(file, rec.before.caseText);
    if (rec.before.metaText !== null) writeFileSync(join(dir, "meta.json"), rec.before.metaText);
    written.delete(file);
    recordedCases.get(h)?.delete(caseId);
    failedCases.get(h)?.delete(caseId);
    recordings.delete(key);
    for (const k of ordinals.keys()) if (k.startsWith(`${h}|`) && k.split("|")[2] === caseId) ordinals.delete(k);
    log(`${h} ${caseId}: failed live (${verdict}), the earlier recording was not marked failed, kept`);
  };

  const fail = (res: ServerResponse, note: Mismatch) => {
    if (!mismatches.some((m) => m.case === note.case && m.harness === note.harness && m.message === note.message)) mismatches.push(note);
    const c = counts[note.harness];
    if (c !== undefined) c.mismatches++;
    log(`MISMATCH ${note.harness}-${note.machine} ${note.case}: ${note.message}`);
    res.writeHead(MISMATCH_STATUS, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "cassette_mismatch", message: note.message } }));
  };

  const serve = async (res: ServerResponse, response: RecordedResponse) => {
    let gone = false;
    res.on("close", () => {
      gone = !res.writableEnded;
    });
    res.writeHead(response.status, { "content-type": response.contentType, "cache-control": "no-cache" });
    if (response.events === undefined) {
      res.end(response.body ?? "");
      return;
    }
    for (const event of response.events) {
      if (event.ms > 0) await sleep(event.ms / speed);
      if (gone) return;
      res.write(serializeSse(event));
    }
    res.end();
  };

  const replay = async (h: StubHarness, machine: string, caseId: string, path: string, raw: string, res: ServerResponse) => {
    const summary = summarize(path, raw, config.literals, VENDOR[h]);
    const kind = kindOf(summary);
    let entry: Entry;
    if (kind === "turn") {
      const usedIn = (id: string): Set<number> => {
        const key = `${h}|${machine}|${id}`;
        const set = used.get(key) ?? new Set<number>();
        used.set(key, set);
        return set;
      };
      const match = matchTurnAcross(cassettes.get(h), caseId, machine, summary, usedIn);
      if ("mismatch" in match) return fail(res, { harness: h, machine, case: caseId, kind, message: match.mismatch });
      if (match.caseId !== caseId) log(`${h}-${machine} ${caseId}: a turn recorded under ${match.caseId} (same digest), served`);
      usedIn(match.caseId).add(match.index);
      entry = match.entry;
    } else {
      const hit = matchSide(sidePool.get(h) ?? [], summary);
      if (hit === null) return fail(res, { harness: h, machine, case: caseId, kind, message: `cassette mismatch: no side entry for prompt "${summary.prompt.slice(0, 100)}" (digest ${digestOf(summary)})` });
      entry = hit;
    }
    const response = rewriteResponse(entry.response, valuesFor(volatileValues(raw), config.literals));
    const left = placeholdersIn(response);
    if (left.length > 0) return fail(res, { harness: h, machine, case: caseId, kind, message: `cassette mismatch: the live request has no value for ${left.join(", ")}` });
    const c = counts[h];
    if (c !== undefined) c.replayed++;
    await serve(res, response);
  };

  const live = async (plan: TierPlan, machine: string, caseId: string, path: string, req: IncomingMessage, raw: string, res: ServerResponse) => {
    const h = plan.harness;
    const vendor = VENDOR[h];
    const summary = summarize(path, raw, config.literals, vendor);
    const kind = kindOf(summary);
    // The slot is taken on arrival, so the cassette keeps the order the requests came in.
    let rec: Recording | undefined;
    let slot = -1;
    let ordinal = 0;
    if (plan.record) {
      const recKey = `${h}|${caseId}`;
      rec = recordings.get(recKey);
      if (rec === undefined) {
        rec = { harness: h, caseId, slots: [], before: snapshot(plan, caseId) };
        recordings.set(recKey, rec);
      }
      slot = rec.slots.push(null) - 1;
      const ordKey = `${h}|${machine}|${caseId}|${kind}`;
      ordinal = ordinals.get(ordKey) ?? 0;
      ordinals.set(ordKey, ordinal + 1);
    }
    upstream++;
    const c = counts[h];
    if (c !== undefined) c.proxied++;
    const started = Date.now();
    let up: Response;
    try {
      const init: RequestInit = { method: req.method ?? "POST", headers: forwardHeaders(req) };
      if (raw !== "") init.body = raw;
      up = await fetch(upstreamUrl(origins[vendor], path, vendor), init);
    } catch (err) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "stub_upstream", message: `the rig stub could not reach ${vendor === "anthropic" ? "Anthropic" : "OpenRouter"}: ${err instanceof Error ? err.message : String(err)}` } }));
      return;
    }
    const contentType = up.headers.get("content-type") ?? "application/octet-stream";
    let clientGone = false;
    res.on("close", () => {
      clientGone = !res.writableEnded;
    });
    res.writeHead(up.status, { "content-type": contentType, "cache-control": "no-cache" });
    const streaming = contentType.includes("event-stream");
    const events: SseEvent[] = [];
    let text = "";
    let pending = "";
    let last = started;
    const decoder = new TextDecoder();
    const reader = up.body?.getReader();
    for (;;) {
      if (reader === undefined) break;
      const { done, value } = await reader.read();
      if (done) break;
      // The harness gets every byte as it comes; once it hangs up, the stream is still read to its end.
      if (!clientGone) res.write(value);
      const chunk = decoder.decode(value, { stream: true });
      if (!streaming) {
        text += chunk;
        continue;
      }
      const split = splitSse(pending + chunk);
      pending = split.rest;
      const now = Date.now();
      for (const block of split.blocks) {
        const event = parseSseBlock(block, now - last);
        if (event === null) continue;
        events.push(event);
        last = now;
      }
    }
    if (!clientGone) res.end();
    if (rec === undefined || plan.version === null) return;
    let recorded: RecordedResponse = streaming ? { status: up.status, contentType, events } : { status: up.status, contentType, body: text };
    if (streaming && clientGone) recorded = { ...recorded, clientAborted: true };
    const response = redactKeys(rewriteResponse(compactResponse(recorded), placeholdersFor(volatileValues(raw), config.literals)));
    rec.slots[slot] = { kind, machine, ordinal, request: { ...summary, path: path.split("?")[0] ?? path, digest: digestOf(summary) }, response };
    if (c !== undefined) c.recorded++;
    writeCase(plan, rec);
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      const url = req.url ?? "/";
      if (url === "/_rig/case" && req.method === "POST") {
        const body = await readBody(req);
        // SAFETY: the leg's own POST (leg.ts stubCase), `{ "case": string | null }`.
        const asked = (JSON.parse(body) as { case: string | null }).case;
        current = asked;
        log(`case ${asked ?? "(none)"}`);
        res.writeHead(204).end();
        return;
      }
      if (url === "/_rig/verdict" && req.method === "POST") {
        const body = await readBody(req);
        // SAFETY: the leg's own POST (leg.ts stubVerdict), `{ "case": string, "verdict": string }`.
        const said = JSON.parse(body) as { case: string; verdict: string };
        for (const h of STUB_HARNESSES) {
          const plan = config.plans[h];
          // Only a live run that records changes a cassette; a replay run never does.
          if (plan === undefined || plan.tier !== "live" || !plan.record || plan.version === null) continue;
          settleRecording(plan, said.case, said.verdict);
        }
        res.writeHead(204).end();
        return;
      }
      if (url === "/_rig/stats") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(statsNow()));
        return;
      }
      const m = INSTANCE.exec(url);
      const h = m?.[1];
      const plan = h !== undefined && isStubHarness(h) ? config.plans[h] : undefined;
      if (m === null || plan === undefined) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "not_found", message: `the rig stub serves /pi-lead/..., /omp-lead/... and /claude-lead/..., not ${url}` } }));
        return;
      }
      const machine = m[2] ?? "lead";
      const path = m[3] ?? "/";
      const raw = await readBody(req);
      // Claude's reachability check: answered here on every tier, so a replay never needs Anthropic.
      if (VENDOR[plan.harness] === "anthropic" && HELLO.test(path)) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(req.method === "HEAD" ? undefined : "{}");
        return;
      }
      // Only a model call is answered. A catalog read (omp lists OpenRouter's models at start) gets a
      // 503 on every tier, so the harness keeps its bundled catalog and the stub's base URL, and the
      // run does not depend on what OpenRouter lists today.
      if (req.method !== "POST" || apiOf(path) === "other") {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "stub_no_catalog", message: "the rig stub answers model calls only" } }));
        return;
      }
      const caseId = current ?? NO_CASE;
      if (plan.tier === "replay") await replay(plan.harness, machine, caseId, path, raw, res);
      else await live(plan, machine, caseId, path, req, raw, res);
  };

  const server = createServer((req, res) => {
    void (async () => {
      try {
        await handle(req, res);
      } catch (err) {
        log(`stub error: ${err instanceof Error ? err.message : String(err)}`);
        if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
        res.end();
      }
    })();
  });

  const statsNow = (): StubStats => ({ upstream, harnesses: counts, mismatches: [...mismatches], written: [...written].toSorted() });

  await new Promise<void>((done, failed) => {
    server.once("error", failed);
    server.listen(port, host, () => done());
  });
  // SAFETY: a TCP listener's address() is an AddressInfo once `listen` has called back.
  const bound = (server.address() as AddressInfo).port;
  log(`stub on ${host}:${String(bound)} (${Object.values(config.plans).map((p) => `${p.harness} ${p.tier}${p.record ? "+record" : ""}`).join(", ")})`);
  return {
    port: bound,
    setCase: (caseId) => {
      current = caseId;
    },
    stats: statsNow,
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}
