import { describe, expect, test } from "bun:test";

import { context, fakeExec, fakeFiles, HOME, type Scripted, type SeededFiles } from "./fakes.ts";
import type { Finding } from "./finding.ts";
import {
  historyFindings,
  JOURNAL_AGENTS,
  paneVerdicts,
  parseIntegrationStatus,
  parseSnapshotPanes,
  readJournalRoots,
  silentPanes,
  type SnapshotPane,
} from "./history.ts";

// `collie doctor`'s history section (issue #137) — the chain that decides whether a pane's
// "Show entire history" link is drawn at all, and which today hides it with no explanation.
//
// Nothing here reaches a Herdr, a bridge or a real home directory: the two system seams are the
// shared fakes (`cli/fakes.ts`), and the snapshot is a string this suite hands over. The parsers are
// pure and are tested as such — they are what a change to Herdr's output would break first.

const CLAUDE_ROOT = `${HOME}/.claude/projects`;

/** A `herdr integration status` carrying one line of each state this build classifies. */
const MIXED_STATUS = [
  "pi: outdated (v6 < v8) (/home/pat/.pi/agent/extensions/herdr-agent-state.ts)",
  "claude: installed (/home/pat/.claude/hooks/herdr-agent-state.sh)",
  "codex: not installed (/home/pat/.codex/herdr-agent-state.sh)",
  "omp: not installed (/home/pat/.omp/agent/extensions/herdr-omp-agent-state.ts)",
].join("\n");

describe("parseIntegrationStatus", () => {
  test("classifies the three states Herdr prints, and keeps the rest of the line verbatim", () => {
    const lines = parseIntegrationStatus(MIXED_STATUS);
    expect(lines.map((l) => [l.agent, l.state])).toEqual([
      ["pi", "outdated"],
      ["claude", "installed"],
      ["codex", "missing"],
      ["omp", "missing"],
    ]);
    expect(lines[0]?.note).toBe("outdated (v6 < v8) (/home/pat/.pi/agent/extensions/herdr-agent-state.ts)");
  });

  test("an agent Collie has no journal for is parsed, not dropped — the caller decides who to report", () => {
    expect(parseIntegrationStatus(MIXED_STATUS).map((l) => l.agent)).toContain("omp");
    expect(JOURNAL_AGENTS).not.toContain("omp");
  });

  test("a state word this build has never seen reads `unknown` rather than healthy", () => {
    expect(parseIntegrationStatus("claude: reinstalling")).toEqual([
      { agent: "claude", state: "unknown", note: "reinstalling" },
    ]);
  });

  test("empty output, blank lines and anything that is not `<agent>: <state>` yield nothing", () => {
    expect(parseIntegrationStatus("")).toEqual([]);
    expect(parseIntegrationStatus("\n\n   \n")).toEqual([]);
    expect(parseIntegrationStatus("Herdr integration report follows")).toEqual([]);
    expect(parseIntegrationStatus("no agents: none are installed")).toEqual([]);
  });
});

describe("parseSnapshotPanes", () => {
  const body = JSON.stringify({
    bridge: "connected",
    agents: [
      { paneId: "w1:p1", agent: "claude", kind: "agent", hasSession: true },
      { paneId: "w2:p5", agent: "claude", kind: "agent" },
      { paneId: "w2:p6", agent: "bash", kind: "shell" },
      { paneId: "w3:p1", agent: "omp", kind: "agent" },
    ],
  });

  test("keeps agent panes only, and reads an absent `hasSession` as false", () => {
    expect(parseSnapshotPanes(body)).toEqual([
      { paneId: "w1:p1", agent: "claude", hasSession: true },
      { paneId: "w2:p5", agent: "claude", hasSession: false },
      { paneId: "w3:p1", agent: "omp", hasSession: false },
    ]);
  });

  test("a body that is not JSON is `null`; one that is JSON without panes is an empty list", () => {
    expect(parseSnapshotPanes("<html>502</html>")).toBeNull();
    expect(parseSnapshotPanes("")).toEqual([]);
    expect(parseSnapshotPanes(JSON.stringify({ bridge: "disconnected" }))).toEqual([]);
  });

  test("a pane missing its id or its agent is dropped rather than reported under an empty name", () => {
    const partial = JSON.stringify({ agents: [{ kind: "agent", agent: "claude" }, { kind: "agent", paneId: "w1:p1" }] });
    expect(parseSnapshotPanes(partial)).toEqual([]);
  });
});

