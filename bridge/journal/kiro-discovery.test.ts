import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createKiroDiscovery, type KiroDiscoveryRuntime, type KiroProcessIdentity } from "./kiro-discovery.ts";
import { kiroJournal } from "./kiro.ts";
import type { DiscoverHints, ForegroundProcess, TranscriptSource } from "./types.ts";
import type { JsonValue } from "../json.ts";
import { toPaneWire, type AgentView } from "../types.ts";
import { adapterFor, buildJournalRegistry } from "./registry.ts";

const NOW = Date.parse("2026-10-01T12:00:00.000Z");
const START = NOW - 60_000;
const BUCKET = "f59dfd564fb1cb64";
const PID = 6867;
const ID = "sess_current";
const OTHER = "sess_other";
const folders: string[] = [];

const runtime: KiroDiscoveryRuntime = {
  now: () => NOW,
  inspect: async (pid): Promise<KiroProcessIdentity> => ({ token: `${pid}:start`, startedAt: START }),
};

function foreground(pid = PID, extra: readonly string[] = []): ForegroundProcess {
  return { pid, argv: ["/home/operator/.local/share/kiro-cli/bun", "--no-env-file", "--config=/home/operator/.local/share/kiro-cli/bunfig.toml", "/home/operator/.local/share/kiro-cli/tui.js", "chat", ...extra] };
}

function hints(pid = PID, extra: readonly string[] = []): DiscoverHints {
  return { processes: [foreground(pid, extra)] };
}

async function sandbox(): Promise<string> {
  const dir = await mkdtemp(join(import.meta.dir, "fixtures", "kiro", ".discovery-"));
  folders.push(dir);
  return dir;
}

async function session(root: string, id = ID, pid = PID, bucket = BUCKET): Promise<string> {
  const dir = join(root, bucket, id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "session.json"), JSON.stringify({ id, schemaVersion: "1.0.0", workspacePaths: ["/shared"] }));
  await writeFile(join(dir, "messages.jsonl"), "");
  await writeFile(join(dir, ".lock"), JSON.stringify({ pid, started_at: new Date(NOW - 1000).toISOString() }));
  return dir;
}

function discover(roots: readonly string[], source = kiroJournal(roots).source, environment = runtime): ReturnType<typeof createKiroDiscovery> {
  return createKiroDiscovery(roots, source, environment);
}

