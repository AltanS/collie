import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import { discoverAgentSkills, isSkillAgent, skillAgentFor, type SkillAgent } from "./agent-skills.ts";
import { MAX_COMMANDS, MAX_SCAN_OPS, MAX_SETTINGS_BYTES, type DiscoveryIo } from "./claude-commands.ts";

interface FakeTree {
  readonly [path: string]: string;
}

const native = (path: string) => path.replaceAll("/", sep);
const agents: SkillAgent[] = ["codex", "opencode", "pi", "omp", "grok", "agy", "muse"];
const skill = (description = "test", extra = "") => `---\ndescription: ${description}\n${extra}---\nbody\n`;
const repo = { "/h/code/app/.git/HEAD": "ref" };

function fakeIo(spelled: FakeTree): DiscoveryIo {
  const files = new Map(Object.entries(spelled).map(([path, text]) => [native(path), text] as const));
  return {
    async realDir(dir) {
      const prefix = dir.endsWith(sep) ? dir : `${dir}${sep}`;
      for (const path of files.keys()) {
        if (path === dir || path.startsWith(prefix)) return dir;
      }
      return null;
    },
    async hasGit(dir) {
      const gitExact = join(dir, ".git");
      const gitPrefix = `${gitExact}${sep}`;
      for (const path of files.keys()) {
        if (path === gitExact || path.startsWith(gitPrefix)) return true;
      }
      return false;
    },
    async list(dir) {
      const prefix = dir.endsWith(sep) ? dir : `${dir}${sep}`;
      const seen = new Map<string, boolean>();
      for (const path of files.keys()) {
        if (!path.startsWith(prefix)) continue;
        const [head, ...rest] = path.slice(prefix.length).split(sep);
        seen.set(head!, (seen.get(head!) ?? false) || rest.length > 0);
      }
      return seen.size === 0 ? null : [...seen].map(([name, isDir]) => ({ name, dir: isDir }));
    },
    async read(path, _roots, opts) {
      const raw = files.get(path);
      if (raw === undefined) return null;
      const maxBytes = opts?.maxBytes ?? 64 * 1024;
      const truncate = opts?.truncate ?? true;
      if (Buffer.byteLength(raw, "utf8") > maxBytes) {
        return truncate ? raw.slice(0, maxBytes) : raw.slice(0, maxBytes + 1);
      }
      return raw;
    },
  };
}

async function run(
  agent: SkillAgent,
  files: FakeTree,
  cwd: string | null = "/h/code/app/src",
  env: Readonly<Record<string, string | undefined>> = {},
) {
  return discoverAgentSkills(agent, { home: native("/h"), cwd: cwd === null ? null : native(cwd), env }, fakeIo(files));
}

async function names(agent: SkillAgent, files: FakeTree, cwd: string | null = "/h/code/app/src") {
  return (await run(agent, files, cwd)).map((row) => row.command);
}

