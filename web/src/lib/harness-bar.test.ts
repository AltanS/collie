import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { commandsFor } from "@/lib/agent-commands";
import { barFor, BAR_AGENTS, CAPTURE_SOURCED } from "@/lib/harness-bar";
import type { OperatorCommand } from "@/lib/types";

// The bar's two invariants, as tests rather than as sentences in a spec. A phrase does not fail a
// build; these do.

/** The repo root, so an `evidence` path can be checked exactly as it is written in the table. */
const REPO = join(import.meta.dirname, "..", "..", "..");

function op(row: Partial<OperatorCommand> & { command: string }): OperatorCommand {
  const out: OperatorCommand = {
    command: row.command,
    description: row.description ?? "Custom command",
    takesArg: row.takesArg ?? false,
    argHint: row.argHint ?? "",
    confirm: row.confirm ?? false,
    bar: row.bar ?? false,
  };
  if (row.agent !== undefined) out.agent = row.agent;
  if (row.barLabel !== undefined) out.barLabel = row.barLabel;
  return out;
}

describe("the shipped bar", () => {
  it("every bar command is a catalog command", () => {
    for (const agent of BAR_AGENTS) {
      const catalog = new Set(commandsFor(agent).map((c) => c.command));
      for (const item of barFor(agent)) {
        expect(catalog, `${agent} bar names ${item.command}`).toContain(item.command);
      }
    }
  });

  it("names a bar for exactly the four harnesses this milestone drove from a phone", () => {
    expect(BAR_AGENTS.toSorted()).toEqual(["claude", "codex", "omp", "pi"]);
  });

  it("gives Claude Model, Effort, Compact and Resume, in that order", () => {
    expect(barFor("claude").map((i) => i.id)).toEqual(["model", "effort", "compact", "resume"]);
  });

  it("gives Codex Model, Compact and Resume, and no Effort button", () => {
    // Codex's own /model picker sets the model AND the reasoning effort, so the one button reaches
    // both dials and there is nothing for a second one to do.
    expect(barFor("codex").map((i) => i.id)).toEqual(["model", "compact", "resume"]);
  });

  it("gives pi Tree and no Effort, because pi has no effort command", () => {
    expect(barFor("pi").map((i) => i.id)).toEqual(["model", "compact", "tree", "resume"]);
  });

  it("gives omp Tree, in pi's order, now that a capture vouches for it", () => {
    expect(barFor("omp").map((i) => i.id)).toEqual(["model", "compact", "tree", "resume"]);
  });

  it("renders nothing for an agent with no bar, and for no agent at all", () => {
    for (const agent of ["grok", "opencode", "agy", "antigravity", "bash", "", undefined, null]) {
      expect(barFor(agent), `${String(agent)} has no bar`).toEqual([]);
    }
  });

  it("reaches a bar through the catalog's own agent ladder", () => {
    expect(barFor("claude-code").map((i) => i.id)).toEqual(barFor("claude").map((i) => i.id));
    expect(barFor("  CLAUDE ").map((i) => i.id)).toEqual(barFor("claude").map((i) => i.id));
  });

  it("spells every shipped label as a harnessBar key", () => {
    for (const agent of BAR_AGENTS) {
      for (const item of barFor(agent)) {
        expect(item.label, `${agent}/${item.id}`).toMatch(/^harnessBar\./);
      }
    }
  });

  it("sends every command bare, so the harness's own picker is what offers the arguments", () => {
    // THE RULE THIS FILE EXISTS TO KEEP. A bar item carries no argument list: Collie would have to
    // track a list the harness owns and changes without telling us, and `/model` paints Claude's own
    // picker in the mirror anyway. One tap, no list of ours to go stale.
    for (const agent of BAR_AGENTS) {
      for (const item of barFor(agent)) {
        expect(item.command, `${agent}/${item.id}`).toMatch(/^\/\S+$/);
      }
    }
  });
});