describe("the per-pane verdict", () => {
  const panes: SnapshotPane[] = [
    { paneId: "w1:p1", agent: "claude", hasSession: true },
    { paneId: "w2:p5", agent: "claude", hasSession: false },
    { paneId: "w3:p1", agent: "omp", hasSession: false },
  ];

  test("a pane is journalled when THIS build has an adapter for its agent, never by its name alone", () => {
    expect(paneVerdicts(panes).map((v) => [v.pane.paneId, v.journalled])).toEqual([
      ["w1:p1", true],
      ["w2:p5", true],
      ["w3:p1", false],
    ]);
  });

  test("only a journalled pane with no session hides its link silently — the other two are honest", () => {
    expect(silentPanes(paneVerdicts(panes)).map((v) => v.pane.paneId)).toEqual(["w2:p5"]);
  });
});

describe("readJournalRoots", () => {
  test("resolves every harness's root from the given env and home, exactly as the bridge does", () => {
    const files = fakeFiles({ [`${CLAUDE_ROOT}/-home-pat-repo/9f3c.jsonl`]: "{}" });
    const readings = readJournalRoots({}, HOME, files);
    expect(readings.map((r) => r.agent).toSorted()).toEqual([...JOURNAL_AGENTS].toSorted());
    const claude = readings.find((r) => r.agent === "claude");
    expect(claude?.path).toBe(CLAUDE_ROOT);
    expect(claude?.exists).toBe(true);
    expect(claude?.entries).toBe(1);
  });

  test("COLLIE_TRANSCRIPT_ROOT takes several roots, and each is probed on its own", () => {
    const files = fakeFiles({ "/srv/a/x.jsonl": "{}" });
    const readings = readJournalRoots({ COLLIE_TRANSCRIPT_ROOT: "/srv/a, /srv/b" }, HOME, files).filter(
      (r) => r.agent === "claude",
    );
    expect(readings.map((r) => [r.path, r.exists])).toEqual([
      ["/srv/a", true],
      ["/srv/b", false],
    ]);
  });
});

// ── The findings ─────────────────────────────────────────────────────────────

const HEALTHY_STATUS = JOURNAL_AGENTS.map((a) => `${a}: installed (/home/pat/.${a}/hook.sh)`).join("\n");

/** A snapshot body with the given panes, as `/api/snapshot` serialises them. */
const snapshotOf = (agents: { paneId: string; agent: string; hasSession?: boolean }[]): string =>
  JSON.stringify({ bridge: "connected", agents: agents.map((a) => ({ ...a, kind: "agent" })) });

async function run(
  over: {
    status?: string;
    files?: SeededFiles;
    env?: Record<string, string | undefined>;
    absent?: string[];
    snapshot?: string | null;
  } = {},
): Promise<Map<string, Finding>> {
  const answers: Scripted["answers"] = [
    ["herdr --version", { stdout: "herdr 0.8.2\n" }],
    ["herdr integration status", { stdout: over.status ?? HEALTHY_STATUS }],
  ];
  const findings = await historyFindings({
    ctx: context(over.env ?? {}),
    exec: fakeExec({ answers, absent: over.absent }),
    files: fakeFiles(over.files ?? { [`${CLAUDE_ROOT}/-home-pat-repo/9f3c.jsonl`]: "{}" }),
    snapshot: async () => (over.snapshot === undefined ? snapshotOf([]) : over.snapshot),
  });
  return new Map(findings.map((f) => [f.check, f]));
}