describe("agent skill discovery", () => {
  test("recognises only the seven skill agents", () => {
    expect(agents.every(isSkillAgent)).toBe(true);
    for (const other of ["claude", "Codex", "", "toString"]) expect(isSkillAgent(other)).toBe(false);
  });

  test("the adapter folds Herdr's second name for agy onto its loader and knows no other alias", () => {
    expect(skillAgentFor("antigravity")).toBe("agy");
    for (const agent of agents) expect(skillAgentFor(agent)).toBe(agent);
    for (const other of ["claude", "hermes", "", "toString", "constructor"]) expect(skillAgentFor(other)).toBeUndefined();
  });

  test("a missing home folder yields an empty list for every agent", async () => {
    for (const agent of agents) {
      expect(await run(agent, {}, null)).toEqual([]);
      expect(await run(agent, repo)).toEqual([]);
    }
  });

  test("codex uses dollar mentions and nearest project definitions before user roots", async () => {
    const rows = await run("codex", {
      ...repo,
      "/h/code/app/src/.agents/skills/local/SKILL.md": skill("nearest", "name: ship\nargument-hint: '[env]'\n"),
      "/h/code/app/.agents/skills/ship/SKILL.md": skill("repo"),
      "/h/.codex/skills/ship/SKILL.md": skill("codex"),
      "/h/.agents/skills/ship/SKILL.md": skill("agents"),
      "/h/.codex/skills/zebra/SKILL.md": skill("z"),
    });
    expect(rows).toEqual([
      { command: "$ship", description: "nearest", argHint: "[env]" },
      { command: "$zebra", description: "z", argHint: "" },
    ]);
    expect((await run("codex", {
      "/h/.codex/skills/ship/SKILL.md": skill("codex"),
      "/h/.agents/skills/ship/SKILL.md": skill("agents"),
    }, null))[0]?.description).toBe("codex");
  });

  test("codex recursively finds depth six, skips deeper and hidden folders, and validates mentions", async () => {
    expect(await names("codex", {
      "/h/.codex/skills/a/b/c/d/e/six/SKILL.md": skill("deep", "name: six_1:ok-yes\n"),
      "/h/.codex/skills/a/b/c/d/e/f/seven/SKILL.md": skill("too deep"),
      "/h/.codex/skills/.system/internal/SKILL.md": skill("hidden"),
      "/h/.codex/skills/visible/.hidden/SKILL.md": skill("hidden"),
      "/h/.codex/skills/empty/SKILL.md": "---\nname: empty\n---\n",
      "/h/.codex/skills/bad.name/SKILL.md": skill("bad"),
    })).toEqual(["$six_1:ok-yes"]);
  });

  test("codex disables by name, file or folder in the configured CODEX_HOME", async () => {
    const files = {
      "/custom/config.toml": `[[skills.config]]\nname = "by-name"\nenabled = false\n[[skills.config]]\npath = ${JSON.stringify(native("/custom/skills/by-file/SKILL.md"))}\nenabled = false\n[[skills.config]]\npath = ${JSON.stringify(native("/custom/skills/by-folder"))}\nenabled = false\n`,
      "/custom/skills/by-name/SKILL.md": skill(),
      "/custom/skills/by-file/SKILL.md": skill(),
      "/custom/skills/by-folder/SKILL.md": skill(),
      "/custom/skills/kept/SKILL.md": skill(),
      "/h/.codex/skills/wrong-home/SKILL.md": skill(),
    };
    expect((await run("codex", files, null, { CODEX_HOME: native("/custom") })).map((row) => row.command)).toEqual(["$kept"]);
    expect(await names("codex", {
      "/h/.codex/config.toml": "[[invalid",
      "/h/.codex/skills/kept/SKILL.md": skill(),
    })).toEqual(["$kept"]);
  });

  test("opencode requires a frontmatter name, recurses, and preserves slash command paths", async () => {
    expect(await run("opencode", {
      "/h/.config/opencode/skills/group/folder/SKILL.md": skill("named", "name: actual\n"),
      "/h/.config/opencode/skills/unnamed/SKILL.md": skill(),
      "/h/.config/opencode/commands/sub/name.md": skill("command", "name: ignored\n"),
      "/h/.config/opencode/command/plain.md": "plain body",
    })).toEqual([
      { command: "/actual", description: "named", argHint: "" },
      { command: "/plain", description: "", argHint: "" },
      { command: "/sub/name", description: "command", argHint: "" },
    ]);
  });

  test("opencode prefers shared project roots, then native roots, then user roots", async () => {
    const rows = await run("opencode", {
      ...repo,
      "/h/code/app/.claude/skills/a/SKILL.md": skill("shared", "name: ship\n"),
      "/h/code/app/src/.opencode/skills/a/SKILL.md": skill("native", "name: ship\n"),
      "/h/.config/opencode/skills/a/SKILL.md": skill("user", "name: ship\n"),
      "/h/code/app/src/.opencode/commands/check.md": skill("project command"),
      "/h/.config/opencode/commands/check.md": skill("user command"),
    });
    expect(rows.map((row) => [row.command, row.description])).toEqual([["/check", "user command"], ["/ship", "shared"]]);
  });

  test("opencode honours XDG_CONFIG_HOME, OPENCODE_CONFIG_DIR and disable flags", async () => {
    const rows = await run("opencode", {
      "/xdg/opencode/skill/yes/SKILL.md": skill("yes", "name: yes\nuser-invocable: false\n"),
      "/xdg/opencode/skills/broken/SKILL.md": "---\nname: [broken\n---\n",
      "/h/.config/opencode/skills/no/SKILL.md": skill("no", "name: no\n"),
    }, null, { XDG_CONFIG_HOME: native("/xdg") });
    expect(rows.map((row) => row.command)).toEqual(["/yes"]);

    const envTree = {
      ...repo,
      "/h/code/app/.claude/skills/c/SKILL.md": skill("proj claude", "name: proj-claude\n"),
      "/h/code/app/.agents/skills/a/SKILL.md": skill("proj agents", "name: proj-agents\n"),
      "/h/code/app/.opencode/skills/o/SKILL.md": skill("proj opencode", "name: proj-opencode\n"),
      "/h/code/app/.opencode/commands/p-cmd.md": skill("proj cmd"),
      "/h/.claude/skills/uc/SKILL.md": skill("user claude", "name: user-claude\n"),
      "/h/.agents/skills/ua/SKILL.md": skill("user agents", "name: user-agents\n"),
      "/custom-oc/skills/co/SKILL.md": skill("custom skill", "name: custom-skill\n"),
      "/custom-oc/commands/c-cmd.md": skill("custom cmd"),
    };
    expect(
      (await run("opencode", envTree, "/h/code/app", {
        OPENCODE_CONFIG_DIR: native("/custom-oc"),
        OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
      })).map((r) => r.command),
    ).toEqual(["/c-cmd", "/custom-skill", "/p-cmd", "/proj-agents", "/proj-opencode", "/user-agents"]);
    expect(
      (await run("opencode", envTree, "/h/code/app", {
        OPENCODE_DISABLE_EXTERNAL_SKILLS: "true",
        OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      })).map((r) => r.command),
    ).toEqual([]);
  });

  test("pi spells skills separately from prompts, stops at skill roots, and prefers trusted projects", async () => {
    const rows = await run("pi", {
      ...repo,
      "/h/.pi/agent/trust.json": JSON.stringify({ [native("/h/code")]: true }),
      "/h/code/app/src/.pi/skills/ship/SKILL.md": skill("project"),
      "/h/code/app/src/.pi/skills/ship/nested/SKILL.md": skill("nested"),
      "/h/code/app/.agents/skills/ship/SKILL.md": skill("repo"),
      "/h/code/app/.pi/skills/above/SKILL.md": skill("above the cwd"),
      "/h/.pi/agent/skills/ship/SKILL.md": skill("user"),
      "/h/.agents/skills/ship/SKILL.md": skill("shared"),
      "/h/code/app/src/.pi/prompts/ship.md": "\nProject prompt line\nsecond",
      "/h/.pi/agent/prompts/ship.md": "\nFirst body line\nsecond",
      "/h/.pi/agent/prompts/explicit.md": skill("explicit", "argument-hint: '[file]'\n"),
    });
    expect(rows).toEqual([
      { command: "/explicit", description: "explicit", argHint: "[file]" },
      { command: "/ship", description: "Project prompt line", argHint: "" },
      { command: "/skill:ship", description: "project", argHint: "" },
    ]);
  });

  test("pi trusts the nearest ancestor entry and denies absent, malformed or false trust", async () => {
    const files = {
      ...repo,
      "/h/code/app/src/.pi/skills/local/SKILL.md": skill(),
      "/h/code/app/.agents/skills/shared/SKILL.md": skill(),
      "/h/.pi/agent/skills/user/SKILL.md": skill(),
    };
    for (const trust of ["{}", "{broken", JSON.stringify({ [native("/h/code")]: true, [native("/h/code/app")]: false })]) {
      expect(await names("pi", { ...files, "/h/.pi/agent/trust.json": trust })).toEqual(["/skill:user"]);
    }
    expect(await names("pi", {
      ...files,
      "/h/.pi/agent/trust.json": JSON.stringify({ [native("/h/code")]: false, [native("/h/code/app/src")]: true }),
    })).toEqual(["/skill:local", "/skill:shared", "/skill:user"]);
  });

  test("pi excludes minus paths and only loads described loose files in its own roots", async () => {
    const files = {
      "/custom/trust.json": JSON.stringify({ [native("/h/code/app/src")]: true }),
      "/custom/settings.json": JSON.stringify({ skills: [`-${native("/custom/skills/file/SKILL.md")}`, "relative", "-relative", 7] }),
      "/custom/skills/file/SKILL.md": skill(),
      "/custom/skills/loose.md": skill("loose", "name: renamed\n"),
      "/custom/skills/no-description.md": "body",
      "/custom/skills/group/SKILL.md": "body",
      "/custom/skills/group/nested/SKILL.md": skill(),
      "/custom/skills/.hidden/SKILL.md": skill(),
      "/custom/skills/node_modules/no/SKILL.md": skill(),
      "/h/.agents/skills/no.md": skill(),
      "/h/blocked/nested/SKILL.md": skill(),
      "/h/code/app/src/.pi/skills/project.md": skill(),
    };
    const rows = await run("pi", files, "/h/code/app/src", { PI_CODING_AGENT_DIR: native("/custom") });
    expect(rows.map((row) => row.command)).toEqual(["/skill:project", "/skill:renamed"]);
    expect(await names("pi", {
      "/h/.pi/agent/settings.json": JSON.stringify({ skills: ["-~/.pi/agent/skills/blocked", "-skills/rel-blocked"] }),
      "/h/.pi/agent/skills/blocked/nested/SKILL.md": skill(),
      "/h/.pi/agent/skills/rel-blocked/SKILL.md": skill(),
      "/h/.pi/agent/skills/blocked-other/SKILL.md": skill(),
    })).toEqual(["/skill:blocked-other"]);
    expect(await names("pi", {
      "/h/.pi/agent/settings.json": JSON.stringify({ enableSkillCommands: false }),
      "/h/.pi/agent/skills/kept/SKILL.md": skill(),
      "/h/.pi/agent/prompts/prompt-only.md": "hello",
    })).toEqual(["/prompt-only"]);
    // Trusted project `.pi/settings.json` overrides global `enableSkillCommands` in both directions;
    // an untrusted project's settings never override a global `false`.
    const overrideBase = {
      ...repo,
      "/h/.pi/agent/settings.json": JSON.stringify({ enableSkillCommands: false }),
      "/h/.pi/agent/skills/user-skill/SKILL.md": skill(),
      "/h/code/app/src/.pi/settings.json": JSON.stringify({ enableSkillCommands: true }),
      "/h/code/app/src/.pi/skills/proj-skill/SKILL.md": skill(),
    };
    expect(await names("pi", overrideBase)).toEqual([]);
    expect(
      await names("pi", {
        ...overrideBase,
        "/h/.pi/agent/trust.json": JSON.stringify({ [native("/h/code/app")]: true }),
      }),
    ).toEqual(["/skill:proj-skill", "/skill:user-skill"]);
    expect(
      await names("pi", {
        ...repo,
        "/h/.pi/agent/trust.json": JSON.stringify({ [native("/h/code/app")]: true }),
        "/h/.pi/agent/skills/user-skill/SKILL.md": skill(),
        "/h/code/app/src/.pi/settings.json": JSON.stringify({ enableSkillCommands: false }),
      }),
    ).toEqual([]);
  });

  test("pi prompt fallback uses the first body line capped at sixty characters", async () => {
    const rows = await run("pi", { "/h/.pi/agent/prompts/long.md": `---\nname: ignored\n---\n\n${"x".repeat(80)}\n` });
    expect(rows).toEqual([{ command: "/long", description: "x".repeat(60), argHint: "" }]);
  });

  test("omp keeps user precedence and one-level layout, ignores foreign users and disabled or slashed names", async () => {
    const rows = await run("omp", {
      ...repo,
      "/h/.omp/agent/skills/ship/SKILL.md": skill("user"),
      "/h/code/app/src/.omp/skills/ship/SKILL.md": skill("project"),
      "/h/.agents/skills/ship/SKILL.md": skill("shared"),
      "/h/.omp/agent/skills/group/nested/SKILL.md": skill(),
      "/h/.omp/agent/skills/off/SKILL.md": skill("off", "enabled: false\n"),
      "/h/.omp/agent/skills/slash/SKILL.md": skill("bad", "name: a/b\n"),
      "/h/.omp/agent/skills/backslash/SKILL.md": skill("bad", "name: a\\b\n"),
      "/h/.claude/skills/foreign/SKILL.md": skill(),
      "/h/.codex/skills/foreign/SKILL.md": skill(),
      "/h/.config/opencode/skills/foreign/SKILL.md": skill(),
      "/h/.omp/skills/home-project/SKILL.md": skill(),
      "/h/code/app/src/.github/skills/no-desc/SKILL.md": "body",
      "/h/code/app/src/.github/skills/github/SKILL.md": skill(),
      "/h/code/app/src/.codex/skills/codex/SKILL.md": "body",
    });
    expect(rows.map((row) => [row.command, row.description])).toEqual([
      ["/skill:codex", ""], ["/skill:github", "test"], ["/skill:ship", "user"],
    ]);
  });

  test("grok normalises names, prefers trusted local then repo then user skills, and hides configured skills", async () => {
    const rows = await run("grok", {
      ...repo,
      "/h/.grok/trusted_folders.toml": `[folders.${JSON.stringify(native("/h/code"))}]\ntrusted = true\n`,
      "/h/code/app/src/.grok/skills/ship/SKILL.md": skill("local", "name: Ship_Now\n"),
      "/h/code/app/.agents/skills/ship/SKILL.md": skill("repo", "name: Ship Now\n"),
      "/h/.grok/skills/ship/SKILL.md": skill("user", "name: ship-now\n"),
      "/h/.grok/skills/hidden/SKILL.md": skill("hidden", "user-invocable: false\n"),
      "/h/.grok/skills/disabled/SKILL.md": skill(),
      "/h/.grok/skills/ignored/SKILL.md": skill(),
      "/h/.grok/config.toml": `[skills]\ndisabled = ["disabled"]\nignore = [${JSON.stringify(native("/h/.grok/skills/ignored"))}]\n`,
      "/h/.grok/commands/User_Check.md": skill("command"),
      "/h/.grok/commands/nested/no.md": skill(),
    });
    expect(rows.map((row) => [row.command, row.description])).toEqual([["/ship-now", "local"], ["/user-check", "command"]]);
  });

  test("grok trust gates every project tier and nearest false overrides an ancestor true", async () => {
    const files = {
      ...repo,
      "/g/skills/user/SKILL.md": skill(),
      "/h/code/app/src/.grok/skills/local/SKILL.md": skill(),
      "/h/code/app/.agents/commands/repo.md": skill(),
      "/h/code/app/src/.claude/skills/claude/SKILL.md": skill(),
      "/h/code/app/src/.cursor/skills/cursor/SKILL.md": skill(),
      "/h/.claude/commands/personal.md": skill(),
    };
    for (const trust of ["", "[broken", `[folders.${JSON.stringify(native("/h/code"))}]\ntrusted = true\n[folders.${JSON.stringify(native("/h/code/app"))}]\ntrusted = false\n`]) {
      const rows = await run("grok", { ...files, "/g/trusted_folders.toml": trust }, "/h/code/app/src", { GROK_HOME: native("/g") });
      expect(rows.map((row) => row.command)).toEqual(["/personal", "/user"]);
    }
    const rows = await run("grok", {
      ...files, "/g/trusted_folders.toml": `[folders.${JSON.stringify(native("/h/code/app/src"))}]\ntrusted = true\n`,
    }, "/h/code/app/src", { GROK_HOME: native("/g") });
    expect(rows.map((row) => row.command)).toEqual(["/claude", "/cursor", "/local", "/personal", "/repo", "/user"]);
  });

  test("agy prefers project spellings, hides disable-slash-command, and namespaces plugins", async () => {
    const rows = await run("agy", {
      ...repo,
      "/h/code/app/src/.agents/skills/ship/SKILL.md": skill("nearest"),
      "/h/code/app/.agent/skills/ship/SKILL.md": skill("repo"),
      "/h/.gemini/skills/ship/SKILL.md": skill("user"),
      "/h/.gemini/skills/hidden/SKILL.md": skill("hidden", "disable-slash-command: true\n"),
      "/h/.gemini/antigravity-cli/plugins/nanobanana/skills/restore/SKILL.md": skill("plugin"),
      "/h/.gemini/antigravity/skills/wrong/SKILL.md": skill(),
      "/h/.agents/skills/wrong/SKILL.md": skill(),
      "/h/code/app/_agents/skills/underscore/SKILL.md": skill(),
      "/h/code/app/_agent/skills/singular/SKILL.md": skill(),
    });
    expect(rows.map((row) => [row.command, row.description])).toEqual([
      ["/nanobanana:restore", "plugin"], ["/ship", "nearest"], ["/singular", "test"], ["/underscore", "test"],
    ]);
  });

  test("muse uses folder ids, user precedence and visibility, and reads no untrusted project", async () => {
    const rows = await run("muse", {
      "/h/.config/muse/skills/ship/SKILL.md": skill("muse", "name: ignored\n"),
      "/h/.agents/skills/ship/SKILL.md": skill("agents"),
      "/h/.agents/skills/shared/SKILL.md": skill("agents"),
      "/h/.claude/skills/shared/SKILL.md": skill("claude"),
      "/h/.codex/skills/shared/SKILL.md": skill("codex"),
      "/h/.codex/skills/.system/internal/SKILL.md": skill(),
      "/h/.config/muse/skills/off/SKILL.md": skill("off", "user-invocable: false\n"),
      "/h/.config/muse/skills/Bad/SKILL.md": skill(),
      "/h/.config/muse/skills/-bad/SKILL.md": skill(),
      [`/h/.config/muse/skills/${"a".repeat(81)}/SKILL.md`]: skill(),
      "/h/.config/muse/skills/ok.id_2-3/SKILL.md": skill(),
      "/h/code/app/src/.agents/skills/project/SKILL.md": skill(),
    });
    expect(rows.map((row) => [row.command, row.description])).toEqual([
      ["/ok.id_2-3", "test"], ["/shared", "agents"], ["/ship", "muse"],
    ]);
    expect((await run("muse", {
      "/xdg/muse/skills/custom/SKILL.md": skill(),
      "/codex/skills/other/SKILL.md": skill(),
    }, null, { XDG_CONFIG_HOME: native("/xdg"), CODEX_HOME: native("/codex") })).map((row) => row.command)).toEqual(["/custom", "/other"]);
  });

  test("opencode reads its home folders after the project ones, in the documented order", async () => {
    const tiers = [
      "/h/code/app/src/.claude/skills",
      "/h/code/app/src/.opencode/skill",
      "/h/.config/opencode/skill",
      "/h/.config/opencode/skills",
      "/h/.opencode/skill",
      "/h/.opencode/skills",
      "/h/.claude/skills",
      "/h/.agents/skills",
    ];
    for (const [i, tier] of tiers.entries()) {
      const files = Object.fromEntries(tiers.slice(i).map((root) => [`${root}/a/SKILL.md`, skill(root, "name: dup\n")]));
      expect((await run("opencode", files)).map((row) => row.description)).toEqual([tier]);
    }
    expect(await names("opencode", {
      "/h/.opencode/command/home.md": skill(),
      "/h/code/app/src/.opencode/commands/nested/deep/walk.md": skill(),
    })).toEqual(["/home", "/nested/deep/walk"]);
  });

  test("omp searches its tiers in the documented order", async () => {
    const tiers = [
      "/h/.omp/agent/skills",
      "/h/code/app/.omp/skills",
      "/h/.agents/skills",
      "/h/.agent/skills",
      "/h/code/app/.agents/skills",
      "/h/code/app/.agent/skills",
      "/h/code/app/.claude/skills",
      "/h/code/app/src/.codex/skills",
      "/h/code/app/src/.opencode/skills",
      "/h/code/app/src/.github/skills",
    ];
    for (const [i, tier] of tiers.entries()) {
      const files = Object.fromEntries(tiers.slice(i).map((root) => [`${root}/dup/SKILL.md`, skill(root)]));
      expect((await run("omp", { ...repo, ...files })).map((row) => row.description)).toEqual([tier]);
    }
  });

  test("grok searches its tiers in the documented order", async () => {
    const tiers = [
      "/h/code/app/src/.grok/skills",
      "/h/code/app/src/.agents/skills",
      "/h/code/app/.grok/skills",
      "/h/code/app/.agents/skills",
      "/g/skills",
      "/h/code/app/src/.claude/skills",
      "/h/.claude/skills",
      "/h/code/app/src/.cursor/skills",
      "/h/.cursor/skills",
    ];
    const trust = `[folders.${JSON.stringify(native("/h/code"))}]\ntrusted = true\n`;
    for (const [i, tier] of tiers.entries()) {
      const files = Object.fromEntries(tiers.slice(i).map((root) => [`${root}/dup/SKILL.md`, skill(root)]));
      const rows = await run("grok", { ...repo, ...files, "/g/trusted_folders.toml": trust }, "/h/code/app/src", { GROK_HOME: native("/g") });
      expect(rows.map((row) => row.description)).toEqual([tier]);
    }
  });

  test("muse reads project skills before user ones only in a trusted project, by exact real-path key", async () => {
    const files = {
      ...repo,
      "/h/code/app/src/.agents/skills/a/SKILL.md": skill("project agents"),
      "/h/code/app/.codex/skills/c/SKILL.md": skill("project codex"),
      "/h/code/app/.claude/skills/b/SKILL.md": skill("project claude"),
      "/h/.agents/skills/a/SKILL.md": skill("user"),
    };
    const trust = (path: string, decision = "trusted") => JSON.stringify({ schema_version: 1, projects: { [native(path)]: { decision } } });
    const userOnly = [["/a", "user"]];
    const all = [["/a", "project agents"], ["/b", "project claude"], ["/c", "project codex"]];
    const described = async (extra: FakeTree, env: Readonly<Record<string, string | undefined>> = {}) =>
      (await run("muse", { ...files, ...extra }, "/h/code/app/src", env)).map((row) => [row.command, row.description]);

    expect(await described({})).toEqual(userOnly);
    expect(await described({ "/h/.config/muse/trust.json": trust("/h/code/app") })).toEqual(all);
    expect(await described({ "/h/.config/muse/trust.json": trust("/h/code/app/src") })).toEqual(all);
    expect(await described({ "/xdg/muse/trust.json": trust("/h/code/app") }, { XDG_CONFIG_HOME: native("/xdg") })).toEqual(all);
    for (const trustFile of [trust("/h/code/app", "denied"), trust("/h/code"), "{broken", "[]", JSON.stringify({ projects: [] })]) {
      expect(await described({ "/h/.config/muse/trust.json": trustFile })).toEqual(userOnly);
    }
  });

  test("repository walk stops at the nearest git marker and uses cwd alone without a repository", async () => {
    const files = {
      "/h/code/app/src/.agents/skills/local/SKILL.md": skill(),
      "/h/code/app/.agents/skills/parent/SKILL.md": skill(),
      "/h/code/.agents/skills/above/SKILL.md": skill(),
    };
    expect(await names("codex", files)).toEqual(["$local"]);
    expect(await names("codex", { ...files, ...repo })).toEqual(["$local", "$parent"]);
    expect(await names("codex", { ...files, ...repo, "/h/code/app/src/.git": "gitdir: elsewhere" })).toEqual(["$local"]);
  });

  test("descriptions are clipped, malformed files skipped, and rows sorted with a thousand-row cap", async () => {
    const files = {
      "/h/.agents/skills/broken/SKILL.md": "---\ndescription: [broken\n---\n",
      "/h/.agents/skills/long/SKILL.md": skill(`'${"word ".repeat(80)}'`),
    };
    const long = await run("muse", files, null);
    expect(long[0]?.description.length).toBe(200);
    expect(long[0]?.description.endsWith("…")).toBe(true);
    const many = Object.fromEntries(
      Array.from({ length: 1002 }, (_, i) => [`/h/.agents/skills/s${String(1001 - i).padStart(4, "0")}/SKILL.md`, skill()]),
    );
    const manyIo = fakeIo({ ...files, ...many });
    let reads = 0;
    const countingIo: DiscoveryIo = {
      ...manyIo,
      read: (path, roots, opts) => {
        reads += 1;
        return manyIo.read(path, roots, opts);
      },
    };
    const rows = await discoverAgentSkills("muse", { home: native("/h"), cwd: null, env: {} }, countingIo);
    expect(reads).toBeLessThanOrEqual(MAX_SCAN_OPS);
    expect(rows.length).toBeLessThanOrEqual(MAX_COMMANDS);
    expect(rows.map((row) => row.command)).toEqual(rows.map((row) => row.command).toSorted());
  });

  test("shares MAX_SCAN_OPS across all roots in one discovery call", async () => {
    const io = fakeIo({});
    let lists = 0;
    const bounded: DiscoveryIo = {
      realDir: async (dir) => dir,
      hasGit: async () => false,
      read: io.read,
      async list(dir) {
        if (!dir.startsWith(native("/h/.codex/skills")) && !dir.startsWith(native("/h/.agents/skills"))) return null;
        lists++;
        return Array.from({ length: 10 }, (_, i) => ({ name: `d${i}`, dir: true }));
      },
    };
    expect(await discoverAgentSkills("codex", { home: native("/h"), cwd: null, env: {} }, bounded)).toEqual([]);
    expect(lists).toBeLessThanOrEqual(MAX_SCAN_OPS);
  });
});

