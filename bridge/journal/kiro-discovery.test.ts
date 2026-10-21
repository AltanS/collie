import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { JsonValue } from "../json.ts";
import { KIRO_BUCKET, kiroSandbox, removeKiroSandboxes, writeKiroLock, writeKiroSession } from "./kiro-fixtures.ts";
import { kiroJournal } from "./kiro.ts";
import type { DiscoverHints, ForegroundProcess, JournalAdapter } from "./types.ts";

const NOW = Date.parse("2026-10-01T12:00:00.000Z");
const BUCKET = KIRO_BUCKET;
const PID = 6867;
const ID = "sess_current";
const OTHER = "sess_other";

const TUI_ARGV = ["/home/operator/.local/share/kiro-cli/bun", "--no-env-file", "--config=/home/operator/.local/share/kiro-cli/bunfig.toml", "/home/operator/.local/share/kiro-cli/tui.js", "chat"];

function foreground(pid = PID, extra: readonly string[] = []): ForegroundProcess {
  return { pid, argv: [...TUI_ARGV, ...extra] };
}

function hints(pid = PID, extra: readonly string[] = []): DiscoverHints {
  return { processes: [foreground(pid, extra)] };
}

/** A session folder with an empty log, locked by `pid` a second before NOW. Returns the folder. */
async function session(root: string, id = ID, pid = PID, bucket = BUCKET): Promise<string> {
  const dir = dirname(await writeKiroSession(root, "", id, bucket));
  await writeKiroLock(dir, pid, NOW - 1000);
  return dir;
}

/** The registered Kiro adapter's own discovery, over the roots its source resolves through. */
function discover(roots: readonly string[]): NonNullable<JournalAdapter["discover"]> {
  const found = kiroJournal(roots).discover;
  if (found === undefined) throw new Error("Kiro discovers its own sessions");
  return found;
}

afterEach(removeKiroSandboxes);

