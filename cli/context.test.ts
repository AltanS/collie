import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  collieVersion,
  collieVersionFrom,
  deriveSettings,
  parseEnvFile,
  PLUGIN_ID,
  resolveConfigDir,
  resolveHome,
} from "./context.ts";

// Ported behaviour, so these tests are written against the shell they replace: the config-dir
// precedence of scripts/collie-ctl.sh:23-39 and the three-way version of :191-200. If the binary and
// the script disagree here, a setting applied one way is silently ignored the other — the exact bug
// the precedence comment records.

const HOME = "/home/tester";
const LEGACY = join(HOME, ".config", "collie");
const CONVENTIONAL = join(HOME, ".config", "herdr", "plugins", "config", PLUGIN_ID);

function resolve(opts: {
  env?: Record<string, string | undefined>;
  files?: string[];
  herdr?: string | null;
}) {
  const files = new Set(opts.files ?? []);
  return resolveConfigDir({
    env: opts.env ?? {},
    home: HOME,
    fileExists: (p) => files.has(p),
    askHerdr: () => opts.herdr ?? null,
  });
}

describe("config dir precedence", () => {
  test("the injected env var wins over everything", () => {
    const r = resolve({
      env: { HERDR_PLUGIN_CONFIG_DIR: "/injected" },
      herdr: "/from-herdr",
      files: [join(CONVENTIONAL, ".env")],
    });
    expect(r.dir).toBe("/injected");
  });

  test("a blank injected value does not count as injected", () => {
    expect(resolve({ env: { HERDR_PLUGIN_CONFIG_DIR: "   " }, herdr: "/from-herdr" }).dir).toBe(
      "/from-herdr",
    );
  });

  test("the Herdr CLI is asked next", () => {
    expect(resolve({ herdr: "/from-herdr" }).dir).toBe("/from-herdr");
  });

  test("Herdr saying nothing (or being absent) falls through", () => {
    expect(resolve({ herdr: "" }).dir).toBe(LEGACY);
    expect(resolve({ herdr: null }).dir).toBe(LEGACY);
  });

  test("the conventional path counts only when it actually holds a .env", () => {
    expect(resolve({ files: [join(CONVENTIONAL, ".env")] }).dir).toBe(CONVENTIONAL);
    expect(resolve({ files: [CONVENTIONAL] }).dir).toBe(LEGACY);
  });

  test("~/.config/collie is the last resort", () => {
    expect(resolve({}).dir).toBe(LEGACY);
  });
});

describe("the legacy .env note", () => {
  test("fires when a legacy .env exists but is not the resolved dir", () => {
    const r = resolve({ herdr: "/from-herdr", files: [join(LEGACY, ".env")] });
    expect(r.note).toContain(join(LEGACY, ".env"));
    expect(r.note).toContain(join("/from-herdr", ".env"));
  });

  test("stays silent when the legacy dir IS the resolved dir", () => {
    expect(resolve({ files: [join(LEGACY, ".env")] }).note).toBeNull();
  });

  test("stays silent when there is no legacy .env to ignore", () => {
    expect(resolve({ herdr: "/from-herdr" }).note).toBeNull();
  });
});

describe("parseEnvFile", () => {
  test("reads plain assignments, comments and blanks", () => {
    expect(parseEnvFile("# a comment\n\nCOLLIE_PORT=9000\n  COLLIE_SERVE_MODE=http\n")).toEqual({
      COLLIE_PORT: "9000",
      COLLIE_SERVE_MODE: "http",
    });
  });

  test("honours an `export` prefix", () => {
    expect(parseEnvFile("export COLLIE_PORT=9000")).toEqual({ COLLIE_PORT: "9000" });
  });

  test("unwraps quotes — single literal, double with the common escapes", () => {
    expect(parseEnvFile(`A='raw $NOPE'\nB="line\\nbreak"\nC="say \\"hi\\""`)).toEqual({
      A: "raw $NOPE",
      B: "line\nbreak",
      C: 'say "hi"',
    });
  });

  test("strips a trailing inline comment only from an unquoted value", () => {
    expect(parseEnvFile("A=8787 # the port\nB='8787 # not a comment'")).toEqual({
      A: "8787",
      B: "8787 # not a comment",
    });
  });

  test("ignores anything that is not an assignment — a .env is parsed, never executed", () => {
    // The whole point of not `source`ing: a function defined here used to shadow the real `bun`
    // and poison every later lookup (scripts/collie-ctl.sh:83-97).
    const parsed = parseEnvFile('bun() { echo nope; }\nrm -rf /\nCOLLIE_PORT=9000\n');
    expect(parsed).toEqual({ COLLIE_PORT: "9000" });
  });

  test("a later assignment wins, as re-assignment would in a sourced file", () => {
    expect(parseEnvFile("A=1\nA=2")).toEqual({ A: "2" });
  });
});