describe("a trust store keyed by the real path", () => {
  // Grok and pi record a trusted folder by its real path (live: a cwd under macOS `/var/...` is keyed
  // `/private/var/...`), while the multiplexer reports the cwd as the shell spelled it.
  const base = mkdtempSync(join(tmpdir(), "collie-skills-"));
  const real = join(base, "real");
  mkdirSync(real);
  const link = join(base, "link");
  symlinkSync(real, link);
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  // The key is spelled by the same `realpath` the lookup calls. On a Windows runner `tmpdir()` is an
  // 8.3 short name (`RUNNER~1`), and a key from `realpathSync` kept that spelling, so both cases
  // found no trusted folder there (Windows CI, 2026-10-15).
  const trustKey = () => realpath(real);

  const rowsAt = (agent: SkillAgent, files: FakeTree) =>
    discoverAgentSkills(agent, { home: base, cwd: link, env: {} }, fakeIo(files));

  test("grok loads a trusted project reached through a link", async () => {
    const key = await trustKey();
    const rows = await rowsAt("grok", {
      [join(base, ".grok", "trusted_folders.toml")]: `[folders.${JSON.stringify(key)}]\ntrusted = true\n`,
      [join(link, ".git", "HEAD")]: "ref",
      [join(link, ".grok", "skills", "probe", "SKILL.md")]: skill(),
    });
    expect(rows.map((row) => row.command)).toContain("/probe");
  });

  test("pi loads a trusted project reached through a link", async () => {
    const key = await trustKey();
    const rows = await rowsAt("pi", {
      [join(base, ".pi", "agent", "trust.json")]: JSON.stringify({ [key]: true }),
      [join(link, ".git", "HEAD")]: "ref",
      [join(link, ".pi", "skills", "probe", "SKILL.md")]: skill(),
    });
    expect(rows.map((row) => row.command)).toContain("/skill:probe");
  });
});

