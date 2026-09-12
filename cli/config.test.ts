import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { CONFIG_SETTINGS } from "../bridge/config-schema.ts";
import {
  configFilePaths,
  emptyConfigLayer,
  readConfigFilesSync,
  type ConfigFileLayer,
  type ConfigFileReader,
  type Environment,
} from "../bridge/config-source.ts";
import {
  cmdConfig,
  cmdConfigCheck,
  cmdConfigInit,
  cmdConfigShow,
  generateConfigFile,
  type ConfigDeps,
} from "./config.ts";
import { capture, CONFIG, context, fakeFiles, HOME, type FakeFiles } from "./fakes.ts";
import { EXIT } from "./io.ts";

const HOME_FILE = join(HOME, ".collie", "config.toml");
const INSTANCE_FILE = join(CONFIG, "config.toml");

interface Harness {
  deps: ConfigDeps;
  io: ReturnType<typeof capture>;
  files: FakeFiles;
}

/**
 * A `config` verb over fakes: a seeded filesystem, and a context whose env and layer are resolved
 * from those same seeded files, exactly as `loadContext` resolves them from real ones.
 */
function harness(seed: Record<string, string> = {}, ambient: Environment = {}): Harness {
  const files = fakeFiles(seed);
  const reader: ConfigFileReader = {
    read: (p) => ({ text: files.read(p), error: null }),
  };
  const env: Environment = { HOME, ...ambient };
  const layer = readConfigFilesSync(reader, configFilePaths(env, HOME, CONFIG), () => {}, { home: HOME });
  const merged: Environment = { ...layer.env, ...env };
  const io = capture();
  return { files, io, deps: { ctx: context(merged, { configLayer: layer, home: HOME }), io, files } };
}

/** The `key  value  [source]` lines, split into their three columns. */
function rows(lines: readonly string[]): { key: string; value: string; source: string }[] {
  return lines
    .filter((l) => l.startsWith("  "))
    .map((l) => l.trim().split(/\s{2,}/u))
    .map((parts) => ({
      key: parts[0] ?? "",
      value: parts[1] ?? "",
      source: (parts[2] ?? "").replace(/^\[|\]$/gu, ""),
    }));
}

describe("config show", () => {
  test("the header names both paths in precedence order, each present or absent", () => {
    const h = harness({ [HOME_FILE]: "[network]\nport = 8800\n" });
    expect(cmdConfigShow(h.deps, [])).toBe(EXIT.OK);
    expect(h.io.stdout[0]).toBe(`machine   ${HOME_FILE}  (present)`);
    expect(h.io.stdout[1]).toBe(`instance  ${INSTANCE_FILE}  (absent)`);
  });

  test("it prints one line per setting in the schema, grouped by section", () => {
    const h = harness();
    cmdConfigShow(h.deps, []);
    expect(rows(h.io.stdout)).toHaveLength(CONFIG_SETTINGS.length);
    expect(h.io.stdout).toContain("[network]");
    expect(h.io.stdout).toContain("[stt]");
  });

  test("the source column names the layer that won, per key", () => {
    const h = harness(
      {
        [HOME_FILE]: "[network]\nport = 8800\n\n[bridge]\npoll_ms = 900\n",
        [INSTANCE_FILE]: "[bridge]\npoll_ms = 800\n",
      },
      { COLLIE_READ_LINES: "42" },
    );
    cmdConfigShow(h.deps, []);
    const byKey = new Map(rows(h.io.stdout).map((r) => [r.key, r]));
    expect(byKey.get("port")).toEqual({ key: "port", value: "8800", source: "file:home" });
    expect(byKey.get("poll_ms")).toEqual({ key: "poll_ms", value: "800", source: "file:instance" });
    expect(byKey.get("read_lines")).toEqual({ key: "read_lines", value: "42", source: "env" });
    expect(byKey.get("host")?.source).toBe("default");
  });

  test("it masks every secret-kind value, whatever the file says", () => {
    const h = harness({
      [HOME_FILE]: '[push]\nvapid_private = "super-secret-signing-key"\n\n[stt]\nstt_key = "sk-abcdef"\n',
    });
    cmdConfigShow(h.deps, []);
    const byKey = new Map(rows(h.io.stdout).map((r) => [r.key, r]));
    expect(byKey.get("vapid_private")?.value).toBe("set");
    expect(byKey.get("stt_key")?.value).toBe("set");
    const all = h.io.stdout.join("\n");
    expect(all).not.toContain("super-secret-signing-key");
    expect(all).not.toContain("sk-abcdef");
    // Every secret row in the schema prints one of the two words and nothing else.
    for (const setting of CONFIG_SETTINGS) {
      if (setting.kind !== "secret") continue;
      expect(["set", "unset"]).toContain(byKey.get(setting.key)?.value ?? "");
    }
  });

  test("it masks a dropped secret too, and reports it as file:blocked", () => {
    const files = fakeFiles({ [HOME_FILE]: '[push]\nvapid_private = "nope"\n' });
    const reader: ConfigFileReader = { read: (p) => ({ text: files.read(p), error: null }) };
    const layer = readConfigFilesSync(reader, configFilePaths({}, HOME, CONFIG), () => {}, {
      home: HOME,
      perms: { mode: () => 0o644, tighten: () => false },
    });
    const io = capture();
    const deps: ConfigDeps = { ctx: context({ HOME }, { configLayer: layer, home: HOME }), io, files };
    cmdConfigShow(deps, []);
    const byKey = new Map(rows(io.stdout).map((r) => [r.key, r]));
    expect(byKey.get("vapid_private")).toEqual({
      key: "vapid_private",
      value: "unset",
      source: "file:blocked",
    });
    expect(io.stdout.join("\n")).not.toContain("nope");
  });

  test("--json prints the same answer with the paths included", () => {
    const h = harness({ [HOME_FILE]: "[network]\nport = 8800\n" });
    expect(cmdConfigShow(h.deps, ["--json"])).toBe(EXIT.OK);
    // SAFETY: `cmdConfigShow --json` is the only writer of this text, two lines above, and it
    // stringifies exactly this shape; the assertion names the object that function just built.
    const parsed = JSON.parse(h.io.stdout.join("\n")) as {
      files: { path: string; present: boolean }[];
      settings: { key: string; source: string; value: string }[];
    };
    expect(parsed.files.map((f) => f.path)).toEqual([HOME_FILE, INSTANCE_FILE]);
    expect(parsed.settings).toHaveLength(CONFIG_SETTINGS.length);
    expect(parsed.settings.find((s) => s.key === "port")).toMatchObject({
      source: "file:home",
      value: "8800",
    });
  });

  test("--source filters to one layer, and an unknown one is a usage error", () => {
    const h = harness({ [HOME_FILE]: "[network]\nport = 8800\n" });
    expect(cmdConfigShow(h.deps, ["--source", "file:home"])).toBe(EXIT.OK);
    expect(rows(h.io.stdout).map((r) => r.key)).toEqual(["port"]);
    const bad = harness();
    expect(cmdConfigShow(bad.deps, ["--source", "nowhere"])).toBe(EXIT.USAGE);
  });
});

