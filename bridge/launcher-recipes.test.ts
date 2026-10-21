import { describe, expect, test } from "bun:test";

import { HARNESS_LAUNCHES } from "./harness-launch.ts";
import {
  buildRecipe,
  cleanLauncherText,
  isForbiddenCodePoint,
  MAX_COMMAND_CHARS,
  MAX_LABEL_CHARS,
  RECIPE_OPTIONS,
  recipeOptions,
  scanNoPrompts,
} from "./launcher-recipes.ts";

describe("the recipe table", () => {
  test("every harness with options is one Collie starts, and ids are unique per harness", () => {
    for (const [harness, options] of RECIPE_OPTIONS) {
      expect(HARNESS_LAUNCHES.some((h) => h.id === harness)).toBe(true);
      expect(new Set(options.map((o) => o.id)).size).toBe(options.length);
      for (const o of options) {
        // A chip appends flags, never a second command or a shell metacharacter.
        expect(o.args).toMatch(/^-[-A-Za-z0-9 =]+$/);
      }
    }
  });

  test("the chips that skip prompts are exactly the verified ones", () => {
    const skipping = [...RECIPE_OPTIONS].flatMap(([h, opts]) =>
      opts.filter((o) => o.noPrompts === true).map((o) => `${h}:${o.args}`),
    );
    expect(skipping.toSorted()).toEqual(
      [
        "claude:--dangerously-skip-permissions",
        "codex:--dangerously-bypass-approvals-and-sandbox",
        "codex:--ask-for-approval never",
        "opencode:--auto",
        "grok:--always-approve",
        "agy:--dangerously-skip-permissions",
        "muse:--yolo",
        "muse:--approval-mode never",
        "muse:--disable-request-user-input",
      ].toSorted(),
    );
  });

  test("a harness without a checked option lists none", () => {
    // hermes's pane goes undetected (see the header).
    expect(recipeOptions("hermes")).toEqual([]);
    expect(recipeOptions("__proto__")).toEqual([]);
  });
});

describe("buildRecipe", () => {
  test("the binary alone, labelled by the harness", () => {
    expect(buildRecipe("claude", [])).toEqual({ ok: true, command: "claude", label: "Claude Code", noPrompts: false, options: [] });
  });

  test("Kiro recipes retain the required V3 flag and offer no permission bypass", () => {
    expect(buildRecipe("kiro", [])).toEqual({ ok: true, command: "kiro-cli", label: "Kiro", noPrompts: false, options: [] });
    expect(recipeOptions("kiro")).toEqual([]);
    expect(buildRecipe("kiro", ["trust-all"])).toEqual({ ok: false, reason: "unknown_option" });
  });

  test("options in TABLE order, whatever order they were picked in", () => {
    const a = buildRecipe("claude", ["continue", "skip", "opus"]);
    const b = buildRecipe("claude", ["opus", "skip", "continue"]);
    expect(a).toEqual(b);
    expect(a).toEqual({
      ok: true,
      command: "claude --dangerously-skip-permissions --model opus --continue",
      label: "Claude Code, Skip permission prompts, Model: opus, Continue last",
      noPrompts: true,
      options: ["skip", "opus", "continue"],
    });
  });

  test("two of one group is a conflict, as is a repeated id", () => {
    expect(buildRecipe("claude", ["opus", "sonnet"])).toEqual({ ok: false, reason: "conflict" });
    expect(buildRecipe("claude", ["skip", "plan"])).toEqual({ ok: false, reason: "conflict" });
    expect(buildRecipe("claude", ["opus", "opus"])).toEqual({ ok: false, reason: "conflict" });
    expect(buildRecipe("codex", ["bypass", "readonly"])).toEqual({ ok: false, reason: "conflict" });
    expect(buildRecipe("muse", ["yolo", "never"])).toEqual({ ok: false, reason: "conflict" });
    expect(buildRecipe("muse", ["yolo", "no-questions"])).toMatchObject({ ok: true, command: "muse --yolo --disable-request-user-input" });
  });

  test("an unknown harness or option is refused", () => {
    expect(buildRecipe("bash", [])).toEqual({ ok: false, reason: "unknown_harness" });
    expect(buildRecipe("claude", ["--yolo"])).toEqual({ ok: false, reason: "unknown_option" });
    expect(buildRecipe("pi", ["auto"])).toEqual({ ok: false, reason: "unknown_option" });
  });

  test("a grok and an agy recipe", () => {
    expect(buildRecipe("grok", ["approve"])).toMatchObject({ ok: true, command: "grok --always-approve", noPrompts: true });
    expect(buildRecipe("agy", ["plan", "continue"])).toMatchObject({ ok: true, command: "agy --mode plan --continue", noPrompts: false });
    expect(buildRecipe("agy", ["skip", "plan"])).toMatchObject({ ok: false });
  });

  test("a codex and an opencode recipe", () => {
    expect(buildRecipe("codex", ["never", "search"])).toMatchObject({ command: "codex --ask-for-approval never --search", noPrompts: true });
    expect(buildRecipe("opencode", ["plan"])).toMatchObject({ command: "opencode --agent plan", noPrompts: false });
  });

  test("a muse recipe", () => {
    expect(buildRecipe("muse", [])).toEqual({ ok: true, command: "muse", label: "Muse", noPrompts: false, options: [] });
    expect(buildRecipe("muse", ["yolo"])).toMatchObject({ ok: true, command: "muse --yolo", noPrompts: true });
    expect(buildRecipe("muse", ["never", "no-questions"])).toMatchObject({
      ok: true,
      command: "muse --approval-mode never --disable-request-user-input",
      noPrompts: true,
    });
    expect(buildRecipe("muse", ["--yolo"])).toEqual({ ok: false, reason: "unknown_option" });
  });
});