afterEach(async () => {
  for (const dir of folders.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("Kiro V3 process-owned discovery", () => {
  test("two panes in the same cwd resolve different exact foreground PIDs", async () => {
    // Given: sessions share workspacePaths but their TUI locks belong to different processes.
    const root = await sandbox();
    await session(root);
    await session(root, OTHER, PID + 1);
    const find = discover([root]);
    // When: both panes ask from that same cwd.
    const first = await find("/shared", hints());
    const second = await find("/shared", hints(PID + 1));
    // Then: process identity, not cwd, chooses the session.
    expect(first).toEqual({ kind: "id", value: ID });
    expect(second).toEqual({ kind: "id", value: OTHER });
    expect(await find("/unrelated", hints())).toEqual(first);
  });

  test.each([undefined, {}, { processes: [] }, { processes: [{ argv: ["kiro-cli"] }] }, { processes: [{ pid: PID, argv: ["bash"] }] }])("no usable process hint refuses without a cwd fallback: %j", async (hint) => {
    // Given: an apparently recent session in the pane's workspace.
    const root = await sandbox();
    await session(root);
    // When: the pane supplies no exact Kiro TUI process identity.
    const result = await discover([root])("/shared", hint);
    // Then: the workspace alone cannot choose the transcript.
    expect(result).toBeNull();
  });

  test.each([0, -1, 1.5, NaN, Infinity, 4194305])("invalid foreground PID %s is refused before process inspection", async (pid) => {
    // Given: an untrusted PID and an inspector that must not be reached.
    const environment: KiroDiscoveryRuntime = { now: () => NOW, inspect: async () => { throw new Error("must not inspect"); } };
    // When: discovery receives the process hint.
    const result = await discover([], undefined, environment)("/shared", hints(pid));
    // Then: no path to a user-shaped process identifier is opened.
    expect(result).toBeNull();
  });

  test.each([
    { argv: ["bun", "/tmp/unrelated.js", "/home/operator/.local/share/kiro-cli/tui.js"] },
    { argv: ["cat", "/home/operator/.local/share/kiro-cli/tui.js"] },
    { argv: ["bun", "--eval", "/home/operator/.local/share/kiro-cli/tui.js"] },
    { argv: ["kiro-cli-server"] },
  ])("a Kiro string in an unrelated process does not count: %j", async ({ argv }) => {
    // Given: the PID does have a lock, but the pane is not running a Kiro TUI.
    const root = await sandbox();
    await session(root);
    // When: discovery receives the misleading argv.
    const result = await discover([root])("/shared", { processes: [{ pid: PID, argv }] });
    // Then: merely mentioning Kiro does not grant access to its journal.
    expect(result).toBeNull();
  });

  test("the real wrapper process group resolves only the TUI lock owner", async () => {
    // Given: Herdr lists the launcher, CLI wrappers and Bun TUI in one foreground group.
    const root = await sandbox();
    await session(root);
    const processes: ForegroundProcess[] = [
      { pid: PID - 4, argv: ["aim", "sandbox", "--client", "kiro-cli", "chat"] },
      { pid: PID - 3, argv: ["/home/operator/.local/bin/kiro-cli", "chat"] },
      { pid: PID - 2, argv: ["kiro-cli-chat", "chat"] },
      foreground(),
    ];
    // When: discovery receives the complete process group instead of one preselected PID.
    const result = await discover([root])("/shared", { processes });
    // Then: wrapper PIDs neither grant authority nor make the TUI ambiguous.
    expect(result).toEqual({ kind: "id", value: ID });
  });

  test("multiple foreground Kiro processes refuse even when one has a matching lock", async () => {
    // Given: the process group names two possible TUIs.
    const root = await sandbox();
    await session(root);
    // When: the pane cannot distinguish between the owners.
    const result = await discover([root])("/shared", { processes: [foreground(), foreground(PID + 1)] });
    // Then: it cannot choose either transcript.
    expect(result).toBeNull();
  });

  test("resume args are used only when the unique live lock agrees", async () => {
    // Given: the pane was launched with an exact resume ID.
    const root = await sandbox();
    await session(root);
    const find = discover([root]);
    // When: separate and equals spellings name that ID.
    const result = await find("/shared", hints(PID, ["--resume-id", ID]));
    // Then: only the lock-backed exact ID is returned.
    expect(result).toEqual({ kind: "id", value: ID });
    expect(await find("/shared", hints(PID, [`--resume-id=${ID}`]))).toEqual(result);
  });

  test("an in-session switch ignores stale resume argv and revalidates previous results", async () => {
    // Given: startup argv still names the previous session.
    const root = await sandbox();
    const old = await session(root);
    const find = discover([root]);
    const hint = hints(PID, ["--resume-id", ID]);
    expect(await find("/shared", hint)).toEqual({ kind: "id", value: ID });
    // When: the TUI transfers ownership to another session.
    await session(root, OTHER);
    await rm(join(old, ".lock"));
    // Then: the old hint and any previous source cache cannot select the old session.
    expect(await find("/shared", hint)).toEqual({ kind: "id", value: OTHER });
  });

  test("the same PID owning two locks is ambiguous even with exact resume argv", async () => {
    // Given: a transfer temporarily owns both outgoing and incoming locks.
    const root = await sandbox();
    await session(root);
    await session(root, OTHER, PID, "_global");
    // When: argv still points to the outgoing ID.
    const result = await discover([root])("/shared", hints(PID, ["--resume-id", ID]));
    // Then: discovery waits for the ownership transfer to settle.
    expect(result).toBeNull();
  });

  test("locks in different configured roots are also checked for ambiguity", async () => {
    // Given: both roots contain a lock for the exact process.
    const root = await sandbox();
    const second = await sandbox();
    await session(root);
    await session(second, OTHER);
    // When: discovery scans the configured roots.
    const result = await discover([root, second])("/shared", hints());
    // Then: root order cannot break a tie.
    expect(result).toBeNull();
  });

  test("a dead process cannot authorize an otherwise valid lock", async () => {
    // Given: the session owner has exited since the foreground snapshot.
    const root = await sandbox();
    await session(root);
    const environment: KiroDiscoveryRuntime = { now: () => NOW, inspect: async () => null };
    // When: the stale pane asks for its history.
    const result = await discover([root], undefined, environment)("/shared", hints());
    // Then: the lock alone cannot establish a live association.
    expect(result).toBeNull();
  });

  test.each([START - 3000, NOW + 3000])("lock timestamp outside the process lifetime refuses: %s", async (stamp) => {
    // Given: a reused PID's old lock, or a future timestamp.
    const root = await sandbox();
    const dir = await session(root);
    await writeFile(join(dir, ".lock"), JSON.stringify({ pid: PID, started_at: new Date(stamp).toISOString() }));
    // When: a live foreground process now has that PID.
    const result = await discover([root])("/shared", hints());
    // Then: its lifetime cannot support this lock acquisition.
    expect(result).toBeNull();
  });

  test.each<{ payload: JsonValue }>([
    null, [], {}, { pid: PID }, { pid: String(PID), started_at: new Date(NOW).toISOString() },
    { pid: 0, started_at: new Date(NOW).toISOString() }, { pid: PID, started_at: "yesterday" },
    { pid: PID, started_at: "2026-02-30T12:00:00.000Z" }, { pid: PID, started_at: 123 },
    { pid: PID, started_at: new Date(NOW).toISOString(), startedAt: new Date(START).toISOString() },
  ].map((payload) => ({ payload })))("malformed lock schema refuses: %j", async ({ payload }) => {
    // Given: a lock without the writer's exact schema.
    const root = await sandbox();
    const dir = await session(root);
    await writeFile(join(dir, ".lock"), JSON.stringify(payload));
    // When: the foreground PID is otherwise valid.
    const result = await discover([root])("/shared", hints());
    // Then: invalid lock data never chooses a transcript.
    expect(result).toBeNull();
  });

  test.each(["{partial", " ".repeat(4097)])("invalid or oversized lock content refuses", async (payload) => {
    // Given: a partial or oversized metadata file.
    const root = await sandbox();
    const dir = await session(root);
    await writeFile(join(dir, ".lock"), payload);
    // When: discovery reads it with the small metadata cap.
    const result = await discover([root])("/shared", hints());
    // Then: the invalid file grants no authority.
    expect(result).toBeNull();
  });

  test("the earlier TUI camelCase timestamp spelling is accepted", async () => {
    // Given: a valid earlier TUI lock.
    const root = await sandbox();
    const dir = await session(root);
    await writeFile(join(dir, ".lock"), JSON.stringify({ pid: PID, startedAt: new Date(NOW).toISOString() }));
    // When: the process lifetime agrees.
    const result = await discover([root])("/shared", hints());
    // Then: the source still validates the exact ID.
    expect(result).toEqual({ kind: "id", value: ID });
  });

  test("V2 CLI sibling locks and workflow or child locks are ignored", async () => {
    // Given: non-parent files with matching locks and no V3 parent lock.
    const root = await sandbox();
    const cli = join(root, "cli");
    await mkdir(cli);
    await writeFile(join(cli, `${ID}.lock`), JSON.stringify({ pid: PID, started_at: new Date(NOW).toISOString() }));
    await session(root, ID, PID, "workflows");
    const parent = await session(root, "unlocked", PID + 1);
    const child = join(parent, "sub_executions");
    await session(child);
    // When: discovery scans only the V3 bucket/session shape.
    const result = await discover([root])("/shared", hints());
    // Then: neither legacy nor child ownership selects a parent session.
    expect(result).toBeNull();
  });

  test.each(["bucket", "session", ".lock", "session.json", "messages.jsonl", "root"])("symlinked %s is refused even into a separate sessions root", async (kind) => {
    // Given: a valid lock reachable through a link to a separate root.
    const root = await sandbox();
    const second = await sandbox();
    const there = await session(second);
    const here = await session(root);
    let link: string;
    let target: string;
    if (kind === "root") { link = root; target = second; }
    else if (kind === "bucket") { link = join(root, BUCKET); target = join(second, BUCKET); }
    else if (kind === "session") { link = here; target = there; }
    else { link = join(here, kind); target = join(there, kind); }
    await rm(link, { recursive: true });
    await symlink(target, link);
    // When: discovery follows the first root only (the second is also a valid configuration).
    const result = await discover([root])("/shared", hints());
    // Then: a link is not an ownership record under the building root.
    expect(result).toBeNull();
  });

  test.each([".lock", "session.json", "messages.jsonl"])("directory in place of %s refuses", async (name) => {
    // Given: a special non-file at a required read path.
    const root = await sandbox();
    const dir = await session(root);
    await rm(join(dir, name));
    await mkdir(join(dir, name));
    // When: discovery checks the session.
    const result = await discover([root])("/shared", hints());
    // Then: no non-regular metadata or log is read.
    expect(result).toBeNull();
  });

  test("discovery must pass existing source metadata validation", async () => {
    // Given: a matching lock with a different ID in its session metadata.
    const root = await sandbox();
    const dir = await session(root);
    await writeFile(join(dir, "session.json"), JSON.stringify({ id: OTHER, schemaVersion: "1.0.0", workspacePaths: ["/shared"] }));
    // When: the candidate goes through normal opaque-ID resolution.
    const result = await discover([root])("/shared", hints());
    // Then: a lock cannot bypass the source's identity checks.
    expect(result).toBeNull();
  });

  test("a source cache for another copy of the ID cannot select the wrong log", async () => {
    // Given: one old unowned copy has already been resolved and cached.
    const root = await sandbox();
    const otherRoot = await sandbox();
    await session(root, ID, PID + 1);
    await session(otherRoot);
    const source = kiroJournal([root, otherRoot]).source;
    expect(await source.resolve({ kind: "id", value: ID })).toBe(join(root, BUCKET, ID, "messages.jsonl"));
    // When: the foreground owner points at the other copy.
    const result = await discover([root, otherRoot], source)("/shared", hints());
    // Then: a source cache cannot override the location established by the live lock.
    expect(result).toBeNull();
  });

  test("a lock removed while source validation runs loses authority", async () => {
    // Given: normal source validation with a session switch during the await.
    const root = await sandbox();
    const dir = await session(root);
    const real = kiroJournal([root]).source;
    const source: TranscriptSource = {
      resolve: async (ref) => { const result = await real.resolve(ref); await rm(join(dir, ".lock")); return result; },
      stat: (path) => real.stat(path), load: (path) => real.load(path), readSince: (path, cursor) => real.readSince(path, cursor),
    };
    // When: discovery finishes its final lock recheck.
    const result = await discover([root], source)("/shared", hints());
    // Then: the historical match is not cached as current authority.
    expect(result).toBeNull();
  });

  test("process reuse while scanning invalidates the result", async () => {
    // Given: the process start identity changes between the two OS inspections.
    const root = await sandbox();
    await session(root);
    let calls = 0;
    const environment: KiroDiscoveryRuntime = { now: () => NOW, inspect: async () => ({ token: String(++calls), startedAt: START }) };
    // When: the lock still names the same numeric PID.
    const result = await discover([root], undefined, environment)("/shared", hints());
    // Then: numeric equality does not hide a different process owner.
    expect(result).toBeNull();
  });

  test("an incomplete bounded scan refuses even after finding a candidate", async () => {
    // Given: an exact resumed candidate in a directory with more than the entry cap.
    const root = await sandbox();
    await session(root);
    for (let i = 0; i < 8193; i++) await writeFile(join(root, BUCKET, `noise-${i}`), "");
    // When: lookup considers the argv candidate first but cannot finish the ambiguity scan.
    const result = await discover([root])("/shared", hints(PID, ["--resume-id", ID]));
    // Then: a partial walk never pretends uniqueness.
    expect(result).toBeNull();
  });

  test("cached discovery never survives a changed session directory", async () => {
    // Given: a source has resolved the current session.
    const root = await sandbox();
    const dir = await session(root);
    const find = discover([root]);
    expect(await find("/shared", hints())).toEqual({ kind: "id", value: ID });
    // When: the directory becomes a symlink to a different root.
    const otherRoot = await sandbox();
    const otherDir = await session(otherRoot);
    await rename(dir, `${dir}-old`);
    await symlink(otherDir, dir);
    // Then: discovery checks the new filesystem state rather than returning the old cache.
    expect(await find("/shared", hints())).toBeNull();
  });

  test("configured root ancestry may be relocated while descendants remain pinned to its real root", async () => {
    // Given: the operator has moved KIRO_HOME and configured its normal sessions subfolder.
    const base = await sandbox();
    const home = join(base, "home");
    const real = join(base, "relocated");
    const root = join(real, "sessions");
    await mkdir(real);
    await symlink(real, home);
    await session(root);
    // When: discovery anchors to the real configured sessions root.
    const result = await discover([join(home, "sessions")])("/shared", hints());
    // Then: a trusted config alias does not permit symlinked session descendants.
    expect(result).toEqual({ kind: "id", value: ID });
  });

  test("resume argv without a V3 lock never discovers a session", async () => {
    // Given: an exact argument and valid metadata, but no current ownership lock.
    const root = await sandbox();
    const dir = await session(root);
    await rm(join(dir, ".lock"));
    // When: discovery sees the startup argument.
    const result = await discover([root])("/shared", hints(PID, ["--resume-id", ID]));
    // Then: args alone cannot identify the active session after a switch.
    expect(result).toBeNull();
  });

  test("the default inspector rejects a forged Kiro hint for this unrelated test process", async () => {
    // Given: this test runner is live, but is not a Kiro TUI.
    const root = await sandbox();
    await session(root, ID, process.pid);
    // When: a stale or misleading foreground hint claims it is Kiro on Linux.
    const result = await kiroJournal([root]).discover?.("/shared", hints(process.pid));
    // Then: current OS argv prevents an unrelated reused PID from granting access.
    if (process.platform === "linux") expect(result).toBeNull();
  });

  test("Kiro without a native report offers Chat without sending process identity to the browser", () => {
    // Given: a known Kiro pane with no native session reference.
    const registry = buildJournalRegistry({ claude: [], codex: [], pi: [], opencode: [], grok: [], hermes: [], muse: [], openclaw: [], kiro: [] });
    const pane: AgentView = { paneId: "pane", workspaceId: "space", workspaceLabel: "shared", workspaceNumber: 1, tabId: "tab", agent: "kiro", status: "idle", cwd: "/shared", focused: true };
    // When: the normal browser conversion checks the registered discovery capability.
    const wire = toPaneWire(pane, (agent) => adapterFor(registry, agent) !== undefined, (agent) => adapterFor(registry, agent)?.discover !== undefined);
    // Then: only an availability flag leaves the bridge.
    expect(wire.hasSession).toBe(true);
    expect("pid" in wire).toBe(false);
    expect("processes" in wire).toBe(false);
    expect("agentSession" in wire).toBe(false);
  });
});
