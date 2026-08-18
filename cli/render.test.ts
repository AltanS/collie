import { describe, expect, test } from "bun:test";

import {
  plainAdd,
  plainUpdate,
  projectAdd,
  projectUpdate,
  renderInputs,
  takePlainFlag,
  wantsRich,
  type AddEvent,
  type UpdateEvent,
} from "./render.ts";

// The whole point of this seam is that the plain path is what runs unless three things are all true
// at once. Every suite in `cli/` and both shell suites depend on that: they capture output from a
// non-TTY, and if the rich branch could ever be chosen there, every golden in the repo would be
// wrong. So the rule is pinned exhaustively rather than by example.

describe("wantsRich", () => {
  test("only a terminal that is not CI and was not overridden gets the drawn view", () => {
    const table: [boolean, boolean, boolean, boolean][] = [
      // isTTY, ci,    plain, rich
      [true, false, false, true],
      [true, false, true, false],
      [true, true, false, false],
      [true, true, true, false],
      [false, false, false, false],
      [false, false, true, false],
      [false, true, false, false],
      [false, true, true, false],
    ];
    for (const [isTTY, ci, plain, rich] of table) {
      expect(wantsRich({ isTTY, ci, plain })).toBe(rich);
    }
  });
});

describe("renderInputs", () => {
  test("a pipe is never a terminal, whatever the environment says", () => {
    expect(renderInputs({}, false, false).isTTY).toBe(false);
    expect(renderInputs({ CI: "true" }, true, false).isTTY).toBe(true);
  });

  test("CI counts however the runner spells it", () => {
    for (const value of ["1", "true", "TRUE", "yes", "woodpecker"]) {
      expect(renderInputs({ CI: value }, true, false).ci).toBe(true);
    }
  });

  test("CI unset, empty, `false` or `0` is not CI — an exported-but-empty CI is a laptop", () => {
    for (const value of [undefined, "", "   ", "false", "FALSE", "0"]) {
      expect(renderInputs({ CI: value }, true, false).ci).toBe(false);
    }
  });
});

describe("takePlainFlag", () => {
  test("takes the flag out wherever it sits, and leaves everything else in order", () => {
    expect(takePlainFlag(["--plain", "pack", "status"])).toEqual({ plain: true, rest: ["pack", "status"] });
    expect(takePlainFlag(["pack", "status", "--plain"])).toEqual({ plain: true, rest: ["pack", "status"] });
    expect(takePlainFlag(["pack", "--plain", "status"])).toEqual({ plain: true, rest: ["pack", "status"] });
  });

  test("no flag leaves argv untouched", () => {
    expect(takePlainFlag(["logs", "200"])).toEqual({ plain: false, rest: ["logs", "200"] });
    expect(takePlainFlag([])).toEqual({ plain: false, rest: [] });
  });

  test("only the exact spelling is taken — a value that merely starts with it survives", () => {
    expect(takePlainFlag(["join", "--label", "--plainly"])).toEqual({
      plain: false,
      rest: ["join", "--label", "--plainly"],
    });
    expect(takePlainFlag(["--plain=1"])).toEqual({ plain: false, rest: ["--plain=1"] });
  });
});

// ── `pack add`'s two readers ─────────────────────────────────────────────────
// One event stream, two renderings. The plain one is pinned to the byte, because `cli/remote.test.ts`
// and `scripts/collie-cli.test.sh` are goldens of it and an operator's scripts read it; the
// projection is pinned to its structure, because that is what `cli/ui/pack-add.tsx` draws.

describe("plainAdd", () => {
  const lines = (...events: AddEvent[]): { out: string[]; err: string[] } => {
    const out: string[] = [];
    const err: string[] = [];
    for (const event of events) plainAdd({ out: (l) => out.push(l), err: (l) => err.push(l) }, event);
    return { out, err };
  };

  test("the ✓ rows keep their columns — including the one `git`/`bun` have always been short", () => {
    const { out } = lines(
      { kind: "fact", name: "git", value: "/usr/bin/git" },
      { kind: "fact", name: "herdr", value: "/usr/local/bin/herdr" },
      { kind: "fact", name: "config", value: "/cfg" },
      { kind: "fact", name: "address", value: "1.2.3.4:8787 (what this lead will dial)" },
      { kind: "fact", name: "port", value: "8787 free" },
      { kind: "leg-done", leg: "install", ok: true, detail: "1.2.3 at /root" },
      { kind: "leg-done", leg: "configure", ok: true, detail: "already 1.2.3.4:8787" },
      { kind: "leg-done", leg: "enroll", ok: true, detail: "nas answered the invite" },
    );
    expect(out).toEqual([
      "✓ git       /usr/bin/git",
      "✓ herdr      /usr/local/bin/herdr",
      "✓ config     /cfg",
      "✓ address    1.2.3.4:8787 (what this lead will dial)",
      "✓ port       8787 free",
      "✓ install    1.2.3 at /root",
      "✓ bind       already 1.2.3.4:8787",
      "✓ enrolled   nas answered the invite",
    ]);
  });

  test("only the events that ever had a line print one, and each keeps its stream", () => {
    const { out, err } = lines(
      { kind: "title", host: "nas" },
      { kind: "leg-start", leg: "probe", text: "probing nas…" },
      { kind: "leg-start", leg: "install", text: "" },
      { kind: "line", text: "warn: no ss there", tone: "warn", stream: "out" },
      { kind: "line", text: "error: it failed", tone: "error", stream: "err" },
      { kind: "restart-begin", label: "bridge restarted (collie) · 1.2.3" },
      { kind: "restart-end", ok: true },
      { kind: "leg-done", leg: "probe", ok: true, detail: "ready" },
      { kind: "leg-done", leg: "install", ok: false, detail: "" },
      { kind: "verdict", ok: false, text: "pack add did not finish (exit 1)" },
      { kind: "verdict", ok: true, text: '"nas" is a member of "home"' },
    );
    // The title, a silent leg-start, both restart brackets, the probe's own done, a failed leg and a
    // failed verdict are all silent — the `error:` lines are the failure's report, as they always were.
    expect(out).toEqual(["probing nas…", "warn: no ss there", '✓ "nas" is a member of "home"']);
    expect(err).toEqual(["error: it failed"]);
  });
});