describe("Kiro V3 process-owned discovery", () => {
  test("two panes in the same cwd resolve different exact foreground PIDs", async () => {
    // Given: sessions share workspacePaths but their TUI locks belong to different processes.
    const root = await kiroSandbox();
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
    const root = await kiroSandbox();
    await session(root);
    // When: the pane supplies no exact Kiro TUI process identity.
    const result = await discover([root])("/shared", hint);
    // Then: the workspace alone cannot choose the transcript.
    expect(result).toBeNull();
  });

  test.each([0, -1, 1.5, NaN, Infinity, 4194305])("invalid foreground PID %s is refused", async (pid) => {
    // Given: a session locked by a valid pid, and a hint naming an invalid one.
    const root = await kiroSandbox();
    await session(root);
    // When: discovery receives the process hint.
    const result = await discover([root])("/shared", hints(pid));
    // Then: no session is chosen.
    expect(result).toBeNull();
  });

  test.each([
    { argv: ["bun", "/tmp/unrelated.js", "/home/operator/.local/share/kiro-cli/tui.js"] },
    { argv: ["cat", "/home/operator/.local/share/kiro-cli/tui.js"] },
    { argv: ["bun", "--eval", "/home/operator/.local/share/kiro-cli/tui.js"] },
    { argv: ["kiro-cli-server"] },
  ])("a Kiro string in an unrelated process does not count: %j", async ({ argv }) => {
    // Given: the PID does have a lock, but the pane is not running a Kiro TUI.
    const root = await kiroSandbox();
    await session(root);
    // When: discovery receives the misleading argv.
    const result = await discover([root])("/shared", { processes: [{ pid: PID, argv }] });
    // Then: merely mentioning Kiro does not grant access to its journal.
    expect(result).toBeNull();
  });

  test("the real wrapper process group resolves only the TUI lock owner", async () => {
    // Given: Herdr lists the launcher, CLI wrappers and Bun TUI in one foreground group.
    const root = await kiroSandbox();
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
    const root = await kiroSandbox();
    await session(root);
    // When: the pane cannot distinguish between the owners.
    const result = await discover([root])("/shared", { processes: [foreground(), foreground(PID + 1)] });
    // Then: it cannot choose either transcript.
    expect(result).toBeNull();
  });

  test("resume args are used only when the unique live lock agrees", async () => {
    // Given: the pane was launched with an exact resume ID.
    const root = await kiroSandbox();
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
    const root = await kiroSandbox();
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
    const root = await kiroSandbox();
    await session(root);
    await session(root, OTHER, PID, "bucket-b");
    // When: argv still points to the outgoing ID.
    const result = await discover([root])("/shared", hints(PID, ["--resume-id", ID]));
    // Then: discovery waits for the ownership transfer to settle.
    expect(result).toBeNull();
  });

  test("locks in different configured roots are also checked for ambiguity", async () => {
    // Given: both roots contain a lock for the exact process.
    const root = await kiroSandbox();
    const second = await kiroSandbox();
    await session(root);
    await session(second, OTHER);
    // When: discovery scans the configured roots.
    const result = await discover([root, second])("/shared", hints());
    // Then: root order cannot break a tie.
    expect(result).toBeNull();
  });

  test.each<{ payload: JsonValue }>([
    null, [], {}, { pid: String(PID) }, { pid: 0 }, { pid: PID + 0.5 }, { started_at: new Date(NOW).toISOString() },
  ].map((payload) => ({ payload })))("a lock without a valid pid refuses: %j", async ({ payload }) => {
    // Given: a lock that names no usable pid.
    const root = await kiroSandbox();
    const dir = await session(root);
    await writeFile(join(dir, ".lock"), JSON.stringify(payload));
    // When: the foreground PID is otherwise valid.
    const result = await discover([root])("/shared", hints());
    // Then: invalid lock data never chooses a transcript.
    expect(result).toBeNull();
  });

  test.each(["{partial", " ".repeat(4097)])("invalid or oversized lock content refuses", async (payload) => {
    // Given: a partial or oversized metadata file.
    const root = await kiroSandbox();
    const dir = await session(root);
    await writeFile(join(dir, ".lock"), payload);
    // When: discovery reads it with the small metadata cap.
    const result = await discover([root])("/shared", hints());
    // Then: the invalid file grants no authority.
    expect(result).toBeNull();
  });

  test("a lock outside a bucket's session folders is ignored", async () => {
    // Given: a matching lock beside the buckets and one inside a session's sub-executions folder.
    const root = await kiroSandbox();
    const loose = join(root, "loose");
    await mkdir(loose);
    await writeFile(join(loose, `${ID}.lock`), JSON.stringify({ pid: PID, started_at: new Date(NOW).toISOString() }));
    const parent = await session(root, "unlocked", PID + 1);
    await session(join(parent, "sub-executions"));
    // When: discovery scans the bucket/session folders.
    const result = await discover([root])("/shared", hints());
    // Then: neither lock selects a session.
    expect(result).toBeNull();
  });

  test.each(["bucket", "session", ".lock", "messages.jsonl"])("symlinked %s is refused even into a separate sessions root", async (kind) => {
    // Given: a valid lock reachable through a link to a separate root.
    const root = await kiroSandbox();
    const second = await kiroSandbox();
    const there = await session(second);
    const here = await session(root);
    let link: string;
    let target: string;
    if (kind === "bucket") { link = join(root, BUCKET); target = join(second, BUCKET); }
    else if (kind === "session") { link = here; target = there; }
    else { link = join(here, kind); target = join(there, kind); }
    await rm(link, { recursive: true });
    await symlink(target, link);
    // When: discovery follows the first root only (the second is also a valid configuration).
    const result = await discover([root])("/shared", hints());
    // Then: a link is not an ownership record under the building root.
    expect(result).toBeNull();
  });

  test("a directory in place of .lock refuses", async () => {
    // Given: a folder where the session's lock file belongs.
    const root = await kiroSandbox();
    const dir = await session(root);
    await rm(join(dir, ".lock"));
    await mkdir(join(dir, ".lock"));
    // When: discovery checks the session.
    const result = await discover([root])("/shared", hints());
    // Then: only a regular file is read as a lock.
    expect(result).toBeNull();
  });

  test("a source cache for another copy of the ID cannot select the wrong log", async () => {
    // Given: one old unowned copy has already been resolved and cached.
    const root = await kiroSandbox();
    const otherRoot = await kiroSandbox();
    await session(root, ID, PID + 1);
    await session(otherRoot);
    const journal = kiroJournal([root, otherRoot]);
    expect(await journal.source.resolve({ kind: "id", value: ID })).toBe(join(root, BUCKET, ID, "messages.jsonl"));
    // When: the foreground owner points at the other copy.
    const result = await journal.discover?.("/shared", hints());
    // Then: a source cache cannot override the location established by the live lock.
    expect(result).toBeNull();
  });

  test("an incomplete bounded scan refuses even after finding a candidate", async () => {
    // Given: an exact resumed candidate in a directory with more than the entry cap.
    const root = await kiroSandbox();
    await session(root);
    for (let i = 0; i < 8193; i++) await writeFile(join(root, BUCKET, `noise-${i}`), "");
    // When: lookup considers the argv candidate first but cannot finish the ambiguity scan.
    const result = await discover([root])("/shared", hints(PID, ["--resume-id", ID]));
    // Then: a partial scan never pretends uniqueness.
    expect(result).toBeNull();
  });

  test("cached discovery never survives a changed session directory", async () => {
    // Given: a source has resolved the current session.
    const root = await kiroSandbox();
    const dir = await session(root);
    const find = discover([root]);
    expect(await find("/shared", hints())).toEqual({ kind: "id", value: ID });
    // When: the directory becomes a symlink to a different root.
    const otherRoot = await kiroSandbox();
    const otherDir = await session(otherRoot);
    await rename(dir, `${root}-saved`);
    await symlink(otherDir, dir);
    // Then: discovery checks the new filesystem state rather than returning the old cache.
    expect(await find("/shared", hints())).toBeNull();
  });

  test("resume argv without a V3 lock never discovers a session", async () => {
    // Given: an exact argument and valid metadata, but no current ownership lock.
    const root = await kiroSandbox();
    const dir = await session(root);
    await rm(join(dir, ".lock"));
    // When: discovery sees the startup argument.
    const result = await discover([root])("/shared", hints(PID, ["--resume-id", ID]));
    // Then: args alone cannot identify the active session after a switch.
    expect(result).toBeNull();
  });
});
