import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { draftIssue, ISSUE_LABEL, labelExists, LEDGER_REL, moveProfile, openIssue, profileRel, publishPass, realGit, writeIssueFiles, type Git, type GitResult, type PassInput } from "./publish";
import { type RedactContext } from "./redact";
import { judge, type LabFacts, type ScreenFact } from "./verdict";

const ROOT = join(import.meta.dir, "..", "..", "..");
const PROFILE = readFileSync(join(ROOT, profileRel("claude")), "utf8");
const ctx: RedactContext = { home: "/home/alice", user: "alice", host: "bluefin", labDirs: [] };

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "lab-publish-"));
  dirs.push(dir);
  return dir;
};

/** A throwaway repo with the two files a pass commit moves and one that it must leave alone. */
function makeRepo(): string {
  const repo = join(temp(), "repo");
  mkdirSync(join(repo, "web", "src", "lib", "harness"), { recursive: true });
  mkdirSync(join(repo, "web", "src", "lib", "surface", "profiles"), { recursive: true });
  cpSync(join(ROOT, LEDGER_REL), join(repo, LEDGER_REL));
  cpSync(join(ROOT, profileRel("claude")), join(repo, profileRel("claude")));
  writeFileSync(join(repo, "README.md"), "# fixture\n");
  const git = (...args: string[]): void => {
    const done = realGit(repo, args);
    if (done.code !== 0) throw new Error(done.stderr);
  };
  git("init", "--quiet", "--initial-branch=main");
  git("-c", "user.name=t", "-c", "user.email=t@t", "add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "init");
  return repo;
}

describe("moveProfile", () => {
  test("moves the range end, verifiedThrough and verifiedOn, and nothing else", () => {
    const moved = moveProfile(PROFILE, "2.1.301", "2026-10-16");
    expect(moved).toContain('"verifiedThrough": "2.1.301"');
    expect(moved).toContain('"verifiedOn": "2026-10-16"');
    expect(moved).toContain('"range": "2.1.0 - 2.1.301"');
    const changed = moved.split("\n").filter((line, i) => line !== PROFILE.split("\n")[i]);
    expect(changed).toHaveLength(3);
  });

  test("a version that is not newer is refused", () => {
    expect(() => moveProfile(PROFILE, "2.1.296", "2026-10-16")).toThrow(/not newer/);
    expect(() => moveProfile(PROFILE, "2.1.100", "2026-10-16")).toThrow(/not newer/);
  });
});

describe("publishPass", () => {
  const input = (repo: string, labRoot: string): PassInput => ({ repo, labRoot, harness: "claude", version: "2.1.301", date: "2026-10-16", log: "line one\nline two", evidence: "harness lab run" });

  test("one commit on its own branch in a scratch worktree, touching exactly two files, never pushing", () => {
    const repo = makeRepo();
    const labRoot = temp();
    const calls: string[][] = [];
    const spy: Git = (cwd, args, env) => {
      calls.push([...args]);
      return realGit(cwd, args, env);
    };
    const done = publishPass(input(repo, labRoot), spy);
    expect(done.branch).toBe("harness-lab/claude-2.1.301");
    expect(done.worktree.startsWith(join(labRoot, "worktrees"))).toBe(true);
    const shown = realGit(done.worktree, ["show", "--stat", "--format=%B", "HEAD"]).stdout;
    expect(shown).toContain("Harness lab: claude 2.1.301 verified");
    expect(shown).toContain("line two");
    const files = realGit(done.worktree, ["show", "--name-only", "--format=", "HEAD"]).stdout.trim().split("\n").toSorted();
    expect(files).toEqual([LEDGER_REL, profileRel("claude")].toSorted());
    expect(JSON.parse(readFileSync(join(done.worktree, LEDGER_REL), "utf8")).agents.claude.version).toBe("2.1.301");
    expect(calls.some((args) => args.includes("push"))).toBe(false);
    expect(realGit(repo, ["remote"]).stdout.trim()).toBe("");
    // The repo it branched from is untouched: still on main, still clean, still at the old version.
    expect(realGit(repo, ["status", "--porcelain"]).stdout.trim()).toBe("");
    expect(JSON.parse(readFileSync(join(repo, LEDGER_REL), "utf8")).agents.claude.version).not.toBe("2.1.301");
  });

  test("a second run on the same pair refuses and changes nothing", () => {
    const repo = makeRepo();
    const labRoot = temp();
    publishPass(input(repo, labRoot));
    expect(() => publishPass(input(repo, labRoot))).toThrow(/exists already/);
  });

  test("a commit body longer than the cap is cut and says so", () => {
    const repo = makeRepo();
    const labRoot = temp();
    const log = Array.from({ length: 300 }, (_, i) => `line ${String(i)}`).join("\n");
    const done = publishPass({ ...input(repo, labRoot), log });
    const body = realGit(done.worktree, ["log", "-1", "--format=%B"]).stdout;
    expect(body).toContain("more lines in the run log");
    expect(body).not.toContain("line 299");
  });
});

describe("the fail issue", () => {
  const screenFree: ScreenFact = { leg: "walk", label: "/model", expects: "dialog", surface: { turn: "unknown", composer: "unknown", modal: "ask" }, free: true, cue: "strong", rows: ["Select model for alice on bluefin", "  1. Default", "token sk-ant-abcdefghijklmnop1234", "/home/alice/project"] };
  const facts: LabFacts = {
    harness: "claude",
    version: "2.1.301",
    profile: "provisional",
    walk: { reached: true, returned: true, menuRead: true, startedTurn: null, sent: ["/model"], unclassified: ["/new-thing"], missing: [] },
    screens: [screenFree],
    send: { outcome: "sent", probed: true, keys: 3 },
    ask: null,
    turns: 1,
  };

  test("the issue has a title, the harness-drift label, the verdicts, the counters and redacted screens", () => {
    const verdict = judge(facts);
    const issue = draftIssue(facts, verdict, "log line for alice", ["send ledger: 1"], ctx);
    expect(issue.title).toBe("Harness drift: claude 2.1.301 fails the nightly lab");
    expect(issue.labels).toEqual([ISSUE_LABEL]);
    expect(issue.body).toContain("/model is a dialog and the Surface read it free");
    expect(issue.body).toContain("send ledger: 1");
    expect(issue.body).toContain("/new-thing");
    expect(issue.body).not.toContain("alice");
    expect(issue.body).not.toContain("bluefin");
    expect(issue.body).not.toContain("sk-ant");
  });

  test("the files are written under the lab root, and gh is not called", () => {
    const labRoot = temp();
    const issue = draftIssue(facts, judge(facts), "log", [], ctx);
    const files = writeIssueFiles(labRoot, "claude", "2.1.301", issue);
    expect(files.json).toBe(join(labRoot, "issues", "claude-2.1.301.json"));
    expect(JSON.parse(readFileSync(files.json, "utf8"))).toMatchObject({ title: issue.title, labels: ["harness-drift"] });
    expect(readFileSync(files.markdown, "utf8")).toBe(issue.body);
    expect(existsSync(files.markdown)).toBe(true);
  });

  test("gh issue create runs only through openIssue, after the label is checked", () => {
    const labRoot = temp();
    const issue = draftIssue(facts, judge(facts), "log", [], ctx);
    const files = writeIssueFiles(labRoot, "claude", "2.1.301", issue);
    const seen: (readonly string[])[] = [];
    const gh = (args: readonly string[]): GitResult => {
      seen.push(args);
      return args[0] === "label" ? { code: 0, stdout: JSON.stringify([{ name: "bug" }, { name: "harness-drift" }]), stderr: "" } : { code: 0, stdout: "https://github.com/AltanS/collie/issues/1\n", stderr: "" };
    };
    expect(openIssue(files, issue, "AltanS/collie", gh)).toBe("https://github.com/AltanS/collie/issues/1");
    expect(seen[0]).toEqual(expect.arrayContaining(["label", "list", "--repo", "AltanS/collie"]));
    expect(seen[1]).toEqual(expect.arrayContaining(["issue", "create", "--repo", "AltanS/collie", "--label", "harness-drift", "--body-file", files.markdown]));
    expect(() => openIssue(files, issue, "AltanS/collie", (args) => (args[0] === "label" ? gh(args) : { code: 1, stdout: "", stderr: "no" }))).toThrow(/gh issue create failed/);
  });

  test("a missing label stops openIssue before any issue is created, and the message says so", () => {
    const labRoot = temp();
    const issue = draftIssue(facts, judge(facts), "log", [], ctx);
    const files = writeIssueFiles(labRoot, "claude", "2.1.301", issue);
    const verbs: string[] = [];
    const gh = (args: readonly string[]): GitResult => {
      verbs.push(args.slice(0, 2).join(" "));
      return { code: 0, stdout: JSON.stringify([{ name: "bug" }]), stderr: "" };
    };
    expect(() => openIssue(files, issue, "AltanS/collie", gh)).toThrow(/label "harness-drift" does not exist in AltanS\/collie/);
    expect(verbs).toEqual(["label list"]);
    expect(() => labelExists("AltanS/collie", "x", () => ({ code: 1, stdout: "", stderr: "denied" }))).toThrow(/gh label list failed/);
  });

  test("the pass commit body states the real send and ask results", () => {
    const repo = makeRepo();
    const labRoot = temp();
    const done = publishPass({ repo, labRoot, harness: "claude", version: "2.1.301", date: "2026-10-16", log: "x", evidence: "one probed send (sent), one ask answer (effective, declined file made: false)" });
    const body = realGit(done.worktree, ["log", "-1", "--format=%B"]).stdout;
    expect(body).toContain("Result: one probed send (sent), one ask answer (effective, declined file made: false).");
  });
});