describe("projectAdd", () => {
  const START: AddEvent[] = [
    { kind: "title", host: "nas" },
    { kind: "leg-start", leg: "probe", text: "probing nas…" },
    { kind: "fact", name: "git", value: "/usr/bin/git" },
  ];

  test("legs are all four, in order, and carry what was said while each was running", () => {
    const view = projectAdd([
      ...START,
      { kind: "leg-done", leg: "probe", ok: true, detail: "nas is ready" },
      { kind: "leg-start", leg: "install", text: "" },
      { kind: "line", text: "  pushing abc123…", tone: "info", stream: "out" },
    ]);
    expect(view.host).toBe("nas");
    expect(view.facts).toEqual([{ name: "git", value: "/usr/bin/git" }]);
    expect(view.legs.map((l) => [l.leg, l.status])).toEqual([
      ["probe", "done"],
      ["install", "active"],
      ["configure", "pending"],
      ["enroll", "pending"],
    ]);
    expect(view.legs[0]!.detail).toBe("nas is ready");
    expect(view.legs[1]!.notes).toEqual([{ text: "  pushing abc123…", tone: "info" }]);
  });

  test("a restart that worked is one row; the block it printed is not shown at all", () => {
    const view = projectAdd([
      ...START,
      { kind: "restart-begin", label: "bridge restarted (collie-v1) · 1.0.0+abc" },
      { kind: "line", text: "bridge stopped", tone: "info", stream: "out" },
      { kind: "line", text: "│ Collie is running │", tone: "info", stream: "out" },
      { kind: "restart-end", ok: true },
    ]);
    expect(view.legs[0]!.notes).toEqual([
      { text: "↻ bridge restarted (collie-v1) · 1.0.0+abc", tone: "info" },
    ]);
  });

  test("a restart that failed keeps every line it printed — there it IS the diagnosis", () => {
    const view = projectAdd([
      ...START,
      { kind: "restart-begin", label: "bridge restarted (collie) · 1.0.0" },
      { kind: "line", text: "error: could not start the bridge", tone: "error", stream: "err" },
      { kind: "restart-end", ok: false },
    ]);
    expect(view.legs[0]!.notes).toEqual([
      { text: "error: could not start the bridge", tone: "warn" },
      { text: "↻ bridge restarted (collie) · 1.0.0 — the restart failed", tone: "error" },
    ]);
  });

  test("a failing verdict marks the leg that was still spinning — a leg never spins forever", () => {
    const view = projectAdd([
      ...START,
      { kind: "leg-done", leg: "probe", ok: true, detail: "" },
      { kind: "leg-start", leg: "install", text: "" },
      { kind: "line", text: "error: the install failed", tone: "error", stream: "err" },
      { kind: "verdict", ok: false, text: "pack add did not finish (exit 1)" },
    ]);
    expect(view.legs[1]!.status).toBe("failed");
    expect(view.verdict).toEqual({ ok: false, text: "pack add did not finish (exit 1)" });
  });

  test("anything said before the first leg — a usage error — still has somewhere to land", () => {
    const view = projectAdd([{ kind: "line", text: "usage: collie pack add <ssh-host>", tone: "error", stream: "err" }]);
    expect(view.preamble).toEqual([{ text: "usage: collie pack add <ssh-host>", tone: "error" }]);
    expect(view.legs.every((l) => l.status === "pending")).toBe(true);
  });
});

// ── `pack update`'s seam ─────────────────────────────────────────────────────
// The same contract as `pack add`'s, one verb later: one event stream, two readers, and neither may
// describe a run the other doesn't.

const RUN: UpdateEvent[] = [
  { kind: "title", version: "1.2.3", commit: "abc123def4567890" },
  { kind: "plan", memberId: "nas", state: "ready", detail: "1.2.2 at 0000feed0000" },
  { kind: "plan", memberId: "pi", state: "skipped", detail: "no ssh record" },
  { kind: "member-start", memberId: "nas" },
  { kind: "leg-start", memberId: "nas", leg: "push" },
  { kind: "line", text: "  pushing abc123def456…", tone: "info", stream: "out" },
  { kind: "leg-done", memberId: "nas", leg: "push", ok: true, detail: "1.2.3 at /home/pat/.collie" },
];