describe("version", () => {
  const BUILD_INFO = '{"id":"x","version":"0.24.2","sha":"f76be58"}';
  const MANIFEST = 'id = "herdr.collie"\nversion = "0.24.2"\n';

  test("the built stamp wins, as version+sha", () => {
    expect(collieVersionFrom(BUILD_INFO, MANIFEST)).toBe("0.24.2+f76be58");
  });

  test("a stamp with no sha prints the bare version", () => {
    expect(collieVersionFrom('{"version":"0.24.2"}', MANIFEST)).toBe("0.24.2");
  });

  test("no stamp falls back to the manifest, tagged as unbuilt", () => {
    expect(collieVersionFrom(null, MANIFEST)).toBe("0.24.2 (manifest; web not built)");
  });

  test("neither is `unknown` — never an empty line or a crash", () => {
    expect(collieVersionFrom(null, null)).toBe("unknown");
    expect(collieVersionFrom(null, "no version here")).toBe("unknown");
  });

  test("a half-written stamp is still read, as the shell's sed would", () => {
    // Truncated mid-write: the version line is complete, the sha's closing quote is not — so the
    // version survives and the sha is simply absent, exactly as the shell's two seds behaved.
    expect(collieVersionFrom('{"version":"0.24.2","sha":"f76be5', MANIFEST)).toBe("0.24.2");
    expect(collieVersionFrom('{"version":"0.24.2","sha":"f76be58"', MANIFEST)).toBe("0.24.2+f76be58");
  });

  test("a stamp with no version at all falls through to the manifest", () => {
    expect(collieVersionFrom("{}", MANIFEST)).toBe("0.24.2 (manifest; web not built)");
  });

  test("reads the two real paths off a checkout-shaped directory", () => {
    const root = mkdtempSync(join(tmpdir(), "collie-version-"));
    writeFileSync(join(root, "herdr-plugin.toml"), MANIFEST);
    expect(collieVersion(root)).toBe("0.24.2 (manifest; web not built)");
    mkdirSync(join(root, "web", "dist"), { recursive: true });
    writeFileSync(join(root, "web", "dist", "build-info.json"), BUILD_INFO);
    expect(collieVersion(root)).toBe("0.24.2+f76be58");
  });

  test("an empty directory is `unknown`, not a thrown ENOENT", () => {
    expect(collieVersion(mkdtempSync(join(tmpdir(), "collie-version-empty-")))).toBe("unknown");
  });
});

describe("derived settings", () => {
  test("defaults match the shell's", () => {
    expect(deriveSettings({}, HOME)).toEqual({
      port: 8787,
      serveMode: "https",
      socket: join(HOME, ".config", "herdr", "herdr.sock"),
    });
  });

  test("env overrides each of them", () => {
    expect(
      deriveSettings(
        { COLLIE_PORT: "9000", COLLIE_SERVE_MODE: "http", HERDR_SOCKET_PATH: "/run/h.sock" },
        HOME,
      ),
    ).toEqual({ port: 9000, serveMode: "http", socket: "/run/h.sock" });
  });

  test("a non-numeric port falls back rather than becoming NaN", () => {
    expect(deriveSettings({ COLLIE_PORT: "8787abc" }, HOME).port).toBe(8787);
  });

  test("only the literal `http` leaves https — a typo does not silently disable TLS", () => {
    expect(deriveSettings({ COLLIE_SERVE_MODE: "htpp" }, HOME).serveMode).toBe("https");
    expect(deriveSettings({ COLLIE_SERVE_MODE: "HTTP" }, HOME).serveMode).toBe("https");
  });
});

describe("resolveHome", () => {
  test("uses $HOME when set", () => {
    expect(resolveHome({ HOME: "/home/x" })).toBe("/home/x");
  });

  test("falls back to the passwd entry when there is no environment at all", () => {
    // `env -i` is the primary contract: no HOME, and every ~-derived path still has to resolve.
    const h = resolveHome({});
    expect(h.startsWith("/")).toBe(true);
    expect(h).not.toBe("");
  });
});