describe("discoverAgentSkills: real-disk containment and size bounds", () => {
  test("oversized settings files are rejected rather than parsed from a truncated prefix", async () => {
    // A 300 KiB TOML where the prefix sets `/h` to trusted and the tail after 256 KiB sets `/h/code/app`
    // to false must be rejected as oversized, never parsed from its prefix to grant trust.
    const padding = `# ${"x".repeat(1024)}\n`.repeat(270);
    const oversized = `[folders.${JSON.stringify(native("/h"))}]\ntrusted = true\n${padding}[folders.${JSON.stringify(native("/h/code/app"))}]\ntrusted = false\n`;
    expect(Buffer.byteLength(oversized, "utf8")).toBeGreaterThan(MAX_SETTINGS_BYTES);
    const rows = await run("grok", {
      ...repo,
      "/h/.grok/trusted_folders.toml": oversized,
      "/h/code/app/src/.grok/skills/secret-project/SKILL.md": skill("should stay hidden"),
      "/h/.grok/skills/personal/SKILL.md": skill("personal"),
    });
    expect(rows.map((r) => r.command)).toEqual(["/personal"]);
  });

  test(
    "real disk: symlinks escaping personal roots, project roots, or an Antigravity plugin root are refused while inside skills load",
    async () => {
      const sandbox = mkdtempSync(join(tmpdir(), "collie-agent-bounds-"));
      try {
        const home = join(sandbox, "home");
        const outside = join(sandbox, "outside");
        const repoA = join(home, "code", "repo-a");
        const repoB = join(home, "code", "repo-b");

        // Outside sentinel with valid frontmatter for every agent (`name` + `description`).
        const outsideSkillDir = join(outside, "escaped-skill");
        mkdirSync(outsideSkillDir, { recursive: true });
        writeFileSync(join(outsideSkillDir, "SKILL.md"), skill("OUTSIDE-SENTINEL", "name: escaped\n"));

        // Sibling repo sentinel inside home, to prove project scans are bound to repoA and not all of home.
        const repoBSkillDir = join(repoB, "sibling-skill");
        mkdirSync(join(repoB, ".git"), { recursive: true });
        mkdirSync(repoBSkillDir, { recursive: true });
        writeFileSync(join(repoBSkillDir, "SKILL.md"), skill("SIBLING-REPO-SENTINEL", "name: sibling\n"));

        // Inside personal skill + escaping personal symlink for Codex.
        const codexInside = join(home, ".codex", "skills", "inside-codex");
        mkdirSync(codexInside, { recursive: true });
        writeFileSync(join(codexInside, "SKILL.md"), skill("inside codex", "name: inside_codex\n"));
        symlinkSync(outsideSkillDir, join(home, ".codex", "skills", "escaped"));

        // Inside project skill + cross-repo symlink inside repoA.
        const repoASkills = join(repoA, ".agents", "skills");
        const repoAInside = join(repoASkills, "inside-project");
        mkdirSync(join(repoA, ".git"), { recursive: true });
        mkdirSync(repoAInside, { recursive: true });
        writeFileSync(join(repoAInside, "SKILL.md"), skill("inside project", "name: inside_project\n"));
        symlinkSync(repoBSkillDir, join(repoASkills, "sibling"));

        const codexRows = await discoverAgentSkills("codex", { home, cwd: repoA, env: {} });
        expect(codexRows.map((r) => r.command)).toEqual(["$inside_codex", "$inside_project"]);
        expect(JSON.stringify(codexRows)).not.toContain("SENTINEL");

        // Antigravity plugin containment: a symlink inside plugin-a pointing to a valid skill in `~/.gemini/skills`
        // (inside home, but outside plugin-a's own root) is refused while plugin-a's own skill loads.
        const geminiUserSkill = join(home, ".gemini", "skills", "user-gemini");
        mkdirSync(geminiUserSkill, { recursive: true });
        writeFileSync(join(geminiUserSkill, "SKILL.md"), skill("user gemini", "name: user_gemini\n"));

        const pluginASkills = join(home, ".gemini", "antigravity-cli", "plugins", "plugin-a", "skills");
        const pluginAInside = join(pluginASkills, "own");
        mkdirSync(pluginAInside, { recursive: true });
        writeFileSync(join(pluginAInside, "SKILL.md"), skill("own plugin skill", "name: own\n"));
        symlinkSync(geminiUserSkill, join(pluginASkills, "leaked-from-user"));

        const agyRows = await discoverAgentSkills("agy", { home, cwd: null, env: {} });
        expect(agyRows.map((r) => r.command)).toEqual(["/plugin-a:own", "/user_gemini"]);
      } finally {
        rmSync(sandbox, { recursive: true, force: true });
      }
    },
  );
});