describe("plainUpdate", () => {
  test("replays a run as the lines the verb prints, and nothing else", () => {
    const out: string[] = [];
    const err: string[] = [];
    for (const event of RUN) plainUpdate({ out: (l) => out.push(l), err: (l) => err.push(l) }, event);
    expect(out).toEqual([
      "pack update — 1.2.3 (abc123def456)",
      "→ nas         1.2.2 at 0000feed0000",
      "· pi          no ssh record",
      "",
      "nas:",
      "  pushing abc123def456…",
      "  ✓ push        1.2.3 at /home/pat/.collie",
    ]);
    expect(err).toEqual([]);
  });

  test("a failed leg prints nothing — the `error:` lines around it are the diagnosis", () => {
    const out: string[] = [];
    plainUpdate({ out: (l) => out.push(l), err: () => {} }, {
      kind: "leg-done",
      memberId: "nas",
      leg: "restart",
      ok: false,
      detail: "its bridge did not come back",
    });
    expect(out).toEqual([]);
  });

  test("the summary is the table plus the one line a script reads", () => {
    const out: string[] = [];
    plainUpdate({ out: (l) => out.push(l), err: () => {} }, {
      kind: "summary",
      rows: [
        { memberId: "nas", outcome: "updated", detail: "1.2.2 → 1.2.3" },
        { memberId: "pi", outcome: "failed", detail: "the build failed there" },
      ],
      verdict: "1 updated, 1 failed",
      ok: false,
    });
    expect(out).toEqual([
      "",
      "summary:",
      "  nas         updated  1.2.2 → 1.2.3",
      "  pi          FAILED   the build failed there",
      "✗ 1 updated, 1 failed",
    ]);
  });
});

describe("projectUpdate", () => {
  test("folds the same run into one row per member, in the order they were planned", () => {
    const view = projectUpdate(RUN);
    expect(view.version).toBe("1.2.3");
    expect(view.members.map((m) => m.memberId)).toEqual(["nas", "pi"]);
    expect(view.members[1]!.legs).toBeNull();
    expect(view.members[0]!.legs?.map((l) => [l.leg, l.status])).toEqual([
      ["push", "done"],
      ["restart", "pending"],
      ["verify", "pending"],
    ]);
    // A line said during a member's turn belongs to that member — and, when a leg was running, to
    // that LEG, so it is drawn under the row it describes rather than under all three of them.
    expect(view.members[0]!.legs?.[0]!.notes).toEqual([{ text: "  pushing abc123def456…", tone: "info" }]);
    expect(view.members[0]!.notes).toEqual([]);
    expect(view.preamble).toEqual([]);
  });

  test("a line said between legs is the member's, not the leg that just finished", () => {
    const view = projectUpdate([
      ...RUN,
      { kind: "line", text: "warn: the ops file could not be updated", tone: "warn", stream: "err" },
    ]);
    expect(view.members[0]!.legs?.[0]!.notes).toEqual([{ text: "  pushing abc123def456…", tone: "info" }]);
    expect(view.members[0]!.notes).toEqual([
      { text: "warn: the ops file could not be updated", tone: "warn" },
    ]);
  });

  test("the push's progress line never lands on a later leg — the field ordering bug", () => {
    const view = projectUpdate([
      ...RUN,
      { kind: "leg-start", memberId: "nas", leg: "restart" },
      { kind: "leg-done", memberId: "nas", leg: "restart", ok: true, detail: "its bridge came back" },
      { kind: "leg-start", memberId: "nas", leg: "verify" },
      { kind: "leg-done", memberId: "nas", leg: "verify", ok: true, detail: "answers at 100.64.0.9:8787 · 1.2.3" },
      { kind: "member-done", memberId: "nas", outcome: "updated" },
    ]);
    expect(view.members[0]!.legs?.map((l) => l.notes.length)).toEqual([1, 0, 0]);
    expect(view.members[0]!.notes).toEqual([]);
  });

  test("a member that ended mid-leg never leaves one spinning", () => {
    const view = projectUpdate([
      ...RUN,
      { kind: "leg-start", memberId: "nas", leg: "restart" },
      { kind: "member-done", memberId: "nas", outcome: "failed" },
    ]);
    expect(view.members[0]!.legs?.map((l) => l.status)).toEqual(["done", "failed", "pending"]);
    expect(view.members[0]!.outcome).toBe("failed");
  });

  test("anything said before the first member — a warning about this checkout — has somewhere to land", () => {
    const view = projectUpdate([
      { kind: "line", text: "warn: this checkout has uncommitted changes", tone: "warn", stream: "err" },
    ]);
    expect(view.preamble).toEqual([{ text: "warn: this checkout has uncommitted changes", tone: "warn" }]);
    expect(view.members).toEqual([]);
  });
});
