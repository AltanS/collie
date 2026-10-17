import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { JsonObject } from "./json.ts";
import { loadConfig } from "./config.ts";
import type { StateEngine } from "./state-engine.ts";
import { createKiroDiscovery } from "./journal/kiro-discovery.ts";
import { LiveWindows, TICK_FLOOR_MS } from "./journal/live.ts";
import { adapterFor, buildJournalRegistry } from "./journal/registry.ts";
import { TranscriptStore } from "./journal/store.ts";
import type { TranscriptEntry } from "./journal/types.ts";
import { declareCapabilities } from "./mux/capabilities.ts";
import { muxGone, muxOk } from "./mux/types.ts";
import { PairingStore, sha256Hex, type PairingIo } from "./pairing.ts";
import { apiFrontGate, guard, paneChat, paneGateLevel, paneHistory } from "./server.ts";
import type { AgentView, PaneChatResponse, PaneHistoryResponse } from "./types.ts";

const FIXTURES = join(import.meta.dir, "journal", "fixtures", "kiro");
const BUCKET = "f59dfd564fb1cb64";
const A = "sess_integration_a";
const B = "sess_integration_b";
const PID_A = 6867;
const PID_B = 6868;
const NOW = Date.parse("2026-10-01T12:00:00.000Z");
const TOKEN = "synthetic-kiro-route-test-token";
const temporary: string[] = [];

afterEach(async () => {
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});

function row(id: string, payload: JsonObject): string {
  return `${JSON.stringify({ id, timestamp: new Date(NOW).toISOString(), payload })}\n`;
}

function pane(paneId: string, session?: string): AgentView {
  const view: AgentView = {
    paneId, workspaceId: "w1", workspaceLabel: "shared", workspaceNumber: 1,
    tabId: paneId === "w1:p1" ? "w1:t1" : "w1:t2", agent: "kiro", status: "idle",
    cwd: "/example/alpha", focused: false,
  };
  if (session !== undefined) view.agentSession = { kind: "id", value: session };
  return view;
}

