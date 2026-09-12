import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { loadConfig } from "./config.ts";
import {
  CONFIG_FILENAME,
  configFilePaths,
  HOME_CONFIG_DIRNAME,
  overlayConfig,
  readConfigFiles,
  sourceOf,
  tightenPrivateFile,
  type ConfigFileLayer,
  type ConfigFilePath,
  type Environment,
  type FilePerms,
} from "./config-source.ts";
import { settingByEnv } from "./config-schema.ts";
import type { OperatorFileIo } from "./operator-file.ts";

const HOME = "/home/pat";
const CONFIG_DIR = "/home/pat/.config/herdr/plugins/config/herdr.collie-next";
const HOME_FILE = join(HOME, HOME_CONFIG_DIRNAME, CONFIG_FILENAME);
const INSTANCE_FILE = join(CONFIG_DIR, CONFIG_FILENAME);

/** An io over a map of path to text. A path the map does not hold is an absent file. */
function fakeIo(files: Record<string, string>): OperatorFileIo {
  return {
    mtime: async (path) => (files[path] === undefined ? null : 1),
    read: async (path) => {
      const text = files[path];
      if (text === undefined) throw new Error(`ENOENT ${path}`);
      return text;
    },
  };
}

const loosePerms = (tightenable: boolean): FilePerms => ({
  mode: () => 0o644,
  tighten: () => tightenable,
});

const paths: readonly ConfigFilePath[] = [
  { path: HOME_FILE, layer: "home" },
  { path: INSTANCE_FILE, layer: "instance" },
];

async function read(files: Record<string, string>, lines: string[] = []): Promise<ConfigFileLayer> {
  return readConfigFiles(fakeIo(files), paths, (m) => lines.push(m), { home: HOME });
}

describe("where the two files are", () => {
  test("exactly two entries, the machine's base first and the instance's second", () => {
    expect(configFilePaths({}, HOME, CONFIG_DIR)).toEqual([
      { path: HOME_FILE, layer: "home" },
      { path: INSTANCE_FILE, layer: "instance" },
    ]);
  });

  test("COLLIE_CONFIG replaces the base path and never the instance's", () => {
    const found = configFilePaths({ COLLIE_CONFIG: "/etc/collie.toml" }, HOME, CONFIG_DIR);
    expect(found[0]).toEqual({ path: "/etc/collie.toml", layer: "home" });
    expect(found[1]).toEqual({ path: INSTANCE_FILE, layer: "instance" });
  });

  test("a blank COLLIE_CONFIG says nothing", () => {
    expect(configFilePaths({ COLLIE_CONFIG: "  " }, HOME, CONFIG_DIR)[0]!.path).toBe(HOME_FILE);
  });

  test("no file anywhere is the ordinary case, not a problem", async () => {
    const layer = await read({});
    expect(layer.problems).toEqual([]);
    expect(layer.env).toEqual({});
    expect(layer.files.map((f) => f.present)).toEqual([false, false]);
  });
});

describe("precedence", () => {
  test("the instance file wins key by key, not file by file", async () => {
    const layer = await read({
      [HOME_FILE]: "[network]\nport = 8800\n\n[bridge]\npoll_ms = 900\n",
      [INSTANCE_FILE]: "[network]\nport = 8801\n",
    });
    expect(layer.env.COLLIE_PORT).toBe("8801");
    expect(layer.env.COLLIE_POLL_MS).toBe("900");
    expect(layer.sources.get("COLLIE_PORT")).toBe("file:instance");
    expect(layer.sources.get("COLLIE_POLL_MS")).toBe("file:home");
  });

  test("the process environment wins over both", async () => {
    const layer = await read({ [HOME_FILE]: "[network]\nport = 8800\n" });
    const env = overlayConfig({ COLLIE_PORT: "9999" }, layer);
    expect(env.COLLIE_PORT).toBe("9999");
    expect(sourceOf(settingByEnv("COLLIE_PORT")!, { COLLIE_PORT: "9999" }, layer)).toBe("env");
  });

  test("an explicitly-undefined name on the process side does not erase a file value", async () => {
    const layer = await read({ [HOME_FILE]: "[network]\nport = 8800\n" });
    expect(overlayConfig({ COLLIE_PORT: undefined }, layer).COLLIE_PORT).toBe("8800");
  });

  test("a key only the file set reports the file it came from", async () => {
    const layer = await read({ [HOME_FILE]: "[network]\nport = 8800\n" });
    const effective = overlayConfig({}, layer);
    expect(sourceOf(settingByEnv("COLLIE_PORT")!, effective, layer)).toBe("file:home");
  });

  test("a key nobody set anywhere reads as the default", async () => {
    const layer = await read({});
    expect(sourceOf(settingByEnv("COLLIE_PORT")!, {}, layer)).toBe("default");
  });

  test("both paths resolving to one file read it once, as the instance's", async () => {
    const one: readonly ConfigFilePath[] = [
      { path: INSTANCE_FILE, layer: "home" },
      { path: INSTANCE_FILE, layer: "instance" },
    ];
    const layer = await readConfigFiles(
      fakeIo({ [INSTANCE_FILE]: "[network]\nport = 8800\n" }),
      one,
      () => {},
      { home: HOME },
    );
    expect(layer.sources.get("COLLIE_PORT")).toBe("file:instance");
    expect(layer.problems).toEqual([]);
  });
});