describe("config check", () => {
  test("a clean pair of files exits 0 and says so", () => {
    const h = harness({ [HOME_FILE]: "[network]\nport = 8800\n" });
    expect(cmdConfigCheck(h.deps, [])).toBe(EXIT.OK);
    expect(h.io.stdout).toContain("ok: no problems.");
  });

  test("one line per problem, and a non-zero exit", () => {
    const h = harness({ [HOME_FILE]: "[bridge]\npoll_mss = 1\n\n[nonsense]\nx = 1\n" });
    expect(cmdConfigCheck(h.deps, [])).toBe(EXIT.FAIL);
    expect(h.io.stderr).toHaveLength(2);
    expect(h.io.stderr[0]).toContain('has no key "poll_mss"');
    expect(h.io.stderr[1]).toContain("[nonsense] is not a section");
  });

  test("a named path is checked alone, which is how a file is checked before it is moved", () => {
    const h = harness({ "/tmp/candidate.toml": "[network]\nport = 8800\n", [HOME_FILE]: "[bad\n" });
    expect(cmdConfigCheck(h.deps, ["/tmp/candidate.toml"])).toBe(EXIT.OK);
    expect(h.io.stdout.some((l) => l.includes(HOME_FILE))).toBe(false);
  });

  test("a named path that does not exist is an error, not a silent pass", () => {
    const h = harness();
    expect(cmdConfigCheck(h.deps, ["/tmp/nope.toml"])).toBe(EXIT.FAIL);
    expect(h.io.stderr[0]).toContain("does not exist");
  });
});