async function world(agents: AgentView[] = [pane("w1:p1", A), pane("w1:p2", B)]) {
  const base = await mkdtemp(join(FIXTURES, ".route-"));
  temporary.push(base);
  const root = join(base, "sessions");
  const source = await readFile(join(FIXTURES, "messages.jsonl"), "utf8");
  // SAFETY: the checked-in synthetic metadata is a JSON object in the shape kiro-cli 2.32.0 saves.
  const metadata = JSON.parse(await readFile(join(FIXTURES, "session.json"), "utf8")) as JsonObject;
  const seed = async (id: string, pid: number, text: string): Promise<string> => {
    const dir = join(root, BUCKET, id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "session.json"), JSON.stringify({ ...metadata, id }));
    await writeFile(join(dir, ".lock"), JSON.stringify({ pid, started_at: new Date(NOW - 1000).toISOString() }));
    const path = join(dir, "messages.jsonl");
    await writeFile(path, text);
    return path;
  };
  const aPath = await seed(A, PID_A, source);
  const bPath = await seed(B, PID_B, row("beta", { type: "user", source: "chat", content: "Only session B owns this prompt." }));
  const cfg = loadConfig({ HOME: base, COLLIE_STATE_DIR: join(base, "state"), COLLIE_HOST: "127.0.0.1" });
  const journals = buildJournalRegistry({ claude: [], codex: [], pi: [], opencode: [], grok: [], hermes: [], muse: [], openclaw: [], kiro: [root] });
  const adapter = adapterFor(journals, "kiro");
  if (adapter === undefined) throw new Error("Kiro must be registered");
  // Only process inspection and time are injected. The registry, disk source, bounded lock
  // scanner, reducer, stores and authenticated route functions below are the shipped code.
  adapter.discover = createKiroDiscovery([root], adapter.source, {
    now: () => NOW,
    inspect: async (pid) => [PID_A, PID_B].includes(pid) ? { token: `${pid}:start`, startedAt: NOW - 60_000 } : null,
  });
  const partial: Partial<StateEngine> = {
    current: () => ({ agents, shellPanes: [], workspaces: [], tabs: [], bridge: "connected" }),
  };
  // SAFETY: both route seams read only current(); no engine polling or real multiplexer is started.
  const engine = partial as StateEngine;
  let processes = 0;
  let hintsAvailable = true;
  const mux = {
    capabilities: declareCapabilities({ supports: ["paneGrid", "agentSessionRef"], topologyLatency: { kind: "push" } }),
    readGrid: async () => muxGone("no terminal needed for lock discovery"),
    foregroundProcesses: async (paneId: string) => {
      processes++;
      return muxOk(hintsAvailable ? [{ pid: paneId === "w1:p1" ? PID_A : PID_B, argv: ["bun", "/synthetic/kiro-cli/tui.js", "chat", "--resume-id", paneId === "w1:p1" ? A : B] }] : []);
    },
  };
  const registry = { devices: [{ label: "test-phone", tokenHash: sha256Hex(TOKEN), createdAt: 1, lastSeenAt: 1 }] };
  const io: PairingIo = {
    readPending: async () => null, writePending: async () => {}, deletePending: async () => {},
    readRegistry: async () => registry, writeRegistry: async () => {}, readRegistrySync: () => registry,
  };
  const pairing = new PairingStore(io, () => NOW);
  const transcripts = new TranscriptStore();
  let time = NOW;
  const live = new LiveWindows(transcripts, () => time);
  const request = async (paneId: string, action: "history" | "chat", query = "", headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }): Promise<Response> => {
    const url = new URL(`http://127.0.0.1/api/pane/${encodeURIComponent(paneId)}/${action}${query}`);
    const req = new Request(url, { headers: { host: "127.0.0.1", origin: "http://127.0.0.1", ...headers } });
    const denied = apiFrontGate(req, url.pathname, cfg, pairing) ?? guard(req, cfg, paneGateLevel(action), pairing);
    if (denied !== null) return denied;
    return action === "history"
      ? paneHistory(cfg, journals, transcripts, engine, mux, paneId, url, req)
      : paneChat(cfg, journals, live, engine, mux, paneId, url, req);
  };
  const history = async (paneId = "w1:p1", query = ""): Promise<Extract<PaneHistoryResponse, { available: true }>> => {
    const res = await request(paneId, "history", query);
    expect(res.status).toBe(200);
    // SAFETY: the JSON is the shipped route's own typed response, not an external service.
    const body = await res.json() as PaneHistoryResponse;
    if (!body.available) throw new Error(`History unavailable: ${body.reason}`);
    return body;
  };
  const chat = async (paneId = "w1:p1", query = ""): Promise<Extract<PaneChatResponse, { available: true }>> => {
    const res = await request(paneId, "chat", query);
    expect(res.status).toBe(200);
    // SAFETY: the JSON is the shipped route's own typed response, not an external service.
    const body = await res.json() as PaneChatResponse;
    if (!body.available) throw new Error(`Chat unavailable: ${body.reason}`);
    return body;
  };
  return {
    request, history, chat, aPath, bPath, seed, source, adapter,
    processReads: () => processes,
    noHints: () => { hintsAvailable = false; },
    advance: () => { time += TICK_FLOOR_MS + 1; },
  };
}

function noPrivateText(body: PaneHistoryResponse | PaneChatResponse): void {
  for (const hidden of ["Synthetic private system prompt.", "Synthetic context, not speech.", "Synthetic model-only context.", "Synthetic consumed steer envelope.", "synthetic-envelope"]) {
    expect(JSON.stringify(body)).not.toContain(hidden);
  }
}

function withoutPositions(entries: readonly (TranscriptEntry & { seq?: number })[]): TranscriptEntry[] {
  return entries.map(({ seq: _seq, ...entry }) => entry);
}

