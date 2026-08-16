import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";

import { defaultSocketPath, loadConfig, parseOperatorCommands } from "./config.ts";

// loadConfig is the deployment contract — env vars in, a resolved Config out. Pure (just reads
// process.env + homedir), so we drive it by mutating the environment and restoring it after.

const KEYS = [
  "COLLIE_PORT",
  "COLLIE_HOST",
  "COLLIE_POLL_MS",
  "COLLIE_POLL_IDLE_MS",
  "COLLIE_NOTIFY_DELAY_MS",
  "COLLIE_READ_LINES",
  "COLLIE_TRANSCRIPT",
  "COLLIE_TRANSCRIPT_ROOT",
  "COLLIE_CODEX_ROOT",
  "COLLIE_PI_ROOT",
  "COLLIE_OPENCODE_ROOT",
  // Each harness's own home var participates in journal-root resolution, so the suite must own them
  // too — otherwise a developer with CODEX_HOME set gets different results than CI.
  "CODEX_HOME",
  "PI_CODING_AGENT_DIR",
  "XDG_DATA_HOME",
  "COLLIE_SUBMIT_KEYS",
  "COLLIE_TRUSTED_USER",
  "COLLIE_DEVICE_HEADER",
  "COLLIE_DEVICE_ALLOWLIST",
  "COLLIE_ALLOWED_ORIGINS",
  "COLLIE_PUBLIC_HOSTS",
  "COLLIE_VAPID_PUBLIC",
  "COLLIE_VAPID_PRIVATE",
  "COLLIE_VAPID_SUBJECT",
  "COLLIE_STATE_DIR",
  "COLLIE_MULTI_SESSION",
  "COLLIE_SKIP_SERVE",
  "HERDR_SOCKET_PATH",
  "HERDR_PLUGIN_STATE_DIR",
  "COLLIE_HERDR_DIAL",
  "COLLIE_COMMANDS",
];

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of KEYS) {
    const v = saved[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("loadConfig", () => {
  test("uses safe single-user defaults", () => {
    const cfg = loadConfig();
    expect(cfg.port).toBe(8787);
    expect(cfg.host).toBe("127.0.0.1");
    expect(cfg.pollMs).toBe(1500);
    expect(cfg.pollIdleMs).toBe(12_000);
    expect(cfg.readLines).toBe(200);
    // Transcript history defaults ON — it's the only scrollback a Claude pane can ever have.
    expect(cfg.transcript).toBe(true);
    // One root by default, and it is a list of one rather than a special case (issue #92).
    expect(cfg.journalRoots.claude).toHaveLength(1);
    expect(cfg.journalRoots.claude[0]).toEndWith("/.claude/projects");
    // OpenCode keeps ONE sqlite database at the top of its XDG data dir — no per-session files.
    expect(cfg.journalRoots.opencode).toEqual([join(homedir(), ".local", "share", "opencode")]);
    expect(cfg.submitKeys).toEqual(["Enter"]);
    expect(cfg.trustedUser).toBe("");
    expect(cfg.allowedOrigins).toEqual([]);
    expect(cfg.notifyDelayMs).toBe(30_000);
    // Host-header validation is opt-in (empty = off, legacy behaviour).
    expect(cfg.publicHosts).toEqual([]);
    // Per-device auth is off by default (empty header = feature disabled).
    expect(cfg.deviceHeader).toBe("");
    expect(cfg.deviceAllowlist).toEqual([]);
    // Multi-session support is on by default.
    expect(cfg.multiSession).toBe(true);
    // tailscale serve is used by default (reverse-proxy bypass is opt-in).
    expect(cfg.skipServe).toBe(false);
  });

  test("parses COLLIE_MULTI_SESSION as a boolean toggle (default on)", () => {
    // Falsey spellings turn it off (pin to the primary session only).
    for (const off of ["off", "0", "false", "no", "OFF", " False "]) {
      process.env.COLLIE_MULTI_SESSION = off;
      expect(loadConfig().multiSession).toBe(false);
    }
    // Truthy spellings keep it on.
    for (const on of ["on", "1", "true", "yes", "ON", " True "]) {
      process.env.COLLIE_MULTI_SESSION = on;
      expect(loadConfig().multiSession).toBe(true);
    }
    // Garbage and empty fall back to the default (on).
    process.env.COLLIE_MULTI_SESSION = "banana";
    expect(loadConfig().multiSession).toBe(true);
    process.env.COLLIE_MULTI_SESSION = "";
    expect(loadConfig().multiSession).toBe(true);
  });

  test("parses COLLIE_SKIP_SERVE as a boolean toggle (default off)", () => {
    // Truthy spellings turn it on (reverse-proxy mode; bypass tailscale serve).
    for (const on of ["on", "1", "true", "yes", "ON", " True "]) {
      process.env.COLLIE_SKIP_SERVE = on;
      expect(loadConfig().skipServe).toBe(true);
    }
    // Falsey spellings keep it off (the default tailscale serve path).
    for (const off of ["off", "0", "false", "no", "OFF", " False "]) {
      process.env.COLLIE_SKIP_SERVE = off;
      expect(loadConfig().skipServe).toBe(false);
    }
    // Garbage and empty fall back to the default (off).
    process.env.COLLIE_SKIP_SERVE = "banana";
    expect(loadConfig().skipServe).toBe(false);
    process.env.COLLIE_SKIP_SERVE = "";
    expect(loadConfig().skipServe).toBe(false);
  });

  test("parses COLLIE_TRANSCRIPT as a boolean toggle (default ON)", () => {
    for (const off of ["off", "0", "false", "no", "OFF"]) {
      process.env.COLLIE_TRANSCRIPT = off;
      expect(loadConfig().transcript).toBe(false);
    }
    for (const on of ["on", "1", "true", "yes"]) {
      process.env.COLLIE_TRANSCRIPT = on;
      expect(loadConfig().transcript).toBe(true);
    }
    // Garbage falls back to the default — a typo must not silently remove the only scrollback a
    // Claude pane has.
    process.env.COLLIE_TRANSCRIPT = "banana";
    expect(loadConfig().transcript).toBe(true);
  });

  // COLLIE_TRANSCRIPT_ROOT predates the per-harness split and meant Claude's root — it keeps meaning
  // exactly that, so an existing deployment's env survives the change untouched.
  test("COLLIE_TRANSCRIPT_ROOT relocates the CLAUDE journal root", () => {
    process.env.COLLIE_TRANSCRIPT_ROOT = "/srv/claude/projects";
    expect(loadConfig().journalRoots.claude).toEqual(["/srv/claude/projects"]);
  });

  // The multi-profile case from issue #92: CLAUDE_CONFIG_DIR gives each Claude profile its own
  // projects tree, so one root can only ever serve half the herd's history.
  test("COLLIE_TRANSCRIPT_ROOT takes several roots, comma-separated and in order", () => {
    process.env.COLLIE_TRANSCRIPT_ROOT = "/srv/work/projects,/srv/personal/projects";
    expect(loadConfig().journalRoots.claude).toEqual([
      "/srv/work/projects",
      "/srv/personal/projects",
    ]);
  });

  test("whitespace and empty entries around the separators are dropped", () => {
    process.env.COLLIE_TRANSCRIPT_ROOT = " /a/projects , , /b/projects ,";
    expect(loadConfig().journalRoots.claude).toEqual(["/a/projects", "/b/projects"]);
  });

  // An empty value used to become a root of `""` — which resolves against the bridge's cwd, not a
  // journal. Falling back to the default is both safer and what the operator meant.
  test("an empty value falls back to the default root", () => {
    process.env.COLLIE_TRANSCRIPT_ROOT = "   ";
    expect(loadConfig().journalRoots.claude).toEqual([join(homedir(), ".claude", "projects")]);
  });

  test("every harness root takes a list, not just Claude's", () => {
    process.env.COLLIE_CODEX_ROOT = "/a/sessions,/b/sessions";
    process.env.COLLIE_PI_ROOT = "/c/sessions,/d/sessions";
    process.env.COLLIE_OPENCODE_ROOT = "/e/opencode,/f/opencode";
    const cfg = loadConfig();
    expect(cfg.journalRoots.codex).toEqual(["/a/sessions", "/b/sessions"]);
    expect(cfg.journalRoots.pi).toEqual(["/c/sessions", "/d/sessions"]);
    expect(cfg.journalRoots.opencode).toEqual(["/e/opencode", "/f/opencode"]);
  });

  test("each harness's own home var relocates its journal root", () => {
    process.env.CODEX_HOME = "/srv/codex";
    process.env.PI_CODING_AGENT_DIR = "/srv/pi";
    process.env.XDG_DATA_HOME = "/srv/share";
    const cfg = loadConfig();
    expect(cfg.journalRoots.codex).toEqual(["/srv/codex/sessions"]);
    expect(cfg.journalRoots.pi).toEqual(["/srv/pi/sessions"]);
    expect(cfg.journalRoots.opencode).toEqual(["/srv/share/opencode"]);
  });

  test("an explicit COLLIE_* root beats the harness's home var", () => {
    process.env.CODEX_HOME = "/srv/codex";
    process.env.COLLIE_CODEX_ROOT = "/elsewhere/rollouts";
    expect(loadConfig().journalRoots.codex).toEqual(["/elsewhere/rollouts"]);
  });

  test("reads the per-device auth header and allowlist", () => {
    process.env.COLLIE_DEVICE_HEADER = "  X-Device-Id  ";
    process.env.COLLIE_DEVICE_ALLOWLIST = " phone , laptop ,";
    const cfg = loadConfig();
    expect(cfg.deviceHeader).toBe("X-Device-Id");
    expect(cfg.deviceAllowlist).toEqual(["phone", "laptop"]);
  });

  test("parses integer env vars and falls back to the default on garbage", () => {
    process.env.COLLIE_PORT = "9999";
    expect(loadConfig().port).toBe(9999);
    process.env.COLLIE_PORT = "not-a-number";
    expect(loadConfig().port).toBe(8787);
  });

  test("rejects trailing-garbage integers (parseInt would have accepted '8080abc')", () => {
    process.env.COLLIE_PORT = "8080abc";
    expect(loadConfig().port).toBe(8787);
    // Surrounding whitespace is still fine.
    process.env.COLLIE_READ_LINES = "  120  ";
    expect(loadConfig().readLines).toBe(120);
  });

  test("clamps out-of-range integers back to the default", () => {
    process.env.COLLIE_PORT = "0";
    expect(loadConfig().port).toBe(8787);
    process.env.COLLIE_PORT = "70000";
    expect(loadConfig().port).toBe(8787);
    process.env.COLLIE_POLL_MS = "100"; // below the 250 floor
    expect(loadConfig().pollMs).toBe(1500);
    process.env.COLLIE_POLL_IDLE_MS = "500"; // below the 1000 floor
    expect(loadConfig().pollIdleMs).toBe(12_000);
    process.env.COLLIE_NOTIFY_DELAY_MS = "-5"; // below the 0 floor
    expect(loadConfig().notifyDelayMs).toBe(30_000);
  });

  test("accepts an in-range integer and a zero notify delay", () => {
    process.env.COLLIE_POLL_MS = "250";
    expect(loadConfig().pollMs).toBe(250);
    process.env.COLLIE_POLL_IDLE_MS = "30000";
    expect(loadConfig().pollIdleMs).toBe(30_000);
    process.env.COLLIE_NOTIFY_DELAY_MS = "0";
    expect(loadConfig().notifyDelayMs).toBe(0);
  });

  test("reads the public-hosts allowlist, trimming and dropping blanks", () => {
    process.env.COLLIE_PUBLIC_HOSTS = " collie.example.ts.net , collie.example.com:8443 ,";
    expect(loadConfig().publicHosts).toEqual([
      "collie.example.ts.net",
      "collie.example.com:8443",
    ]);
  });

  test("splits comma lists, trimming whitespace and dropping blanks", () => {
    process.env.COLLIE_SUBMIT_KEYS = " ctrl+a , Enter ,";
    expect(loadConfig().submitKeys).toEqual(["ctrl+a", "Enter"]);
    process.env.COLLIE_ALLOWED_ORIGINS = "https://a.example.com, https://b.example.com";
    expect(loadConfig().allowedOrigins).toEqual(["https://a.example.com", "https://b.example.com"]);
  });

  test("falls back to [Enter] when COLLIE_SUBMIT_KEYS is empty", () => {
    process.env.COLLIE_SUBMIT_KEYS = "";
    expect(loadConfig().submitKeys).toEqual(["Enter"]);
  });

  test("honours an explicit trusted user and host override", () => {
    process.env.COLLIE_TRUSTED_USER = "me@example.com";
    process.env.COLLIE_HOST = "0.0.0.0";
    const cfg = loadConfig();
    expect(cfg.trustedUser).toBe("me@example.com");
    expect(cfg.host).toBe("0.0.0.0");
  });

  test("dial mode defaults to auto and accepts a forced dialer", () => {
    expect(loadConfig().dialMode).toBe("auto");
    process.env.COLLIE_HERDR_DIAL = "net";
    expect(loadConfig().dialMode).toBe("net");
    process.env.COLLIE_HERDR_DIAL = "BUN"; // case-insensitive
    expect(loadConfig().dialMode).toBe("bun");
  });

  test("an unrecognised dial mode falls back to auto rather than dialling nothing", () => {
    process.env.COLLIE_HERDR_DIAL = "carrier-pigeon";
    expect(loadConfig().dialMode).toBe("auto");
  });
});

// Pure — both platform branches are testable from any host (expectations use join() so the
// host's separator never leaks into the assertion).
describe("defaultSocketPath", () => {
  test("unix default lives under ~/.config/herdr", () => {
    expect(defaultSocketPath("linux", {}, "/home/u")).toBe(join("/home/u", ".config", "herdr", "herdr.sock"));
    expect(defaultSocketPath("darwin", {}, "/Users/u")).toBe(join("/Users/u", ".config", "herdr", "herdr.sock"));
  });

  test("win32 default honours APPDATA", () => {
    expect(defaultSocketPath("win32", { APPDATA: "C:\\Users\\u\\AppData\\Roaming" }, "C:\\Users\\u")).toBe(
      join("C:\\Users\\u\\AppData\\Roaming", "herdr", "herdr.sock"),
    );
  });

  test("win32 falls back to <home>/AppData/Roaming when APPDATA is unset", () => {
    expect(defaultSocketPath("win32", {}, "C:\\Users\\u")).toBe(
      join("C:\\Users\\u", "AppData", "Roaming", "herdr", "herdr.sock"),
    );
  });
});

// The palette's escape hatch: an operator-declared row for a command the shipped catalog cannot
// vouch for (a plugin's, or their own). Pure, so it is driven directly rather than through env.
describe("parseOperatorCommands", () => {
  test("unset or blank yields nothing", () => {
    expect(parseOperatorCommands(undefined)).toEqual([]);
    expect(parseOperatorCommands("")).toEqual([]);
    expect(parseOperatorCommands(" , ,")).toEqual([]);
  });

  test("scopes a row to one agent and keeps its description", () => {
    expect(parseOperatorCommands("omp:/fork-in-herdr=Fork into a new herdr tab")).toEqual([
      {
        agent: "omp",
        command: "/fork-in-herdr",
        description: "Fork into a new herdr tab",
        takesArg: false,
        argHint: "",
      },
    ]);
  });

  test("an unscoped row carries no agent, so every pane gets it", () => {
    const rows = parseOperatorCommands("/deploy");
    expect(rows).toEqual([
      { command: "/deploy", description: "Custom command", takesArg: false, argHint: "" },
    ]);
    expect("agent" in rows[0]!).toBe(false);
  });

  test("a hint after the command marks the row arg-taking", () => {
    expect(parseOperatorCommands("claude:/model <name>=Switch model")).toEqual([
      {
        agent: "claude",
        command: "/model",
        description: "Switch model",
        takesArg: true,
        argHint: "<name>",
      },
    ]);
  });

  test("splits on commas, trims fields, and lowercases the agent", () => {
    expect(parseOperatorCommands(" OMP:/a=One , codex:/b=Two ").map((c) => [c.agent, c.command, c.description])).toEqual([
      ["omp", "/a", "One"],
      ["codex", "/b", "Two"],
    ]);
  });

  test("a colon AFTER the slash belongs to the command, not to a scope", () => {
    const rows = parseOperatorCommands("/skill:review=Run the review skill");
    expect(rows[0]!.agent).toBeUndefined();
    expect(rows[0]!.command).toBe("/skill:review");
  });

  test("drops entries that are not slash commands", () => {
    expect(parseOperatorCommands("fork-in-herdr,omp:,/,omp:/ok")).toEqual([
      { agent: "omp", command: "/ok", description: "Custom command", takesArg: false, argHint: "" },
    ]);
  });

  test("a redefinition wins, in place, without disturbing another scope", () => {
    expect(
      parseOperatorCommands("omp:/x=first,codex:/x=other,omp:/x=second").map((c) => [
        c.agent,
        c.description,
      ]),
    ).toEqual([
      ["omp", "second"],
      ["codex", "other"],
    ]);
  });

  test("an empty scope is rejected, never widened to every agent", () => {
    // ":/wipe" is someone reaching for a narrower rule than they typed. Dropping the empty prefix
    // would hand them a row on every pane — the one outcome they were not asking for.
    expect(parseOperatorCommands(":/wipe=Wipe")).toEqual([]);
    expect(parseOperatorCommands("  :/wipe")).toEqual([]);
  });

  test("the FIRST = starts the description, so a hint cannot contain one", () => {
    // A documented cost of the grammar, pinned so it cannot drift into a silent change of meaning:
    // everything after that first `=` is description, `=` included.
    expect(parseOperatorCommands("omp:/deploy <env>=Ship to a=b")).toMatchObject([
      { command: "/deploy", argHint: "<env>", description: "Ship to a=b", takesArg: true },
    ]);
    expect(parseOperatorCommands("omp:/set [key=value]=Set a key")).toMatchObject([
      { command: "/set", argHint: "[key", description: "value]=Set a key" },
    ]);
  });
});
