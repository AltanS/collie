import { launchersKey, type LaunchersState } from "@/lib/launchers";
import { hasSheetRows, sheetRows } from "@/lib/new-tab-sheet";
import type { LauncherItem } from "@/lib/types";

function item(over: Partial<LauncherItem> & Pick<LauncherItem, "key" | "start" | "group" | "label">): LauncherItem {
  return { source: "builtin", noPrompts: false, branch: true, available: true, ...over };
}

const SHELL = item({ key: "shell", start: { shell: true }, group: "commands", label: "Shell" });
const CLAUDE = item({ key: "harness:claude", start: { harness: "claude" }, group: "agents", label: "Claude Code", harness: "claude" });
const CODEX_OFF = item({ key: "harness:codex", start: { harness: "codex" }, group: "agents", label: "Codex", harness: "codex", available: false, reason: "not_found" });
const HTOP = item({ key: "row:htop", start: { command: "htop" }, group: "commands", label: "htop", command: "htop", source: "operator", branch: false });

function state(over: Partial<LaunchersState> = {}): LaunchersState {
  return { launchers: [], home: "/home/op", harnesses: [], items: [CLAUDE, SHELL, HTOP], adding: null, recentRuns: null, loadedFor: launchersKey(undefined), ...over };
}

describe("sheetRows", () => {
  it("lists the agents, then the command rows, without the shell", () => {
    const rows = sheetRows(state(), undefined);
    expect(rows.agents.map((r) => r.key)).toEqual(["harness:claude"]);
    expect(rows.commands.map((r) => r.key)).toEqual(["row:htop"]);
  });

  it("lists nothing before the answer for that machine is in", () => {
    expect(sheetRows(state({ loadedFor: null }), undefined)).toEqual({ agents: [], commands: [] });
    expect(sheetRows(state(), { host: "minibuch" })).toEqual({ agents: [], commands: [] });
  });

  it("marks a lead's row", () => {
    const rows = sheetRows(state({ items: [CLAUDE, SHELL, { ...HTOP, from: "lead" }] }), undefined);
    expect(rows.commands[0]!.fromLead).toBe(true);
    expect(rows.agents[0]!.fromLead).toBe(false);
  });

  it("lists nothing for a machine whose program offers only starters: its + keeps the New page", () => {
    const starter = item({ key: "starter:triage", start: { starter: "triage" }, group: "agents", label: "Triage", source: "program" });
    expect(sheetRows(state({ items: [starter, CLAUDE, SHELL] }), undefined)).toEqual({ agents: [], commands: [] });
  });

  it("builds the rows of a bridge older than 1.19.0 from its agents and launchers", () => {
    const older = state({
      items: null,
      harnesses: [{ id: "claude", label: "Claude Code", found: true }],
      launchers: [{ label: "htop", command: "htop" }],
    });
    const rows = sheetRows(older, undefined);
    expect(rows.agents.map((r) => r.key)).toEqual(["harness:claude"]);
    expect(rows.commands.map((r) => r.key)).toEqual(["row:htop"]);
  });
});

describe("hasSheetRows", () => {
  it("is true when one row can start", () => {
    expect(hasSheetRows(sheetRows(state(), undefined))).toBe(true);
    expect(hasSheetRows(sheetRows(state({ items: [CODEX_OFF, SHELL, HTOP] }), undefined))).toBe(true);
  });

  it("is false when nothing beyond the shell can start: every agent not installed and no rows", () => {
    expect(hasSheetRows(sheetRows(state({ items: [CODEX_OFF, SHELL] }), undefined))).toBe(false);
    expect(hasSheetRows(sheetRows(state({ items: [SHELL] }), undefined))).toBe(false);
  });
});
