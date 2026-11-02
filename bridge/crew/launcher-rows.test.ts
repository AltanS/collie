import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeLaunchers } from "../launcher-adds.ts";
import type { AddedLauncher } from "../launchers-added.ts";
import type { HarnessInfo, Launcher, LauncherItem, LaunchersResponse } from "../types.ts";
import {
  CWD_PARAM,
  folderAnswers,
  folderOnMember,
  folderQuestion,
  folderQuestions,
  leadRowsRead,
  MAX_FOLDER_QUESTIONS,
  parseMemberLaunchers,
  withFolderQuestions,
  withLeadRows,
  type LeadRows,
} from "./launcher-rows.ts";

const LEAD_HOME = "/var/home/op";
const MEMBER_HOME = "/home/op";
const SWITCHES = { adds: true, freeText: true, run: true };
const HARNESSES: HarnessInfo[] = [
  { id: "claude", label: "Claude Code", found: true },
  { id: "codex", label: "Codex", found: false },
];

function lead(operator: Launcher[], added: AddedLauncher[] = []): LeadRows {
  return { merged: mergeLaunchers(operator, added, SWITCHES), file: "/var/home/op/.config/collie/launchers.toml", home: LEAD_HOME };
}

/** A member's own item, as its own `launcherItems` builds one. */
function ownRow(command: string, label: string): LauncherItem {
  return {
    key: `row:${command}`,
    start: { command },
    group: "commands",
    label,
    command,
    source: "operator",
    noPrompts: false,
    branch: false,
    available: true,
  };
}

function member(over: Partial<LaunchersResponse> = {}): LaunchersResponse {
  return {
    launchers: [{ command: "htop", label: "Top (member)", source: "operator", kind: "command", noPrompts: false }],
    home: MEMBER_HOME,
    harnesses: HARNESSES,
    items: [
      { key: "starter:p1", start: { starter: "p1" }, group: "agents", label: "Program", source: "program", noPrompts: false, branch: false, available: true },
      ownRow("htop", "Top (member)"),
    ],
    recentRuns: [{ line: "ls", cwd: null, at: 1, noPrompts: false, available: true }],
    ...over,
  };
}

describe("a pinned folder is asked under the member's home", () => {
  test("a folder under the lead's home is asked as `~/...`; any other path as it is", () => {
    expect(folderQuestion("/var/home/op", LEAD_HOME)).toBe("~");
    expect(folderQuestion("/var/home/op/src/app", LEAD_HOME)).toBe("~/src/app");
    expect(folderQuestion("/srv/data", LEAD_HOME)).toBe("/srv/data");
    expect(folderQuestion("/var/home/opx", LEAD_HOME)).toBe("/var/home/opx");
    expect(folderQuestion("relative/dir", LEAD_HOME)).toBe("relative/dir");
  });

  test("the member reads `~` as its own home, with its own separator", () => {
    expect(folderOnMember("~", MEMBER_HOME)).toBe(MEMBER_HOME);
    expect(folderOnMember("~/src/app", MEMBER_HOME)).toBe("/home/op/src/app");
    expect(folderOnMember("~/src/app", "C:\\Users\\op")).toBe("C:\\Users\\op\\src\\app");
    expect(folderOnMember("/srv/data", MEMBER_HOME)).toBe("/srv/data");
  });

  test("each pinned folder is asked once, at most fifty, and a relative one not at all", () => {
    const rows: Launcher[] = [
      { command: "a", label: "a", cwd: "/var/home/op/src" },
      { command: "b", label: "b", cwd: "/var/home/op/src" },
      { command: "c", label: "c" },
      { command: "d", label: "d", cwd: "rel" },
    ];
    expect(folderQuestions(lead(rows).merged, LEAD_HOME)).toEqual(["~/src"]);
    const many = Array.from({ length: 60 }, (_, i): Launcher => ({ command: `r${String(i)}`, label: "r", cwd: `/srv/${String(i)}` }));
    expect(folderQuestions(lead(many).merged, LEAD_HOME)).toHaveLength(MAX_FOLDER_QUESTIONS);
  });

  test("the lead's questions replace any `cwd` the phone put on its URL", () => {
    const asked = withFolderQuestions(new URL("https://lead/api/launchers?host=m&cwd=/etc"), ["~/src", "/srv/data"]);
    expect(asked.searchParams.getAll(CWD_PARAM)).toEqual(["~/src", "/srv/data"]);
    expect(asked.searchParams.get("host")).toBe("m");
  });
});