describe("scanNoPrompts", () => {
  const cases: [string, boolean][] = [
    ["claude --dangerously-skip-permissions", true],
    ["claude --permission-mode bypassPermissions", true],
    ["claude --permission-mode=bypassPermissions", true],
    ["claude --permission-mode plan", false],
    ["claude --allow-dangerously-skip-permissions", false],
    ["codex --dangerously-bypass-approvals-and-sandbox", true],
    ["codex --yolo", true],
    ["codex -a never", true],
    ["codex --ask-for-approval never", true],
    ["codex --ask-for-approval=never", true],
    ["codex -a on-request", false],
    ["codex --full-auto", false],
    ["opencode --auto", true],
    ["grok --always-approve", true],
    ["hermes --yolo", true],
    ["muse --yolo", true],
    ["muse --disable-approval", true],
    ["muse --disable-request-user-input", true],
    ["muse --approval-mode never", true],
    ["muse --approval-mode=never", true],
    ["muse '--disable-approval'", true],
    ["muse --approval-mode on-request", false],
    ["muse --disable-sandbox", false],
    ["muse --trust-workspace", false],
    ["muse --disable-write", false],
    ["agy --dangerously-skip-permissions", true],
    ["agy --mode plan", false],
    ["kiro-cli chat --v3 --trust-all-tools", true],
    ["kiro-cli chat -a", true],
    ["kiro-cli chat --trust-tools fs_read", false],
    ["make -a", false],
    ["make --always-approve", false],
    ["~/bin/opencode --auto", true],
    ["C:\\Tools\\opencode.exe --auto", true],
    ["codex.cmd -a never", true],
    ["make --auto", false],
    ["pi -a never", false],
    ["FOO=1 claude '--dangerously-skip-permissions'", true],
    ["claude-danger", false],
    ["htop", false],
  ];
  for (const [line, want] of cases) {
    test(`${JSON.stringify(line)} → ${want}`, () => expect(scanNoPrompts(line)).toBe(want));
  }
});

describe("the character rule", () => {
  test("which code points are refused", () => {
    const refused = [0x00, 0x09, 0x0a, 0x0d, 0x1b, 0x7f, 0x80, 0x85, 0x9f, 0x2028, 0x2029, 0x202a, 0x202e, 0x2066, 0x2069, 0x200e, 0x200f, 0x061c];
    for (const c of refused) expect(isForbiddenCodePoint(c)).toBe(true);
    const allowed = [0x20, 0x41, 0x7e, 0xa0, 0xe9, 0x200b, 0x2030, 0x2065, 0x206a, 0x4e2d, 0x1f600];
    for (const c of allowed) expect(isForbiddenCodePoint(c)).toBe(false);
  });

  const table: [string, string, ReturnType<typeof cleanLauncherText>][] = [
    ["plain", "htop", { ok: true, text: "htop" }],
    ["trimmed", "  htop -d 5  ", { ok: true, text: "htop -d 5" }],
    ["NFC", "café", { ok: true, text: "café" }],
    ["empty", "   ", { ok: false, problem: "empty" }],
    ["a trailing newline is refused, not trimmed away", "htop\n", { ok: false, problem: "forbidden_character" }],
    ["a tab", "a\tb", { ok: false, problem: "forbidden_character" }],
    ["escape", "echo \u001b[31m", { ok: false, problem: "forbidden_character" }],
    ["C1 next line", "a\u0085b", { ok: false, problem: "forbidden_character" }],
    ["line separator", "a\u2028b", { ok: false, problem: "forbidden_character" }],
    ["paragraph separator", "a\u2029b", { ok: false, problem: "forbidden_character" }],
    ["right-to-left override", "ls \u202Etxt.exe", { ok: false, problem: "forbidden_character" }],
    ["first strong isolate", "a\u2068b", { ok: false, problem: "forbidden_character" }],
    ["right-to-left mark", "a\u200Fb", { ok: false, problem: "forbidden_character" }],
  ];
  for (const [name, raw, want] of table) {
    test(name, () => expect(cleanLauncherText(raw, MAX_COMMAND_CHARS)).toEqual(want));
  }

  test("length is counted in code points after NFC", () => {
    expect(cleanLauncherText("x".repeat(MAX_COMMAND_CHARS), MAX_COMMAND_CHARS).ok).toBe(true);
    expect(cleanLauncherText("x".repeat(MAX_COMMAND_CHARS + 1), MAX_COMMAND_CHARS)).toEqual({ ok: false, problem: "too_long" });
    // One emoji is two UTF-16 units and one code point.
    expect(cleanLauncherText("😀".repeat(MAX_LABEL_CHARS), MAX_LABEL_CHARS).ok).toBe(true);
    expect(cleanLauncherText("é".repeat(MAX_LABEL_CHARS), MAX_LABEL_CHARS).ok).toBe(true);
  });
});