describe("the history section", () => {
  test("a host with current hooks and a readable root passes every line", async () => {
    const byCheck = await run();
    expect(byCheck.get("herdr-version")?.detail).toBe("herdr 0.8.2");
    expect(byCheck.get("integration-claude")?.status).toBe("ok");
    expect(byCheck.get("hook-python3")?.status).toBe("ok");
    expect(byCheck.get("journal-roots")?.status).toBe("ok");
    expect([...byCheck.values()].some((f) => f.status === "error")).toBe(false);
  });

  test("every non-ok line names a remedy, and an ok line names none", async () => {
    for (const finding of (await run({ status: MIXED_STATUS, absent: ["python3", "herdr"] })).values()) {
      expect(finding.remedy === null).toBe(finding.status === "ok");
    }
  });

  test("a missing hook is only an ERROR when a pane of that agent is running without a session", async () => {
    // Nothing of codex's is hidden, so an absent codex hook is not a fault — an operator who learns
    // to ignore one yellow line ignores the next. An OUTDATED one is still ours, so it still warns.
    const quiet = await run({ status: MIXED_STATUS, snapshot: snapshotOf([]) });
    expect(quiet.get("integration-codex")?.status).toBe("ok");
    expect(quiet.get("integration-pi")?.status).toBe("warn");

    const loud = await run({
      status: MIXED_STATUS,
      snapshot: snapshotOf([{ paneId: "w2:p5", agent: "codex" }]),
    });
    expect(loud.get("integration-codex")?.status).toBe("error");
    expect(loud.get("integration-codex")?.remedy).toContain("herdr integration install codex");
    expect(loud.get("integration-codex")?.detail).toContain("w2:p5");
  });

  test("an installed hook with a pane that predates it says so, and asks for a restart — not an install", async () => {
    const byCheck = await run({ snapshot: snapshotOf([{ paneId: "w2:p5", agent: "claude" }]) });
    expect(byCheck.get("integration-claude")?.status).toBe("warn");
    expect(byCheck.get("integration-claude")?.remedy).toContain("restart claude in w2:p5");
  });

  test("agent-sessions names the panes whose History link is hidden, and passes when none is", async () => {
    const bad = await run({
      snapshot: snapshotOf([
        { paneId: "w1:p1", agent: "claude", hasSession: true },
        { paneId: "w2:p5", agent: "claude" },
        { paneId: "w3:p1", agent: "omp" },
      ]),
    });
    expect(bad.get("agent-sessions")?.status).toBe("error");
    expect(bad.get("agent-sessions")?.detail).toContain("w2:p5 (claude)");
    // A pane whose agent has no journal adapter has no History to hide, so it is never named.
    expect(bad.get("agent-sessions")?.detail).not.toContain("w3:p1");

    const good = await run({ snapshot: snapshotOf([{ paneId: "w1:p1", agent: "claude", hasSession: true }]) });
    expect(good.get("agent-sessions")?.status).toBe("ok");
  });

  test("a bridge that does not answer is `skipped`, never a pass — and takes nothing else down", async () => {
    const byCheck = await run({ snapshot: null });
    expect(byCheck.get("agent-sessions")?.status).toBe("skipped");
    expect(byCheck.get("integration-claude")?.status).toBe("ok");
  });

  test("`herdr integration status` that says nothing leaves every agent skipped, never ok", async () => {
    const byCheck = await run({ status: "" });
    for (const agent of JOURNAL_AGENTS) expect(byCheck.get(`integration-${agent}`)?.status).toBe("skipped");
  });

  test("no python3 is an error: the hook needs it and exits silently without it", async () => {
    const byCheck = await run({ absent: ["python3"] });
    expect(byCheck.get("hook-python3")?.status).toBe("error");
  });

  test("COLLIE_TRANSCRIPT off is reported for what it is — no journal is read at all", async () => {
    const byCheck = await run({ env: { COLLIE_TRANSCRIPT: "0" } });
    expect(byCheck.get("journal-roots")?.status).toBe("warn");
    expect(byCheck.get("journal-roots")?.detail).toContain("COLLIE_TRANSCRIPT is off");
  });

  test("no journal root on disk warns, and a present-but-unlistable one says which", async () => {
    const none = await run({ files: {} });
    expect(none.get("journal-roots")?.status).toBe("warn");
    expect(none.get("journal-roots")?.detail).toContain("none of the 5 journal roots is there");

    // `list` answers `[]` for a directory this user cannot read AND for an empty one; the finding
    // says both, because the seam cannot tell them apart and a doctor may not guess.
    const blind = await run({ files: { [CLAUDE_ROOT]: "" } });
    expect(blind.get("journal-roots")?.status).toBe("warn");
    expect(blind.get("journal-roots")?.detail).toContain("empty, or not readable by you");
  });

  test("the roots line always says whose home they came from — the bridge resolves its own", async () => {
    expect((await run()).get("journal-roots")?.detail).toContain("the BRIDGE resolves them from ITS OWN user's home");
  });
});
