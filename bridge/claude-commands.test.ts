import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import {
  claudeConfigDir,
  discoverClaudeCommands,
  discoveryDiskIo,
  MAX_COMMANDS,
  MAX_SCAN_OPS,
  parseFrontmatter,
  type DiscoveryIo,
} from "./claude-commands.ts";

interface FakeTree {
  readonly [path: string]: string;
}

/** Fixtures are spelled with `/`; the code joins with the platform's separator, `\` on Windows. */
const native = (path: string) => path.replaceAll("/", sep);

/** A disk made of file paths; every folder is implied by a file below it. */
function fakeIo(spelled: FakeTree): DiscoveryIo {
  const files = new Map(Object.entries(spelled).map(([path, text]) => [native(path), text] as const));
  return {
    async realDir(dir) {
      const prefix = `${dir}${sep}`;
      for (const path of files.keys()) {
        if (path === dir || path.startsWith(prefix)) return dir;
      }
      return null;
    },
    async hasGit(dir) {
      const gitPrefix = `${join(dir, ".git")}${sep}`;
      const gitExact = join(dir, ".git");
      for (const path of files.keys()) {
        if (path === gitExact || path.startsWith(gitPrefix)) return true;
      }
      return false;
    },
    async list(dir) {
      const prefix = `${dir}${sep}`;
      const seen = new Map<string, boolean>();
      for (const path of files.keys()) {
        if (!path.startsWith(prefix)) continue;
        const [head, ...rest] = path.slice(prefix.length).split(sep);
        seen.set(head!, (seen.get(head!) ?? false) || rest.length > 0);
      }
      return seen.size === 0
        ? null
        : [...seen]
            .map(([name, isDir]) => ({ name, dir: isDir }))
            .toSorted((a, b) => a.name.localeCompare(b.name));
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

const skill = (description: string, extra = "") => `---\ndescription: ${description}\n${extra}---\nbody\n`;

async function run(files: FakeTree, cwd: string | null = "/h/code/app/src") {
  const warns: string[] = [];
  const rows = await discoverClaudeCommands({
    home: native("/h"),
    cwd: cwd === null ? null : native(cwd),
    configDir: native("/h/.claude"),
    io: fakeIo(files),
    warn: (m) => warns.push(m),
  });
  return { rows, warns, names: rows.map((r) => r.command) };
}

describe("parseFrontmatter", () => {
  test("reads the fields Claude Code uses", () => {
    expect(
      parseFrontmatter('---\nname: deploy\ndescription: "Ship it"\nargument-hint: "[env]"\nuser-invocable: false\n---\n'),
    ).toEqual({ name: "deploy", description: "Ship it", argumentHint: "[env]", userInvocable: false });
  });

  test("a file without a block is an ordinary command", () => {
    expect(parseFrontmatter("just a prompt\n")).toEqual({});
  });

  test("an unclosed or non-mapping block is broken, not empty", () => {
    expect(parseFrontmatter("---\ndescription: x\n")).toBeNull();
    expect(parseFrontmatter("---\n- a\n- b\n---\n")).toBeNull();
  });
});

describe("claudeConfigDir", () => {
  test("follows a profile's journal root, else the home default", () => {
    const roots = [native("/h/.claude-work/projects"), native("/h/.claude/projects")];
    expect(claudeConfigDir(roots, native("/h"))).toBe(native("/h/.claude-work"));
    expect(claudeConfigDir([native("/srv/logs")], native("/h"))).toBe(native("/h/.claude"));
    expect(claudeConfigDir([], native("/h"))).toBe(native("/h/.claude"));
  });
});

describe("discoverClaudeCommands", () => {
  test("nothing on disk is a quiet empty list", async () => {
    expect(await run({})).toEqual({ rows: [], warns: [], names: [] });
  });

  test("personal skills take the frontmatter name, commands take a namespaced file name", async () => {
    const { rows } = await run({
      "/h/.claude/skills/deploy-staging/SKILL.md": skill("Deploy", 'name: deploy\nargument-hint: "[env]"\n'),
      "/h/.claude/skills/notes/README.md": "not a skill",
      "/h/.claude/commands/frontend/component.md": "---\ndescription: Make a component\n---\n",
      "/h/.claude/commands/plain.md": "no frontmatter\n",
    });
    expect(rows).toEqual([
      { command: "/deploy", description: "Deploy", argHint: "[env]" },
      { command: "/frontend:component", description: "Make a component", argHint: "" },
      { command: "/plain", description: "", argHint: "" },
    ]);
  });

  test("user-invocable: false and skillOverrides off (including __proto__ and >64 KiB settings) are left out", async () => {
    const padding = "x".repeat(70 * 1024);
    const { names } = await run({
      "/h/.claude/skills/hidden/SKILL.md": skill("x", "user-invocable: false\n"),
      "/h/.claude/skills/muted/SKILL.md": skill("x"),
      "/h/.claude/skills/__proto__/SKILL.md": skill("proto"),
      "/h/.claude/skills/re-enabled/SKILL.md": skill("x"),
      "/h/.claude/skills/kept/SKILL.md": skill("x"),
      "/h/.claude/settings.json": `{"padding":"${padding}","skillOverrides":{"muted":"off","__proto__":"off","re-enabled":"off","kept":"name-only"}}`,
      "/h/code/app/.git/HEAD": "ref",
      "/h/code/app/.claude/settings.local.json": JSON.stringify({
        skillOverrides: { "re-enabled": "on", muted: "invalid-typo-ignored" },
      }),
    });
    expect(names).toEqual(["/kept", "/re-enabled"]);
  });

  test("project folders are read from the cwd up to the repository root, and personal wins a name", async () => {
    const { rows, names } = await run({
      "/h/.claude/skills/deploy/SKILL.md": skill("personal"),
      "/h/code/app/.git/HEAD": "ref",
      "/h/code/app/.claude/skills/deploy/SKILL.md": skill("project"),
      "/h/code/app/.claude/skills/build/SKILL.md": skill("root"),
      "/h/code/app/src/.claude/commands/lint.md": "---\ndescription: near\n---\n",
      "/h/code/.claude/skills/above-repo/SKILL.md": skill("outside"),
    });
    expect(names).toEqual(["/deploy", "/lint", "/build"]);
    expect(rows[0]!.description).toBe("personal");
  });

  test("with no repository above it, only the cwd itself counts", async () => {
    const { names } = await run({
      "/h/code/app/src/.claude/skills/here/SKILL.md": skill("x"),
      "/h/code/app/.claude/skills/parent/SKILL.md": skill("x"),
    });
    expect(names).toEqual(["/here"]);
  });

  test("a broken or oversized settings file is skipped with its path named, and the rest still load", async () => {
    const hugeSettings = `{"padding":"${"y".repeat(270 * 1024)}","skillOverrides":{"fine":"off"}}`;
    const { names, warns } = await run({
      "/h/.claude/skills/broken/SKILL.md": "---\ndescription: [unclosed\n---\n",
      "/h/.claude/skills/fine/SKILL.md": skill("x"),
      "/h/.claude/settings.json": "{ not json",
      "/h/code/app/.git/HEAD": "ref",
      "/h/code/app/.claude/settings.json": hugeSettings,
    });
    expect(names).toEqual(["/fine"]);
    expect(warns).toHaveLength(3);
    expect(warns.join("\n")).toContain(native("/h/.claude/skills/broken/SKILL.md"));
    expect(warns.join("\n")).toContain(native("/h/.claude/settings.json"));
    expect(warns.join("\n")).toContain(native("/h/code/app/.claude/settings.json"));
  });

  test("descriptions are flattened and cut, and invalid folder, namespace or file names are dropped", async () => {
    const long = "word ".repeat(80);
    const { rows } = await run({
      "/h/.claude/skills/long/SKILL.md": `---\ndescription: >\n  ${long}\n---\n`,
      "/h/.claude/skills/has space/SKILL.md": skill("x"),
      "/h/.claude/skills/bad-front/SKILL.md": skill("x", 'name: "bad:colon"\n'),
      "/h/.claude/commands/bad\nns/x.md": "---\ndescription: newline namespace\n---\n",
      "/h/.claude/commands/space ns/x.md": "---\ndescription: space namespace\n---\n",
      "/h/.claude/commands/colon:ns/x.md": "---\ndescription: colon namespace\n---\n",
    });
    expect(rows.map((r) => r.command)).toEqual(["/long"]);
    expect(rows[0]!.description.length).toBe(200);
    expect(rows[0]!.description.endsWith("…")).toBe(true);
  });

  test("real disk: refuses symlinks escaping a project root or home, deduplicates symlink cycles, and keeps dotfiles inside home", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "collie-claude-skills-"));
    try {
      const home = join(sandbox, "home");
      const outside = join(sandbox, "outside");
      const dotfiles = join(home, "dotfiles", "shared-skill");
      const secretHome = join(home, "secret-skill");
      const repo = join(home, "code", "app");
      const configDir = join(home, ".claude");

      await mkdir(join(outside, "escaped-skill"), { recursive: true });
      await writeFile(join(outside, "escaped-skill", "SKILL.md"), skill("outside sandbox"));
      await writeFile(join(outside, "escaped-cmd.md"), "---\ndescription: outside cmd\n---\n");

      await mkdir(dotfiles, { recursive: true });
      await writeFile(join(dotfiles, "SKILL.md"), skill("from dotfiles"));

      await mkdir(secretHome, { recursive: true });
      await writeFile(join(secretHome, "SKILL.md"), skill("from home outside repo"));

      await mkdir(join(configDir, "skills"), { recursive: true });
      await symlink(dotfiles, join(configDir, "skills", "dotfiles-skill"));
      await symlink(join(outside, "escaped-skill"), join(configDir, "skills", "escape-personal"));

      await mkdir(join(repo, ".git"), { recursive: true });
      await mkdir(join(repo, ".claude", "skills", "local-skill"), { recursive: true });
      await writeFile(join(repo, ".claude", "skills", "local-skill", "SKILL.md"), skill("inside repo"));
      const cmdRoot = join(repo, ".claude", "commands");
      await mkdir(cmdRoot, { recursive: true });
      await writeFile(join(cmdRoot, "ok.md"), "---\ndescription: inside cmd\n---\n");
      // Symlink cycle inside the repository's commands folder: visited at most once.
      for (let i = 0; i < 10; i++) {
        await symlink(cmdRoot, join(cmdRoot, `cycle-${String(i)}`));
      }
      // A project symlink must not even escape into another folder of the operator's own home.
      await symlink(secretHome, join(repo, ".claude", "skills", "escape-to-home"));
      await symlink(join(outside, "escaped-cmd.md"), join(cmdRoot, "escape-outside.md"));

      const rows = await discoverClaudeCommands({ home, cwd: repo, configDir });
      expect(rows.map((r) => r.command)).toEqual(["/dotfiles-skill", "/local-skill", "/ok"]);

      // A cwd outside home is ignored for project discovery.
      const outsideRows = await discoverClaudeCommands({ home, cwd: outside, configDir });
      expect(outsideRows.map((r) => r.command)).toEqual(["/dotfiles-skill"]);
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });
});

describe("discoverClaudeCommands: the bounds a reader of the operator's disk keeps", () => {
  test("command folders are read four levels down and no deeper", async () => {
    const { names } = await run({
      "/h/.claude/commands/a/b/c/d/at-limit.md": "x",
      "/h/.claude/commands/a/b/c/d/e/too-deep.md": "x",
    });
    expect(names).toEqual(["/a:b:c:d:at-limit"]);
  });

  test("a folder of many files costs at most MAX_SCAN_OPS reads and returns at most MAX_COMMANDS rows", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < MAX_SCAN_OPS + 500; i++) files[`/h/.claude/commands/c${String(i).padStart(5, "0")}.md`] = "x";
    const inner = fakeIo(files);
    let reads = 0;
    const counting: DiscoveryIo = {
      ...inner,
      read: (path, roots, opts) => {
        reads += 1;
        return inner.read(path, roots, opts);
      },
    };
    const rows = await discoverClaudeCommands({
      home: native("/h"),
      cwd: null,
      configDir: native("/h/.claude"),
      io: counting,
      warn: () => {},
    });
    expect(reads).toBeLessThanOrEqual(MAX_SCAN_OPS);
    expect(rows.length).toBeLessThanOrEqual(MAX_COMMANDS);
    expect(rows.length).toBeLessThan(MAX_SCAN_OPS + 500);
  });

  test("real disk: one folder lists at most 256 entries, and a file is read only to its 64 KiB head", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "collie-claude-bounds-"));
    try {
      const home = join(sandbox, "home");
      const configDir = join(home, ".claude");
      const commands = join(configDir, "commands");
      await mkdir(commands, { recursive: true });
      for (let i = 0; i < 300; i++) await writeFile(join(commands, `c${String(i).padStart(3, "0")}.md`), "x");
      const big = join(commands, "zz-big.md");
      const secretBody = "SECRET-BODY-LINE ".repeat(20_000);
      await writeFile(big, `---\ndescription: head only\n---\n${secretBody}`);

      const listed = await discoveryDiskIo.list(commands, [configDir]);
      expect(listed?.length).toBe(256);

      const head = await discoveryDiskIo.read(big, [configDir]);
      expect(head).not.toBeNull();
      expect(head!.length).toBeLessThanOrEqual(64 * 1024);
      expect(head!.length).toBeLessThan(secretBody.length);

      const rows = await discoverClaudeCommands({ home, cwd: null, configDir });
      expect(rows.length).toBeLessThanOrEqual(256);
      for (const row of rows) {
        expect(Object.keys(row).toSorted()).toEqual(["argHint", "command", "description"]);
        expect(JSON.stringify(row)).not.toContain("SECRET-BODY-LINE");
      }
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === "win32")("real disk: a symlink to /etc, in a project or in the personal folders, yields no row", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "collie-claude-etc-"));
    try {
      const home = join(sandbox, "home");
      const configDir = join(home, ".claude");
      const repo = join(home, "code", "app");
      await mkdir(join(configDir, "skills"), { recursive: true });
      await mkdir(join(configDir, "commands"), { recursive: true });
      await mkdir(join(repo, ".git"), { recursive: true });
      await mkdir(join(repo, ".claude", "skills"), { recursive: true });
      await mkdir(join(repo, ".claude", "commands"), { recursive: true });
      // A whole folder, and one file, each pointing at /etc.
      await symlink("/etc", join(configDir, "skills", "etc-skill"));
      await symlink("/etc", join(configDir, "commands", "etc"));
      await symlink("/etc/hostname", join(configDir, "commands", "hostname.md"));
      await symlink("/etc", join(repo, ".claude", "skills", "etc-skill"));
      await symlink("/etc", join(repo, ".claude", "commands", "etc"));
      await symlink("/etc/hostname", join(repo, ".claude", "commands", "hostname.md"));
      // The settings file too: a link to /etc/passwd is not parsed as skill settings.
      await symlink("/etc/passwd", join(repo, ".claude", "settings.json"));

      const warns: string[] = [];
      const rows = await discoverClaudeCommands({ home, cwd: repo, configDir, warn: (m) => warns.push(m) });
      expect(rows).toEqual([]);
      expect(warns).toEqual([]);
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });
});