describe("config init", () => {
  test("init names every setting in the schema, under its own section", () => {
    const text = generateConfigFile("/tmp/x.toml");
    for (const setting of CONFIG_SETTINGS) {
      expect(text, `${setting.env} is missing`).toContain(`#${setting.key} = `);
      expect(text, `${setting.env}'s doc is missing`).toContain(setting.doc);
      expect(text, `${setting.env} is not named`).toContain(`# env: ${setting.env}`);
    }
    for (const section of new Set(CONFIG_SETTINGS.map((s) => s.section))) {
      expect(text).toContain(`[${section}]`);
    }
  });

  test("the generated file says the environment still wins, and names its own path", () => {
    const text = generateConfigFile("/tmp/x.toml");
    expect(text.split("\n")[0]).toBe("# /tmp/x.toml");
    expect(text.split("\n")[1]).toContain("always override this file");
  });

  test("the generated file changes nothing: every key is commented out", () => {
    // The file is read back through the real reader, so "commented out" means what the bridge would
    // see rather than what the text looks like: no key set, and no problem either.
    const text = generateConfigFile(HOME_FILE);
    const layer = readConfigFilesSync(
      { read: (p) => ({ text: p === HOME_FILE ? text : null, error: null }) },
      configFilePaths({}, HOME, CONFIG),
      () => {},
      { home: HOME },
    );
    expect(layer.env).toEqual({});
    expect(layer.problems).toEqual([]);
  });

  test("it writes the machine's file 0600 and prints the path", () => {
    const h = harness();
    expect(cmdConfigInit(h.deps, [])).toBe(EXIT.OK);
    expect(h.io.stdout).toEqual([HOME_FILE]);
    expect(h.files.entries.get(HOME_FILE)?.mode).toBe(0o600);
  });

  test("--instance writes the config dir's file instead", () => {
    const h = harness();
    expect(cmdConfigInit(h.deps, ["--instance"])).toBe(EXIT.OK);
    expect(h.io.stdout).toEqual([INSTANCE_FILE]);
    expect(h.files.entries.has(HOME_FILE)).toBe(false);
  });

  test("--print writes nothing and puts the file on stdout", () => {
    const h = harness();
    expect(cmdConfigInit(h.deps, ["--print"])).toBe(EXIT.OK);
    expect(h.files.entries.size).toBe(0);
    expect(h.io.stdout[0]).toBe(`# ${HOME_FILE}`);
  });

  test("it refuses to overwrite a file that is already there, and says so", () => {
    const h = harness({ [HOME_FILE]: "[network]\nport = 8800\n" });
    expect(cmdConfigInit(h.deps, [])).toBe(EXIT.STATE);
    expect(h.io.stderr[0]).toContain("refusing to overwrite");
    expect(h.files.read(HOME_FILE)).toBe("[network]\nport = 8800\n");
  });
});

describe("round trip", () => {
  test("round trip: init, then check passes, and show reports the file's keys as file:home", () => {
    const written = harness();
    expect(cmdConfigInit(written.deps, [])).toBe(EXIT.OK);
    const text = written.files.read(HOME_FILE)!;

    // A generated file with two keys uncommented is the file an operator actually ends up with.
    const edited = text.replace("#port = 8787", "port = 8800").replace("#read_lines = 200", "read_lines = 42");
    const h = harness({ [HOME_FILE]: edited });
    expect(cmdConfigCheck(h.deps, [])).toBe(EXIT.OK);

    cmdConfigShow(h.deps, []);
    const byKey = new Map(rows(h.io.stdout).map((r) => [r.key, r]));
    expect(byKey.get("port")).toEqual({ key: "port", value: "8800", source: "file:home" });
    expect(byKey.get("read_lines")).toEqual({ key: "read_lines", value: "42", source: "file:home" });
  });

  test("instance file wins: the same key in both files reads from the config dir's", () => {
    const h = harness({
      [HOME_FILE]: "[network]\nport = 8800\n\n[bridge]\nread_lines = 10\n",
      [INSTANCE_FILE]: "[network]\nport = 8801\n",
    });
    expect(cmdConfigCheck(h.deps, [])).toBe(EXIT.OK);
    cmdConfigShow(h.deps, []);
    const byKey = new Map(rows(h.io.stdout).map((r) => [r.key, r]));
    expect(byKey.get("port")).toEqual({ key: "port", value: "8801", source: "file:instance" });
    // And a key only the machine's file sets keeps its value, so the win is per key.
    expect(byKey.get("read_lines")).toEqual({ key: "read_lines", value: "10", source: "file:home" });
  });
});

describe("the bare verb", () => {
  test("a bare `config` prints the usage block and exits 2", () => {
    const h = harness();
    expect(cmdConfig(h.deps, [])).toBe(EXIT.USAGE);
    expect(h.io.stderr[0]).toContain("usage: collie config");
  });

  test("a misspelt sub-verb names itself", () => {
    const h = harness();
    expect(cmdConfig(h.deps, ["shwo"])).toBe(EXIT.USAGE);
    expect(h.io.stderr[0]).toContain('unknown subcommand "shwo"');
  });

  test("each sub-verb dispatches to its own function", () => {
    const h = harness();
    expect(cmdConfig(h.deps, ["show", "--json"])).toBe(EXIT.OK);
    expect(h.io.stdout.join("").startsWith("{")).toBe(true);
  });
});

describe("an empty layer is a usable one", () => {
  test("show over no files at all reports every setting as a default", () => {
    const io = capture();
    const deps: ConfigDeps = {
      ctx: context({ HOME }, { configLayer: emptyConfigLayer(), home: HOME }),
      io,
      files: fakeFiles(),
    };
    expect(cmdConfigShow(deps, [])).toBe(EXIT.OK);
    expect(new Set(rows(io.stdout).map((r) => r.source))).toEqual(new Set(["default"]));
  });
});

/** A layer the doctor test also uses, exported so the two suites agree on what one looks like. */
export function layerFrom(seed: Record<string, string>): ConfigFileLayer {
  const files = fakeFiles(seed);
  return readConfigFilesSync(
    { read: (p) => ({ text: files.read(p), error: null }) },
    configFilePaths({}, HOME, CONFIG),
    () => {},
    { home: HOME },
  );
}