describe("Kiro journal routes with actual saved-session files", () => {
  test("native refs keep same-cwd panes separate in History and Chat without process discovery", async () => {
    // Given: the registered adapter and two source-schema sessions sharing workspacePaths.
    const w = await world();
    // When: the phone reads both route families for each pane.
    const a = await w.history();
    const b = await w.history("w1:p2");
    const liveA = await w.chat();
    const liveB = await w.chat("w1:p2");
    // Then: only the exact pane's speech leaves each route, with no internal prompt/context.
    expect(a.entries).toEqual(w.adapter.parse(w.source));
    expect(withoutPositions(liveA.upserts)).toEqual(a.entries);
    expect(withoutPositions(liveB.upserts)).toEqual(b.entries);
    expect(JSON.stringify(a)).toContain("List the sample files.");
    expect(JSON.stringify(a)).not.toContain("Only session B");
    expect(JSON.stringify(b)).toContain("Only session B");
    expect(JSON.stringify(b)).not.toContain("List the sample files.");
    noPrivateText(a);
    noPrivateText(liveA);
    expect(w.processReads()).toBe(0);
  });

  test("missing refs resolve exact foreground locks rather than the newest session in the same cwd", async () => {
    // Given: two panes report no native ref, but their exact PIDs own distinct V3 locks.
    const w = await world([pane("w1:p1"), pane("w1:p2")]);
    // When: both authenticated History and incremental Chat routes discover their journals.
    const a = await w.history();
    const b = await w.history("w1:p2");
    const liveA = await w.chat();
    const liveB = await w.chat("w1:p2");
    // Then: file-backed lock discovery chooses the same pane-specific histories as native refs.
    expect(a.entries).toEqual(w.adapter.parse(w.source));
    expect(withoutPositions(liveA.upserts)).toEqual(a.entries);
    expect(withoutPositions(liveB.upserts)).toEqual(b.entries);
    expect(b.entries.map((entry) => entry.uuid)).toEqual(["beta"]);
    expect(w.processReads()).toBe(4);
    noPrivateText(liveA);
  });

  test("no process identity and overlapping session locks refuse without a cwd fallback", async () => {
    // Given: real session logs exist in a shared cwd but the TUI temporarily owns two locks.
    const w = await world([pane("w1:p1"), pane("w1:p2")]);
    await w.seed("sess_switch_overlap", PID_A, row("other", { type: "user", content: "Wrong successor." }));
    // When: a read cannot establish one exact live owner, then cannot obtain process hints.
    for (const action of ["history", "chat"] as const) {
      expect(await (await w.request("w1:p1", action)).json()).toMatchObject({ available: false, reason: "no-session" });
    }
    w.noHints();
    // Then: even a valid neighbouring journal cannot make either route guess a session.
    for (const action of ["history", "chat"] as const) {
      expect(await (await w.request("w1:p2", action)).json()).toMatchObject({ available: false, reason: "no-session" });
    }
  });

  test("lock ownership transfer beats stale resume argv on subsequent Chat and History reads", async () => {
    // Given: a missing-ref pane has already read its initial session.
    const w = await world([pane("w1:p1"), pane("w1:p2")]);
    await w.chat();
    const successor = "sess_switched";
    await w.seed(successor, PID_A, row("switched", { type: "user", content: "Current switched conversation." }));
    // When: the outgoing lock disappears but the mux's startup resume-id still names it.
    await rm(join(w.aPath, "..", ".lock"));
    w.advance();
    const history = await w.history();
    const chat = await w.chat();
    // Then: neither route serves the cached outgoing session or the neighbour's session.
    expect(history.entries.map((entry) => entry.uuid)).toEqual(["switched"]);
    expect(chat.upserts.map((entry) => entry.uuid)).toEqual(["switched"]);
    expect(JSON.stringify(chat)).not.toContain("List the sample files.");
    expect(JSON.stringify(chat)).not.toContain("Only session B");
  });

  test("incremental tool results keep denial, stable positions, hidden context and History parity", async () => {
    // Given: the seeded session ends with a denied tool call but no result yet.
    const w = await world();
    await appendFile(w.aPath, row("denied-call", { type: "tool_call", toolCallId: "denied", toolName: "execute_bash", kind: "execute", args: { command: "printf never_run" }, status: "denied" }));
    const first = await w.chat();
    if (first.page !== "live") throw new Error("Expected live window");
    const previous = first.upserts.find((entry) => entry.uuid === "denied-call");
    // When: the real append log receives a terminal denial result and private context.
    await appendFile(w.aPath, row("denied-result", { type: "tool_result", toolCallId: "denied", content: "Permission refused.", success: false }) + row("hidden", { type: "system", content: "Private appended system text." }));
    w.advance();
    const query = `?after=${first.gen}:${first.rev}`;
    const delta = await w.chat("w1:p1", query);
    if (delta.page !== "live") throw new Error("Expected live delta");
    // Then: one existing card changes, and merging the wire delta reproduces History.
    expect(delta.gen).toBe(first.gen);
    expect(delta.rev).toBeGreaterThan(first.rev);
    expect(delta.upserts).toHaveLength(1);
    expect(delta.upserts[0]).toMatchObject({ uuid: "denied-call", seq: previous?.seq, parts: [{ kind: "tool", result: { text: "Permission refused.", denied: true, isError: true } }] });
    const merged = first.upserts.map((entry) => delta.upserts.find((update) => update.uuid === entry.uuid) ?? entry);
    expect(withoutPositions(merged)).toEqual((await w.history()).entries);
    noPrivateText(delta);
    expect(JSON.stringify(delta)).not.toContain("Private appended system text.");
    expect((await w.chat("w1:p2")).upserts.map((entry) => entry.uuid)).toEqual(["beta"]);
    const noChangeQuery = `?after=${delta.gen}:${delta.rev}`;
    const unchanged = await w.request("w1:p1", "chat", noChangeQuery);
    const tag = unchanged.headers.get("etag");
    if (tag === null) throw new Error("Chat needs an ETag");
    const conditional = await w.request("w1:p1", "chat", noChangeQuery, { authorization: `Bearer ${TOKEN}`, "if-none-match": tag });
    expect(conditional.status).toBe(304);
    expect(await conditional.text()).toBe("");
  });

  test("History paging and Chat older pages read the same file without leaking internal rows", async () => {
    // Given: the phone first reads a bounded recent window of the real seeded log.
    const w = await world();
    const live = await w.chat("w1:p1", "?limit=2");
    const oldest = live.upserts[0];
    if (oldest === undefined) throw new Error("Expected newest turns");
    // When: both routes ask for entries before that same opaque turn ID.
    const history = await w.history("w1:p1", `?before=${oldest.uuid}&limit=2`);
    const chat = await w.chat("w1:p1", `?before=${oldest.seq}:${oldest.uuid}&limit=2`);
    // Then: both use the journal projection, not raw source/context text.
    expect(chat.page).toBe("older");
    expect(withoutPositions(chat.upserts)).toEqual(history.entries);
    expect(history.hasMore).toBe(true);
    noPrivateText(history);
    noPrivateText(chat);
  });

  test("anonymous and cross-origin requests are denied before journal discovery", async () => {
    // Given: valid journals and a real hashed paired-device registry behind unchanged gates.
    const w = await world([pane("w1:p1"), pane("w1:p2")]);
    // When: unpaired, incorrect-token and foreign-origin clients try either read route.
    for (const action of ["history", "chat"] as const) {
      const deniedHeaders: Record<string, string>[] = [{}, { authorization: "Bearer wrong" }, { authorization: `Bearer ${TOKEN}`, origin: "https://foreign.invalid" }];
      for (const headers of deniedHeaders) {
        const response = await w.request("w1:p1", action, "", headers);
        // Then: no file-derived response or process inspection is reachable.
        expect(response.status).toBe(403);
        expect(await response.text()).toBe("origin" in headers ? "cross-origin rejected" : "device not paired");
      }
    }
    expect(w.processReads()).toBe(0);
    expect((await w.request("w1:p1", "history")).status).toBe(200);
  });
});
