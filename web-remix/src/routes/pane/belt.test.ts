/// <reference types="bun" />
import { describe, expect, test } from "bun:test";

import { commandsFor } from "@web/lib/agent-commands";
import { t } from "@web/lib/i18n";
import type { OperatorCommand } from "@web/lib/types";

import { filterCommands } from "./agent-palette";
import { asBeltScale, groupTitle, stepSize } from "./belt-drawers";
import { accentFor, beltVars, edgeOf, harnessItems, iconFor, labelText, overflowEdge, pinnedReach, switchPillInset } from "./belt";

describe("switchPillInset", () => {
  test("is the scale-1 arithmetic at scale 1", () => {
    expect(switchPillInset(1, 1)).toBe(117);
    expect(switchPillInset(1, 2)).toBe(155);
    expect(switchPillInset(1, 3)).toBe(193);
  });

  test("grows only the pills with the belt scale: 122, 165, 208 at the default 1.15", () => {
    expect(switchPillInset(1.15, 1)).toBe(122);
    expect(switchPillInset(1.15, 2)).toBe(165);
    expect(switchPillInset(1.15, 3)).toBe(208);
  });

  test("holds the pill count between one and three", () => {
    expect(switchPillInset(1.15, 0)).toBe(122);
    expect(switchPillInset(1.15, 9)).toBe(208);
  });
});

describe("pinnedReach", () => {
  test("reaches 7px out at an end of the block and 3px toward a neighbour", () => {
    expect(pinnedReach(true, true)).toBe("before:-left-[7px] before:-right-[7px]");
    expect(pinnedReach(true, false)).toBe("before:-left-[7px] before:-right-[3px]");
    expect(pinnedReach(false, true)).toBe("before:-left-[3px] before:-right-[7px]");
    expect(pinnedReach(false, false)).toBe("before:-left-[3px] before:-right-[3px]");
  });
});

describe("beltVars", () => {
  test("carries the one scale and the seven sizes derived from it", () => {
    const vars = beltVars(1.3);
    expect(vars["--belt-scale"]).toBe("1.3");
    expect(Object.keys(vars).toSorted()).toEqual(
      ["--belt-band", "--belt-icon", "--belt-pad", "--belt-pill", "--belt-reach", "--belt-rule", "--belt-scale", "--belt-text"].toSorted(),
    );
  });
});

describe("overflowEdge", () => {
  test("says which side still hides something", () => {
    expect(overflowEdge(0, 300, 500)).toBe("right");
    expect(overflowEdge(100, 300, 500)).toBe("both");
    expect(overflowEdge(200, 300, 500)).toBe("left");
    expect(overflowEdge(0, 300, 300)).toBe("none");
  });

  test("a sub-pixel overshoot does not fade a row that fits", () => {
    expect(overflowEdge(0.5, 300, 300.8)).toBe("none");
    expect(edgeOf(false, false)).toBe("none");
  });
});

describe("harness rows", () => {
  const OWN: OperatorCommand = { command: "/mine", description: "", takesArg: false, argHint: "", bar: true };

  test("a Claude pane gets Model, Effort, Compact and Resume", () => {
    expect(harnessItems("claude", undefined, true).map((i) => i.id)).toEqual(["model", "effort", "compact", "resume"]);
  });

  test("the canonical agent ladder reaches the bar: claude-code is Claude", () => {
    expect(harnessItems("claude-code", undefined, true).length).toBe(4);
  });

  test("a shell, an empty agent and a switched-off bar draw no section", () => {
    expect(harnessItems(undefined, undefined, true)).toEqual([]);
    expect(harnessItems("", undefined, true)).toEqual([]);
    expect(harnessItems("claude", undefined, false)).toEqual([]);
  });

  test("an operator row marked bar replaces the shipped bar", () => {
    const items = harnessItems("claude", [OWN], true);
    expect(items.map((i) => i.command)).toEqual(["/mine"]);
    expect(items[0]?.operator).toBe(true);
  });

  test("every shipped bar command is in the agent's command catalog", () => {
    for (const agent of ["claude", "codex", "pi", "omp"]) {
      const known = new Set(commandsFor(agent).map((c) => c.command));
      for (const item of harnessItems(agent, undefined, true)) expect(known.has(item.command)).toBe(true);
    }
  });

  test("an operator label prints as typed, a shipped one is a key", () => {
    expect(labelText("Ship it")).toBe("Ship it");
    expect(labelText("harnessBar.model")).not.toBe("harnessBar.model");
  });

  test("each shipped id has its own glyph, an operator row gets the slash", () => {
    expect(iconFor("model")).not.toBe(iconFor("effort"));
    expect(iconFor("op:/mine")).toBe(iconFor("anything-else"));
  });
});

describe("accentFor", () => {
  test("finds Claude's brand through the agent ladder", () => {
    expect(accentFor("claude")).toBeDefined();
    expect(accentFor("claude-code")).toBe(accentFor("claude"));
  });

  test("a brand with no accent, an unknown agent and a shell have none", () => {
    expect(accentFor("codex")).toBeUndefined();
    expect(accentFor("nothing-like-this")).toBeUndefined();
    expect(accentFor(undefined)).toBeUndefined();
    expect(accentFor("")).toBeUndefined();
  });
});

describe("filterCommands", () => {
  const all = commandsFor("claude");

  test("an empty box shows the common commands only", () => {
    const common = filterCommands(all, "  ");
    expect(common.length).toBeGreaterThan(0);
    expect(common.every((c) => c.common)).toBe(true);
    expect(common.length).toBeLessThan(all.length);
  });

  test("typing searches the whole catalog across command and description", () => {
    expect(filterCommands(all, "/MODEL").some((c) => c.command === "/model")).toBe(true);
    const byWords = all.find((c) => !c.common);
    if (byWords) expect(filterCommands(all, byWords.description.slice(0, 12)).some((c) => c.command === byWords.command)).toBe(true);
  });

  test("a query nothing matches is empty", () => {
    expect(filterCommands(all, "zzzz-no-such-command")).toEqual([]);
  });
});

describe("the dock's pure parts", () => {
  test("a text-size step stays inside its range", () => {
    expect(stepSize(10, 1, { min: 9, max: 16 })).toBe(11);
    expect(stepSize(9, -1, { min: 9, max: 16 })).toBe(9);
    expect(stepSize(16, 1, { min: 9, max: 16 })).toBe(16);
  });

  test("a belt size is one of the three the belt was measured at", () => {
    expect(asBeltScale(1.3)).toBe(1.3);
    expect(asBeltScale(1.5)).toBe(1.5);
    expect(asBeltScale(2)).toBe(1.15);
    expect(asBeltScale("1.3")).toBe(1.15);
  });

  test("quick-reply group titles are catalog ids, translated; an unknown id prints as it stands", () => {
    expect(groupTitle("confirm")).toBe(t("quickActions.group.confirm"));
    expect(groupTitle("common")).toBe(t("quickActions.group.common"));
    expect(groupTitle("future-group")).toBe("future-group");
  });
});