describe("discoverClaudeCommands: installed plugins", () => {
  const cache = "/h/.claude/plugins/cache/mk";
  const installed = (plugins: Record<string, Array<Record<string, string>>>) =>
    JSON.stringify({ version: 2, plugins });
  /** Like `run`, but a fixture with no user settings file enables every plugin it installs. */
  const runOn = (files: FakeTree, cwd?: string | null) => {
    const installedText = files["/h/.claude/plugins/installed_plugins.json"];
    if (files["/h/.claude/settings.json"] !== undefined || installedText === undefined) return run(files, cwd);
    // The keys are read by pattern, so a broken installed_plugins.json stays broken for the reader.
    const keys = [...installedText.matchAll(/"([^"]+@[^"]+)":\s*\[/g)].map((m) => m[1]!);
    const enabledPlugins = Object.fromEntries(keys.map((key) => [key, true] as const));
    return run({ ...files, "/h/.claude/settings.json": JSON.stringify({ enabledPlugins }) }, cwd);
  };
  const entry = (name: string, extra: Record<string, string> = {}) => ({
    scope: "user",
    installPath: native(`${cache}/${name}/1.0.0`),
    installedAt: "2026-01-01T00:00:00.000Z",
    ...extra,
  });

  test("a plugin skill and command are listed with the plugin prefix, a description and a hint", async () => {
    const { rows, warns } = await runOn({
      "/h/.claude/plugins/installed_plugins.json": installed({ "dev-tools@mk": [entry("dev-tools")] }),
      [`${cache}/dev-tools/1.0.0/skills/log-off/SKILL.md`]: skill("End a session", 'argument-hint: "[note]"\n'),
      [`${cache}/dev-tools/1.0.0/skills/wordsmith/SKILL.md`]: skill("Polish prose", "name: wordsmith\n"),
      [`${cache}/dev-tools/1.0.0/commands/ship.md`]: "---\ndescription: Ship it\n---\n",
    });
    expect(rows).toEqual([
      { command: "/dev-tools:log-off", description: "End a session", argHint: "[note]" },
      { command: "/dev-tools:wordsmith", description: "Polish prose", argHint: "" },
      { command: "/dev-tools:ship", description: "Ship it", argHint: "" },
    ]);
    expect(warns).toEqual([]);
  });

  test("only a plugin the merged enabledPlugins maps set to true is listed; false and absent are skipped", async () => {
    const files = {
      "/h/.claude/plugins/installed_plugins.json": installed({
        "off@mk": [entry("off")],
        "on@mk": [entry("on")],
        "absent@mk": [entry("absent")],
        "project-off@mk": [entry("project-off")],
        "project-on@mk": [entry("project-on")],
      }),
      [`${cache}/off/1.0.0/skills/a/SKILL.md`]: skill("x"),
      [`${cache}/on/1.0.0/skills/a/SKILL.md`]: skill("x"),
      [`${cache}/absent/1.0.0/skills/a/SKILL.md`]: skill("x"),
      [`${cache}/project-off/1.0.0/skills/a/SKILL.md`]: skill("x"),
      [`${cache}/project-on/1.0.0/skills/a/SKILL.md`]: skill("x"),
      "/h/.claude/settings.json": JSON.stringify({
        enabledPlugins: { "off@mk": false, "on@mk": true, "project-off@mk": true },
      }),
      "/h/code/app/.git/HEAD": "ref",
      "/h/code/app/.claude/settings.local.json": JSON.stringify({
        enabledPlugins: { "project-off@mk": false, "off@mk": true, "project-on@mk": true },
      }),
    };
    // Narrowest wins: the local file turns off@mk on and project-off@mk off.
    expect((await runOn(files)).names).toEqual(["/off:a", "/on:a", "/project-on:a"]);
    // Without the local file, only the user map counts.
    expect((await runOn({ ...files, "/h/code/app/.claude/settings.local.json": "{}" })).names).toEqual([
      "/on:a",
      "/project-off:a",
    ]);
  });

  test("the plugin cap counts enabled plugins only: two enabled past 64 disabled ones are listed", async () => {
    const names = Array.from({ length: 70 }, (_, i) => `p${String(i)}`);
    const { names: listed, warns } = await runOn({
      "/h/.claude/plugins/installed_plugins.json": installed(
        Object.fromEntries(names.map((name) => [`${name}@mk`, [entry(name)]])),
      ),
      "/h/.claude/settings.json": JSON.stringify({ enabledPlugins: { "p68@mk": true, "p69@mk": true } }),
      ...Object.fromEntries(names.map((name) => [`${cache}/${name}/1.0.0/skills/a/SKILL.md`, skill("x")])),
    });
    expect(listed).toEqual(["/p68:a", "/p69:a"]);
    expect(warns).toEqual([]);
  });

  test("a manifest defaultEnabled does not turn an unnamed plugin on", async () => {
    const { names } = await run({
      "/h/.claude/plugins/installed_plugins.json": installed({ "loud@mk": [entry("loud")] }),
      [`${cache}/loud/1.0.0/.claude-plugin/plugin.json`]: '{"name":"loud","defaultEnabled":true}',
      [`${cache}/loud/1.0.0/skills/a/SKILL.md`]: skill("x"),
    });
    expect(names).toEqual([]);
  });

  test("plugin.json skills adds a folder to skills/, and a path that leaves the plugin is refused", async () => {
    const { names, warns } = await runOn({
      "/h/.claude/plugins/installed_plugins.json": installed({ "p@mk": [entry("p")] }),
      [`${cache}/p/1.0.0/.claude-plugin/plugin.json`]: JSON.stringify({
        name: "p",
        skills: ["./extra", "../../other/skills", "/etc", "elsewhere", "./../../other/skills"],
      }),
      [`${cache}/p/1.0.0/skills/default/SKILL.md`]: skill("x"),
      [`${cache}/p/1.0.0/extra/custom/SKILL.md`]: skill("x"),
      [`${cache}/other/skills/stolen/SKILL.md`]: skill("x"),
    });
    expect(names).toEqual(["/p:default", "/p:custom"]);
    // Four refusals: the `./../` spelling passes the prefix check and is caught by the containment.
    expect(warns).toHaveLength(4);
    expect(warns.join("\n")).toContain("../../other/skills");
  });

  test("plugin.json commands replaces commands/, takes files and folders, and maps a name to a source", async () => {
    const { rows } = await runOn({
      "/h/.claude/plugins/installed_plugins.json": installed({ "p@mk": [entry("p")] }),
      [`${cache}/p/1.0.0/.claude-plugin/plugin.json`]: JSON.stringify({ name: "p", commands: ["./cmds", "./single.md"] }),
      [`${cache}/p/1.0.0/commands/ignored.md`]: "x",
      [`${cache}/p/1.0.0/cmds/one.md`]: "x",
      [`${cache}/p/1.0.0/single.md`]: "---\ndescription: Single\n---\n",
    });
    expect(rows.map((r) => r.command)).toEqual(["/p:one", "/p:single"]);
    const mapped = await runOn({
      "/h/.claude/plugins/installed_plugins.json": installed({ "p@mk": [entry("p")] }),
      [`${cache}/p/1.0.0/.claude-plugin/plugin.json`]: JSON.stringify({
        name: "p",
        commands: {
          status: { source: "./c/s.md", argumentHint: "[env]" },
          about: { content: "Explain.", description: "About" },
          bad: { source: "../x.md" },
        },
      }),
      [`${cache}/p/1.0.0/c/s.md`]: "---\ndescription: From file\n---\n",
    });
    expect(mapped.rows).toEqual([
      { command: "/p:status", description: "From file", argHint: "[env]" },
      { command: "/p:about", description: "About", argHint: "" },
    ]);
    expect(mapped.warns).toHaveLength(1);
  });

  test("a nested plugin command carries the plugin and folder prefix", async () => {
    const { names } = await runOn({
      "/h/.claude/plugins/installed_plugins.json": installed({ "p@mk": [entry("p")] }),
      [`${cache}/p/1.0.0/commands/git/commit.md`]: "x",
    });
    expect(names).toEqual(["/p:git:commit"]);
  });

  test("a broken installed_plugins.json is reported and the personal and project rows still load", async () => {
    const files = {
      "/h/.claude/skills/mine/SKILL.md": skill("x"),
      "/h/code/app/.git/HEAD": "ref",
      "/h/code/app/.claude/skills/theirs/SKILL.md": skill("x"),
    };
    for (const bad of ["{ not json", '{"version":2}', '{"plugins":{"p@mk":"nope","q@mk":[{"installPath":3}]}}']) {
      const { names, warns } = await runOn({ ...files, "/h/.claude/plugins/installed_plugins.json": bad });
      expect(names).toEqual(["/mine", "/theirs"]);
      expect(warns.length).toBe(bad === '{"version":2}' || bad === "{ not json" ? 1 : 0);
      expect(warns.join("\n")).not.toContain("undefined");
    }
  });

  test("a broken plugin.json drops that plugin only", async () => {
    const { names, warns } = await runOn({
      "/h/.claude/plugins/installed_plugins.json": installed({ "bad@mk": [entry("bad")], "good@mk": [entry("good")] }),
      [`${cache}/bad/1.0.0/.claude-plugin/plugin.json`]: "{ nope",
      [`${cache}/bad/1.0.0/skills/a/SKILL.md`]: skill("x"),
      [`${cache}/good/1.0.0/skills/a/SKILL.md`]: skill("x"),
    });
    expect(names).toEqual(["/good:a"]);
    expect(warns).toHaveLength(1);
  });

  test("with several installs of one plugin, a matching project install wins, else the newest", async () => {
    const files = {
      "/h/.claude/plugins/installed_plugins.json": installed({
        "p@mk": [
          entry("old", { installedAt: "2025-01-01T00:00:00.000Z" }),
          entry("new", { installedAt: "2026-06-01T00:00:00.000Z" }),
          entry("proj", { scope: "project", projectPath: native("/h/code/app"), installedAt: "2024-01-01T00:00:00.000Z" }),
          entry("elsewhere", { scope: "local", projectPath: native("/h/other"), installedAt: "2027-01-01T00:00:00.000Z" }),
        ],
      }),
      [`${cache}/old/1.0.0/skills/old/SKILL.md`]: skill("x"),
      [`${cache}/new/1.0.0/skills/new/SKILL.md`]: skill("x"),
      [`${cache}/proj/1.0.0/skills/proj/SKILL.md`]: skill("x"),
      [`${cache}/elsewhere/1.0.0/skills/elsewhere/SKILL.md`]: skill("x"),
      "/h/code/app/.git/HEAD": "ref",
    };
    expect((await runOn(files)).names).toEqual(["/p:proj"]);
    expect((await runOn(files, "/h/unrelated")).names).toEqual(["/p:new"]);
  });

  test("a skillOverrides off entry also hides a plugin row", async () => {
    const { names } = await runOn({
      "/h/.claude/plugins/installed_plugins.json": installed({ "p@mk": [entry("p")] }),
      [`${cache}/p/1.0.0/skills/a/SKILL.md`]: skill("x"),
      [`${cache}/p/1.0.0/skills/b/SKILL.md`]: skill("x"),
      "/h/.claude/settings.json": JSON.stringify({ enabledPlugins: { "p@mk": true }, skillOverrides: { "p:a": "off" } }),
    });
    expect(names).toEqual(["/p:b"]);
  });

  test("plugin rows come after personal ones and before project ones, and personal and project rows win the cap", async () => {
    const files: Record<string, string> = {};
    files["/h/.claude/plugins/installed_plugins.json"] = installed({ "p@mk": [entry("p")] });
    files["/h/.claude/skills/mine/SKILL.md"] = skill("x");
    files["/h/code/app/.git/HEAD"] = "ref";
    files["/h/code/app/.claude/skills/theirs/SKILL.md"] = skill("x");
    expect((await runOn({ ...files, [`${cache}/p/1.0.0/skills/a/SKILL.md`]: skill("x") })).names).toEqual([
      "/mine",
      "/p:a",
      "/theirs",
    ]);
    // Enough plugin rows to fill the response: the project row is still read first and kept.
    for (let i = 0; i < 400; i++) files[`${cache}/p/1.0.0/commands/c${String(i).padStart(4, "0")}.md`] = "x";
    for (let i = 0; i < 400; i++) files[`${cache}/p/1.0.0/commands/d${String(i).padStart(4, "0")}.md`] = "x";
    for (let i = 0; i < 400; i++) files[`/h/.claude/commands/m${String(i).padStart(4, "0")}.md`] = "x";
    const names = (await runOn(files)).names;
    expect(names.length).toBeLessThanOrEqual(MAX_COMMANDS);
    expect(names).toContain("/mine");
    expect(names).toContain("/theirs");
    expect(names.some((n) => n.startsWith("/m0"))).toBe(true);
  });

  test("real disk: a custom install path in the home is read, one outside the home is refused, and a link out of the plugin is not followed", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "collie-claude-plugins-"));
    try {
      const home = join(sandbox, "home");
      const configDir = join(home, ".claude");
      const custom = join(home, "dev", "my-plugin");
      const foreign = join(sandbox, "elsewhere", "foreign-plugin");
      const linked = join(configDir, "plugins", "cache", "mk", "linked", "1.0.0");
      const secret = join(home, "private-skill");

      await mkdir(join(custom, "skills", "mine"), { recursive: true });
      await writeFile(join(custom, "skills", "mine", "SKILL.md"), skill("custom path"));
      await mkdir(join(foreign, "skills", "theirs"), { recursive: true });
      await writeFile(join(foreign, "skills", "theirs", "SKILL.md"), skill("outside the home"));
      await mkdir(join(linked, "skills"), { recursive: true });
      await mkdir(secret, { recursive: true });
      await writeFile(join(secret, "SKILL.md"), skill("not in the plugin"));
      await symlink(secret, join(linked, "skills", "escape"));
      await mkdir(join(linked, "skills", "inside"), { recursive: true });
      await writeFile(join(linked, "skills", "inside", "SKILL.md"), skill("inside"));
      await writeFile(
        join(configDir, "plugins", "installed_plugins.json"),
        JSON.stringify({
          version: 2,
          plugins: {
            "custom@mk": [{ scope: "user", installPath: custom }],
            "foreign@mk": [{ scope: "user", installPath: foreign }],
            "linked@mk": [{ scope: "user", installPath: linked }],
          },
        }),
      );

      await writeFile(
        join(configDir, "settings.json"),
        JSON.stringify({ enabledPlugins: { "custom@mk": true, "foreign@mk": true, "linked@mk": true } }),
      );

      const warns: string[] = [];
      const rows = await discoverClaudeCommands({ home, cwd: null, configDir, warn: (m) => warns.push(m) });
      expect(rows.map((r) => r.command)).toEqual(["/custom:mine", "/linked:inside"]);
      expect(warns).toHaveLength(1);
      expect(warns[0]).toContain("foreign@mk");
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });
});
