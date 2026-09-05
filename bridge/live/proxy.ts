import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, normalize } from "node:path";
import { containedRealpath } from "../journal/files.ts";
import type { AgentSessionRef } from "../journal/types.ts";
import type { JsonValue } from "../json.ts";
import { jsonRecord, jsonStringField, jsonNumberField } from "../stt/json.ts";
import type { AgentView } from "../types.ts";
import type { LiveCommand, LiveDescriptor, LiveReply, LiveStatus, LiveTranscript } from "./types.ts";
import { LIVE_SESSION_HEADER, MAX_LIVE_REQUEST_BYTES, MAX_LIVE_SDP_BYTES, parseLiveCommand } from "./commands.ts";

const PHASES = {
  idle: true, connecting: true, listening: true, working: true, muted: true, error: true,
} satisfies Record<LiveStatus["phase"], true>;

function sameReference(left: AgentSessionRef, right: AgentSessionRef): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "id") return left.value === right.value;
  const a = normalize(left.value);
  const b = normalize(right.value);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function descriptorFrom(raw: JsonValue): LiveDescriptor | null {
  const value = jsonRecord(raw);
  if (!value || value.version !== 1) return null;
  const pid = jsonNumberField(value.pid);
  const port = jsonNumberField(value.port);
  const token = jsonStringField(value.token);
  const paneId = jsonStringField(value.paneId);
  const sessionId = jsonStringField(value.sessionId);
  const sessionRef = jsonRecord(value.sessionRef);
  if (pid === null || !Number.isSafeInteger(pid) || pid < 1) return null;
  if (port === null || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (!token || !/^[\w-]{43,128}$/.test(token) || !paneId || !sessionId) return null;
  if (!sessionRef || (sessionRef.kind !== "path" && sessionRef.kind !== "id")) return null;
  const ref = jsonStringField(sessionRef.value);
  if (!ref) return null;
  return { version: 1, pid, port, token, paneId, sessionId, sessionRef: { kind: sessionRef.kind, value: ref } };
}


/** Whitelist the browser response: a local descriptor/OAuth field can never ride through a spread. */
function statusFrom(raw: JsonValue | undefined): LiveStatus | null {
  const value = jsonRecord(raw);
  if (!value || (value.available !== true && value.available !== false) || (value.muted !== true && value.muted !== false)) return null;
  const phase = jsonStringField(value.phase);
  if (!phase || !Object.hasOwn(PHASES, phase) || !Array.isArray(value.transcripts)) return null;
  const transcripts: LiveTranscript[] = [];
  for (const item of value.transcripts.slice(-8)) {
    const row = jsonRecord(item);
    const text = jsonStringField(row?.text);
    if (!row || (row.role !== "user" && row.role !== "assistant") || text === null || (row.final !== true && row.final !== false)) return null;
    transcripts.push({ role: row.role, text: text.slice(0, 4000), final: row.final });
  }
  // SAFETY: PHASES has only the members of the LiveStatus phase union.
  const result: LiveStatus = { available: value.available, phase: phase as LiveStatus["phase"], muted: value.muted, transcripts };
  const error = jsonStringField(value.error);
  if (error !== null) result.error = error.slice(0, 2048);
  return result;
}

export function liveJson(body: LiveStatus | LiveReply | { ok: false; error: string }, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

function unavailable(error: string): LiveStatus {
  return { available: false, phase: "idle", muted: false, transcripts: [], error };
}

/** Only host-authored records are read; the phone supplies a pane id, never a path or URL. */
export class OmpLiveProxy {
  constructor(private readonly directory = process.env.COLLIE_OMP_LIVE_DIR || join(homedir(), ".omp", "collie-live")) {}

  private async find(pane: AgentView): Promise<LiveDescriptor | null> {
    if (pane.agent !== "omp") return null;
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch {
      return null;
    }
    let selected: LiveDescriptor | null = null;
    for (const name of names.slice(0, 512)) {
      if (!/^\d+\.json$/.test(name)) continue;
      const safe = await containedRealpath(join(this.directory, name), this.directory);
      if (!safe) continue;
      try {
        const file = Bun.file(safe);
        if (file.size > 16 * 1024) continue;
        const descriptor = descriptorFrom(await file.json());
        if (!descriptor || name !== `${descriptor.pid}.json` || descriptor.paneId !== pane.paneId) continue;
        // Herdr has no journal reference until a fresh OMP session writes its first turn.
        // The unique interactive listener remains pinned by session ID on every HTTP request.
        if (pane.agentSession && !sameReference(descriptor.sessionRef, pane.agentSession)) continue;
        process.kill(descriptor.pid, 0);
        // More than one OMP claiming this pane/session is ambiguous, never choose at random.
        if (selected) return null;
        selected = descriptor;
      } catch {
        // Dead processes and half-written/stale records are not call targets.
      }
    }
    return selected;
  }

  async handle(req: Request, pane: AgentView): Promise<Response> {
    if (req.method !== "GET" && req.method !== "POST") return liveJson({ ok: false, error: "Method not allowed" }, 405);
    let command: LiveCommand | null = null;
    if (req.method === "POST") {
      if (req.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json") return liveJson({ ok: false, error: "JSON required" }, 415);
      const body = await req.text();
      if (Buffer.byteLength(body) > MAX_LIVE_REQUEST_BYTES) return liveJson({ ok: false, error: "Live request too large" }, 413);
      try { command = parseLiveCommand(JSON.parse(body)); } catch { /* Invalid JSON is a client error. */ }
      if (!command) return liveJson({ ok: false, error: "Invalid live request" }, 400);
    }
    const descriptor = await this.find(pane);
    if (!descriptor) {
      const status = unavailable("Open a new OMP pane to load Collie Live, or restart OMP and resume this session.");
      return req.method === "GET" ? liveJson(status) : liveJson({ ok: false, error: status.error! }, 503);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${descriptor.port}/live`, {
        method: req.method,
        headers: {
          host: `localhost:${descriptor.port}`, authorization: `Bearer ${descriptor.token}`,
          "content-type": "application/json", [LIVE_SESSION_HEADER]: descriptor.sessionId,
        },
        body: command ? JSON.stringify(command) : undefined,
        redirect: "error",
        signal: AbortSignal.any([req.signal, AbortSignal.timeout(command?.action === "ready" || command?.action === "offer" ? 40_000 : 5_000)]),
      });
      const body = await response.text();
      if (Buffer.byteLength(body) > MAX_LIVE_REQUEST_BYTES) throw new Error("Oversized live response");
      const value: JsonValue = JSON.parse(body);
      const object = jsonRecord(value);
      if (!response.ok) {
        const error = jsonStringField(object?.error)?.slice(0, 2048) ?? "OMP refused the live request";
        return liveJson({ ok: false, error }, response.status);
      }
      if (req.method === "GET") {
        const status = statusFrom(value);
        if (!status) throw new Error("Invalid live status");
        return liveJson(status);
      }
      if (!object || object.ok !== true) throw new Error("Invalid live response");
      const status = statusFrom(object.status);
      if (!status) throw new Error("Invalid live status");
      const reply: LiveReply = { ok: true, status };
      if (command?.action === "offer") {
        const sdp = jsonStringField(object.sdp);
        if (!sdp || Buffer.byteLength(sdp) > MAX_LIVE_SDP_BYTES || !sdp.startsWith("v=0")) throw new Error("Invalid SDP answer");
        reply.sdp = sdp;
      }
      return liveJson(reply);
    } catch {
      const error = "The OMP live connection is unavailable or timed out. Reopen Live to reconnect.";
      return req.method === "GET" ? liveJson(unavailable(error)) : liveJson({ ok: false, error }, 502);
    }
  }
}