describe("evidence", () => {
  it("names a capture that exists on disk", () => {
    for (const agent of BAR_AGENTS) {
      for (const item of barFor(agent)) {
        if (item.evidence === undefined) continue;
        expect(
          existsSync(join(REPO, item.evidence)),
          `${agent}/${item.id} cites a missing capture: ${item.evidence}`,
        ).toBe(true);
      }
    }
  });

  it("is carried by every row of a capture-sourced harness", () => {
    for (const agent of CAPTURE_SOURCED) {
      const bar = barFor(agent);
      expect(bar.length, `${agent} has a bar`).toBeGreaterThan(0);
      for (const item of bar) {
        expect(item.evidence, `${agent}/${item.id} needs a capture`).toBeDefined();
      }
    }
  });

  it("is claimed on the one doc-sourced row a live pane vouches for", () => {
    // Claude's catalog comes from a published page, so only its Model item cites a capture:
    // `claude--model-alias.txt` is the live pane that proves /model reaches Claude's model picker.
    const cited = barFor("claude").filter((i) => i.evidence !== undefined);
    expect(cited.map((i) => i.id)).toEqual(["model"]);
    expect(cited[0]?.evidence).toBe("web/src/fixtures/panes/claude--model-alias.txt");
  });
});

describe("the operator's bar rows", () => {
  it("replace the shipped bar for the panes they address", () => {
    const mine = [op({ agent: "claude", command: "/statusline", bar: true, barLabel: "Status" })];
    expect(barFor("claude", mine)).toEqual([
      {
        id: "op:/statusline",
        label: "Status",
        command: "/statusline",
        confirm: false,
        operator: true,
      },
    ]);
  });

  it("leave the bar alone on every pane they do not address", () => {
    const mine = [op({ agent: "codex", command: "/deploy", bar: true })];
    expect(barFor("claude", mine).map((i) => i.id)).toEqual(barFor("claude").map((i) => i.id));
  });

  it("fall back to the command name without its slash when no label was given", () => {
    const mine = [op({ agent: "pi", command: "/deploy", bar: true })];
    expect(barFor("pi", mine)[0]!.label).toBe("deploy");
  });

  it("are ignored by the bar unless bar = true, so the palette's rows stay off it", () => {
    const mine = [op({ agent: "claude", command: "/statusline" })];
    expect(barFor("claude", mine).map((i) => i.id)).toEqual(barFor("claude").map((i) => i.id));
  });

  it("do not blank the Agent palette for that pane — ADR 0018 is unchanged", () => {
    const mine = [op({ agent: "claude", command: "/statusline", bar: true })];
    // A bar row IS an ordinary palette row, so the palette replaces exactly as it always did.
    expect(commandsFor("claude", mine).map((c) => c.command)).toEqual(["/statusline"]);
    // And a pane no row addresses keeps the shipped palette AND the shipped bar.
    expect(commandsFor("pi", mine).length).toBeGreaterThan(1);
    expect(barFor("pi", mine).map((i) => i.id)).toEqual(["model", "compact", "tree", "resume"]);
  });

  it("keep the shipped two-tap confirm when they name a dangerous command", () => {
    const mine = [op({ agent: "claude", command: "/clear", bar: true, confirm: false })];
    expect(barFor("claude", mine)[0]!.confirm).toBe(true);
  });

  it("confirm on their own word for a command the catalog does not know", () => {
    const mine = [op({ agent: "claude", command: "/wipe-everything", bar: true, confirm: true })];
    expect(barFor("claude", mine)[0]!.confirm).toBe(true);
  });

  it("are not capped, and keep file order", () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      op({ agent: "claude", command: `/row${i}`, bar: true }),
    );
    const bar = barFor("claude", many);
    expect(bar).toHaveLength(20);
    expect(bar[0]!.command).toBe("/row0");
    expect(bar[19]!.command).toBe("/row19");
  });

  it("never carry evidence — the operator vouches for their own commands", () => {
    const mine = [op({ agent: "omp", command: "/fork-in-herdr", bar: true })];
    expect(barFor("omp", mine)[0]!.evidence).toBeUndefined();
  });

  it("let a narrower bar = false row take a command back off the bar", () => {
    const mine = [
      op({ command: "/deploy", bar: true }),
      op({ agent: "claude", command: "/deploy", bar: false }),
    ];
    // The scope ladder resolves first, so the claude-scoped row wins for a claude pane and its
    // `bar = false` leaves no bar rows at all — the shipped table stands again.
    expect(barFor("claude", mine).map((i) => i.id)).toEqual(barFor("claude").map((i) => i.id));
    // Every other pane still gets the wider row.
    expect(barFor("pi", mine).map((i) => i.command)).toEqual(["/deploy"]);
  });
});