describe("the file's shape", () => {
  test("a list takes an array and reaches the env comma-joined", async () => {
    const layer = await read({
      [HOME_FILE]: '[network]\nallowed_origins = ["https://a.example", "https://b.example"]\n',
    });
    expect(layer.env.COLLIE_ALLOWED_ORIGINS).toBe("https://a.example,https://b.example");
  });

  test("a leading ~/ expands to the resolving process's home", async () => {
    const layer = await read({
      [HOME_FILE]: '[bridge]\nstate_dir = "~/state/collie"\n\n[journal]\ntranscript_root = ["~/.claude/projects"]\n',
    });
    expect(layer.env.COLLIE_STATE_DIR).toBe("/home/pat/state/collie");
    expect(layer.env.COLLIE_TRANSCRIPT_ROOT).toBe("/home/pat/.claude/projects");
  });

  test("a bool reaches the env in the spelling envBool already reads", async () => {
    const layer = await read({ [HOME_FILE]: "[bridge]\ntranscript = false\nmulti_session = true\n" });
    expect(layer.env.COLLIE_TRANSCRIPT).toBe("0");
    expect(layer.env.COLLIE_MULTI_SESSION).toBe("1");
  });

  test("socket_path is the one key whose env name is not a COLLIE_ one", async () => {
    const layer = await read({ [HOME_FILE]: '[mux]\nsocket_path = "/run/herdr.sock"\n' });
    expect(layer.env.HERDR_SOCKET_PATH).toBe("/run/herdr.sock");
  });

  test("an enum value is normalised to the spelling the schema declares", async () => {
    const layer = await read({ [HOME_FILE]: '[access]\naudit_content = "NONE"\n' });
    expect(layer.env.COLLIE_AUDIT_CONTENT).toBe("none");
  });
});

describe("problems", () => {
  test("a file that is not TOML is one problem for the file", async () => {
    const layer = await read({ [HOME_FILE]: "[network\nport = " });
    expect(layer.problems).toHaveLength(1);
    expect(layer.problems[0]!.message).toContain(HOME_FILE);
    expect(layer.problems[0]!.key).toBeNull();
    expect(layer.env).toEqual({});
  });

  test("an unknown section is named, and the rest of the file still applies", async () => {
    const layer = await read({ [HOME_FILE]: "[nonsense]\nx = 1\n\n[network]\nport = 8800\n" });
    expect(layer.problems.map((p) => p.section)).toEqual(["nonsense"]);
    expect(layer.env.COLLIE_PORT).toBe("8800");
  });

  test("an unknown key names the file, the section and the key, and suggests nothing", async () => {
    const layer = await read({ [HOME_FILE]: "[bridge]\npoll_mss = 900\npoll_ms = 800\n" });
    expect(layer.problems).toHaveLength(1);
    expect(layer.problems[0]!.message).toBe(`${HOME_FILE}: [bridge] has no key "poll_mss"`);
    expect(layer.problems[0]!.message).not.toContain("did you mean");
    expect(layer.env.COLLIE_POLL_MS).toBe("800");
  });

  test("a string where an int belongs is a problem, never a coercion", async () => {
    const layer = await read({ [HOME_FILE]: '[network]\nport = "8800"\n' });
    expect(layer.problems[0]!.message).toContain("must be a whole number");
    expect(layer.env.COLLIE_PORT).toBeUndefined();
  });

  test("an int outside its bounds names the bound", async () => {
    const under = await read({ [HOME_FILE]: "[bridge]\npoll_ms = 10\n" });
    expect(under.problems[0]!.message).toContain("at least 250");
    const over = await read({ [HOME_FILE]: "[network]\nport = 70000\n" });
    expect(over.problems[0]!.message).toContain("at most 65535");
  });

  test("an enum value outside the allowed set lists them", async () => {
    const layer = await read({ [HOME_FILE]: '[access]\naudit_content = "verbose"\n' });
    expect(layer.problems[0]!.message).toContain("preview, none");
  });

  test("a scalar where a section belongs is a problem about the section", async () => {
    const layer = await read({ [HOME_FILE]: "network = 3\n" });
    expect(layer.problems[0]!.message).toContain("must be a table of keys");
  });

  test("a comma inside a list entry is refused rather than mangled into two", async () => {
    const layer = await read({ [HOME_FILE]: '[network]\npublic_hosts = ["a.example,b.example"]\n' });
    expect(layer.problems[0]!.message).toContain("may not contain a comma");
  });

  test("a problem warns once per file, naming the remedy, and never throws", async () => {
    const lines: string[] = [];
    await read({ [HOME_FILE]: "[bridge]\npoll_mss = 1\nread_liness = 2\n" }, lines);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("2 problems");
    expect(lines[0]).toContain("collie config check");
  });

  test("a file this process cannot read is a problem, not a throw", async () => {
    const io: OperatorFileIo = {
      mtime: async () => 1,
      read: async () => {
        throw new Error("EACCES");
      },
    };
    const layer = await readConfigFiles(io, paths, () => {}, { home: HOME });
    expect(layer.problems.length).toBeGreaterThan(0);
    expect(layer.env).toEqual({});
  });
});