describe("the member answers the folder questions", () => {
  test("`~` is this machine's home; a path that is not absolute is no folder; at most fifty", () => {
    const seen: string[] = [];
    const isFolder = (path: string): boolean => {
      seen.push(path);
      return path !== "/home/op/gone";
    };
    expect(folderAnswers(["~/src", "~/gone", "/srv", "rel"], MEMBER_HOME, isFolder)).toEqual({
      "~/src": true,
      "~/gone": false,
      "/srv": true,
      rel: false,
    });
    expect(seen).toEqual(["/home/op/src", "/home/op/gone", "/srv"]);
    const many = Array.from({ length: 60 }, (_, i) => `/srv/${String(i)}`);
    expect(Object.keys(folderAnswers(many, MEMBER_HOME, () => true))).toHaveLength(MAX_FOLDER_QUESTIONS);
  });

  test("on the disk: a folder is true, a file and a missing path are false", () => {
    const home = mkdtempSync(join(tmpdir(), "collie-launcher-rows-"));
    try {
      mkdirSync(join(home, "src"));
      writeFileSync(join(home, "notes.txt"), "x");
      expect(folderAnswers(["~/src", "~/notes.txt", "~/nope", "~/bad\u0000"], home)).toEqual({
        "~/src": true,
        "~/notes.txt": false,
        "~/nope": false,
        "~/bad\u0000": false,
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("the lead's rows in a member's answer", () => {
  const rows: Launcher[] = [
    { command: "make test", label: "Tests", cwd: "/var/home/op/src/app" },
    { command: "htop", label: "Top (lead)" },
    { command: "claude --resume", label: "Claude resume", harness: "claude", kind: "agent" },
    { command: "du -sh", label: "Disk", cwd: "/srv/data" },
  ];

  test("the member's items come first, then the lead's, each marked `from: \"lead\"`", () => {
    const out = withLeadRows(member(), lead(rows));
    expect(out.items!.map((i) => [i.key, i.from])).toEqual([
      ["starter:p1", undefined],
      ["row:htop", undefined],
      ["row:claude --resume", "lead"],
      ["row:make test", "lead"],
      ["row:du -sh", "lead"],
    ]);
    // Keys stay unique in one answer: the lead's `htop` was dropped for the member's own.
    expect(new Set(out.items!.map((i) => i.key)).size).toBe(out.items!.length);
  });

  test("the member's own row wins on the same command: its label, and no lead copy", () => {
    const out = withLeadRows(member(), lead(rows));
    const htop = out.items!.filter((i) => i.command === "htop");
    expect(htop).toHaveLength(1);
    expect(htop[0]!.label).toBe("Top (member)");
    expect(htop[0]!.from).toBeUndefined();
  });

  test("the built-in agents and the shell are the member's alone; the lead adds rows only", () => {
    const out = withLeadRows(member(), lead(rows));
    const fromLead = out.items!.filter((i) => i.from === "lead");
    expect(fromLead.every((i) => i.key.startsWith("row:"))).toBe(true);
  });

  test("a pinned folder the member says is absent reads `no_folder`; a present one stays available", () => {
    const out = withLeadRows(member({ folders: { "~/src/app": false, "/srv/data": true } }), lead(rows));
    const tests = out.items!.find((i) => i.command === "make test")!;
    expect(tests).toMatchObject({ available: false, reason: "no_folder", cwd: "/home/op/src/app", from: "lead" });
    const disk = out.items!.find((i) => i.command === "du -sh")!;
    expect(disk.available).toBe(true);
    expect(disk.reason).toBeUndefined();
    expect(disk.cwd).toBe("/srv/data");
  });

  test("a member that predates 0127 answers no `folders`: the lead's rows stay as the harness check says", () => {
    const out = withLeadRows(member(), lead(rows));
    const fromLead = out.items!.filter((i) => i.from === "lead");
    expect(fromLead.every((i) => i.available)).toBe(true);
    expect(fromLead.find((i) => i.command === "make test")!.cwd).toBe("/home/op/src/app");
  });

  test("`adding` is the lead's, `folders` goes, and the rest stays the member's", () => {
    const answer = member({ folders: { "~/src/app": true } });
    const out = withLeadRows(answer, lead(rows));
    expect(out.adding!.file).toBe("/var/home/op/.config/collie/launchers.toml");
    expect(out.folders).toBeUndefined();
    expect(out.home).toBe(MEMBER_HOME);
    expect(out.launchers).toEqual(answer.launchers);
    expect(out.harnesses).toEqual(HARNESSES);
    expect(out.recentRuns).toEqual(answer.recentRuns);
  });

  test("a member with no `items` (older than 1.19.0) is answered as forwarded", () => {
    const old: LaunchersResponse = { launchers: [], home: MEMBER_HOME };
    expect(withLeadRows(old, lead(rows))).toEqual(old);
  });
});

describe("the member's body, read on the lead", () => {
  test("a launcher answer parses; `folders` keeps its booleans only", () => {
    const parsed = parseMemberLaunchers(JSON.stringify({ ...member(), folders: { "~/a": true, "~/b": "yes" } }));
    expect(parsed?.folders).toEqual({ "~/a": true });
    expect(parsed?.items).toHaveLength(2);
  });

  test("anything else is not one", () => {
    expect(parseMemberLaunchers("not json")).toBeNull();
    expect(parseMemberLaunchers("[]")).toBeNull();
    expect(parseMemberLaunchers(JSON.stringify({ launchers: [] }))).toBeNull();
    expect(parseMemberLaunchers(JSON.stringify({ launchers: [], home: "/h", items: [{ key: 1 }] }))).toBeNull();
    expect(parseMemberLaunchers(JSON.stringify({ launchers: [], home: "/h", harnesses: [{ id: "x" }] }))).toBeNull();
  });
});

describe("leadRowsRead — the forward's merge", () => {
  const rows: Launcher[] = [{ command: "make test", label: "Tests", cwd: "/var/home/op/src/app" }];

  function merge() {
    let reads = 0;
    const read = leadRowsRead(
      () => {
        reads += 1;
        return Promise.resolve({ ...lead(rows), home: LEAD_HOME });
      },
      (body) => Response.json(body),
    );
    return { read, reads: () => reads };
  }

  test("the member is asked the lead's folder questions, and the lead's rows are read once", async () => {
    const { read, reads } = merge();
    const asked = await read.ask(new URL("https://lead/api/launchers?host=m"));
    expect(asked.searchParams.getAll(CWD_PARAM)).toEqual(["~/src/app"]);
    const res = await read.answer(Response.json({ ...member(), folders: { "~/src/app": false } }));
    // SAFETY: `respond` above is `Response.json` of a `LaunchersResponse`, the only body this answers with.
    const body = (await res.json()) as LaunchersResponse;
    expect(body.items!.at(-1)).toMatchObject({ command: "make test", from: "lead", reason: "no_folder" });
    expect(reads()).toBe(1);
  });

  test("an error, or a body that is not a launcher answer, goes on as forwarded", async () => {
    const { read } = merge();
    const refused = new Response("host unreachable", { status: 503 });
    expect(await read.answer(refused)).toBe(refused);
    const odd = await read.answer(new Response("not json", { status: 200, headers: { "content-type": "text/plain" } }));
    expect(odd.status).toBe(200);
    expect(await odd.text()).toBe("not json");
  });
});