describe("a malformed network key never widens the bind", () => {
  // The fallback is the ENV-ONLY view, and the env-only view is the loopback default. So the only
  // thing a wrong-typed `host`, `port`, `allow_non_loopback_bind` or `allow_any_host` can do is
  // nothing at all.
  const wrong = {
    host: '[network]\nhost = 3\n',
    port: '[network]\nport = "wide-open"\n',
    allow_non_loopback_bind: '[network]\nallow_non_loopback_bind = "yes"\n',
    allow_any_host: '[network]\nallow_any_host = 1\n',
  } satisfies Record<string, string>;

  for (const [key, text] of Object.entries(wrong)) {
    test(`a wrong-typed ${key} resolves the Config with no file at all`, async () => {
      const layer = await read({ [HOME_FILE]: text });
      expect(layer.problems).toHaveLength(1);
      const bare: Environment = { HOME, HERDR_PLUGIN_CONFIG_DIR: CONFIG_DIR };
      expect(loadConfig(overlayConfig(bare, layer))).toEqual(loadConfig(bare));
    });
  }

  test("and a GOOD network key still lands, so the fallback is per key", async () => {
    const layer = await read({ [HOME_FILE]: '[network]\nhost = "127.0.0.2"\nport = "nope"\n' });
    const bare: Environment = { HOME, HERDR_PLUGIN_CONFIG_DIR: CONFIG_DIR };
    const cfg = loadConfig(overlayConfig(bare, layer));
    expect(cfg.host).toBe("127.0.0.2");
    expect(cfg.port).toBe(loadConfig(bare).port);
  });
});

describe("a secret in the file is held to 0600", () => {
  test("a loose file that can be tightened keeps its secrets and says so", async () => {
    const lines: string[] = [];
    const layer = await readConfigFiles(
      fakeIo({ [HOME_FILE]: '[push]\nvapid_private = "abc"\n' }),
      paths,
      (m) => lines.push(m),
      { home: HOME, perms: loosePerms(true) },
    );
    expect(layer.env.COLLIE_VAPID_PRIVATE).toBe("abc");
    expect(layer.blocked).toEqual([]);
    expect(lines[0]).toContain("tightened it to 600");
  });

  test("a loose file that cannot be tightened drops the secret keys ALONE, loudly", async () => {
    const lines: string[] = [];
    const layer = await readConfigFiles(
      fakeIo({ [HOME_FILE]: '[push]\nvapid_private = "abc"\nvapid_public = "pub"\n' }),
      paths,
      (m) => lines.push(m),
      { home: HOME, perms: loosePerms(false) },
    );
    expect(layer.env.COLLIE_VAPID_PRIVATE).toBeUndefined();
    expect(layer.env.COLLIE_VAPID_PUBLIC).toBe("pub");
    expect(layer.blocked).toEqual(["COLLIE_VAPID_PRIVATE"]);
    expect(layer.sources.get("COLLIE_VAPID_PRIVATE")).toBe("file:blocked");
    expect(lines.some((l) => l.includes("COLLIE_VAPID_PRIVATE"))).toBe(true);
  });

  test("a file with no secret in it is never chmodded", async () => {
    let asked = false;
    const perms: FilePerms = {
      mode: () => {
        asked = true;
        return 0o644;
      },
      tighten: () => true,
    };
    await readConfigFiles(fakeIo({ [HOME_FILE]: "[network]\nport = 8800\n" }), paths, () => {}, {
      home: HOME,
      perms,
    });
    expect(asked).toBe(false);
  });

  test("an already-private file says nothing", () => {
    expect(tightenPrivateFile("/x", { mode: () => 0o600, tighten: () => false })).toEqual({
      ok: true,
      warning: null,
    });
    expect(tightenPrivateFile("/x", { mode: () => null, tighten: () => false }).ok).toBe(true);
  });
});

describe("no path is ever named after an instance", () => {
  test("neither resolved path carries a `config.<instance>.toml` name", () => {
    for (const entry of configFilePaths({ COLLIE_INSTANCE: "next" }, HOME, CONFIG_DIR)) {
      expect(entry.path.endsWith(`/${CONFIG_FILENAME}`)).toBe(true);
      expect(entry.path).not.toContain("config.next");
    }
  });
});
